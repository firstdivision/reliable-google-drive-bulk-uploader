import { DriveUpload, UploadError } from '../phase1/drive-upload.mjs';

const STATES = ['queued', 'preparing', 'uploading', 'paused', 'retrying', 'failed', 'skipped', 'completed'];
const UNIT = 256 * 1024;
const DUPLICATE_POLICIES = ['upload', 'skip', 'increment'];

// Metadata identity is a conservative selection heuristic, not a content hash.
export function selectionKey(file) {
  return JSON.stringify([file.name, file.size, file.type || '', file.lastModified || 0]);
}

export async function sourceFingerprint(file) {
  const block = 64 * 1024;
  const sample = new Blob([file.slice(0, Math.min(block, file.size)),
    file.slice(Math.min(file.size, Math.max(block, file.size - block)), file.size)]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Batch coordinator. Protocol work and live requests stay in DriveUpload. */
export class UploadQueue {
  constructor({ getToken, onChange = () => {}, concurrency = 2, chunkSize = 8 * 1024 * 1024,
    uploadOptions = {}, createUpload = (options) => new DriveUpload(options),
    saveSnapshot = null, getAccountId = () => null, duplicatePolicy = 'skip', checkDriveNameExists = null }) {
    if (typeof getToken !== 'function' || !Number.isSafeInteger(concurrency) || concurrency < 1 ||
        !Number.isSafeInteger(chunkSize) || chunkSize < UNIT || chunkSize % UNIT) {
      throw new UploadError('Invalid queue concurrency or chunk configuration.');
    }
    if (!DUPLICATE_POLICIES.includes(duplicatePolicy) || (checkDriveNameExists !== null && typeof checkDriveNameExists !== 'function')) {
      throw new UploadError('Invalid duplicate-file handling configuration.');
    }
    Object.assign(this, { getToken, onChange, concurrency, chunkSize, uploadOptions, createUpload, saveSnapshot,
      getAccountId, duplicatePolicy, checkDriveNameExists });
    this.accountId = null;
    this.missingSources = 0;
    this.storageError = null;
    this.saving = null;
    this.revision = 0;
    this.savedRevision = 0;
    this.items = new Map();
    this.keys = new Map();
    this.counts = Object.fromEntries(STATES.map((state) => [state, 0]));
    this.sourceCounts = Object.fromEntries(STATES.map((state) => [state, 0]));
    this.sourceAuthFailures = 0;
    this.totalBytes = 0;
    this.confirmedBytes = 0;
    this.unstarted = 0;
    this.folderId = null;
    this.enabled = false;
    this.authRequired = false;
    this.active = new Set();
    this.pending = [];
    this.pendingIds = new Set();
    this.reservedNames = new Set();
    this.nameChecks = new Map();
    this.head = 0;
    this.nextId = 1;
    this.scheduled = false;
  }

  get summary() {
    return { total: this.items.size, totalBytes: this.totalBytes, confirmedBytes: this.confirmedBytes,
      counts: { ...this.counts }, remaining: this.items.size - this.counts.completed - this.counts.skipped,
      active: this.active.size, enabled: this.enabled, authRequired: this.authRequired,
      unstarted: this.unstarted, missingSources: this.missingSources, storageError: this.storageError,
      saving: Boolean(this.saving),
      resumableSources: this.sourceCounts.queued + this.sourceCounts.paused + this.sourceAuthFailures,
      retryableSources: this.sourceCounts.failed };
  }

  notify() {
    this.onChange(this);
    if (this.saveSnapshot && !this.storageError) void this.persist().catch(() => {});
  }

  snapshot() {
    return { version: 1, accountId: this.accountId, folderId: this.folderId,
      duplicatePolicy: this.duplicatePolicy,
      items: [...this.items.values()].map(item => ({ id: item.id, name: item.name, size: item.size,
        type: item.type, lastModified: item.lastModified, status: item.status, attempted: item.attempted,
        confirmedBytes: item.confirmedBytes, driveFileId: item.driveFileId,
        sessionUrl: item.upload?.sessionUrl ?? item.sessionUrl ?? null, fingerprint: item.fingerprint ?? null,
        resolvedName: item.resolvedName ?? null,
        error: item.error ? { message: item.error.auth ? 'Reconnect the original Google account.' : 'Upload failed. Review account access and retry.',
          auth: Boolean(item.error.auth), status: item.error.status || 0, transient: Boolean(item.error.transient) } : null })) };
  }

  setDuplicatePolicy(policy) {
    if (!DUPLICATE_POLICIES.includes(policy)) throw new UploadError('Invalid duplicate-file handling configuration.');
    if (this.folderId || this.enabled || this.active.size) throw new UploadError('Pause uploads before changing duplicate-file handling.');
    this.duplicatePolicy = policy;
    this.notify();
  }

  async checkNameExists(name) {
    if (this.reservedNames.has(name)) return true;
    if (!this.checkDriveNameExists || !this.folderId) return false;
    if (!this.nameChecks.has(name)) {
      this.nameChecks.set(name, Promise.resolve().then(() => this.checkDriveNameExists(this.folderId, name)));
    }
    const exists = await this.nameChecks.get(name);
    if (!exists) this.nameChecks.set(name, Promise.resolve(false));
    return exists;
  }

  incrementName(name, suffix) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    return `${base}_${suffix}${extension}`;
  }

  reserveName(name) {
    this.reservedNames.add(name);
  }

  async resolveName(item) {
    if (item.resolvedName) return item.resolvedName;
    if (this.duplicatePolicy === 'upload' || !this.checkDriveNameExists || !this.folderId) {
      item.resolvedName = item.name;
      return item.resolvedName;
    }
    if (this.duplicatePolicy === 'skip') {
      if (await this.checkNameExists(item.name)) return null;
      item.resolvedName = item.name;
      this.reserveName(item.resolvedName);
      return item.resolvedName;
    }
    let suffix = 0;
    let candidate = item.name;
    while (await this.checkNameExists(candidate)) {
      suffix += 1;
      candidate = this.incrementName(item.name, suffix);
    }
    item.resolvedName = candidate;
    this.reserveName(candidate);
    return candidate;
  }

  async persist() {
    if (!this.saveSnapshot) return;
    if (this.storageError) throw this.storageError;
    const requiredRevision = ++this.revision;
    while (this.savedRevision < requiredRevision) {
      if (this.storageError) throw this.storageError;
      if (!this.saving) {
        this.saving = Promise.resolve().then(async () => {
          while (this.savedRevision !== this.revision) {
            const revision = this.revision;
            await this.saveSnapshot(this.snapshot());
            this.savedRevision = revision;
          }
        }).catch(() => {
          this.storageError = new UploadError('Queue could not be saved. Uploads paused; restore browser storage access and retry saving.');
          this.pause();
          throw this.storageError;
        }).finally(() => { this.saving = null; this.onChange(this); });
      }
      await this.saving;
    }
  }

  async retryStorage() {
    this.storageError = null;
    await this.persist();
  }

  restore(snapshot) {
    if (this.items.size || this.active.size || this.saving) throw new UploadError('Restore requires an empty, idle queue.');
    const invalid = () => { throw new UploadError('Saved queue is invalid or from an unsupported version. Nothing was overwritten.'); };
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items) ||
        (snapshot.accountId !== null && (typeof snapshot.accountId !== 'string' || !snapshot.accountId)) ||
        (snapshot.folderId !== null && (typeof snapshot.folderId !== 'string' || !/^[\w-]+$/.test(snapshot.folderId))) ||
      (snapshot.folderId && !snapshot.accountId) ||
      (snapshot.duplicatePolicy !== undefined && !DUPLICATE_POLICIES.includes(snapshot.duplicatePolicy))) invalid();
    const ids = new Set();
    const keys = new Set();
    const driveIds = new Set();
    const sessions = new Set();
    let total = 0;
    const restored = Array.from(snapshot.items, saved => {
      if (!saved || typeof saved.id !== 'string' || !/^[1-9]\d*$/.test(saved.id) ||
          !Number.isSafeInteger(Number(saved.id) + 1) || ids.has(saved.id) ||
          typeof saved.name !== 'string' || typeof saved.type !== 'string' ||
          !Number.isSafeInteger(saved.size) || saved.size <= 0 ||
          !Number.isSafeInteger(saved.lastModified) || saved.lastModified < 0 ||
          !Number.isSafeInteger(saved.confirmedBytes) || saved.confirmedBytes < 0 || saved.confirmedBytes > saved.size ||
          !STATES.includes(saved.status) || typeof saved.attempted !== 'boolean' ||
          (saved.fingerprint !== null && (typeof saved.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(saved.fingerprint))) ||
          (saved.attempted && !snapshot.folderId) ||
          (saved.driveFileId != null && (typeof saved.driveFileId !== 'string' || !/^[\w-]+$/.test(saved.driveFileId))) ||
          (saved.driveFileId && (!saved.attempted || !saved.fingerprint)) ||
          (saved.confirmedBytes && !saved.driveFileId) ||
          (saved.sessionUrl != null && typeof saved.sessionUrl !== 'string') ||
          (saved.resolvedName != null && typeof saved.resolvedName !== 'string') ||
          (saved.status === 'skipped' && !saved.attempted) ||
          (saved.status === 'skipped' && (saved.confirmedBytes !== 0 || saved.driveFileId !== null || saved.sessionUrl !== null)) ||
          (saved.status === 'completed' && (!saved.driveFileId || saved.confirmedBytes !== saved.size)) ||
          (saved.error != null && (typeof saved.error?.message !== 'string' || typeof saved.error.auth !== 'boolean' ||
            typeof saved.error.transient !== 'boolean' || !Number.isInteger(saved.error.status)))) invalid();
      total += saved.size;
      if (!Number.isSafeInteger(total)) invalid();
      const key = selectionKey(saved);
        if (keys.has(key) || (saved.driveFileId && driveIds.has(saved.driveFileId)) ||
          (saved.sessionUrl && sessions.has(saved.sessionUrl))) invalid();
      ids.add(saved.id); keys.add(key);
        if (saved.driveFileId) driveIds.add(saved.driveFileId);
        if (saved.sessionUrl) sessions.add(saved.sessionUrl);
      try {
        new DriveUpload({ file: { size: saved.size, slice() {} }, folderId: snapshot.folderId || 'unstarted',
          getToken: this.getToken, recovery: { fileId: saved.driveFileId, sessionUrl: saved.sessionUrl,
            confirmedBytes: saved.confirmedBytes } });
      } catch { invalid(); }
      return { id: saved.id, key, name: saved.name, size: saved.size, type: saved.type,
        lastModified: saved.lastModified, attempted: saved.attempted, confirmedBytes: saved.confirmedBytes,
        driveFileId: saved.driveFileId, sessionUrl: saved.sessionUrl, fingerprint: saved.fingerprint,
        resolvedName: saved.resolvedName ?? null,
        error: saved.error ? new UploadError(saved.error.message, saved.error) : null,
        status: ['completed', 'failed', 'skipped'].includes(saved.status) ? saved.status : 'paused', file: null, upload: null };
    });
    this.accountId = snapshot.accountId;
    this.folderId = snapshot.folderId;
    this.duplicatePolicy = snapshot.duplicatePolicy || 'skip';
    for (const item of restored) {
      this.items.set(item.id, item);
      this.keys.set(item.key, item.id);
      this.counts[item.status]++;
      this.totalBytes += item.size;
      this.confirmedBytes += item.confirmedBytes;
      if (!item.attempted) this.unstarted++;
      if (!['completed', 'skipped'].includes(item.status)) this.missingSources++;
      if (item.resolvedName) this.reservedNames.add(item.resolvedName);
      this.nextId = Math.max(this.nextId, Number(item.id) + 1);
    }
    this.onChange(this);
  }

  async reconnectSources(files) {
    if (this.enabled || this.active.size) throw new UploadError('Pause uploads before reconnecting source files.');
    const candidates = new Map();
    const result = { matched: 0, skipped: 0, unmatched: 0, ambiguous: 0, mismatched: 0 };
    for (const file of files) {
      const key = selectionKey(file);
      const group = candidates.get(key) || [];
      group.push(file); candidates.set(key, group);
    }
    for (const [key, group] of candidates) {
      const item = this.items.get(this.keys.get(key));
      if (!item) { result.unmatched += group.length; continue; }
      if (item.status === 'completed') { result.skipped += group.length; continue; }
      if (group.length !== 1) { result.ambiguous += group.length; continue; }
      const file = group[0];
      try {
        if (typeof file.slice !== 'function' || (item.fingerprint && await sourceFingerprint(file) !== item.fingerprint)) {
          result.mismatched++; continue;
        }
      } catch { result.mismatched++; continue; }
      if (!item.file) {
        this.missingSources--;
        this.sourceCounts[item.status]++;
        if (item.status === 'failed' && item.error?.auth) this.sourceAuthFailures++;
      }
      item.file = file;
      item.upload = null;
      result.matched++;
    }
    this.notify();
    return result;
  }

  update(item, status, confirmedBytes = item.confirmedBytes, error = item.error) {
    if (item.file) {
      this.sourceCounts[item.status]--;
      this.sourceCounts[status]++;
      if (item.status === 'failed' && item.error?.auth) this.sourceAuthFailures--;
      if (status === 'failed' && error?.auth) this.sourceAuthFailures++;
    }
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
        confirmedBytes: 0, driveFileId: null, error: null, upload: null, attempted: false, resolvedName: null };
      this.items.set(item.id, item);
      this.keys.set(key, item.id);
      this.counts.queued++;
      this.sourceCounts.queued++;
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
    if (item.file) {
      this.sourceCounts[item.status]--;
      if (item.status === 'failed' && item.error?.auth) this.sourceAuthFailures--;
    }
    this.totalBytes -= item.size;
    if (!item.file && item.status !== 'completed') this.missingSources--;
    this.unstarted--;
    this.notify();
    return true;
  }

  start(folderId = this.folderId) {
    if (this.storageError) throw this.storageError;
    if (!folderId || (this.folderId && this.folderId !== folderId)) {
      throw new UploadError('Choose a destination. Once started, this batch keeps the same destination.');
    }
    // A user gesture/reconnect occurs outside this engine; never open OAuth popups here.
    if (!this.getToken()) throw new UploadError('Reconnect Google before resuming.', { auth: true });
    if (this.saveSnapshot) {
      const accountId = this.getAccountId();
      if (!accountId || (this.accountId && accountId !== this.accountId)) {
        throw new UploadError('Reconnect with the original Google account.', { auth: true });
      }
      this.accountId = accountId;
    }
    this.folderId = folderId;
    this.authRequired = false;
    this.enabled = true;
    for (const item of this.items.values()) {
      if (item.status === 'paused' || (item.status === 'failed' && item.error?.auth)) {
        // Aborted workers still occupy their slots until their promises settle.
        if (this.active.has(item.id) || !item.file) continue;
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
        item.upload?.pause();
        if (!item.upload) this.update(item, 'paused');
      }
    }
    this.notify();
  }

  retryFailed() {
    if (!this.counts.failed) return;
    // Validate authorization before mutating failures; start also resumes paused work.
    this.start();
    for (const item of this.items.values()) {
      if (item.status !== 'failed' || !item.file) continue;
      if (this.active.has(item.id)) { item.retryRequested = true; continue; }
      this.update(item, 'queued', item.confirmedBytes, null);
      this.enqueue(item);
    }
    this.notify();
    this.schedule();
  }

  uploadChanged(item, upload) {
    item.driveFileId = upload.fileId;
    item.sessionUrl = upload.sessionUrl || null;
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
      if (!item.file) { this.update(item, 'paused'); continue; }
      if (!item.attempted) this.unstarted--;
      item.attempted = true;
      item.retryRequested = false;
      this.update(item, 'preparing');
      this.active.add(id);
      // Defer invocation so even synchronous failures use the same slot cleanup path.
      void Promise.resolve().then(async () => {
        if (this.saveSnapshot && !item.fingerprint) item.fingerprint = await sourceFingerprint(item.file);
        if (this.enabled && !this.authRequired) {
          const resolvedName = await this.resolveName(item);
          if (!resolvedName) {
            this.update(item, 'skipped', 0, null);
            return;
          }
          item.upload ||= this.createUpload({ ...this.uploadOptions, file: item.file,
            name: resolvedName, folderId: this.folderId, getToken: this.getToken, chunkSize: this.chunkSize,
            recovery: { fileId: item.driveFileId, sessionUrl: item.sessionUrl || null, confirmedBytes: item.confirmedBytes },
            checkpoint: async upload => {
              item.driveFileId = upload.fileId;
              item.sessionUrl = upload.sessionUrl;
              await this.persist();
            }, onChange: (upload) => this.uploadChanged(item, upload) });
          return item.upload.start();
        }
        this.update(item, 'paused');
      }).catch((error) => {
        this.update(item, 'failed', item.confirmedBytes, error);
        if (error.auth) { this.authRequired = true; this.pause(); }
      }).finally(() => {
        this.active.delete(id);
        if (item.status === 'completed' || item.status === 'skipped') {
          // Keep the completion/selection identity, not large live source references.
          if (item.file) this.sourceCounts[item.status]--;
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