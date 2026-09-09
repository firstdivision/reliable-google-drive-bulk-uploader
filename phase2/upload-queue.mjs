import { DriveUpload, UploadError } from '../phase1/drive-upload.mjs';

const STATES = ['queued', 'preparing', 'uploading', 'paused', 'retrying', 'failed', 'completed'];
const UNIT = 256 * 1024;

// Metadata identity is a conservative selection heuristic, not a content hash.
export function selectionKey(file) {
  return JSON.stringify([file.name, file.size, file.type || '', file.lastModified || 0]);
}

/** In-memory batch coordinator. Protocol work and live requests stay in DriveUpload. */
export class UploadQueue {
  constructor({ getToken, onChange = () => {}, concurrency = 2, chunkSize = 8 * 1024 * 1024,
    uploadOptions = {}, createUpload = (options) => new DriveUpload(options) }) {
    if (typeof getToken !== 'function' || !Number.isSafeInteger(concurrency) || concurrency < 1 ||
        !Number.isSafeInteger(chunkSize) || chunkSize < UNIT || chunkSize % UNIT) {
      throw new UploadError('Invalid queue concurrency or chunk configuration.');
    }
    Object.assign(this, { getToken, onChange, concurrency, chunkSize, uploadOptions, createUpload });
    this.items = new Map();
    this.keys = new Map();
    this.counts = Object.fromEntries(STATES.map((state) => [state, 0]));
    this.totalBytes = 0;
    this.confirmedBytes = 0;
    this.unstarted = 0;
    this.folderId = null;
    this.enabled = false;
    this.authRequired = false;
    this.active = new Set();
    this.pending = [];
    this.pendingIds = new Set();
    this.head = 0;
    this.nextId = 1;
    this.scheduled = false;
  }

  get summary() {
    return { total: this.items.size, totalBytes: this.totalBytes, confirmedBytes: this.confirmedBytes,
      counts: { ...this.counts }, remaining: this.items.size - this.counts.completed,
      active: this.active.size, enabled: this.enabled, authRequired: this.authRequired,
      unstarted: this.unstarted };
  }

  notify() { this.onChange(this); }

  update(item, status, confirmedBytes = item.confirmedBytes, error = item.error) {
    this.counts[item.status]--;
    this.counts[status]++;
    this.confirmedBytes += confirmedBytes - item.confirmedBytes;
    Object.assign(item, { status, confirmedBytes, error });
  }

  enqueue(item) {
    if (this.pendingIds.has(item.id) || this.active.has(item.id)) return;
    this.pendingIds.add(item.id);
    this.pending.push(item.id);
  }

  add(files) {
    const result = { added: 0, duplicates: 0, rejected: 0 };
    for (const file of files) {
      if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) ||
          file.size <= 0 || typeof file.slice !== 'function' ||
          !Number.isSafeInteger(this.totalBytes + file.size)) {
        result.rejected++;
        continue;
      }
      const key = selectionKey(file);
      if (this.keys.has(key)) { result.duplicates++; continue; }
      const item = { id: String(this.nextId++), key, file, name: file.name, size: file.size,
        type: file.type || '', lastModified: file.lastModified || 0, status: 'queued',
        confirmedBytes: 0, driveFileId: null, error: null, upload: null, attempted: false };
      this.items.set(item.id, item);
      this.keys.set(key, item.id);
      this.counts.queued++;
      this.totalBytes += file.size;
      this.unstarted++;
      this.enqueue(item);
      result.added++;
    }
    this.notify();
    this.schedule();
    return result;
  }

  // Local removal only, before a destination identity or request can exist.
  remove(id) {
    const item = this.items.get(id);
    if (!item || item.attempted) return false;
    this.items.delete(id);
    this.keys.delete(item.key);
    this.pendingIds.delete(id);
    this.counts[item.status]--;
    this.totalBytes -= item.size;
    this.unstarted--;
    this.notify();
    return true;
  }

  start(folderId = this.folderId) {
    if (!folderId || (this.folderId && this.folderId !== folderId)) {
      throw new UploadError('Choose a destination. Once started, this batch keeps the same destination.');
    }
    // A user gesture/reconnect occurs outside this engine; never open OAuth popups here.
    if (!this.getToken()) throw new UploadError('Reconnect Google before resuming.', { auth: true });
    this.folderId = folderId;
    this.authRequired = false;
    this.enabled = true;
    for (const item of this.items.values()) {
      if (item.status === 'paused' || (item.status === 'failed' && item.error?.auth)) {
        // Aborted workers still occupy their slots until their promises settle.
        if (this.active.has(item.id)) continue;
        this.update(item, 'queued', item.confirmedBytes, null);
        this.enqueue(item);
      }
    }
    this.notify();
    this.schedule();
  }

  pause() {
    this.enabled = false; // Stop dispatch before abort callbacks can run.
    for (const item of this.items.values()) {
      if (item.status === 'queued') this.update(item, 'paused');
      if (this.active.has(item.id) && ['preparing', 'uploading', 'retrying'].includes(item.status)) {
        item.upload.pause();
      }
    }
    this.notify();
  }

  retryFailed() {
    if (!this.counts.failed) return;
    // Validate authorization before mutating failures; start also resumes paused work.
    this.start();
    for (const item of this.items.values()) {
      if (item.status !== 'failed') continue;
      if (this.active.has(item.id)) { item.retryRequested = true; continue; }
      this.update(item, 'queued', item.confirmedBytes, null);
      this.enqueue(item);
    }
    this.notify();
    this.schedule();
  }

  uploadChanged(item, upload) {
    item.driveFileId = upload.fileId;
    this.update(item, upload.state, upload.confirmedBytes, upload.error);
    if (upload.state === 'failed' && upload.error?.auth && !this.authRequired) {
      this.authRequired = true;
      this.pause();
    }
    this.notify();
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  pump() {
    if (!this.enabled || this.authRequired) return;
    while (this.enabled && !this.authRequired && this.active.size < this.concurrency && this.head < this.pending.length) {
      const id = this.pending[this.head++];
      this.pendingIds.delete(id);
      const item = this.items.get(id);
      if (!item || item.status !== 'queued' || this.active.has(id)) continue;
      if (!item.attempted) this.unstarted--;
      item.attempted = true;
      item.retryRequested = false;
      try {
        item.upload ||= this.createUpload({ ...this.uploadOptions, file: item.file,
          folderId: this.folderId, getToken: this.getToken, chunkSize: this.chunkSize,
          onChange: (upload) => this.uploadChanged(item, upload) });
      } catch (error) {
        this.update(item, 'failed', item.confirmedBytes, error);
        continue;
      }
      this.active.add(id);
      // Defer invocation so even synchronous failures use the same slot cleanup path.
      void Promise.resolve().then(() => {
        if (this.enabled && !this.authRequired) return item.upload.start();
        this.update(item, 'paused');
      }).catch((error) => {
        this.update(item, 'failed', item.confirmedBytes, error);
        if (error.auth) { this.authRequired = true; this.pause(); }
      }).finally(() => {
        this.active.delete(id);
        if (item.status === 'completed') {
          // Keep the completion/selection identity, not large live source references.
          item.file = null;
          item.upload = null;
        } else if (this.enabled && !this.authRequired &&
          (item.status === 'paused' || (item.status === 'failed' && (item.error?.auth || item.retryRequested)))) {
          this.update(item, 'queued', item.confirmedBytes, null);
          this.enqueue(item);
        }
        this.schedule();
        this.notify();
      });
    }
    if (this.head === this.pending.length) { this.pending = []; this.head = 0; }
    if (!this.active.size && !this.pending.length) this.enabled = false;
    this.notify();
  }
}