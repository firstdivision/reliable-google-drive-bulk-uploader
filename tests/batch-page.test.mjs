import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { UploadQueue } from '../phase2/upload-queue.mjs';

const tick = () => new Promise(setImmediate);
function element() {
  return { textContent: '', disabled: false, hidden: false, files: [], value: '', checked: false,
    open: false, children: [], options: [], listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    emit(type) { return this.listeners[type]?.(); },
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; this.options = [...children]; },
    add(option) { this.options.push(option); },
    get selectedOptions() { return this.options.filter((option) => option.value === this.value); },
    setAttribute(name, value) { this[name] = value; },
  };
}

function harness() {
  const nodes = new Map();
  const timers = [];
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  let queue;
  let auth;
  const window = element();
  const workers = [];
  class TestAuth {
    constructor() { auth = this; this.token = ''; }
    connect() { this.token = 'test'; return Promise.resolve({ displayName: 'Synthetic account' }); }
    invalidate() { this.token = ''; }
    getToken() {
      if (!this.token) throw Object.assign(new Error('Reconnect'), { auth: true });
      return this.token;
    }
  }
  class TestQueue extends UploadQueue {
    constructor(config) {
      super({ ...config, createUpload: (options) => {
        const worker = { ...options, fileId: `id-${workers.length}`, confirmedBytes: 0, error: null,
          state: 'queued', starts: 0,
          change(state) { this.state = state; this.onChange(this); },
          start() {
            this.starts++; this.error = null; this.change('uploading');
            return new Promise((resolve) => { this.finish = resolve; });
          },
          pause() { this.change('paused'); this.finish?.(); },
          settle(state, error = null) {
            this.error = error;
            if (state === 'completed') this.confirmedBytes = this.file.size;
            this.change(state); this.finish();
          },
        };
        workers.push(worker);
        return worker;
      } });
      queue = this;
    }
  }
  vm.runInNewContext(readFileSync('phase2/app.mjs', 'utf8').replace(/^import .*;\n/gm, ''), {
    GoogleAuth: TestAuth,
    DriveFolders: class {
      list() { return Promise.resolve([{ id: 'folder', name: 'Test folder' }]); }
      create() { return Promise.resolve({ id: 'new-folder', name: 'New folder' }); }
    },
    UploadQueue: TestQueue,
    document: { getElementById: get, createElement: element }, window,
    navigator: { onLine: true },
    Option: function (text, value) { return { textContent: text, value }; },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
  });
  return { get, queue, workers, auth, window,
    flush() { while (timers.length) timers.shift()(); },
    async connect() {
      await get('connect').emit('click');
      get('folders').value = 'folder';
      get('folders').emit('change');
    },
    select(count = 3) {
      get('files').files = Array.from({ length: count }, (_, i) => ({
        name: i === 0 ? '<img src=x onerror=alert(1)>' : `video-${i}`, size: 10, lastModified: 1,
        type: 'video/mp4', slice() { throw new Error('UI must not read file bytes'); },
      }));
      get('files').value = 'native-selection';
      get('files').emit('change');
    },
  };
}

test('batch page bounds details to 50 rows and safely renders 5,000 metadata selections', () => {
  const h = harness();
  h.select(5000);
  assert.equal(h.get('files').value, '');
  assert.equal(h.get('selected').textContent, '5,000');
  assert.equal(h.get('items').children.length, 0, 'closed details have no rows');
  h.get('details').open = true;
  h.get('details').emit('toggle');
  assert.equal(h.get('items').children.length, 50);
  assert.match(h.get('items').children[0].children[0].textContent, /^<img src=x/);
  for (let i = 0; i < 99; i++) h.get('next').emit('click');
  assert.equal(h.get('next').disabled, true);
  assert.match(h.get('page').textContent, /Page 100 of 100/);
  h.select(5000);
  assert.match(h.get('selection-status').textContent, /5000 matching selections skipped/);
  h.get('clear').emit('click');
  assert.equal(h.get('selected').textContent, '0');
  assert.equal(h.get('items').children.length, 0);
});

test('batch controls reflect selection, destination lock, pause/resume, and completed results', async () => {
  const h = harness();
  assert.equal(h.get('upload').disabled, true);
  h.select();
  await h.connect();
  assert.equal(h.get('upload').disabled, false);
  h.get('upload').emit('click');
  await tick(); h.flush();
  assert.equal(h.get('folders').disabled, true);
  assert.equal(h.get('active').textContent, '2');
  assert.equal(h.get('connect').disabled, true);
  h.get('pause').emit('click');
  await tick(); h.flush();
  assert.equal(h.get('active').textContent, '0');
  assert.equal(h.get('upload').disabled, false);
  h.get('upload').emit('click');
  await tick();
  for (const worker of h.workers.filter((worker) => worker.state === 'uploading')) worker.settle('completed');
  await tick();
  for (const worker of h.workers.filter((worker) => worker.state === 'uploading')) worker.settle('completed');
  await tick(); h.flush();
  assert.equal(h.get('completed').textContent, '3');
  assert.equal(h.get('percent').textContent, '100.0%');
  assert.match(h.get('batch-status').textContent, /Batch complete/);
  assert.equal(h.get('retry').disabled, true);
  assert.equal(h.get('upload').disabled, true);
});

test('UI reconnect does not invalidate the new token before Resume', async () => {
  const h = harness();
  h.select(); await h.connect();
  h.get('upload').emit('click');
  await tick();
  h.workers[0].settle('failed', Object.assign(new Error('Expired'), { auth: true }));
  await tick(); h.flush();
  assert.equal(h.auth.token, '');
  assert.equal(h.get('connect').disabled, false);
  assert.equal(h.get('upload').disabled, true);
  await h.get('connect').emit('click');
  h.flush();
  assert.equal(h.auth.token, 'test');
  assert.equal(h.get('upload').disabled, false);
  h.get('upload').emit('click');
  await tick(); h.flush();
  assert.equal(h.queue.authRequired, false);
  assert.equal(h.get('active').textContent, '2');
  h.queue.pause(); await tick();
});

test('failures are filterable and Retry Failed never restarts completed files', async () => {
  const h = harness();
  h.select(2); await h.connect();
  h.get('upload').emit('click');
  await tick();
  h.workers[0].settle('failed', new Error('Permission denied'));
  h.workers[1].settle('completed');
  await tick(); h.flush();
  assert.equal(h.get('retry').disabled, false);
  h.get('details').open = true;
  h.get('failed-only').checked = true;
  h.get('failed-only').emit('change');
  assert.equal(h.get('items').children.length, 1);
  assert.equal(h.get('items').children[0].children[1].textContent, 'Permission denied');
  h.get('retry').emit('click');
  await tick();
  assert.equal(h.workers[0].starts, 2);
  assert.equal(h.workers[1].starts, 1);
  h.workers[0].settle('completed');
  await tick(); h.flush();
  assert.equal(h.get('items').children.length, 0);
});

test('pagehide pauses the batch instead of claiming background execution', async () => {
  const h = harness();
  h.select(); await h.connect();
  h.get('upload').emit('click');
  await tick();
  h.window.emit('pagehide');
  await tick(); h.flush();
  assert.equal(h.queue.summary.active, 0);
  assert.equal(h.queue.summary.counts.paused, 3);
});

test('batch static assets use restricted destinations and are included in Pages deployment', () => {
  const html = readFileSync('phase2/index.html', 'utf8');
  const workflow = readFileSync('.github/workflows/pages.yml', 'utf8');
  assert.match(html, /connect-src https:\/\/www.googleapis.com https:\/\/accounts.google.com\/gsi\/;/);
  assert.match(html, /type="file" accept="image\/\*,video\/\*" multiple/);
  assert.match(html, /src="\.\.\/phase1\/wake.js"/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(workflow, /cp phase2\/\* public\/phase2\//);
  assert.match(workflow, /node --check phase2\/upload-queue.mjs/);
});