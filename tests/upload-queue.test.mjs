import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UploadQueue, selectionKey } from '../phase2/upload-queue.mjs';
import { UploadError } from '../phase1/drive-upload.mjs';

const UNIT = 256 * 1024;
const tick = () => new Promise(setImmediate);
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