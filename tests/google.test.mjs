import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAuth, DriveFolders, DRIVE_SCOPE, AuthRequiredError } from '../phase1/google.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function authFixture() {
  let config;
  let requested = false;
  let now = 0;
  let account = 'original';
  const auth = new GoogleAuth({
    now: () => now,
    googleProvider: () => ({ accounts: { oauth2: {
      initTokenClient(options) { config = options; return { requestAccessToken() { requested = true; } }; },
      hasGrantedAllScopes(result, scope) { return result.scope === scope; },
    } } }),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return json({ user: { permissionId: account, displayName: 'Tester' } });
    },
  });
  return { auth, requested: () => requested, config: () => config,
    setNow: (value) => { now = value; }, setAccount: (value) => { account = value; },
    respond: (overrides = {}) => config.callback({ access_token: 'test-token', expires_in: 3600, scope: DRIVE_SCOPE, ...overrides }),
  };
}

test('connect opens directly, validates scope/account, expires early without automatic popup', async () => {
  const f = authFixture();
  assert.throws(() => f.auth.getToken(), AuthRequiredError);
  const connected = f.auth.connect();
  assert.equal(f.requested(), true);
  assert.equal(f.config().scope, DRIVE_SCOPE);
  assert.equal(f.config().include_granted_scopes, false);
  assert.throws(() => f.auth.getToken(), AuthRequiredError);
  await f.respond();
  assert.equal((await connected).permissionId, 'original');
  assert.equal(f.auth.getToken(), 'test-token');
  f.setNow(3570000);
  assert.throws(() => f.auth.getToken(), AuthRequiredError);
});

test('reauthorization cannot substitute a different Drive account', async () => {
  const f = authFixture();
  let promise = f.auth.connect();
  await f.respond(); await promise;
  f.setAccount('different');
  promise = f.auth.connect();
  const rejection = assert.rejects(promise, /original Google account/);
  await f.respond(); await rejection;
  assert.throws(() => f.auth.getToken(), AuthRequiredError);
  assert.equal(f.auth.user.permissionId, 'original');
  f.setAccount('original');
  promise = f.auth.connect(); await f.respond(); await promise;
  assert.equal(f.auth.getToken(), 'test-token');
});

test('denied permission and popup close recover without accepting tokens', async () => {
  const f = authFixture();
  let promise = f.auth.connect();
  let rejection = assert.rejects(promise, /not granted/);
  await f.respond({ scope: '' }); await rejection;
  assert.throws(() => f.auth.getToken(), AuthRequiredError);
  promise = f.auth.connect();
  rejection = assert.rejects(promise, /closed or could not open/);
  f.config().error_callback({ type: 'popup_closed' }); await rejection;
  promise = f.auth.connect(); await f.respond(); await promise;
});

const stubAuth = () => ({ getToken: () => 'test-token', invalidate() { this.invalidated = true; } });
const folder = (id, name = 'Test') => ({ id, name, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true } });

test('folder listing follows empty pages and excludes non-writable destinations', async () => {
  const urls = [];
  const replies = [{ files: [], nextPageToken: 'page+2' }, { files: [folder('yes'), { ...folder('no'), capabilities: { canAddChildren: false } }] }];
  const folders = new DriveFolders(stubAuth(), { fetchImpl: async (url) => { urls.push(new URL(url)); return json(replies.shift()); } });
  assert.deepEqual(await folders.list(), [{ id: 'yes', name: 'Test' }]);
  assert.equal(urls[1].searchParams.get('pageToken'), 'page+2');
});

test('folder listing rejects incomplete searches and authorization failures', async () => {
  const auth = stubAuth();
  const folders = new DriveFolders(auth, { fetchImpl: async () => json({ files: [], incompleteSearch: true }) });
  await assert.rejects(folders.list(), /incomplete folder search/);
  folders.fetchImpl = async () => json({}, 401);
  await assert.rejects(folders.list(), AuthRequiredError);
  assert.equal(auth.invalidated, true);
});

test('lost folder create response retains ID and verifies 409 on retry', async () => {
  const calls = [];
  const folders = new DriveFolders(stubAuth(), { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({ ids: ['stable-id'] });
    if (calls.length === 2) throw new TypeError('network interrupted');
    if (calls.length === 3) return json({}, 409);
    return json(folder('stable-id'));
  } });
  await assert.rejects(folders.create('Test'), /network interrupted/);
  assert.equal(folders.pendingName, 'Test');
  await assert.rejects(folders.create('Another'), /pending folder name/);
  assert.deepEqual(await folders.create('Test'), { id: 'stable-id', name: 'Test' });
  assert.equal(folders.pendingName, null);
  assert.equal(JSON.parse(calls[1].options.body).id, 'stable-id');
  assert.equal(calls[1].options.body, calls[2].options.body);
  assert.equal(calls.filter((call) => call.url.includes('generateIds')).length, 1);
});

test('conflicting folder identity is never accepted as a destination', async () => {
  let call = 0;
  const folders = new DriveFolders(stubAuth(), { fetchImpl: async () => {
    call += 1;
    if (call === 1) return json({ ids: ['stable-id'] });
    if (call === 2) return json({}, 409);
    return json(folder('stable-id', 'Different name'));
  } });
  await assert.rejects(folders.create('Test'), /Could not verify/);
  assert.equal(folders.pendingName, 'Test');
});
