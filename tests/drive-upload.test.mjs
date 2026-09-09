import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveUpload } from '../phase1/drive-upload.mjs';

const UNIT = 256 * 1024;
const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test';
const reply = (status, data = null, headers = {}) => new Response(data === null ? null : JSON.stringify(data), { status, headers });
const metadata = size => ({ id: 'reserved', size: String(size), parents: ['folder'] });
const init = () => [reply(200, { ids: ['reserved'] }), reply(200, null, { Location: session })];
function fixture(size, sequence, options = {}) {
  const calls = [];
  const file = new Blob([new Uint8Array(size)], { type: 'video/mp4' });
  file.name = 'sample.mp4';
  const upload = new DriveUpload({ file, folderId: 'folder', getToken: () => 'token',
    chunkSize: UNIT, retryBaseMs: 0, ...options,
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, 'Bearer token');
      assert.ok(sequence.length, `Unexpected request ${url}`);
      const response = sequence.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(request) : response;
    },
  });
  return { upload, calls };
}

test('uploads bounded aligned chunks, counts confirmed bytes, completed start is inert', async () => {
  const seen = [];
  const { upload, calls } = fixture(UNIT + 7, [...init(), reply(308, null, { Range: `bytes=0-${UNIT - 1}` }), reply(200, metadata(UNIT + 7))],
    { onChange: current => seen.push(current.confirmedBytes) });
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(calls[2].headers['Content-Range'], `bytes 0-${UNIT - 1}/${UNIT + 7}`);
  assert.equal(calls[2].body.size, UNIT);
  assert.equal(calls[3].headers['Content-Range'], `bytes ${UNIT}-${UNIT + 6}/${UNIT + 7}`);
  assert.deepEqual([...new Set(seen)], [0, UNIT, UNIT + 7]);
  await upload.start();
  assert.equal(calls.length, 4);
});

test('lost final response probes completion without sending media again', async () => {
  const { upload, calls } = fixture(10, [...init(), new TypeError('offline'), reply(200, metadata(10))]);
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(calls[3].headers['Content-Range'], 'bytes */10');
  assert.equal(calls[3].body.size, 0);
});

test('pause aborts active request, resume probes server offset', async () => {
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const { upload, calls } = fixture(UNIT + 10, [...init(), request => new Promise((resolve, reject) => {
    entered(); request.signal.addEventListener('abort', () => reject(request.signal.reason));
  }), reply(308, null, { Range: `bytes=0-${UNIT - 1}` }), reply(200, metadata(UNIT + 10))]);
  const running = upload.start();
  await pending;
  upload.pause();
  await running;
  assert.equal(upload.state, 'paused');
  assert.equal(upload.confirmedBytes, 0);
  assert.equal(upload.running, false);
  await upload.start();
  assert.equal(calls[3].headers['Content-Range'], `bytes */${UNIT + 10}`);
  assert.equal(calls[4].headers['Content-Range'], `bytes ${UNIT}-${UNIT + 9}/${UNIT + 10}`);
  assert.equal(upload.state, 'completed');
});

test('expired session reconciles absence and reuses the same generated identity', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(404), reply(404), reply(200, null, { Location: session }), reply(201, metadata(10))]);
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(JSON.parse(calls[1].body).id, JSON.parse(calls[4].body).id);
  assert.equal(calls.filter(call => call.url.includes('generateIds')).length, 1);
});

test('expired completed session is recovered by metadata without creating another session', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(404), reply(200, { ...metadata(10), trashed: false })]);
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(calls.length, 4);
});

test('lost creation response retries the same ID and reconciles 409', async () => {
  const { upload, calls } = fixture(10, [reply(200, { ids: ['reserved'] }), new TypeError('offline'), reply(409), reply(200, metadata(10))]);
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(JSON.parse(calls[1].body).id, JSON.parse(calls[2].body).id);
});

test('metadata mismatch on conflict stops without overwrite', async () => {
  const { upload, calls } = fixture(10, [reply(200, { ids: ['reserved'] }), reply(409), reply(200, metadata(9))]);
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.match(upload.error.message, /does not match/);
  assert.equal(calls.length, 3);
});

test('401 requires authorization; retry with restored token probes the same session', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(401), reply(308), reply(200, metadata(10))]);
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.equal(upload.error.auth, true);
  await upload.start();
  assert.equal(upload.state, 'completed');
  assert.equal(calls[3].headers['Content-Range'], 'bytes */10');
});

test('permanent permission failure is not retried', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(403, { error: { errors: [{ reason: 'insufficientFilePermissions' }] } })]);
  await upload.start();
  assert.equal(upload.error.transient, false);
  assert.equal(calls.length, 3);
});

test('rate limits retry but repeated transient failures are bounded', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), reply(503), reply(429)], { maxRetries: 2 });
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.equal(calls.length, 5);
  assert.equal(calls[3].headers['Content-Range'], 'bytes */10');
});

test('repeated no-progress responses stop within retry bound', async () => {
  const { upload, calls } = fixture(10, [...init(), reply(308), reply(308), reply(308)], { maxRetries: 2 });
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.equal(calls.length, 5);
});

test('untrusted session URL never receives credentials or media', async () => {
  for (const url of ['https://evil.example/upload?upload_id=test', 'https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=x', 'http://www.googleapis.com/upload/drive/v3/files?upload_id=x']) {
    const { upload, calls } = fixture(10, [reply(200, { ids: ['reserved'] }), reply(200, null, { Location: url })]);
    await upload.start();
    assert.equal(upload.state, 'failed');
    assert.match(upload.error.message, /invalid upload session/);
    assert.equal(calls.length, 2);
  }
});

test('timeout aborts and exhausts retry allowance', async () => {
  const stall = request => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
  const { upload, calls } = fixture(10, [stall, stall], { requestTimeoutMs: 5, maxRetries: 1 });
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.equal(calls.length, 2);
});

test('invalid offsets fail and token-provider auth errors are preserved', async () => {
  const { upload } = fixture(10, [...init(), reply(308, null, { Range: 'bytes=0-100' })]);
  await upload.start();
  assert.equal(upload.state, 'failed');
  assert.equal(upload.confirmedBytes, 0);
  const authError = Object.assign(new Error('Sign in'), { auth: true });
  const second = fixture(10, [], { getToken: () => { throw authError; } }).upload;
  await second.start();
  assert.equal(second.error, authError);
});
