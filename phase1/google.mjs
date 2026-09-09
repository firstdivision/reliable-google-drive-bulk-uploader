export const CLIENT_ID = '602921289532-48mhvtbo26r3ihmelppft0gj2r3fs4bv.apps.googleusercontent.com';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/';
const FOLDER = 'application/vnd.google-apps.folder';

export class AuthRequiredError extends Error {
  constructor(message = 'Connect Google Drive again to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'auth_required';
    this.auth = true;
  }
}

// Tokens live only in this instance. Each newly authorized token must first prove
// it belongs to the original Drive account before any folder/upload can use it.
export class GoogleAuth {
  #token = null;
  #expiresAt = 0;
  #user = null;
  #connecting = false;
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), googleProvider = () => globalThis.google, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.googleProvider = googleProvider;
    this.now = now;
  }
  get user() { return this.#user; }
  invalidate() { this.#token = null; this.#expiresAt = 0; }
  getToken() {
    if (!this.#token || this.now() >= this.#expiresAt) {
      this.invalidate();
      throw new AuthRequiredError();
    }
    return this.#token;
  }
  // Call directly from a click handler: no await precedes requestAccessToken.
  connect() {
    if (this.#connecting) return Promise.reject(new Error('Google connection is already in progress.'));
    const oauth = this.googleProvider()?.accounts?.oauth2;
    if (!oauth) return Promise.reject(new Error('Google sign-in has not loaded. Check your connection and try again.'));
    this.invalidate();
    this.#connecting = true;
    return new Promise((resolve, reject) => {
      const fail = (error) => { this.invalidate(); this.#connecting = false; reject(error); };
      try {
        const client = oauth.initTokenClient({
          client_id: CLIENT_ID,
          scope: DRIVE_SCOPE,
          include_granted_scopes: false,
          error_callback: () => fail(new AuthRequiredError('Google sign-in was closed or could not open. Try connecting again.')),
          callback: async (result) => {
            try {
              if (result.error || !result.access_token || !oauth.hasGrantedAllScopes(result, DRIVE_SCOPE)) {
                throw new AuthRequiredError('Google Drive access was not granted. Connect and allow access to continue.');
              }
              const lifetime = Number(result.expires_in);
              if (!Number.isFinite(lifetime) || lifetime <= 30) throw new AuthRequiredError();
              const expiresAt = this.now() + (lifetime - 30) * 1000;
              const response = await this.fetchImpl(`${API}about?fields=user(permissionId,displayName,emailAddress)`, {
                headers: { Authorization: `Bearer ${result.access_token}` }, cache: 'no-store', redirect: 'error',
              });
              if (!response.ok) throw new AuthRequiredError('Could not verify the Drive account. Connect again.');
              const { user } = await response.json();
              if (!user?.permissionId) throw new AuthRequiredError('Google did not return a Drive account identifier.');
              if (this.#user && this.#user.permissionId !== user.permissionId) {
                throw new AuthRequiredError('Reconnect with the original Google account to preserve this upload and destination.');
              }
              if (this.now() >= expiresAt) throw new AuthRequiredError();
              this.#user = Object.freeze({ permissionId: user.permissionId, displayName: user.displayName, emailAddress: user.emailAddress });
              this.#token = result.access_token;
              this.#expiresAt = expiresAt;
              this.#connecting = false;
              resolve(this.#user);
            } catch (error) {
              fail(error instanceof AuthRequiredError ? error : new AuthRequiredError('Could not verify the Drive account. Check your connection and reconnect.'));
            }
          },
        });
        client.requestAccessToken({ prompt: 'select_account' });
      } catch { fail(new AuthRequiredError('Google sign-in could not start. Try connecting again.')); }
    });
  }
}

export class DriveFolders {
  #pending = null;
  #creating = false;
  constructor(auth, { fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }
  get pendingName() { return this.#pending?.name ?? null; }
  async request(path, options = {}) {
    const response = await this.fetchImpl(API + path, {
      ...options, cache: 'no-store', redirect: 'error',
      headers: { ...options.headers, Authorization: `Bearer ${this.auth.getToken()}` },
    });
    if (response.status === 401) { this.auth.invalidate(); throw new AuthRequiredError(); }
    return response;
  }
  async checked(response) {
    if (!response.ok) throw new Error(`Drive folder request failed (HTTP ${response.status}). Check access and retry.`);
    return response.json();
  }
  // drive.file lists only app-created / explicitly app-authorized folders.
  async list() {
    const folders = new Map();
    let pageToken;
    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({ q: `mimeType = '${FOLDER}' and trashed = false`, spaces: 'drive', pageSize: '100', fields: 'nextPageToken,incompleteSearch,files(id,name,capabilities(canAddChildren))' });
      if (pageToken) params.set('pageToken', pageToken);
      const result = await this.checked(await this.request(`files?${params}`));
      if (result.incompleteSearch) throw new Error('Google returned an incomplete folder search. Retry before choosing a destination.');
      if (!Array.isArray(result.files)) throw new Error('Google returned an invalid folder list. Retry.');
      for (const folder of result.files) {
        if (folder.id && typeof folder.name === 'string' && folder.capabilities?.canAddChildren) folders.set(folder.id, { id: folder.id, name: folder.name });
      }
      pageToken = result.nextPageToken;
      if (!pageToken) return [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    throw new Error('Folder listing exceeded the spike limit of 10,000 entries. The partial list was not used.');
  }
  async create(name) {
    name = name.trim();
    if (!name) throw new Error('Enter a test folder name.');
    if (this.#creating) throw new Error('Folder creation is already in progress.');
    if (this.#pending && this.#pending.name !== name) throw new Error('Retry the pending folder name first to avoid creating a duplicate.');
    this.#creating = true;
    try {
      if (!this.#pending) {
        const generated = await this.checked(await this.request('files/generateIds?count=1&space=drive&type=files'));
        const id = generated.ids?.[0];
        if (typeof id !== 'string' || !id) throw new Error('Google did not return a new folder ID. Retry.');
        this.#pending = { id, name };
      }
      const pending = this.#pending;
      let response = await this.request('files?fields=id,name,mimeType,trashed,capabilities(canAddChildren)', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pending, mimeType: FOLDER, parents: ['root'] }),
      });
      // A lost successful response can be retried using the same ID. Verify the
      // existing object after 409 instead of allocating another destination.
      if (response.status === 409) response = await this.request(`files/${encodeURIComponent(pending.id)}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)`);
      const folder = await this.checked(response);
      if (folder.id !== pending.id || folder.name !== pending.name || folder.mimeType !== FOLDER || folder.trashed || !folder.capabilities?.canAddChildren) {
        throw new Error('Could not verify the created folder. Retry the same folder name.');
      }
      this.#pending = null;
      return { id: folder.id, name: folder.name };
    } finally { this.#creating = false; }
  }
}
