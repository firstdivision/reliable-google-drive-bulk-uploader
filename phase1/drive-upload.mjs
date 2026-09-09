// Protocol reference: https://developers.google.com/workspace/drive/api/guides/manage-uploads
const API = 'https://www.googleapis.com/drive/v3/files';
const CREATE = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,parents';
const UNIT = 256 * 1024;

export class UploadError extends Error {
  constructor(message, { auth = false, transient = false, status = 0 } = {}) {
    super(message);
    this.name = 'UploadError';
    Object.assign(this, { auth, transient, status });
  }
}

function validateSession(value) {
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || url.origin !== 'https://www.googleapis.com' || url.username || url.password ||
      url.pathname !== '/upload/drive/v3/files' || !url.searchParams.get('upload_id') || url.hash) {
    throw new UploadError('Google returned an invalid upload session URL.');
  }
  return url.href;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One live File and destination identity; intentionally no persistence across reloads. */
export class DriveUpload {
  constructor({ file, folderId, getToken, onChange = () => {}, fetchImpl = fetch,
    chunkSize = 8 * 1024 * 1024, maxRetries = 5, requestTimeoutMs = 120000,
    retryBaseMs = 1000, random = Math.random }) {
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.slice !== 'function') {
      throw new UploadError('Select a nonempty file.');
    }
    if (!folderId || typeof getToken !== 'function' || !Number.isSafeInteger(chunkSize) || chunkSize < UNIT || chunkSize % UNIT) {
      throw new UploadError('Invalid destination or chunk configuration.');
    }
    Object.assign(this, { file, folderId, getToken, onChange, fetchImpl, chunkSize,
      maxRetries, requestTimeoutMs, retryBaseMs, random });
    this.state = 'queued';
    this.confirmedBytes = 0;
    this.fileId = null;
    this.sessionUrl = null;
    this.error = null;
    this.running = false;
    this.needsProbe = false;
  }

  change(state) { this.state = state; this.onChange(this); }

  pause() {
    if (!this.running || this.state === 'completed') return;
    this.controller.abort(new DOMException('Paused', 'AbortError'));
    this.change('paused');
  }

  async start() {
    if (this.running || this.state === 'completed') return;
    this.running = true;
    this.error = null;
    this.controller = new AbortController();
    this.needsProbe = Boolean(this.sessionUrl);
    let failures = 0;
    this.change('preparing');
    try {
      while (this.state !== 'completed') {
        this.controller.signal.throwIfAborted();
        const previous = this.confirmedBytes;
        try {
          await this.step();
          if (this.confirmedBytes > previous) failures = 0;
        } catch (error) {
          if (this.controller.signal.aborted) throw error;
          if (!error.transient || failures >= this.maxRetries) throw error;
          this.error = error;
          this.change('retrying');
          await delay(Math.min(32000, this.retryBaseMs * 2 ** failures++) * (0.5 + this.random() * 0.5), this.controller.signal);
          this.error = null;
        }
      }
    } catch (error) {
      if (this.controller.signal.aborted) this.change('paused');
      else { this.error = error; this.change('failed'); }
    } finally {
      this.running = false;
      this.onChange(this);
    }
  }

  async request(url, options = {}) {
    const token = this.getToken();
    if (!token) throw new UploadError('Connect Google again, then resume this upload.', { auth: true });
    const requestController = new AbortController();
    const abort = () => requestController.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => requestController.abort(), this.requestTimeoutMs);
    try {
      this.controller.signal.throwIfAborted();
      const response = await this.fetchImpl(url, { ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
        signal: requestController.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      const body = await response.text(); // Timeout remains active through body consumption.
      let data = null;
      try { data = body ? JSON.parse(body) : null; } catch { /* validate at use sites */ }
      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      const detail = error?.name ? `${error.name}: ${error.message}` : String(error?.message || error);
      throw new UploadError(`Network request failed or timed out (${detail}). Retrying from Google’s confirmed position.`, { transient: true });
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', abort);
    }
  }

  check(response) {
    const status = response.status;
    if (status >= 200 && status < 300) return;
    const reasons = response.data?.error?.errors?.map(item => item.reason) || [];
    const transient = [408, 429, 500, 502, 503, 504].includes(status) ||
      (status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)));
    throw new UploadError(status === 401 ? 'Google authorization expired. Connect Google again, then resume.' :
      `Google Drive request failed (HTTP ${status}). ${transient ? 'Temporary failure.' : 'Check account access, destination permissions, and storage quota.'}`,
    { auth: status === 401, transient, status });
  }

  complete(data) {
    if (data?.id !== this.fileId || String(data.size) !== String(this.file.size) ||
        !data.parents?.includes(this.folderId)) {
      throw new UploadError('Drive metadata does not match this upload. Stopped to avoid overwriting or duplicating a file.');
    }
    this.confirmedBytes = this.file.size;
    this.change('completed');
  }

  async reconcile() {
    const response = await this.request(`${API}/${encodeURIComponent(this.fileId)}?fields=id,size,parents,trashed`);
    if (response.status === 404) return false;
    this.check(response);
    if (response.data?.trashed) throw new UploadError('The destination file is in the trash. Stopped without changing it.');
    this.complete(response.data);
    return true;
  }

  async step() {
    if (!this.fileId) {
      const response = await this.request(`${API}/generateIds?count=1&space=drive&type=files`);
      this.check(response);
      if (!/^[\w-]+$/.test(response.data?.ids?.[0] || '')) throw new UploadError('Google did not return a valid file ID.');
      this.fileId = response.data.ids[0];
    }
    if (!this.sessionUrl) {
      this.change('preparing');
      const response = await this.request(CREATE, { method: 'POST', headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': this.file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(this.file.size),
      }, body: JSON.stringify({ id: this.fileId, name: this.file.name,
        mimeType: this.file.type || 'application/octet-stream', parents: [this.folderId] }) });
      if (response.status === 409) {
        if (await this.reconcile()) return;
        throw new UploadError('The reserved file ID conflicts, but completion cannot be confirmed.');
      }
      this.check(response);
      this.sessionUrl = validateSession(response.headers.get('Location'));
      this.confirmedBytes = 0;
      this.needsProbe = false;
    }
    this.change('uploading');
    const probe = this.needsProbe;
    const start = this.confirmedBytes;
    const end = Math.min(start + this.chunkSize, this.file.size);
    this.needsProbe = true; // Any ambiguous result must be probed before sending more bytes.
    const response = await this.request(validateSession(this.sessionUrl), { method: 'PUT', headers: {
      'Content-Type': this.file.type || 'application/octet-stream',
      'Content-Range': probe ? `bytes */${this.file.size}` : `bytes ${start}-${end - 1}/${this.file.size}`,
    }, body: probe ? new Blob([]) : this.file.slice(start, end) });
    if (response.status === 404) {
      if (await this.reconcile()) return;
      this.sessionUrl = null;
      this.confirmedBytes = 0;
      throw new UploadError('Upload session expired; restarting with the same reserved file ID.', { transient: true });
    }
    if (response.status === 200 || response.status === 201) { this.complete(response.data); return; }
    if (response.status !== 308) { this.check(response); throw new UploadError('Unexpected upload response.'); }
    const range = response.headers.get('Range');
    const match = range?.match(/^bytes=0-(\d+)$/);
    if (range && !match) throw new UploadError('Google returned an invalid committed range.');
    const offset = match ? Number(match[1]) + 1 : 0;
    if (!Number.isSafeInteger(offset) || offset > this.file.size || offset < start || (!probe && offset > end)) {
      throw new UploadError('Google returned an inconsistent committed offset.');
    }
    this.confirmedBytes = offset;
    this.needsProbe = offset === this.file.size;
    this.onChange(this);
    if (offset === start && (!probe || offset === this.file.size)) {
      throw new UploadError('Google has not confirmed further upload progress.', { transient: true });
    }
  }
}
