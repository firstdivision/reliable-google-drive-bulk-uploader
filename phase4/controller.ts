import { DriveFolders, GoogleAuth } from '../phase1/google.mjs';
import { QueueStore } from '../phase2/queue-store.mjs';
import { UploadQueue } from '../phase2/upload-queue.mjs';

export type DashboardStatus = 'queued' | 'preparing' | 'uploading' | 'paused' | 'retrying' | 'failed' | 'completed';
export interface DashboardItem {
  id: string;
  name: string;
  size: number;
  status: DashboardStatus;
  confirmedBytes: number;
  driveFileId: string | null;
  attempted: boolean;
  hasSource: boolean;
  error: string | null;
}
export interface DashboardSummary {
  total: number;
  totalBytes: number;
  confirmedBytes: number;
  counts: Record<DashboardStatus, number>;
  remaining: number;
  active: number;
  enabled: boolean;
  authRequired: boolean;
  unstarted: number;
  missingSources: number;
  storageError: Error | null;
  saving: boolean;
  resumableSources: number;
  retryableSources: number;
}
export interface DashboardFolder { id: string; name: string }
export interface DashboardWake {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
}
export interface DashboardSnapshot {
  ready: boolean;
  busy: boolean;
  connected: boolean;
  startupError: string;
  actionMessage: string;
  selectionMessage: string;
  storageMessage: string;
  retentionMessage: string;
  folderId: string;
  folderName: string;
  destinationLocked: boolean;
  folders: DashboardFolder[];
  accountLabel: string;
  summary: DashboardSummary;
  wake: DashboardWake;
  online: boolean;
}
export interface DashboardAccount {
  permissionId: string;
  emailAddress?: string;
  displayName?: string;
}
export interface DashboardAuth {
  readonly user: DashboardAccount | null;
  connect(): Promise<DashboardAccount>;
  getToken(): string;
  invalidate(): void;
  resetAccount(): void;
}
export interface DashboardFolders {
  list(): Promise<DashboardFolder[]>;
  create(name: string): Promise<DashboardFolder>;
  resetPending?(): void;
}
export interface DashboardStore {
  open(): Promise<unknown>;
  load(): Promise<unknown>;
  save(snapshot: unknown): Promise<unknown>;
  close(): void;
}
export interface DashboardQueueItem extends Omit<DashboardItem, 'hasSource' | 'error'> {
  file: File | null;
  error: { message: string } | null;
}
export interface DashboardQueue {
  readonly summary: DashboardSummary;
  readonly items: ReadonlyMap<string, DashboardQueueItem>;
  readonly accountId: string | null;
  readonly folderId: string | null;
  readonly active: ReadonlySet<string>;
  readonly saving: Promise<unknown> | null;
  saveSnapshot: ((snapshot: unknown) => Promise<unknown>) | null;
  restore(snapshot: unknown): void;
  snapshot(): unknown;
  add(files: File[]): { added: number; duplicates: number; rejected: number };
  reconnectSources(files: File[]): Promise<{ matched: number; skipped: number; unmatched: number; ambiguous: number; mismatched: number }>;
  start(folderId?: string): void;
  pause(): void;
  retryFailed(): void;
  remove(id: string): boolean;
  retryStorage(): Promise<void>;
  persist(): Promise<void>;
}
export interface DashboardQueueOptions {
  getToken(): string;
  getAccountId(): string | null;
  onChange(): void;
}
export interface DashboardLockManager {
  request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<unknown>;
}
export interface DashboardWakeSentinel {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
export interface DashboardNavigator {
  readonly onLine?: boolean;
  locks?: DashboardLockManager;
  storage?: { persist(): Promise<boolean> };
  wakeLock?: { request(type: 'screen'): Promise<DashboardWakeSentinel> };
}
export interface DashboardDocument extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  readonly visibilityState: string;
}
export interface DashboardWindow extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  readonly isSecureContext: boolean;
}
export interface DashboardControllerOptions {
  auth?: DashboardAuth;
  folders?: DashboardFolders;
  store?: DashboardStore;
  lockManager?: DashboardLockManager;
  document?: DashboardDocument;
  window?: DashboardWindow;
  navigator?: DashboardNavigator;
  queueFactory?: (options: DashboardQueueOptions) => DashboardQueue;
  startupTimeoutMs?: number;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed. Try again.';
const isAuthError = (error: unknown): boolean => typeof error === 'object' && error !== null && 'auth' in error && Boolean(error.auth);

export class DashboardController {
  private readonly auth: DashboardAuth;
  private readonly foldersApi: DashboardFolders;
  private readonly store: DashboardStore;
  private queue: DashboardQueue;
  private readonly createQueue: () => DashboardQueue;
  private resetting = false;
  private readonly locks?: DashboardLockManager;
  private readonly document?: DashboardDocument;
  private readonly window?: DashboardWindow;
  private readonly navigator?: DashboardNavigator;
  private readonly listeners = new Set<() => void>();
  private readonly queueWaiters = new Set<() => void>();
  private readonly writes = new Set<Promise<unknown>>();
  private snapshot: DashboardSnapshot;
  private ready = false;
  private busy = true;
  private connected = false;
  private lastAuthRequired = false;
  private startupError = '';
  private actionMessage = '';
  private selectionMessage = '';
  private retentionMessage = '';
  private folderId = '';
  private folders: DashboardFolder[] = [];
  private accountLabel = '';
  private disposed = false;
  private initialization?: Promise<void>;
  private readonly startupTimeoutMs: number;
  private startupStopped = false;
  private finishStartup?: () => void;
  private disposal?: Promise<void>;
  private lockTask?: Promise<unknown>;
  private releaseWriter?: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private wake: DashboardWake;
  private wakeSentinel: DashboardWakeSentinel | null = null;
  private wakeTask?: Promise<void>;
  private readonly wakeReleases = new Set<Promise<void>>();
  private resumeWake = false;

  constructor(options: DashboardControllerOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15000;
    this.document = options.document ?? globalThis.document;
    this.window = options.window ?? globalThis.window;
    this.navigator = options.navigator ?? globalThis.navigator;
    this.locks = options.lockManager ?? this.navigator?.locks;
    this.store = options.store ?? new QueueStore();
    this.auth = options.auth ?? new (GoogleAuth as unknown as new (options: { getExpectedAccountId(): string | null }) => DashboardAuth)({
      getExpectedAccountId: () => this.queue.accountId,
    });
    this.foldersApi = options.folders ?? new (DriveFolders as unknown as new (auth: DashboardAuth) => DashboardFolders)(this.auth);
    const queueOptions: DashboardQueueOptions = {
      getToken: () => this.auth.getToken(),
      getAccountId: () => this.auth.user?.permissionId ?? null,
      onChange: () => this.queueChanged(),
    };
    this.createQueue = () => options.queueFactory ? options.queueFactory(queueOptions)
      : new (UploadQueue as unknown as new (options: DashboardQueueOptions) => DashboardQueue)(queueOptions);
    this.queue = this.createQueue();
    const supported = Boolean(this.window?.isSecureContext && this.navigator?.wakeLock?.request);
    this.wake = { supported, enabled: false, active: false, message: supported ? 'Supported; currently off.'
      : 'Unavailable. Use HTTPS and a supporting browser, or keep the screen awake manually.' };
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): DashboardSnapshot => this.snapshot;

  private buildSnapshot(): DashboardSnapshot {
    const summary = this.queue.summary;
    const folderId = this.queue.folderId || this.folderId;
    return {
      ready: this.ready, busy: this.busy, connected: this.connected,
      startupError: this.startupError, actionMessage: this.actionMessage,
      selectionMessage: this.selectionMessage, retentionMessage: this.retentionMessage,
      storageMessage: this.startupError || (summary.storageError ? summary.storageError.message : !this.ready
        ? 'Opening saved queue...' : summary.saving ? 'Saving queue metadata on this device...'
          : 'Queue metadata saved on this device. Browser data clearing can still remove it.'),
      folderId, folderName: this.folders.find(folder => folder.id === folderId)?.name || (folderId ? 'Saved batch destination' : ''),
      destinationLocked: Boolean(this.queue.folderId),
      folders: this.folders.map(folder => ({ ...folder })), accountLabel: this.accountLabel,
      summary, wake: { ...this.wake }, online: this.navigator?.onLine !== false,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private queueChanged(): void {
    for (const resolve of this.queueWaiters) resolve();
    this.queueWaiters.clear();
    if (this.disposed) return;
    const authRequired = this.queue.summary.authRequired;
    const newAuthFailure = authRequired && !this.lastAuthRequired;
    this.lastAuthRequired = authRequired;
    if (newAuthFailure && this.connected) {
      this.connected = false;
      this.auth.invalidate();
      this.actionMessage = 'Batch paused for authorization. Reconnect with the original Google account, then resume.';
      this.queue.pause();
    }
    this.renderTimer ??= setTimeout(() => { this.renderTimer = undefined; this.emit(); }, 100);
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.disposed) return Promise.resolve();
    this.window?.addEventListener('pagehide', this.pagehide);
    this.window?.addEventListener('online', this.networkChanged);
    this.window?.addEventListener('offline', this.networkChanged);
    this.document?.addEventListener('visibilitychange', this.visibilityChanged);
    let initialized!: () => void;
    this.initialization = new Promise(resolve => { initialized = resolve; });
    const held = new Promise<void>(resolve => { this.releaseWriter = resolve; });
    let stage = 'acquiring the batch tab lock';
    const deadline = setTimeout(() => {
      this.startupFailed(new Error(`Startup timed out while ${stage}. Close other BatchHarbor tabs, then reload. If it repeats, report this stage; do not clear website data to retry.`));
    }, this.startupTimeoutMs);
    this.finishStartup = () => { clearTimeout(deadline); initialized(); };
    try {
      if (!this.locks?.request) throw new Error('This browser cannot safely lock the saved queue. Use a current browser over HTTPS.');
      this.lockTask = this.locks.request('batchharbor-queue-writer', { ifAvailable: true }, async lock => {
        if (this.disposed || this.startupStopped) return;
        if (!lock) throw new Error('This batch is open in another tab. Close that tab, then reload this page.');
        stage = 'opening browser queue storage';
        await this.store.open();
        if (this.disposed || this.startupStopped) { this.store.close(); return; }
        stage = 'reading the saved batch';
        const saved = await this.store.load();
        if (this.disposed || this.startupStopped) { this.store.close(); return; }
        stage = 'validating the saved batch';
        if (saved !== null) this.queue.restore(saved);
        this.queue.saveSnapshot = snapshot => this.store.save(snapshot);
        this.ready = true;
        this.busy = false;
        this.emit();
        this.finishStartup?.();
        await held;
      }).catch(error => { this.startupFailed(error); }).finally(() => this.finishStartup?.());
    } catch (error) {
      this.startupFailed(error);
    }
    return this.initialization;
  }

  private startupFailed(error: unknown): void {
    if (this.disposed || this.startupStopped) return;
    this.startupStopped = true;
    this.finishStartup?.();
    this.store.close();
    this.releaseWriter?.();
    this.startupError = `${messageOf(error)} Saved data has not been replaced. Reload to retry.`;
    this.ready = false;
    this.busy = true;
    this.emit();
  }

  private requireReady(storage = true): void {
    if (this.disposed) throw new Error('This dashboard is closed.');
    if (!this.ready) throw new Error(this.startupError || 'Wait for the saved queue to open.');
    if (this.busy) throw new Error('Wait for the current operation to finish.');
    if (storage && this.queue.summary.storageError) throw this.queue.summary.storageError;
  }

  private requireIdle(): void {
    if (this.queue.summary.enabled || this.queue.active.size) throw new Error('Pause uploads and wait for active requests to stop first.');
  }

  private requireConnected(): void {
    if (!this.connected) throw Object.assign(new Error('Connect Google Drive before continuing.'), { auth: true });
    this.auth.getToken();
  }

  private failure(error: unknown): void {
    if (this.disposed) return;
    if (isAuthError(error)) {
      this.connected = false;
      this.auth.invalidate();
      if (this.ready) this.queue.pause();
    }
    this.actionMessage = messageOf(error);
  }

  private action(work: () => void): void {
    if (this.disposed) return;
    try { this.requireReady(); this.actionMessage = ''; work(); }
    catch (error) { this.failure(error); }
    this.emit();
  }

  private async asyncAction(work: () => Promise<void>, storage = true): Promise<void> {
    if (this.disposed) return;
    try { this.requireReady(storage); }
    catch (error) { this.failure(error); this.emit(); return; }
    this.busy = true;
    this.actionMessage = '';
    try {
      const pending = work();
      this.emit();
      await pending;
    } catch (error) { this.failure(error); }
    finally { this.busy = false; this.emit(); }
  }

  connect(): Promise<void> {
    return this.asyncAction(async () => {
      this.requireIdle();
      this.connected = false;
      const user = await this.auth.connect();
      if (this.disposed) { this.auth.invalidate(); return; }
      if (this.queue.accountId && user.permissionId !== this.queue.accountId) {
        throw Object.assign(new Error('Reconnect with the original Google account to preserve this upload and destination.'), { auth: true });
      }
      this.connected = true;
      this.accountLabel = user.emailAddress || user.displayName || 'Your Google account';
      this.actionMessage = 'Connected. Upload or resume when ready.';
      if (!this.queue.folderId) await this.loadFolders();
    }, false);
  }

  select(files: File[]): void {
    this.action(() => {
      if (this.queue.summary.missingSources) throw new Error('Reconnect the original source files before adding more files.');
      const result = this.queue.add(files);
      this.selectionMessage = `${result.added} added; ${result.duplicates} matching selections skipped; ${result.rejected} empty or invalid files skipped.`;
    });
  }

  private trackWrite<T>(promise: Promise<T>): Promise<T> {
    this.writes.add(promise);
    void promise.then(() => this.writes.delete(promise), () => this.writes.delete(promise));
    return promise;
  }

  reconnectSources(files: File[]): Promise<void> {
    return this.asyncAction(async () => {
      this.requireIdle();
      const result = await this.trackWrite(this.queue.reconnectSources(files));
      if (this.disposed) return;
      this.selectionMessage = `${result.matched} reconnected; ${result.skipped} completed selections skipped; ${result.unmatched} unmatched; ${result.ambiguous} ambiguous; ${result.mismatched} changed or unreadable. No unmatched files were added.`;
    });
  }

  chooseFolder(id: string): void {
    this.action(() => {
      this.requireConnected();
      if (this.queue.folderId) throw new Error('Once started, this batch keeps the same destination.');
      if (id && !this.folders.some(folder => folder.id === id)) throw new Error('Choose an app-accessible destination folder.');
      this.folderId = id;
    });
  }

  private async loadFolders(): Promise<void> {
    const folders = await this.foldersApi.list();
    if (this.disposed) return;
    this.folders = folders;
    if (!this.queue.folderId && !folders.some(folder => folder.id === this.folderId)) this.folderId = '';
  }

  refreshFolders(): Promise<void> {
    return this.asyncAction(async () => { this.requireConnected(); await this.loadFolders(); });
  }

  createFolder(name: string): Promise<void> {
    return this.asyncAction(async () => {
      this.requireConnected();
      if (this.queue.folderId) throw new Error('Once started, this batch keeps the same destination.');
      const folder = await this.foldersApi.create(name);
      if (this.disposed) return;
      this.folders = [...this.folders.filter(current => current.id !== folder.id), folder];
      this.folderId = folder.id;
    });
  }

  start(): void {
    this.action(() => {
      this.requireConnected();
      const summary = this.queue.summary;
      if (summary.remaining === summary.missingSources) throw new Error('Select or reconnect source files before uploading.');
      this.queue.start(this.queue.folderId || this.folderId);
    });
  }

  pause(): void {
    if (!this.ready || this.disposed || this.resetting) return;
    this.queue.pause();
    this.emit();
  }

  retryFailed(): void {
    this.action(() => {
      this.requireConnected();
      if (this.queue.summary.remaining === this.queue.summary.missingSources) throw new Error('Reconnect source files before retrying.');
      this.queue.retryFailed();
      this.actionMessage = 'Failed files requeued; paused work resumed. Completed files stay completed.';
    });
  }

  remove(id: string): void {
    this.action(() => {
      if (!this.queue.remove(id)) throw new Error('Only unstarted files can be removed from this queue.');
      this.selectionMessage = 'Removed from this queue only. No source or Drive files were deleted.';
    });
  }

  async startNewBatch(confirmed: boolean): Promise<boolean> {
    let replaced = false;
    await this.asyncAction(async () => {
      if (!confirmed) throw new Error('Confirm that you checked Drive and accept losing saved recovery and duplicate-prevention history.');
      this.requireIdle();
      this.resetting = true;
      try {
        await this.trackWrite((async () => {
          const previous = this.queue;
          if (previous.saving) await previous.saving.catch(() => {});
          if (this.disposed) return;
          await this.store.open();
          if (this.disposed) return;
          const next = this.createQueue();
          await this.store.save(next.snapshot());
          previous.saveSnapshot = null;
          this.queue = next;
          next.saveSnapshot = snapshot => this.store.save(snapshot);
          this.auth.resetAccount();
          this.foldersApi.resetPending?.();
          this.connected = false;
          this.lastAuthRequired = false;
          this.folderId = '';
          this.folders = [];
          this.accountLabel = '';
          this.selectionMessage = '';
          this.actionMessage = 'New batch ready. Previous local recovery records were cleared. No originals or Drive files were deleted.';
          replaced = true;
        })());
      } finally { this.resetting = false; }
    }, false);
    return replaced;
  }

  retryStorage(): Promise<void> {
    return this.asyncAction(async () => {
      this.requireIdle();
      await this.trackWrite((async () => { await this.store.open(); if (!this.disposed) await this.queue.retryStorage(); })());
    }, false);
  }

  protectStorage(): Promise<void> {
    return this.asyncAction(async () => {
      if (!this.navigator?.storage?.persist) {
        this.retentionMessage = 'Storage protection unavailable. Saved records may be evicted.';
        return;
      }
      try {
        const granted = await this.navigator.storage.persist();
        if (this.disposed) return;
        this.retentionMessage = granted ? 'Storage protection granted. Clearing site data still removes saved recovery records.'
          : 'Storage protection not granted. The browser may evict saved recovery records.';
      } catch (error) {
        if (!this.disposed) this.retentionMessage = `Storage protection unavailable: ${messageOf(error)} Saved records may be evicted.`;
        throw error;
      }
    }, false);
  }

  getItems(): readonly DashboardItem[] {
    return Array.from(this.queue.items.values(), item => ({
      id: item.id, name: item.name, size: item.size, status: item.status,
      confirmedBytes: item.confirmedBytes, driveFileId: item.driveFileId,
      attempted: item.attempted, hasSource: Boolean(item.file), error: item.error?.message || null,
    }));
  }

  private networkChanged = (): void => { this.emit(); };
  private pagehide = (): void => { this.pause(); };
  private visibilityChanged = (): void => {
    if (this.disposed) return;
    if (this.document?.visibilityState === 'visible' && this.wake.enabled) {
      this.resumeWake = true;
      void this.acquireWake();
    }
    this.emit();
  };

  async setWake(enabled: boolean): Promise<void> {
    if (this.disposed || !this.wake.supported) return;
    this.wake.enabled = enabled;
    if (enabled) await this.acquireWake();
    else {
      this.resumeWake = false;
      const previous = this.wakeSentinel;
      this.wakeSentinel = null;
      this.wake.active = false;
      this.wake.message = 'Keep Awake is off.';
      this.emit();
      if (previous) await this.releaseWake(previous);
    }
    this.emit();
  }

  private releaseWake(sentinel: DashboardWakeSentinel): Promise<void> {
    const release = (async () => {
      try { await sentinel.release(); }
      catch (error) { this.wake.message = `Release could not be confirmed: ${messageOf(error)}`; this.emit(); }
    })();
    this.wakeReleases.add(release);
    void release.then(() => this.wakeReleases.delete(release));
    return release;
  }

  private acquireWake(): Promise<void> {
    if (this.wakeTask) return this.wakeTask;
    if (this.disposed || !this.wake.enabled || this.wakeSentinel || this.document?.visibilityState !== 'visible') return Promise.resolve();
    this.resumeWake = false;
    this.wake.message = 'Requesting screen wake lock...';
    this.emit();
    this.wakeTask = (async () => {
      try {
        const acquired = await this.navigator!.wakeLock!.request('screen');
        if (this.disposed || !this.wake.enabled || this.document?.visibilityState !== 'visible') {
          await this.releaseWake(acquired);
          this.wake.message = this.wake.enabled ? 'Not active while the page is hidden.' : 'Keep Awake is off.';
          return;
        }
        if (acquired.released) {
          this.wake.message = 'Not active: the browser released the lock before acquisition completed.';
          return;
        }
        this.wakeSentinel = acquired;
        this.wake.active = true;
        this.wake.message = 'Active: screen wake lock acquired.';
        acquired.addEventListener('release', () => {
          if (this.wakeSentinel !== acquired) return;
          this.wakeSentinel = null;
          this.wake.active = false;
          this.wake.message = this.wake.enabled ? 'Released by browser/system. Return to this page or disable and re-enable to retry.' : 'Keep Awake is off.';
          if (this.resumeWake) void this.acquireWake();
          this.emit();
        });
      } catch (error) {
        this.wake.message = this.wake.enabled ? `Not active: ${messageOf(error)} Keep the device awake manually; disable and re-enable to retry.` : 'Keep Awake is off.';
      }
    })().finally(() => {
      this.wakeTask = undefined;
      if (this.resumeWake) void this.acquireWake();
      this.emit();
    });
    return this.wakeTask;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (!this.ready) {
      this.startupStopped = true;
      this.finishStartup?.();
      this.store.close();
      this.releaseWriter?.();
    }
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    this.listeners.clear();
    this.window?.removeEventListener('pagehide', this.pagehide);
    this.window?.removeEventListener('online', this.networkChanged);
    this.window?.removeEventListener('offline', this.networkChanged);
    this.document?.removeEventListener('visibilitychange', this.visibilityChanged);
    this.wake.enabled = false;
    this.resumeWake = false;
    const previous = this.wakeSentinel;
    this.wakeSentinel = null;
    this.wake.active = false;
    if (previous) void this.releaseWake(previous);
    if (this.ready && !this.resetting) this.queue.pause();
    this.disposal = (async () => {
      await this.initialization;
      await Promise.allSettled([...this.writes]);
      while (this.queue.active.size) await new Promise<void>(resolve => this.queueWaiters.add(resolve));
      await Promise.resolve();
      if (this.queue.saving) await this.queue.saving.catch(() => {});
      if (this.ready && !this.queue.summary.storageError) {
        try { await this.queue.persist(); }
        catch (error) { this.actionMessage = messageOf(error); }
      }
      this.queue.saveSnapshot = null;
      this.store.close();
      this.releaseWriter?.();
      if (!this.startupStopped) await this.lockTask;
      await this.wakeTask;
      await Promise.all([...this.wakeReleases]);
      this.auth.invalidate();
      this.connected = false;
      this.ready = false;
      this.busy = false;
      this.snapshot = this.buildSnapshot();
    })();
    return this.disposal;
  }
}