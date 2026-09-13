export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${value.toFixed(2)} ${units[index]}`;
}

export function formatPercent(summary) {
  if (summary.total > 0 && summary.remaining === 0) return '100.0';
  const percent = summary.totalBytes ? 100 * summary.confirmedBytes / summary.totalBytes : 0;
  return Math.min(99.9, percent).toFixed(1);
}

export function dashboardState({ summary, ready, busy, connected, folderId, startupError = '' }) {
  const { counts, remaining, missingSources, active, enabled, storageError } = summary;
  const complete = summary.total > 0 && remaining === 0;
  const blockers = [];
  if (startupError) blockers.push({ kind: 'startup', message: startupError });
  else if (!ready) blockers.push({ kind: 'loading', message: 'Opening saved batch...' });
  if (storageError) blockers.push({ kind: 'storage', message: storageError.message });
  if (missingSources) blockers.push({ kind: 'sources', message:
    `${missingSources.toLocaleString()} ${missingSources === 1 ? 'file needs' : 'files need'} to be selected again. The list is saved; access to the originals is not.` });
  if (!connected && !complete && ready) blockers.push({ kind: 'account', message:
    'Connect the original Google account before uploading.' });
  if (!folderId && connected) blockers.push({ kind: 'folder', message: 'Choose a destination folder.' });
  const available = remaining > missingSources;
  const allowed = ready && !busy && !storageError && connected && Boolean(folderId) && available;
  return {
    complete, blockers,
    canResume: allowed && !enabled && summary.resumableSources > 0,
    canRetry: allowed && summary.retryableSources > 0,
    title: startupError ? 'Batch unavailable' : !ready ? 'Opening your batch' :
      storageError ? 'Saving needs attention' : summary.authRequired ? 'Reconnect Google' :
      enabled ? 'Uploading to Google Drive' : active ? 'Pausing uploads' : complete ? 'Batch complete' :
      missingSources ? 'Reconnect your originals' : counts.failed ? 'Some files need attention' :
      counts.skipped ? 'Some files were skipped' :
      counts.paused ? 'Your batch is paused' : 'Ready to upload',
  };
}

export class TransferEstimate {
  constructor() { this.reset(); }
  reset() { this.samples = []; this.total = null; }
  update(summary, now = performance.now()) {
    if (!summary.enabled || summary.authRequired || summary.storageError || summary.counts.retrying ||
        summary.confirmedBytes >= summary.totalBytes) { this.reset(); return null; }
    const last = this.samples.at(-1);
    if (this.total !== summary.totalBytes || (last && summary.confirmedBytes < last.bytes)) this.reset();
    this.total = summary.totalBytes;
    this.samples.push({ time: now, bytes: summary.confirmedBytes });
    while (this.samples.length > 2 && this.samples[1].time < now - 30000) this.samples.shift();
    const first = this.samples[0];
    const elapsed = (now - first.time) / 1000;
    const bytes = summary.confirmedBytes - first.bytes;
    if (elapsed < 5 || bytes <= 0) return null;
    return { bytesPerSecond: bytes / elapsed, seconds: (summary.totalBytes - summary.confirmedBytes) * elapsed / bytes };
  }
}

export function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Calculating remaining time';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `About ${minutes} min remaining`;
  return `About ${Math.floor(minutes / 60)} hr ${minutes % 60} min remaining`;
}