import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueStore } from '../phase2/queue-store.mjs';

const tick = () => new Promise(setImmediate);

function fixture({ manualOpen = false, existing = false, missingStore = false } = {}) {
  const records = new Map();
  const requests = [];
  const connections = [];
  const transactions = [];
  const pending = [];
  let active = null;
  let hasStore = existing && !missingStore;
  let nextFailure = null;

  function dispatch() {
    if (active || pending.length === 0) return;
    active = pending.shift();
    setImmediate(() => active.run());
  }

  function connect(request) {
    const database = {
      closed: false,
      objectStoreNames: { contains: (name) => name === 'state' && hasStore },
      createObjectStore(name) {
        assert.equal(name, 'state');
        assert.equal(hasStore, false);
        hasStore = true;
      },
      close() { this.closed = true; },
      transaction(name, mode, options) {
        assert.equal(name, 'state');
        assert.ok(['readonly', 'readwrite'].includes(mode));
        assert.equal(options.durability, mode === 'readwrite' ? 'strict' : 'default');
        if (this.closed || !hasStore) throw new Error('Invalid database state');
        const failure = nextFailure;
        nextFailure = null;
        if (failure === 'start') throw new Error('Private storage failure details');
        let operation;
        let finished = false;
        const transaction = {
          mode,
          objectStore(storeName) {
            assert.equal(storeName, 'state');
            return {
              get(key) {
                assert.equal(mode, 'readonly');
                assert.equal(key, 'batch');
                operation = { key, request: {} };
                return operation.request;
              },
              put(value, key) {
                assert.equal(mode, 'readwrite');
                assert.equal(key, 'batch');
                operation = { key, value: structuredClone(value), request: {} };
                return operation.request;
              },
            };
          },
          abort() {
            if (finished) return;
            finished = true;
            setImmediate(() => {
              this.onabort?.();
              if (active === this) active = null;
              dispatch();
            });
          },
          run() {
            if (finished) return;
            if (failure === 'request') {
              operation.request.onerror?.();
              this.onerror?.();
              this.abort();
              return;
            }
            operation.request.result = mode === 'readonly' ? structuredClone(records.get(operation.key)) : operation.key;
            operation.request.onsuccess?.();
            setImmediate(() => {
              if (finished) return;
              if (failure === 'abort') {
                this.abort();
                return;
              }
              finished = true;
              if (mode === 'readwrite') records.set(operation.key, operation.value);
              this.oncomplete?.();
              active = null;
              dispatch();
            });
          },
        };
        transactions.push(transaction);
        pending.push(transaction);
        dispatch();
        return transaction;
      },
    };
    connections.push(database);
    request.result = database;
    if (!existing) {
      let aborted = false;
      request.transaction = { abort() { aborted = true; } };
      request.onupgradeneeded?.({ oldVersion: 0 });
      if (aborted) {
        database.close();
        request.onerror?.();
        return;
      }
      existing = true;
    }
    request.onsuccess?.();
  }

  const indexedDB = {
    open(name, version) {
      const request = { name, version };
      requests.push(request);
      if (!manualOpen) setImmediate(() => connect(request));
      return request;
    },
  };
  return { indexedDB, records, requests, connections, transactions, connect,
    failNext(failure) { nextFailure = failure; } };
}

test('unavailable IndexedDB rejects without an in-memory fallback', async () => {
  for (const indexedDB of [null, {}]) {
    const store = new QueueStore({ indexedDB });
    await assert.rejects(store.open(), /IndexedDB queue storage is unavailable/);
    await assert.rejects(store.save({}), /not open/);
  }
  if (!globalThis.indexedDB) await assert.rejects(new QueueStore().open(), /unavailable/);
});

test('open uses version 1, creates state, and shares concurrent opens', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await Promise.all([store.open(), store.open()]);
  await store.open();
  assert.equal(database.requests.length, 1);
  assert.equal(database.requests[0].name, 'batchharbor-queue');
  assert.equal(database.requests[0].version, 1);
  assert.equal(await store.load(), null);
  assert.equal(database.transactions[0].mode, 'readonly');
});

test('load and save require an explicit open', async () => {
  const store = new QueueStore({ indexedDB: fixture().indexedDB });
  await assert.rejects(store.load(), /not open/);
  await assert.rejects(store.save({}), /not open/);
});

test('whole snapshots round trip opaquely with structured cloning and survive reopen', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB, name: 'test-queue' });
  await store.open();
  assert.equal(database.requests[0].name, 'test-queue');
  const snapshot = { version: 999, items: [{ id: 'one', confirmedBytes: 4 }], time: new Date(0) };
  const saving = store.save(snapshot);
  snapshot.items[0].confirmedBytes = 9;
  await saving;
  const loaded = await store.load();
  assert.equal(loaded.items[0].confirmedBytes, 4);
  assert.deepEqual(loaded.time, new Date(0));
  loaded.items.length = 0;
  assert.equal((await store.load()).items.length, 1);
  await store.save({ arbitrary: 'no domain version required' });
  store.close();
  await store.open();
  assert.deepEqual(await store.load(), { arbitrary: 'no domain version required' });
  assert.deepEqual([...database.records.keys()], ['batch']);
});

test('save resolves only on commit and concurrent saves retain invocation order', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  const completed = [];
  const first = store.save({ sequence: 1 }).then(() => completed.push(1));
  const second = store.save({ sequence: 2 }).then(() => completed.push(2));
  await tick();
  assert.deepEqual(completed, []);
  assert.equal(database.records.has('batch'), false);
  const loading = store.load();
  await Promise.all([first, second]);
  assert.deepEqual(completed, [1, 2]);
  assert.deepEqual(await loading, { sequence: 2 });
});

test('transaction abort after request success rejects and retains the previous snapshot', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  await store.save({ sequence: 1 });
  database.failNext('abort');
  await assert.rejects(store.save({ sequence: 2 }), /save.*transaction aborted/);
  assert.deepEqual(await store.load(), { sequence: 1 });
  await store.save({ sequence: 3 });
  assert.deepEqual(await store.load(), { sequence: 3 });
});

test('read aborts and request failures reject instead of returning an empty batch', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  await store.save({ retained: true });
  database.failNext('abort');
  await assert.rejects(store.load(), /load.*transaction aborted/);
  database.failNext('request');
  await assert.rejects(store.load(), /load.*transaction aborted/);
  database.failNext('request');
  await assert.rejects(store.save({ retained: false }), /save.*transaction aborted/);
  assert.deepEqual(await store.load(), { retained: true });
});

test('synchronous transaction and cloning failures reject without replacing stored data', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  await store.save({ retained: true });
  database.failNext('start');
  await assert.rejects(store.load(), { message: 'Unable to load queue snapshot: IndexedDB operation failed.' });
  await assert.rejects(store.save({ unsupported() {} }), /save.*operation failed/);
  assert.deepEqual(await store.load(), { retained: true });
});

test('blocked open rejects promptly and closes a late successful connection', async () => {
  const database = fixture({ manualOpen: true, existing: true });
  const store = new QueueStore({ indexedDB: database.indexedDB });
  const opening = store.open();
  database.requests[0].onblocked();
  await assert.rejects(opening, /blocked.*Close other tabs/);
  database.connect(database.requests[0]);
  assert.equal(database.connections[0].closed, true);
  await assert.rejects(store.save({}), /not open/);
  const retry = store.open();
  database.connect(database.requests[1]);
  await retry;
});

test('blocked new database open aborts a late upgrade', async () => {
  const database = fixture({ manualOpen: true });
  const store = new QueueStore({ indexedDB: database.indexedDB });
  const opening = store.open();
  database.requests[0].onblocked();
  await assert.rejects(opening, /blocked/);
  database.connect(database.requests[0]);
  assert.equal(database.connections[0].closed, true);
  assert.equal(database.connections[0].objectStoreNames.contains('state'), false);
});

test('open errors are descriptive and do not include underlying error details', async () => {
  const store = new QueueStore({ indexedDB: { open() { throw new Error('Private storage failure details'); } } });
  await assert.rejects(store.open(), { message: 'Unable to open IndexedDB queue storage.' });
  const database = fixture({ manualOpen: true });
  const asynchronous = new QueueStore({ indexedDB: database.indexedDB });
  const opening = asynchronous.open();
  database.requests[0].error = new Error('Private storage failure details');
  database.requests[0].onerror();
  await assert.rejects(opening, { message: 'Unable to open IndexedDB queue storage.' });
});

test('missing object store is a schema error, not an empty snapshot', async () => {
  const database = fixture({ existing: true, missingStore: true });
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await assert.rejects(store.open(), /schema is invalid/);
  assert.equal(database.connections[0].closed, true);
});

test('versionchange closes the connection and requires explicit reopen', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  database.connections[0].onversionchange();
  assert.equal(database.connections[0].closed, true);
  await assert.rejects(store.load(), /version changed/);
  await assert.rejects(store.save({}), /version changed/);
  await store.open();
  await store.save({ reopened: true });
});

test('unexpected connection closure is surfaced', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  database.connections[0].closed = true;
  database.connections[0].onclose();
  await assert.rejects(store.load(), /closed unexpectedly/);
});

test('close is idempotent and lets already-started transactions complete', async () => {
  const database = fixture();
  const store = new QueueStore({ indexedDB: database.indexedDB });
  await store.open();
  const saving = store.save({ retained: true });
  store.close();
  store.close();
  await assert.rejects(store.save({}), /closed/);
  await saving;
  await store.open();
  assert.deepEqual(await store.load(), { retained: true });
});

test('close cancels pending open without allowing its late result to replace a new connection', async () => {
  const database = fixture({ manualOpen: true, existing: true });
  const store = new QueueStore({ indexedDB: database.indexedDB });
  const first = store.open();
  store.close();
  const second = store.open();
  await assert.rejects(first, /closed while opening/);
  database.connect(database.requests[1]);
  await second;
  database.connect(database.requests[0]);
  assert.equal(database.connections[0].closed, false);
  assert.equal(database.connections[1].closed, true);
  await store.save({ current: true });
});