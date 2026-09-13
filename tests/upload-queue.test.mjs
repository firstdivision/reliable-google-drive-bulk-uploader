import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UploadQueue, selectionKey, sourceFingerprint } from '../phase2/upload-queue.mjs';
import { UploadError } from '../phase1/drive-upload.mjs';

const UNIT = 256 * 1024;
const tick = () => new Promise(setImmediate);
const waitFor = async predicate => {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Expected queue state was not reached');
};
function file(name, size = 10, lastModified = 1) {
  return { name, size, lastModified, type: 'video/mp4',
    slice(start, end) { return new Blob([new Uint8Array(end - start)]); } };
}

function fixture(options = {}) {
  const workers = [];
  const queue = new UploadQueue({ getToken: () => 'token', createUpload: (config) => {
    const worker = { ...config, state: 'queued', confirmedBytes: 0, fileId: null,
      error: null, starts: 0, running: false,
      change(state) { this.state = state; this.onChange(this); },
      start() {
        assert.equal(this.running, false, 'one invocation per worker at a time');
        this.running = true;
        this.starts++;
        this.error = null;
        this.fileId ||= `drive-${workers.indexOf(this)}`;
        this.change('preparing');
        return new Promise((resolve) => { this.finish = resolve; });
      },
      progress(bytes) { this.confirmedBytes = bytes; this.change('uploading'); },
      pause() { this.change('paused'); }, // Abort takes time; settle explicitly in race tests.
      settle(state = this.state, error = null) {
        this.error = error;
        if (state === 'completed') this.confirmedBytes = this.file.size;
        this.change(state);
        this.running = false;
        this.onChange(this);
        this.finish();
      },
    };
    workers.push(worker);
    return worker;
  }, ...options });
  return { queue, workers };
}

test('large metadata-only selection deduplicates without reading sources', () => {
  const { queue } = fixture();
  const files = Array.from({ length: 5000 }, (_, i) => ({ ...file(`clip-${i}`, 9_000_000_000),
    slice() { throw new Error('Must not read during selection'); } }));
  assert.deepEqual(queue.add(files), { added: 5000, duplicates: 0, rejected: 0 });
  assert.deepEqual(queue.add(files), { added: 0, duplicates: 5000, rejected: 0 });
  assert.equal(queue.summary.totalBytes, 45_000_000_000_000);
  assert.equal(queue.summary.counts.queued, 5000);
  assert.equal(queue.summary.active, 0);
  assert.notEqual(selectionKey(file('clip', 10, 1)), selectionKey(file('clip', 10, 2)));
  assert.deepEqual(queue.add([file('empty', 0), file('negative', -1), {}]),
    { added: 0, duplicates: 0, rejected: 3 });
});

test('fingerprints read at most 128 KiB and detect changed sampled bytes', async () => {
  const ranges = [];
  const source = { ...file('large', 9_000_000_000), slice(start, end) {
    ranges.push([start, end]); return new Blob([new Uint8Array(end - start)]);
  } };
  assert.match(await sourceFingerprint(source), /^[a-f0-9]{64}$/);
  assert.equal(ranges.reduce((total, [start, end]) => total + end - start, 0), 128 * 1024);
  assert.notEqual(await sourceFingerprint(file('small')), await sourceFingerprint({ ...file('small'),
    slice(start, end) { return new Blob([new Uint8Array(end - start).fill(1)]); } }));
});

test('snapshot roundtrip keeps completion records, requires sources, and never stores tokens or media', async () => {
  let saved;
  const { queue, workers } = fixture({ saveSnapshot: async snapshot => { saved = structuredClone(snapshot); },
    getAccountId: () => 'original-account' });
  queue.add([file('complete'), file('partial'), file('queued')]);
  queue.start('folder');
  await waitFor(() => workers.length === 2 && workers.every(worker => worker.running));
  const completed = workers.find(worker => worker.file.name === 'complete');
  const partial = workers.find(worker => worker.file.name === 'partial');
  completed.settle('completed');
  partial.progress(4);
  queue.pause();
  partial.settle();
  await tick(); await queue.persist();
  assert.equal(saved.accountId, 'original-account');
  assert.ok(saved.items.every(item => !('file' in item) && !('upload' in item) && !('getToken' in item)));
  const restored = fixture({ saveSnapshot: async () => {}, getAccountId: () => 'original-account' });
  restored.queue.restore(saved);
  assert.equal(restored.queue.summary.counts.completed, 1);
  assert.equal(restored.queue.summary.missingSources, 2);
  assert.equal(restored.queue.summary.confirmedBytes, 14);
  restored.queue.start();
  await tick();
  assert.equal(restored.workers.length, 0);
  const result = await restored.queue.reconnectSources([file('complete'), file('partial'), file('unrelated')]);
  assert.deepEqual(result, { matched: 1, skipped: 1, unmatched: 1, ambiguous: 0, mismatched: 0 });
  restored.queue.start();
  await waitFor(() => restored.workers.length === 1);
  assert.equal(restored.workers[0].recovery.fileId, saved.items[1].driveFileId);
  restored.workers[0].settle('completed');
  await tick();
  assert.equal(restored.queue.summary.counts.completed, 2);
  assert.equal(restored.queue.summary.missingSources, 1);
});

test('reselection rejects ambiguous and changed sources without adding new uploads', async () => {
  const { queue } = fixture();
  queue.add([file('source')]);
  queue.items.get('1').fingerprint = await sourceFingerprint(file('source'));
  const restored = fixture().queue;
  restored.restore(queue.snapshot());
  assert.equal((await restored.reconnectSources([file('source'), file('source')])).ambiguous, 2);
  assert.equal((await restored.reconnectSources([{ ...file('source'), slice(start, end) {
    return new Blob([new Uint8Array(end - start).fill(9)]);
  } }])).mismatched, 1);
  assert.equal(restored.summary.missingSources, 1);
  assert.equal(restored.summary.total, 1);
});

test('reselection replaces a stale live reference while retaining resumable identity', async () => {
  const { queue, workers } = fixture();
  queue.add([file('source')]);
  queue.start('folder');
  await tick();
  workers[0].progress(4);
  queue.pause(); workers[0].settle();
  await tick();
  const item = queue.items.get('1');
  item.fingerprint = await sourceFingerprint(file('source'));
  const identity = item.driveFileId;
  item.file = { ...item.file, slice() { throw new Error('Source access lost'); } };
  const replacement = file('source');
  assert.equal((await queue.reconnectSources([replacement])).matched, 1);
  assert.equal(item.file, replacement);
  assert.equal(item.upload, null);
  assert.equal(item.driveFileId, identity);
  assert.equal(item.confirmedBytes, 4);
  assert.equal(queue.missingSources, 0);
});

test('source eligibility counters follow mixed recovery, retries, removal and completion', async () => {
  const { queue, workers } = fixture();
  queue.add([file('paused'), file('failed'), file('remove')]);
  assert.equal(queue.summary.resumableSources, 3);
  queue.remove('3');
  assert.equal(queue.summary.resumableSources, 2);
  queue.start('folder');
  await tick();
  const failed = workers.find(worker => worker.file.name === 'failed');
  failed.settle('failed', new UploadError('Permission denied'));
  queue.pause();
  workers.find(worker => worker.file.name === 'paused').settle();
  await tick();
  assert.equal(queue.summary.resumableSources, 1);
  assert.equal(queue.summary.retryableSources, 1);
  queue.accountId = 'account';
  for (const item of queue.items.values()) item.fingerprint = await sourceFingerprint(file(item.name));
  const restored = fixture();
  restored.queue.restore(queue.snapshot());
  assert.equal(restored.queue.summary.resumableSources, 0);
  await restored.queue.reconnectSources([file('failed')]);
  assert.equal(restored.queue.summary.resumableSources, 0);
  assert.equal(restored.queue.summary.retryableSources, 1);
  restored.queue.retryFailed();
  await tick();
  assert.equal(restored.queue.summary.retryableSources, 0);
  restored.workers[0].settle('completed');
  await tick();
  assert.equal(restored.queue.summary.resumableSources, 0);
  assert.equal(restored.queue.summary.retryableSources, 0);
  await restored.queue.reconnectSources([file('paused')]);
  assert.equal(restored.queue.summary.resumableSources, 1);
});

test('invalid snapshots are rejected atomically without overwriting saved data', () => {
  const original = fixture().queue;
  original.add([file('one'), file('two')]);
  const snapshot = original.snapshot();
  for (const corrupt of [
    value => { value.version = 2; },
    value => { value.items[1].size = -1; },
    value => { value.items[1].id = '1'; },
    value => { value.items[1].confirmedBytes = 11; },
    value => { value.items[1].sessionUrl = 'https://evil.example/?upload_id=private'; },
    value => { value.items[1].status = 'completed'; },
    value => { value.folderId = 'folder'; },
    value => { delete value.items[1]; },
    value => {
      value.folderId = 'folder'; value.accountId = 'original';
      for (const item of value.items) {
        item.attempted = true; item.fingerprint = 'a'.repeat(64); item.driveFileId = 'shared-id';
      }
    },
  ]) {
    const broken = structuredClone(snapshot);
    corrupt(broken);
    const { queue } = fixture();
    assert.throws(() => queue.restore(broken), /Saved queue is invalid/);
    assert.equal(queue.summary.total, 0);
  }
});

test('storage failure pauses the batch and blocks requests until a successful explicit save', async () => {
  let broken = true;
  let requests = 0;
  const queue = new UploadQueue({ getToken: () => 'token', getAccountId: () => 'account',
    saveSnapshot: async () => { if (broken) throw new Error('Quota exceeded'); },
    uploadOptions: { fetchImpl: async () => { requests++; throw new Error('Unexpected request'); } } });
  queue.add([file('source')]);
  queue.start('folder');
  await waitFor(() => queue.storageError && !queue.active.size);
  assert.equal(requests, 0);
  assert.throws(() => queue.start(), /could not be saved/);
  broken = false;
  await queue.retryStorage();
  assert.equal(queue.storageError, null);
  assert.equal(queue.enabled, false);
});

test('a checkpoint at save-loop completion still waits for its own revision', async () => {
  const snapshots = [];
  const { queue } = fixture({ saveSnapshot: async snapshot => { snapshots.push(structuredClone(snapshot)); } });
  queue.add([file('first')]);
  let second;
  const first = queue.persist();
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
    queue.items.get('1').fingerprint = 'b'.repeat(64);
    second = queue.persist();
  })));
  await first;
  await second;
  assert.equal(queue.savedRevision, queue.revision);
  assert.equal(snapshots.at(-1).items[0].fingerprint, 'b'.repeat(64));
});

test('saved destination rejects a different account before any upload starts', async () => {
  const original = fixture().queue;
  original.add([file('source')]);
  const saved = original.snapshot();
  saved.folderId = 'folder'; saved.accountId = 'original';
  const { queue, workers } = fixture({ saveSnapshot: async () => {}, getAccountId: () => 'different' });
  queue.restore(saved);
  await queue.reconnectSources([file('source')]);
  assert.throws(() => queue.start(), /original Google account/);
  assert.equal(workers.length, 0);
});

test('real protocol recovery after lost completion reuses the saved ID and only probes', async () => {
  let saved;
  const reply = (status, body = null, headers = {}) => new Response(body && JSON.stringify(body), { status, headers });
  const first = new UploadQueue({ getToken: () => 'token', getAccountId: () => 'account',
    saveSnapshot: async snapshot => { saved = structuredClone(snapshot); },
    uploadOptions: { maxRetries: 0, fetchImpl: async (url, request) => {
      if (url.includes('generateIds')) return reply(200, { ids: ['stable'] });
      if (request.method === 'POST') {
        assert.equal(saved.items[0].driveFileId, 'stable');
        return reply(200, null, { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=stable' });
      }
      assert.ok(saved.items[0].sessionUrl);
      throw new TypeError('Lost completion response');
    } } });
  first.add([file('source')]); first.start('folder');
  await waitFor(() => first.summary.counts.failed === 1 && !first.active.size);
  await first.persist();
  const requests = [];
  const restored = new UploadQueue({ getToken: () => 'new-token', getAccountId: () => 'account',
    saveSnapshot: async () => {}, uploadOptions: { fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      return reply(200, { id: 'stable', size: '10', parents: ['folder'] });
    } } });
  restored.restore(saved);
  await restored.reconnectSources([file('source')]);
  restored.retryFailed();
  await waitFor(() => restored.summary.counts.completed === 1 && !restored.active.size);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['Content-Range'], 'bytes */10');
  assert.equal(requests[0].body.size, 0);
});

test('local removal before upload updates totals and allows reselection', async () => {
  const { queue, workers } = fixture({ concurrency: 1 });
  queue.add([file('one'), file('two')]);
  assert.equal(queue.remove('1'), true);
  assert.equal(queue.summary.totalBytes, 10);
  queue.add([file('one')]);
  queue.start('folder');
  await tick();
  assert.equal(workers[0].file.name, 'two');
  assert.equal(queue.remove('2'), false);
  workers[0].settle('completed');
  await tick();
  assert.equal(workers[1].file.name, 'one');
  workers[1].settle('completed');
  await tick();
  assert.equal(queue.summary.total, 2);
});

test('bounded FIFO concurrency drains a batch and keeps completed records inert', async () => {
  const { queue, workers } = fixture();
  queue.add([file('a'), file('b'), file('c'), file('d')]);
  queue.start('folder');
  queue.start('folder');
  await tick();
  assert.equal(workers.length, 2);
  assert.equal(queue.summary.active, 2);
  workers[0].progress(4);
  assert.equal(queue.summary.confirmedBytes, 4);
  workers[0].settle('completed');
  await tick();
  assert.equal(workers.length, 3);
  assert.equal(queue.summary.active, 2);
  assert.equal(queue.items.get('1').file, null, 'release completed source reference');
  assert.equal(queue.items.get('1').driveFileId, 'drive-0');
  workers[1].settle('completed');
  workers[2].settle('completed');
  await tick();
  workers[3].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 4);
  assert.equal(queue.summary.confirmedBytes, 40);
  assert.equal(queue.summary.remaining, 0);
  assert.equal(queue.summary.enabled, false);
  queue.start();
  queue.retryFailed();
  await tick();
  assert.equal(workers.length, 4);
  assert.equal(queue.add([file('a')]).duplicates, 1);
});

test('pause stops dispatch and immediate resume waits for aborted workers to settle', async () => {
  const { queue, workers } = fixture({ concurrency: 1 });
  queue.add([file('a'), file('b')]);
  queue.start('folder');
  await tick();
  workers[0].progress(4);
  queue.pause();
  assert.equal(queue.summary.counts.paused, 2);
  queue.start();
  queue.start();
  await tick();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].starts, 1);
  workers[0].settle();
  await tick();
  assert.equal(queue.summary.active, 1);
  // Already queued work may run first, but the aborted item cannot be lost.
  workers[1].settle('completed');
  await tick();
  assert.equal(workers[0].starts, 2);
  assert.equal(workers[0].confirmedBytes, 4);
  workers[0].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 2);
});

test('pause before dispatch is inert until explicit resume', async () => {
  const { queue, workers } = fixture();
  queue.add([file('a')]);
  queue.start('folder');
  queue.pause();
  await tick();
  assert.equal(workers.length, 0);
  queue.start();
  await tick();
  workers[0].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 1);
});

test('permanent failure does not block other files; Retry Failed preserves worker and completed identities', async () => {
  const { queue, workers } = fixture();
  queue.add([file('a'), file('b'), file('c')]);
  queue.start('folder');
  await tick();
  workers[0].progress(3);
  workers[0].settle('failed', new UploadError('Permission denied', { status: 403 }));
  workers[1].settle('completed');
  await tick();
  workers[2].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.failed, 1);
  assert.equal(queue.summary.confirmedBytes, 23);
  const id = queue.items.get('1').driveFileId;
  queue.start(); // Upload All/Resume is not Retry Failed.
  await tick();
  assert.equal(workers[0].starts, 1);
  queue.retryFailed();
  queue.retryFailed();
  await tick();
  assert.equal(workers[0].starts, 2);
  assert.equal(workers[1].starts, 1);
  assert.equal(queue.items.get('1').driveFileId, id);
  workers[0].settle('completed');
  await tick();
  assert.equal(queue.summary.confirmedBytes, 30);
});

test('authorization failure stops the whole batch; reconnect resumes only auth failures and paused work', async () => {
  let token = 'token';
  const { queue, workers } = fixture({ getToken: () => token });
  queue.add([file('a'), file('b'), file('c')]);
  queue.start('folder');
  await tick();
  token = '';
  workers[0].settle('failed', new UploadError('Expired', { auth: true }));
  await tick();
  assert.equal(queue.authRequired, true);
  assert.equal(queue.enabled, false);
  assert.equal(workers[1].state, 'paused');
  assert.equal(queue.items.get('3').status, 'paused');
  assert.throws(() => queue.start(), /Reconnect/);
  workers[1].settle();
  await tick();
  assert.equal(workers.length, 2);
  token = 'new-token';
  queue.start();
  await tick();
  assert.equal(queue.authRequired, false);
  assert.equal(queue.summary.active, 2);
  for (const worker of workers.filter((worker) => worker.running)) worker.settle('completed');
  await tick();
  for (const worker of workers.filter((worker) => worker.running)) worker.settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 3);
});

test('aggregate counters reflect confirmed-offset rollback and retries without inventing progress', async () => {
  const { queue, workers } = fixture();
  queue.add([file('a'), file('b')]);
  queue.start('folder');
  await tick();
  workers[0].progress(5);
  workers[1].progress(3);
  assert.equal(queue.summary.confirmedBytes, 8);
  workers[0].change('retrying');
  assert.equal(queue.summary.counts.retrying, 1);
  workers[0].progress(0); // Session expired; same reserved identity starts a new session.
  assert.equal(queue.summary.confirmedBytes, 3);
  workers.forEach((worker) => worker.settle('completed'));
  await tick();
  assert.equal(queue.summary.confirmedBytes, 20);
  assert.equal(Object.values(queue.summary.counts).reduce((a, b) => a + b), 2);
});

test('destination stays pinned and queue configuration is validated', async () => {
  assert.throws(() => fixture({ concurrency: 0 }), /configuration/);
  assert.throws(() => fixture({ chunkSize: UNIT + 1 }), /configuration/);
  const { queue, workers } = fixture({ chunkSize: UNIT });
  queue.add([file('a')]);
  assert.throws(() => queue.start(), /destination/);
  queue.start('folder');
  assert.throws(() => queue.start('different-folder'), /same destination/);
  await tick();
  assert.equal(workers[0].folderId, 'folder');
  assert.equal(workers[0].chunkSize, UNIT);
  workers[0].settle('completed');
  await tick();
});

test('adding files during a running batch joins its fixed destination', async () => {
  const { queue, workers } = fixture({ concurrency: 1 });
  queue.add([file('a')]);
  queue.start('folder');
  await tick();
  queue.add([file('b')]);
  await tick();
  assert.equal(workers.length, 1);
  workers[0].settle('completed');
  await tick();
  assert.equal(workers[1].folderId, 'folder');
  workers[1].settle('completed');
  await tick();
});

test('construction and unexpected worker failures free slots without dropping the queue', async () => {
  let calls = 0;
  const queue = new UploadQueue({ getToken: () => 'token', concurrency: 1, createUpload: () => {
    if (++calls === 1) throw new Error('Could not read source');
    return { start() { throw new Error('Unexpected error'); } };
  } });
  queue.add([file('a'), file('b')]);
  queue.start('folder');
  await tick();
  assert.equal(queue.summary.counts.failed, 2);
  assert.equal(queue.summary.active, 0);
  assert.equal(queue.summary.enabled, false);
});

test('real DriveUpload integration: ambiguous chunk probes, bounded retries, and Retry Failed reuse IDs', async () => {
  const requests = [];
  let ids = 0;
  let fail = true;
  const uploaded = new Map();
  const response = (status, data = null, headers = {}) => new Response(data && JSON.stringify(data), { status, headers });
  const queue = new UploadQueue({ getToken: () => 'token', concurrency: 2, chunkSize: UNIT,
    uploadOptions: { retryBaseMs: 0, maxRetries: 0, fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      if (url.includes('generateIds')) return response(200, { ids: [`reserved-${++ids}`] });
      if (request.method === 'POST') {
        const { id } = JSON.parse(request.body);
        return response(200, null, { Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}` });
      }
      const id = new URL(url).searchParams.get('upload_id');
      const range = request.headers['Content-Range'];
      if (id === 'reserved-1' && fail) {
        fail = false;
        uploaded.set(id, UNIT);
        throw new TypeError('Response lost');
      }
      if (range.startsWith('bytes */')) return response(308, null, { Range: `bytes=0-${uploaded.get(id) - 1}` });
      if (range.startsWith('bytes 0-')) return response(308, null, { Range: `bytes=0-${UNIT - 1}` });
      return response(200, { id, size: String(UNIT + 1), parents: ['folder'] });
    } } });
  queue.add([file('a', UNIT + 1), file('b', UNIT + 1)]);
  queue.start('folder');
  await tick();
  assert.equal(queue.summary.counts.failed, 1);
  assert.equal(queue.summary.counts.completed, 1);
  queue.retryFailed();
  await tick();
  assert.equal(queue.summary.counts.completed, 2);
  assert.equal(ids, 2, 'no fresh destination identity on retry');
  const resumed = requests.filter((request) => request.url.endsWith('upload_id=reserved-1'));
  assert.deepEqual(resumed.map((request) => request.headers['Content-Range']),
    [`bytes 0-${UNIT - 1}/${UNIT + 1}`, `bytes */${UNIT + 1}`, `bytes ${UNIT}-${UNIT}/${UNIT + 1}`]);
  assert.equal(resumed[1].body.size, 0);
  assert.equal(queue.summary.confirmedBytes, 2 * (UNIT + 1));
});

test('Retry Failed during a terminal callback is retained until the worker settles', async () => {
  let retry = false;
  const { queue, workers } = fixture({ onChange: (current) => {
    if (retry && current.summary.counts.failed) { retry = false; current.retryFailed(); }
  } });
  queue.add([file('a')]);
  queue.start('folder');
  await tick();
  retry = true;
  workers[0].settle('failed', new UploadError('Failed'));
  await tick();
  assert.equal(workers[0].starts, 2);
  workers[0].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 1);
});

test('removing pending work mid-batch never dispatches it and counts remain consistent', async () => {
  const { queue, workers } = fixture({ concurrency: 1 });
  queue.add([file('a'), file('b'), file('c')]);
  queue.start('folder');
  await tick();
  assert.equal(queue.summary.unstarted, 2);
  queue.remove('2');
  assert.equal(queue.summary.unstarted, 1);
  workers[0].settle('completed');
  await tick();
  assert.equal(workers[1].file.name, 'c');
  assert.equal(queue.summary.unstarted, 0);
  workers[1].settle('completed');
  await tick();
  assert.equal(queue.summary.counts.completed, 2);
  assert.equal(queue.pendingIds.size, 0);
});