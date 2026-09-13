import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleFolderPicker } from '../phase4/drive-picker';

function fixture() {
  const settings: Record<string, unknown> = {};
  let callback!: (result: { action: string; docs?: { id: string }[] }) => void;
  let disposed = 0;
  class View {
    constructor(id: string) { settings.view = id; }
    setIncludeFolders(value: boolean) { settings.folders = value; return this; }
    setSelectFolderEnabled(value: boolean) { settings.selectFolders = value; return this; }
    setMimeTypes(value: string) { settings.mime = value; return this; }
    setMode(value: string) { settings.mode = value; return this; }
    setOwnedByMe(value: boolean) { settings.owned = value; return this; }
  }
  class Builder {
    setDeveloperKey(value: string) { settings.key = value; return this; }
    setAppId(value: string) { settings.app = value; return this; }
    setOAuthToken(value: string) { settings.token = value; return this; }
    setOrigin(value: string) { settings.origin = value; return this; }
    setTitle(value: string) { settings.title = value; return this; }
    addView() { return this; }
    setCallback(value: typeof callback) { callback = value; return this; }
    build() { return { setVisible(value: boolean) { settings.visible = value; }, dispose() { disposed++; } }; }
  }
  const api = { DocsView: View, PickerBuilder: Builder, ViewId: { DOCS: 'docs' }, DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel' } };
  const picker = new GoogleFolderPicker({ apiKey: 'test-key', appId: '123' }, async () => api, () => 'https://example.test');
  return { picker, api, settings, reply: (result: Parameters<typeof callback>[0]) => callback(result), disposed: () => disposed };
}

test('Picker uses the current account and folder list without filtering out shared or owned folders', async () => {
  const harness = fixture();
  const result = harness.picker.pick(() => 'memory-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.settings, { view: 'docs', folders: true, selectFolders: true, mime: 'application/vnd.google-apps.folder', mode: 'list',
    key: 'test-key', app: '123', token: 'memory-token', origin: 'https://example.test', title: 'Choose your upload folder', visible: true });
  await assert.rejects(harness.picker.pick(() => 'other'), /already open/);
  harness.reply({ action: 'picked', docs: [{ id: 'existing-folder' }] });
  assert.equal(await result, 'existing-folder');
  assert.equal(harness.disposed(), 1);
});

test('Picker cancellation, malformed selection, loader failure and expiry do not return a destination', async () => {
  const harness = fixture();
  let result = harness.picker.pick(() => 'token');
  await new Promise(resolve => setImmediate(resolve));
  harness.reply({ action: 'cancel' });
  assert.equal(await result, null);
  result = harness.picker.pick(() => 'token');
  const rejected = assert.rejects(result, /Choose one/);
  await new Promise(resolve => setImmediate(resolve));
  harness.reply({ action: 'picked', docs: [{ id: '../invalid' }] });
  await rejected;
  await assert.rejects(harness.picker.pick(() => { throw new Error('Token expired'); }), /Token expired/);
  const unavailable = new GoogleFolderPicker({ apiKey: 'key', appId: '123' }, async () => { throw new Error('Blocked script'); });
  await assert.rejects(unavailable.pick(() => 'token'), /Blocked script/);
  const unconfigured = new GoogleFolderPicker({ apiKey: '', appId: '' });
  await assert.rejects(unconfigured.pick(() => 'token'), /not configured/);
});

test('closing during library loading settles immediately and never opens a late dialog', async () => {
  const harness = fixture();
  let release!: (api: typeof harness.api) => void;
  const loading = new Promise<typeof harness.api>(resolve => { release = resolve; });
  const picker = new GoogleFolderPicker({ apiKey: 'key', appId: '123' }, () => loading);
  const result = picker.pick(() => { throw new Error('Must not read token after closing'); });
  picker.cancel();
  assert.equal(await result, null);
  release(harness.api);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.settings, {});
});