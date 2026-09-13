import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardController } from '../phase4/controller.ts';
import type {
  DashboardAccount, DashboardAuth, DashboardControllerOptions, DashboardFolders,
  DashboardLockManager, DashboardQueue, DashboardQueueOptions, DashboardSnapshot,
  DashboardStatus, DashboardStore, DashboardWakeSentinel,
} from '../phase4/controller.ts';
import { UploadQueue, sourceFingerprint } from '../phase2/upload-queue.mjs';
import { GoogleAuth, DRIVE_SCOPE } from '../phase1/google.mjs';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function waitFor(predicate: () => boolean, subscribe: (check: () => void) => () => void): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Expected state was not reached.')); }, 5000);
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribe(check);
    check();
  });
}

const file = (name = 'clip.mp4', contents = '0123456789') => new File([contents], name, { type: 'video/mp4', lastModified: 1 });

class TestAuth implements DashboardAuth {
  user: DashboardAccount | null = null;
  nextAccount = 'original';
  token = '';
  connections = 0;
  connectGate?: Promise<void>;
  async connect() {
    this.connections++;
    this.token = '';
    if (this.connectGate) await this.connectGate;
    this.user = { permissionId: this.nextAccount, emailAddress: `${this.nextAccount}@example.test` };
    this.token = 'memory-only-token';
    return this.user;
  }
  invalidate() { this.token = ''; }
  resetAccount() { this.invalidate(); this.user = null; }
  getToken() {
    if (!this.token) throw Object.assign(new Error('Reconnect Google.'), { auth: true });
    return this.token;
  }
}

class TestStore implements DashboardStore {
  saved: unknown = null;
  saves: unknown[] = [];
  opened = 0;
  loaded = 0;
  closed = false;
  failLoad = false;
  failSave = false;
  openGate?: Promise<void>;
  loadGate?: Promise<void>;
  saveGate?: Promise<void>;
  readonly loadStarted = deferred();
  async open() { this.opened++; this.closed = false; await this.openGate; }
  async load() {
    this.loaded++;
    this.loadStarted.resolve();
    await this.loadGate;
    if (this.failLoad) throw new Error('Storage unavailable.');
    return structuredClone(this.saved);
  }
  async save(snapshot: unknown) {
    await this.saveGate;
    if (this.failSave) throw new Error('Quota exceeded.');
    assert.equal(this.closed, false, 'no write after storage closes');
    this.saved = structuredClone(snapshot);
    this.saves.push(this.saved);
  }
  close() { this.closed = true; }
}

class TestLocks implements DashboardLockManager {
  held = false;
  requests = 0;
  async request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>) {
    assert.equal(name, 'batchharbor-queue-writer');
    assert.deepEqual(options, { ifAvailable: true });
    this.requests++;
    if (this.held) return callback(null);
    this.held = true;
    try { await callback({}); }
    finally { this.held = false; }
  }
}

class TestDocument extends EventTarget {
  visibilityState = 'visible';
  visibility(value: string) {
    this.visibilityState = value;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class TestWindow extends EventTarget { isSecureContext = true; }

class TestSentinel extends EventTarget implements DashboardWakeSentinel {
  released = false;
  releases = 0;
  releaseGate?: Promise<void>;
  releaseError?: Error;
  async release() {
    this.releases++;
    if (this.releaseError) throw this.releaseError;
    await this.releaseGate;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

interface WorkerOptions {
  file: File;
  recovery: { fileId: string | null; sessionUrl: string | null; confirmedBytes: number };
  onChange(worker: Worker): void;
}
class Worker {
  state: DashboardStatus = 'queued';
  fileId: string;
  sessionUrl: string | null;
  confirmedBytes: number;
  error: (Error & { auth?: boolean }) | null = null;
  starts = 0;
  running = false;
  finish = () => {};
  constructor(readonly options: WorkerOptions, id: string, readonly delayedPause: boolean) {
    this.fileId = options.recovery.fileId || id;
    this.sessionUrl = options.recovery.sessionUrl;
    this.confirmedBytes = options.recovery.confirmedBytes;
  }
  change(state: DashboardStatus) { this.state = state; this.options.onChange(this); }
  start() {
    assert.equal(this.running, false);
    this.starts++;
    this.running = true;
    this.error = null;
    const done = new Promise<void>(resolve => { this.finish = resolve; });
    this.change('uploading');
    return done;
  }
  pause() { this.change('paused'); if (!this.delayedPause) this.settle(); }
  settle(state = this.state, error: Worker['error'] = null) {
    this.error = error;
    if (state === 'completed') this.confirmedBytes = this.options.file.size;
    this.running = false;
    this.change(state);
    this.finish();
  }
}

interface TestQueue extends DashboardQueue { notify(): void; snapshot(): unknown }
function fixture(options: DashboardControllerOptions & { delayedPause?: boolean } = {}) {
  const auth = options.auth as TestAuth | undefined ?? new TestAuth();
  const store = options.store as TestStore | undefined ?? new TestStore();
  const locks = options.lockManager as TestLocks | undefined ?? new TestLocks();
  const document = new TestDocument();
  const window = new TestWindow();
  const navigator = { onLine: true, storage: { persist: async () => true }, ...options.navigator };
  const workers: Worker[] = [];
  const waiters = new Set<() => void>();
  let queue!: TestQueue;
  let queueCreations = 0;
  const folders: DashboardFolders = { list: async () => [{ id: 'folder', name: 'Test folder' }],
    create: async name => ({ id: 'new-folder', name: name.trim() }) };
  const controller = new DashboardController({ ...options, auth, store, lockManager: locks,
    folders: options.folders ?? folders, document, window, navigator,
    queueFactory(config) {
      queueCreations++;
      queue = new (UploadQueue as unknown as new (options: DashboardQueueOptions & {
        createUpload(options: WorkerOptions): Worker;
      }) => TestQueue)({ ...config, onChange() {
        config.onChange();
        for (const check of waiters) check();
      }, createUpload(config) {
        const worker = new Worker(config, `drive-${workers.length}`, options.delayedPause ?? false);
        workers.push(worker);
        return worker;
      } });
      return queue;
    },
  });
  return {
    controller, queue, auth, store, locks, document, window, navigator, workers,
    queueCreations: () => queueCreations,
    wait: (predicate: () => boolean) => waitFor(predicate, check => { waiters.add(check); return () => { waiters.delete(check); }; }),
    snapshot: () => controller.getSnapshot(),
    waitSnapshot: (predicate: (snapshot: DashboardSnapshot) => boolean) => waitFor(() => predicate(controller.getSnapshot()), controller.subscribe),
    async setup(files = [file()]) {
      await controller.initialize();
      controller.select(files);
      await controller.connect();
      controller.chooseFolder('folder');
    },
  };
}

async function restoredSnapshot() {
  return { version: 1, accountId: 'original', folderId: 'saved-folder', items: [
    { id: '1', name: 'clip.mp4', size: 10, type: 'video/mp4', lastModified: 1, status: 'uploading',
      attempted: true, confirmedBytes: 4, driveFileId: 'reserved-id', sessionUrl: null,
      fingerprint: await sourceFingerprint(file()), error: null },
    { id: '2', name: 'done.mp4', size: 10, type: 'video/mp4', lastModified: 1, status: 'completed',
      attempted: true, confirmedBytes: 10, driveFileId: 'completed-id', sessionUrl: null,
      fingerprint: await sourceFingerprint(file('done.mp4')), error: null },
  ] };
}

test('initialization is idempotent, snapshots are cached, progress coalesces without item copies', async () => {
  const harness = fixture();
  const { controller, queue } = harness;
  const before = controller.getSnapshot();
  assert.equal(before.ready, false);
  assert.equal(controller.getSnapshot(), before);
  const initializing = controller.initialize();
  assert.equal(controller.initialize(), initializing);
  await initializing;
  assert.equal(harness.queueCreations(), 1);
  assert.equal(harness.locks.requests, 1);
  controller.select([file(), file(), file('empty', '')]);
  assert.equal(harness.snapshot().summary.total, 1);
  assert.match(harness.snapshot().selectionMessage, /1 added; 1 matching.*1 empty/);
  await queue.persist();
  await harness.waitSnapshot(snapshot => !snapshot.summary.saving);
  let emissions = 0;
  const unsubscribe = controller.subscribe(() => { emissions++; });
  const stable = harness.snapshot();
  const items = queue.items as Map<string, unknown>;
  const values = items.values;
  let copies = 0;
  items.values = function () { copies++; return values.call(this); };
  queue.saveSnapshot = null;
  for (let notification = 0; notification < 100; notification++) queue.notify();
  assert.equal(harness.snapshot(), stable);
  await harness.waitSnapshot(snapshot => snapshot !== stable);
  assert.equal(emissions, 1);
  assert.equal(copies, 0);
  const details = controller.getItems();
  assert.equal(copies, 1);
  assert.deepEqual(details[0], { id: '1', name: 'clip.mp4', size: 10, status: 'queued', confirmedBytes: 0,
    driveFileId: null, attempted: false, hasSource: true, error: null });
  assert.equal('file' in details[0], false);
  unsubscribe();
  controller.remove('1');
  assert.equal(harness.snapshot().summary.total, 0);
  await controller.dispose();
});

test('startup deadlines identify stalled stages and ignore late successful responses', async () => {
  for (const stage of ['lock', 'open', 'load'] as const) {
    const gate = deferred();
    const store = new TestStore();
    store.saved = await restoredSnapshot();
    if (stage === 'open') store.openGate = gate.promise;
    if (stage === 'load') store.loadGate = gate.promise;
    const locks = new TestLocks();
    const lockManager = stage === 'lock' ? {
      request: async (...args: Parameters<TestLocks['request']>) => {
        await gate.promise;
        return locks.request(...args);
      },
    } : locks;
    const harness = fixture({ store, lockManager, startupTimeoutMs: 20 });
    await harness.controller.initialize();
    const expected = { lock: 'acquiring the batch tab lock', open: 'opening browser queue storage', load: 'reading the saved batch' };
    assert.match(harness.snapshot().startupError, new RegExp(expected[stage]));
    assert.equal(harness.snapshot().ready, false);
    harness.controller.select([file()]);
    harness.controller.start();
    assert.equal(harness.workers.length, 0);
    assert.equal(store.saves.length, 0);
    const error = harness.snapshot().startupError;
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.snapshot().startupError, error);
    assert.equal(harness.snapshot().summary.total, 0);
    assert.equal(harness.queue.saveSnapshot, null);
    assert.equal(store.closed, true);
    assert.equal(locks.held, false);
    assert.equal(store.saves.length, 0);
    assert.deepEqual(store.saved, await restoredSnapshot());
    await harness.controller.dispose();
  }
});

test('reset requires confirmation and idle ownership; a committed empty batch unlocks destination and account', async () => {
  const store = new TestStore();
  store.saved = await restoredSnapshot();
  const harness = fixture({ store });
  assert.equal(await harness.controller.startNewBatch(true), false);
  await harness.controller.initialize();
  assert.equal(await harness.controller.startNewBatch(false), false);
  assert.equal(store.saves.length, 0);
  await harness.controller.connect();
  assert.equal(await harness.controller.startNewBatch(true), true);
  assert.deepEqual(store.saved, { version: 1, accountId: null, folderId: null, items: [] });
  assert.equal(harness.snapshot().summary.total, 0);
  assert.equal(harness.snapshot().destinationLocked, false);
  assert.equal(harness.snapshot().folderId, '');
  assert.equal(harness.snapshot().connected, false);
  assert.equal(harness.auth.token, '');
  assert.equal(harness.queue.saveSnapshot, null);
  assert.equal(harness.locks.held, true);
  assert.equal(harness.workers.length, 0, 'reset makes no Drive requests');
  harness.auth.nextAccount = 'another-account';
  await harness.controller.connect();
  harness.controller.chooseFolder('folder');
  harness.controller.select([file()]);
  harness.controller.start();
  await harness.wait(() => harness.workers.some(worker => worker.running));
  assert.equal(await harness.controller.startNewBatch(true), false);
  assert.match(harness.snapshot().actionMessage, /Pause uploads/);
  harness.workers[0].settle('completed');
  await harness.wait(() => harness.snapshot().summary.total === 1 && !harness.workers[0].running);
  await harness.controller.dispose();
});

test('reset preserves the old queue on save failure and drains a previous save before replacing it', async () => {
  const harness = fixture();
  await harness.setup();
  await harness.queue.persist();
  const saved = structuredClone(harness.store.saved);
  harness.store.failSave = true;
  assert.equal(await harness.controller.startNewBatch(true), false);
  assert.deepEqual(harness.store.saved, saved);
  assert.equal(harness.snapshot().summary.total, 1);
  assert.match(harness.snapshot().actionMessage, /Quota exceeded/);
  assert.notEqual(harness.queue.saveSnapshot, null);
  harness.store.failSave = false;
  const gate = deferred();
  harness.store.saveGate = gate.promise;
  harness.controller.select([file('second.mp4')]);
  const saving = harness.queue.saving;
  const resetting = harness.controller.startNewBatch(true);
  harness.controller.select([file('blocked.mp4')]);
  harness.controller.pause();
  assert.equal(harness.snapshot().summary.total, 2);
  assert.equal(harness.snapshot().busy, true);
  assert.deepEqual(harness.store.saved, saved);
  gate.resolve();
  await saving;
  assert.equal(await resetting, true);
  assert.deepEqual(harness.store.saved, { version: 1, accountId: null, folderId: null, items: [] });
  assert.equal(harness.snapshot().summary.total, 0);
  await harness.controller.dispose();
});

test('committed reset permits another account using the real GoogleAuth identity checks', async () => {
  let account = 'original';
  let respond!: () => Promise<void>;
  const auth = new GoogleAuth({
    googleProvider: () => ({ accounts: { oauth2: {
      initTokenClient(config: { callback(result: unknown): Promise<void> }) {
        respond = () => config.callback({ access_token: 'test-token', expires_in: 3600, scope: DRIVE_SCOPE });
        return { requestAccessToken() {} };
      },
      hasGrantedAllScopes: () => true,
    } } }),
    fetchImpl: async () => new Response(JSON.stringify({ user: { permissionId: account } })),
  });
  const harness = fixture({ auth });
  await harness.controller.initialize();
  let connection = harness.controller.connect();
  await respond(); await connection;
  harness.controller.select([file()]);
  account = 'different';
  connection = harness.controller.connect();
  await respond(); await connection;
  assert.equal(harness.snapshot().connected, false);
  assert.match(harness.snapshot().actionMessage, /original Google account/);
  assert.equal(await harness.controller.startNewBatch(true), true);
  assert.equal(auth.user, null);
  connection = harness.controller.connect();
  await respond(); await connection;
  assert.equal(harness.snapshot().connected, true);
  assert.deepEqual(auth.user, { permissionId: 'different', displayName: undefined, emailAddress: undefined });
  await harness.controller.dispose();
});

test('disposal during reset commit cannot persist the old queue after the empty snapshot', async () => {
  const harness = fixture();
  await harness.setup();
  await harness.queue.persist();
  const gate = deferred();
  const started = deferred();
  const save = harness.store.save.bind(harness.store);
  harness.store.save = async snapshot => { started.resolve(); await gate.promise; await save(snapshot); };
  const resetting = harness.controller.startNewBatch(true);
  await started.promise;
  const disposing = harness.controller.dispose();
  assert.equal(harness.locks.held, true);
  gate.resolve();
  assert.equal(await resetting, true);
  await disposing;
  assert.deepEqual(harness.store.saved, { version: 1, accountId: null, folderId: null, items: [] });
  assert.equal(harness.locks.held, false);
});

test('server authorization rejection invalidates a locally unexpired token exactly once', async () => {
  const harness = fixture();
  await harness.setup();
  harness.controller.start();
  await harness.wait(() => harness.workers.length === 1 && harness.workers[0].running);
  assert.equal(harness.auth.getToken(), 'memory-only-token');
  harness.workers[0].settle('failed', Object.assign(new Error('HTTP 401'), { auth: true }));
  await harness.waitSnapshot(snapshot => !snapshot.connected && snapshot.summary.active === 0);
  assert.equal(harness.auth.token, '');
  await harness.controller.connect();
  harness.queue.notify();
  assert.equal(harness.auth.getToken(), 'memory-only-token');
  harness.controller.start();
  await harness.wait(() => harness.workers[0].starts === 2);
  harness.workers[0].settle('failed', Object.assign(new Error('HTTP 401'), { auth: true }));
  await harness.waitSnapshot(snapshot => !snapshot.connected);
  assert.equal(harness.auth.token, '');
  await harness.controller.dispose();
});

test('restored records retain source, account, destination and completed-file gates', async () => {
  const store = new TestStore();
  store.saved = await restoredSnapshot();
  const harness = fixture({ store });
  const { controller, auth, queue, workers } = harness;
  await controller.initialize();
  assert.equal(store.saves.length, 0, 'restore must precede durable saves');
  assert.equal(harness.snapshot().folderId, 'saved-folder');
  assert.equal(harness.snapshot().folderName, 'Saved batch destination');
  assert.equal(harness.snapshot().summary.missingSources, 1);
  assert.equal(harness.snapshot().summary.confirmedBytes, 14);
  controller.select([file('new.mp4')]);
  assert.equal(queue.summary.total, 2);
  auth.nextAccount = 'wrong-account';
  await controller.connect();
  assert.equal(harness.snapshot().connected, false);
  assert.match(harness.snapshot().actionMessage, /original Google account/);
  assert.equal(auth.token, '');
  auth.nextAccount = 'original';
  await controller.connect();
  assert.equal(harness.snapshot().accountLabel, 'original@example.test');
  controller.start();
  assert.match(harness.snapshot().actionMessage, /source files/);
  assert.equal(workers.length, 0);
  await controller.reconnectSources([file('clip.mp4', 'abcdefghij'), file('done.mp4'), file('unrelated.mp4')]);
  assert.equal(harness.snapshot().summary.missingSources, 1);
  assert.match(harness.snapshot().selectionMessage, /1 changed or unreadable/);
  await controller.reconnectSources([file(), file()]);
  assert.match(harness.snapshot().selectionMessage, /2 ambiguous/);
  await controller.reconnectSources([file()]);
  assert.equal(harness.snapshot().summary.missingSources, 0);
  await controller.refreshFolders();
  assert.equal(harness.snapshot().folderId, 'saved-folder');
  controller.chooseFolder('folder');
  assert.match(harness.snapshot().actionMessage, /same destination/);
  controller.start();
  await harness.wait(() => workers.some(worker => worker.running));
  assert.equal(workers[0].fileId, 'reserved-id');
  assert.equal(workers[0].confirmedBytes, 4);
  controller.remove('1');
  assert.match(harness.snapshot().actionMessage, /Only unstarted/);
  workers[0].settle('failed', new Error('Permission denied.'));
  await harness.wait(() => queue.active.size === 0);
  assert.equal(controller.getItems()[0].error, 'Permission denied.');
  controller.retryFailed();
  await harness.wait(() => workers[0].running);
  workers[0].settle('completed');
  await harness.wait(() => queue.active.size === 0);
  controller.retryFailed();
  assert.equal(queue.summary.counts.completed, 2);
  assert.equal(workers.length, 1);
  assert.equal(controller.getItems()[0].hasSource, false);
  await controller.dispose();
  const saved = JSON.stringify(store.saved);
  assert.equal(saved.includes('memory-only-token'), false);
  assert.equal(saved.includes('"file":'), false);
});

test('startup lock and invalid/load failures never enable actions or overwrite records', async () => {
  for (const mode of ['invalid', 'load', 'missing-lock'] as const) {
    const store = new TestStore();
    store.saved = mode === 'invalid' ? { version: 99, items: [] } : await restoredSnapshot();
    store.failLoad = mode === 'load';
    const original = structuredClone(store.saved);
    const locks = mode === 'missing-lock' ? {} as DashboardLockManager : new TestLocks();
    const harness = fixture({ store, lockManager: locks });
    await harness.controller.initialize();
    assert.equal(harness.snapshot().ready, false);
    assert.match(harness.snapshot().startupError, /Saved data has not been replaced/);
    harness.controller.select([file()]);
    harness.controller.pause();
    await harness.controller.connect();
    await harness.controller.retryStorage();
    assert.equal(harness.auth.connections, 0);
    await harness.controller.dispose();
    assert.deepEqual(store.saved, original);
    assert.equal(store.saves.length, 0);
  }
});

test('shared writer lock excludes other dashboards and the existing phase2 lock name', async () => {
  const locks = new TestLocks();
  const first = fixture({ lockManager: locks });
  await first.controller.initialize();
  const second = fixture({ lockManager: locks });
  await second.controller.initialize();
  assert.match(second.snapshot().startupError, /another tab/);
  assert.equal(second.store.opened, 0);
  let phase2Lock: object | null = {};
  await locks.request('batchharbor-queue-writer', { ifAvailable: true }, async lock => { phase2Lock = lock; });
  assert.equal(phase2Lock, null);
  first.window.dispatchEvent(new Event('pagehide'));
  assert.equal(locks.held, true);
  await second.controller.dispose();
  await first.controller.dispose();
  assert.equal(locks.held, false);
  const third = fixture({ lockManager: locks });
  await third.controller.initialize();
  assert.equal(third.snapshot().ready, true);
  await third.controller.dispose();
});

test('save failure pauses and blocks mutation; explicit save retry exposes failure then recovers', async () => {
  const harness = fixture();
  await harness.setup();
  await harness.queue.persist();
  harness.store.failSave = true;
  harness.controller.select([file('second.mp4')]);
  await harness.waitSnapshot(snapshot => Boolean(snapshot.summary.storageError));
  assert.match(harness.snapshot().storageMessage, /could not be saved/);
  harness.controller.select([file('third.mp4')]);
  assert.equal(harness.queue.summary.total, 2);
  harness.controller.start();
  assert.equal(harness.workers.length, 0);
  await harness.controller.retryStorage();
  assert.match(harness.snapshot().actionMessage, /could not be saved/);
  harness.store.failSave = false;
  await harness.controller.retryStorage();
  assert.equal(harness.snapshot().summary.storageError, null);
  assert.ok(harness.store.opened >= 3);
  assert.equal(harness.queue.summary.enabled, false, 'storage recovery does not auto-resume');
  await harness.controller.dispose();
});

test('connect starts synchronously and queue authRequired cannot invalidate fresh authorization before Resume', async () => {
  const harness = fixture();
  const { controller, auth, queue, workers } = harness;
  await controller.initialize();
  controller.select([file()]);
  const connecting = controller.connect();
  assert.equal(auth.connections, 1, 'OAuth invoked in the click call stack');
  await connecting;
  controller.chooseFolder('folder');
  controller.start();
  await harness.wait(() => workers.some(worker => worker.running));
  auth.invalidate();
  workers[0].settle('failed', Object.assign(new Error('Expired.'), { auth: true }));
  await harness.wait(() => queue.active.size === 0 && !queue.saving);
  await harness.waitSnapshot(snapshot => !snapshot.connected);
  await controller.connect();
  assert.equal(queue.summary.authRequired, true);
  queue.notify();
  await queue.persist();
  await harness.waitSnapshot(snapshot => snapshot.connected && !snapshot.summary.saving);
  assert.equal(auth.getToken(), 'memory-only-token');
  controller.start();
  await harness.wait(() => workers[0].running);
  assert.equal(queue.summary.authRequired, false);
  assert.equal(workers[0].fileId, 'drive-0');
  await controller.dispose();
});

test('pagehide pauses, network updates, and dispose holds the lock through worker and save settlement', async () => {
  const harness = fixture({ delayedPause: true });
  await harness.setup();
  harness.controller.start();
  await harness.wait(() => harness.workers.some(worker => worker.running));
  harness.navigator.onLine = false;
  harness.window.dispatchEvent(new Event('offline'));
  assert.equal(harness.snapshot().online, false);
  harness.window.dispatchEvent(new Event('pagehide'));
  assert.equal(harness.queue.summary.enabled, false);
  assert.equal(harness.queue.active.size, 1);
  assert.equal(harness.workers[0].state, 'paused');
  const saveGate = deferred();
  harness.store.saveGate = saveGate.promise;
  const disposing = harness.controller.dispose();
  assert.equal(harness.controller.dispose(), disposing);
  assert.equal(harness.locks.held, true);
  assert.equal(harness.store.closed, false);
  harness.workers[0].settle();
  await harness.wait(() => harness.queue.active.size === 0);
  assert.equal(harness.locks.held, true);
  assert.equal(harness.store.closed, false);
  saveGate.resolve();
  await disposing;
  assert.equal(harness.locks.held, false);
  assert.equal(harness.store.closed, true);
  const final = harness.snapshot();
  harness.window.dispatchEvent(new Event('online'));
  assert.equal(harness.snapshot(), final, 'lifecycle listeners removed');
});

test('dispose during initialization never restores, installs saving or enables the stale controller', async () => {
  for (const stage of ['open', 'load'] as const) {
    const store = new TestStore();
    store.saved = await restoredSnapshot();
    const gate = deferred();
    if (stage === 'open') store.openGate = gate.promise;
    else store.loadGate = gate.promise;
    const harness = fixture({ store });
    const initializing = harness.controller.initialize();
    if (stage === 'load') await store.loadStarted.promise;
    const disposing = harness.controller.dispose();
    gate.resolve();
    await initializing;
    await disposing;
    assert.equal(harness.snapshot().ready, false);
    assert.equal(harness.queue.saveSnapshot, null);
    assert.equal(harness.queue.summary.total, 0);
    assert.equal(store.saves.length, 0);
    assert.equal(store.closed, true);
    assert.equal(harness.locks.held, false);
    await harness.controller.initialize();
    assert.equal(harness.snapshot().ready, false);
  }
});

test('late OAuth completion cannot reconnect a disposed controller', async () => {
  const harness = fixture();
  await harness.controller.initialize();
  const gate = deferred();
  harness.auth.connectGate = gate.promise;
  const connecting = harness.controller.connect();
  await harness.controller.dispose();
  gate.resolve();
  await connecting;
  assert.equal(harness.auth.token, '');
  assert.equal(harness.snapshot().connected, false);
});

test('dispose drains pending source fingerprinting and its save before releasing the writer', async () => {
  const store = new TestStore();
  store.saved = await restoredSnapshot();
  const harness = fixture({ store });
  await harness.controller.initialize();
  const digestStarted = deferred();
  const digestGate = deferred();
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const digest = globalThis.crypto.subtle.digest;
  globalThis.crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
    digestStarted.resolve();
    await digestGate.promise;
    return originalDigest(...args);
  };
  try {
    const reconnecting = harness.controller.reconnectSources([file()]);
    await digestStarted.promise;
    const disposing = harness.controller.dispose();
    assert.equal(harness.locks.held, true);
    assert.equal(store.closed, false);
    digestGate.resolve();
    await reconnecting;
    await disposing;
    assert.equal(harness.queue.summary.missingSources, 0);
    assert.ok(store.saves.length > 0);
    assert.equal(harness.locks.held, false);
    assert.equal(store.closed, true);
  } finally {
    digestGate.resolve();
    globalThis.crypto.subtle.digest = digest;
    await harness.controller.dispose();
  }
});

test('folder and retention operations expose errors and preserve the fixed destination', async () => {
  let fail = false;
  const harness = fixture({ folders: {
    list: async () => { if (fail) throw new Error('Folder list unavailable.'); return [{ id: 'folder', name: 'Test folder' }]; },
    create: async name => { if (fail) throw new Error('Retry the pending folder name.'); return { id: 'created', name }; },
  } });
  await harness.setup();
  await harness.controller.createFolder('Photos');
  assert.equal(harness.snapshot().folderId, 'created');
  assert.equal(harness.snapshot().folderName, 'Photos');
  fail = true;
  await harness.controller.refreshFolders();
  assert.match(harness.snapshot().actionMessage, /Folder list unavailable/);
  assert.equal(harness.snapshot().folderId, 'created');
  await harness.controller.createFolder('Photos');
  assert.match(harness.snapshot().actionMessage, /pending folder name/);
  await harness.controller.protectStorage();
  assert.match(harness.snapshot().retentionMessage, /protection granted/);
  harness.navigator.storage.persist = async () => false;
  await harness.controller.protectStorage();
  assert.match(harness.snapshot().retentionMessage, /not granted/);
  harness.navigator.storage.persist = async () => { throw new Error('Storage denied.'); };
  await harness.controller.protectStorage();
  assert.match(harness.snapshot().actionMessage, /Storage denied/);
  assert.match(harness.snapshot().retentionMessage, /unavailable/);
  await harness.controller.dispose();
});

test('wake feature detection, denial and release errors are visible without retry loops', async () => {
  const unavailable = fixture();
  assert.equal(unavailable.snapshot().wake.supported, false);
  await unavailable.controller.setWake(true);
  assert.equal(unavailable.snapshot().wake.enabled, false);
  await unavailable.controller.dispose();
  let requests = 0;
  const sentinel = new TestSentinel();
  const harness = fixture({ navigator: { wakeLock: { request: async () => {
    requests++;
    if (requests === 1) throw new Error('Permission denied.');
    return sentinel;
  } } } });
  await harness.controller.initialize();
  await harness.controller.setWake(true);
  assert.equal(requests, 1);
  assert.equal(harness.snapshot().wake.active, false);
  assert.match(harness.snapshot().wake.message, /Permission denied/);
  harness.document.visibility('hidden');
  harness.document.visibility('visible');
  await harness.waitSnapshot(snapshot => snapshot.wake.active);
  assert.equal(requests, 2);
  sentinel.releaseError = new Error('System release failed.');
  await harness.controller.setWake(false);
  assert.match(harness.snapshot().wake.message, /Release could not be confirmed/);
  assert.equal(requests, 2);
  sentinel.releaseError = undefined;
  await sentinel.release();
  await harness.controller.dispose();
});

test('wake reacquires on visibility return during a pending hidden-page release, then disposes', async () => {
  const first = new TestSentinel();
  const second = new TestSentinel();
  const acquire = deferred<DashboardWakeSentinel>();
  const release = deferred();
  first.releaseGate = release.promise;
  let requests = 0;
  const harness = fixture({ navigator: { wakeLock: { request: () => ++requests === 1 ? acquire.promise : Promise.resolve(second) } } });
  await harness.controller.initialize();
  const enabling = harness.controller.setWake(true);
  harness.document.visibility('hidden');
  acquire.resolve(first);
  await Promise.resolve();
  assert.equal(first.releases, 1);
  harness.document.visibility('visible');
  release.resolve();
  await enabling;
  await harness.waitSnapshot(snapshot => snapshot.wake.active);
  assert.equal(requests, 2);
  await harness.controller.dispose();
  assert.equal(second.released, true);
  assert.equal(second.releases, 1);
});

test('pending wake acquisition after disable/dispose is released and never published active', async () => {
  for (const dispose of [false, true]) {
    const gate = deferred<DashboardWakeSentinel>();
    const sentinel = new TestSentinel();
    const harness = fixture({ navigator: { wakeLock: { request: () => gate.promise } } });
    await harness.controller.initialize();
    const enabling = harness.controller.setWake(true);
    const stopping = dispose ? harness.controller.dispose() : harness.controller.setWake(false);
    gate.resolve(sentinel);
    await enabling;
    await stopping;
    assert.equal(sentinel.released, true);
    assert.equal(harness.snapshot().wake.active, false);
    assert.equal(harness.snapshot().wake.enabled, false);
    await harness.controller.dispose();
  }
});

test('visibility return before the system release event permits exactly one reacquisition', async () => {
  const sentinels = [new TestSentinel(), new TestSentinel()];
  let requests = 0;
  const harness = fixture({ navigator: { wakeLock: { request: async () => sentinels[requests++] } } });
  await harness.controller.initialize();
  await harness.controller.setWake(true);
  harness.document.visibility('hidden');
  harness.document.visibility('visible');
  assert.equal(requests, 1);
  await sentinels[0].release();
  await harness.waitSnapshot(snapshot => snapshot.wake.active && requests === 2);
  await sentinels[1].release();
  assert.equal(harness.snapshot().wake.active, false);
  assert.equal(requests, 2, 'release alone must not cause an endless retry loop');
  await harness.controller.dispose();
});