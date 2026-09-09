const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function element() {
  return {
    textContent: '', disabled: false, files: [], value: '', children: [], listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    emit(type) { return this.listeners[type]?.(); },
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
  };
}

function harness(script, navigator = {}) {
  const nodes = new Map();
  const document = Object.assign(element(), {
    visibilityState: 'visible',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
  });
  vm.runInNewContext(readFileSync(`phase0/${script}.js`, 'utf8'), {
    document, navigator, window: { isSecureContext: true },
  });
  return { document, get: (id) => document.getElementById(id) };
}

test('5,000 selections report all bytes without content reads or rendering all rows', () => {
  const { get } = harness('baseline');
  get('files').files = Array.from({ length: 5000 }, (_, i) => ({
    name: i === 0 ? '<img src=x onerror=alert(1)>' : `sample-${i}.mov`, type: '', size: 1000,
    slice() { throw new Error('Baseline must never read contents'); },
    arrayBuffer() { throw new Error('Baseline must never read contents'); },
  }));
  get('files').emit('change');
  assert.match(get('summary').textContent, /5,000 files · 5,000,000 bytes/);
  assert.equal(get('metadata').children.length, 100);
  assert.match(get('metadata').children[0].textContent, /^<img src=x/);
  for (let i = 0; i < 49; i++) get('next').emit('click');
  assert.equal(get('next').disabled, true);
  assert.match(get('metadata').children[99].textContent, /sample-4999.mov/);
  get('previous').emit('click');
  assert.equal(get('next').disabled, false);
  get('files').emit('cancel');
  assert.match(get('summary').textContent, /5,000 files/);
  get('clear').emit('click');
  assert.equal(get('metadata').children.length, 0);
  assert.equal(get('files').value, '');
  assert.equal(get('next').disabled, true);
});

test('experiment reads only a bounded slice and reports failures', async () => {
  const { get } = harness('experiments');
  let calls = 0;
  get('files').files = [{ name: 'huge.mov', size: 9_000_000_000, slice(start, end) {
    calls++;
    assert.equal(start, 0);
    assert.equal(end, 65536);
    return { arrayBuffer: async () => new ArrayBuffer(end) };
  } }];
  get('files').emit('change');
  assert.equal(calls, 0);
  await get('read').emit('click');
  assert.equal(calls, 1);
  assert.match(get('read-status').textContent, /Read 65,536 bytes/);
  get('files').files[0].slice = () => { throw new Error('Source access lost'); };
  await get('read').emit('click');
  assert.match(get('read-status').textContent, /Read failed: Source access lost/);
  assert.equal(get('read').disabled, false);
  assert.equal(get('wake').disabled, true);
});

test('clearing a pending read does not restore a stale result', async () => {
  const { get } = harness('experiments');
  let finish;
  get('files').files = [{ name: 'sample', size: 10, slice: () => ({
    arrayBuffer: () => new Promise((resolve) => { finish = resolve; }),
  }) }];
  get('files').emit('change');
  const pending = get('read').emit('click');
  get('clear').emit('click');
  finish(new ArrayBuffer(10));
  await pending;
  assert.match(get('read-status').textContent, /References cleared/);
  assert.equal(get('read').disabled, true);
});

test('wake lock reflects release and reacquires on visibility return', async () => {
  const locks = [];
  const { get, document } = harness('experiments', { wakeLock: { request: async () => {
    const lock = element();
    lock.release = async () => lock.emit('release');
    locks.push(lock);
    return lock;
  } } });
  await get('wake').emit('click');
  assert.match(get('wake-status').textContent, /^Active/);
  document.visibilityState = 'hidden';
  await locks[0].release();
  assert.match(get('wake-status').textContent, /Released/);
  document.visibilityState = 'visible';
  document.emit('visibilitychange');
  await new Promise(setImmediate);
  assert.equal(locks.length, 2);
  assert.match(get('wake-status').textContent, /^Active/);
  await get('wake').emit('click');
  assert.equal(get('wake')['aria-pressed'], 'false');
  assert.equal(get('wake-status').textContent, 'Keep Awake is off.');
});

test('wake lock denial and disabling during acquisition stay truthful', async () => {
  const denied = harness('experiments', { wakeLock: { request: async () => { throw new Error('Denied'); } } });
  await denied.get('wake').emit('click');
  assert.match(denied.get('wake-status').textContent, /Not active: Denied/);
  let finish;
  let released = false;
  const { get } = harness('experiments', { wakeLock: { request: () => new Promise((resolve) => { finish = resolve; }) } });
  const pending = get('wake').emit('click');
  await get('wake').emit('click');
  finish({ release: async () => { released = true; } });
  await pending;
  assert.equal(released, true);
  assert.equal(get('wake-status').textContent, 'Keep Awake is off.');
});

test('visibility return before the old lock release event still reacquires', async () => {
  const locks = [];
  const { get, document } = harness('experiments', { wakeLock: { request: async () => {
    const lock = element();
    lock.release = async () => lock.emit('release');
    locks.push(lock);
    return lock;
  } } });
  await get('wake').emit('click');
  document.visibilityState = 'hidden';
  document.emit('visibilitychange');
  document.visibilityState = 'visible';
  document.emit('visibilitychange');
  assert.equal(locks.length, 1);
  await locks[0].release();
  await new Promise(setImmediate);
  assert.equal(locks.length, 2);
  assert.match(get('wake-status').textContent, /^Active/);
  await locks[1].release();
  await new Promise(setImmediate);
  assert.equal(locks.length, 2, 'system release alone must not cause a retry loop');
});

test('visibility return during hidden acquisition cleanup is not lost', async () => {
  let resolveRequest;
  let finishRelease;
  let requests = 0;
  const { get, document } = harness('experiments', { wakeLock: { request: () => {
    requests++;
    if (requests === 1) return new Promise((resolve) => { resolveRequest = resolve; });
    return Promise.resolve(element());
  } } });
  const pending = get('wake').emit('click');
  document.visibilityState = 'hidden';
  document.emit('visibilitychange');
  resolveRequest({ release: () => new Promise((resolve) => { finishRelease = resolve; }) });
  await new Promise(setImmediate);
  document.visibilityState = 'visible';
  document.emit('visibilitychange');
  finishRelease();
  await pending;
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.match(get('wake-status').textContent, /^Active/);
});
