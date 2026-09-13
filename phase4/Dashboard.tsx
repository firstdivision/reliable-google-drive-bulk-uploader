import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Coffee, Folder,
  FolderPlus, ImagePlus, Link2, ListFilter, LoaderCircle, Pause, Play, RefreshCw, RotateCcw,
  ShieldCheck, TriangleAlert, Trash2, Upload, Wifi, WifiOff } from 'lucide-react';
import type { DashboardController, DashboardSnapshot } from './controller';
import { dashboardState, formatBytes, formatPercent, formatRemaining, TransferEstimate } from './dashboard-model.mjs';

const logo = new URL('../assets/brand/reliable-uploader-logo.png', import.meta.url).href;

type Props = { controller: DashboardController };
type FilePickerProps = { id: string; label: string; disabled: boolean; onFiles(files: File[]): void; recovery?: boolean };

function FilePicker({ id, label, disabled, onFiles, recovery = false }: FilePickerProps) {
  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (files.length) onFiles(files);
  };
  return <label className={`file-picker ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
    {recovery ? <Link2 size={20} aria-hidden="true" /> : <ImagePlus size={20} aria-hidden="true" />}
    <span>{label}</span>
    <input id={id} type="file" accept="image/*,video/*" multiple disabled={disabled} onChange={select} />
  </label>;
}

function WakeControl({ controller, state }: Props & { state: DashboardSnapshot }) {
  return <section className={`wake-strip ${state.wake.active ? 'wake-active' : ''}`} aria-label="Keep screen awake">
    <Coffee size={26} aria-hidden="true" />
    <div><strong>Keep screen awake</strong><p id="wake-description">{state.wake.active ? 'Active' : state.wake.message}</p></div>
    <button className="switch" role="switch" aria-checked={state.wake.enabled} aria-label="Keep screen awake"
      aria-describedby="wake-description" disabled={!state.wake.supported}
      onClick={() => void controller.setWake(!state.wake.enabled)}><span /></button>
  </section>;
}

function Destination({ controller, state }: Props & { state: DashboardSnapshot }) {
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [name, setName] = useState('');
  const pinned = state.destinationLocked;
  const disabled = !state.ready || state.busy || !state.connected || pinned;
  return <div className="destination-fields">
    <div className="account-row"><div><span className="field-caption">Google account</span>
      <strong>{state.connected ? state.accountLabel : 'Not connected'}</strong></div>
      <button className="button secondary" disabled={!state.ready || state.busy || state.summary.active > 0 || state.summary.enabled}
        onClick={() => void controller.connect()}><Link2 size={17} aria-hidden="true" />{state.connected ? 'Reconnect' : 'Connect Google'}</button></div>
    <button className="button secondary" disabled={disabled} onClick={() => {
      setBrowsing(true);
      void controller.browseFolders().finally(() => setBrowsing(false));
    }}><Folder size={18} />Browse Google Drive</button>
    {browsing && <div role="status"><p className="small">Opening Google Drive folder selection...</p>
      <button className="text-button" onClick={() => controller.cancelFolderBrowse()}>Cancel folder selection</button></div>}
    <label htmlFor="destination">Destination folder</label>
    <div className="folder-input"><Folder size={20} aria-hidden="true" />
      <select id="destination" disabled={disabled} value={state.folderId} onChange={event => controller.chooseFolder(event.target.value)}>
        <option value="">Choose a folder</option>
        {state.folderId && !state.folders.some(folder => folder.id === state.folderId) &&
          <option value={state.folderId}>Saved batch destination</option>}
        {state.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select>
      <button className="icon-button" title="Refresh folders" aria-label="Refresh folders" disabled={disabled}
        onClick={() => void controller.refreshFolders()}><RefreshCw size={18} /></button>
    </div>
    <div className="folder-links"><button className="text-button" disabled={disabled} onClick={() => setCreating(!creating)}>
      <FolderPlus size={17} aria-hidden="true" />New folder</button>
      {state.folderId && <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(state.folderId)}`} target="_blank" rel="noopener noreferrer">Open in Drive <ArrowRight size={15} /></a>}</div>
    {creating && !pinned && <form className="new-folder" onSubmit={event => {
      event.preventDefault(); if (name.trim()) void controller.createFolder(name);
    }}><label htmlFor="new-folder-name">Folder name</label><div className="inline-field">
      <input id="new-folder-name" value={name} onChange={event => setName(event.target.value)} maxLength={150} disabled={disabled} required />
      <button className="button secondary" disabled={disabled || !name.trim()} type="submit">Create</button>
    </div></form>}
    <p className="small muted">Browse your existing Drive folders, or choose a previously authorized folder above. The destination stays fixed once uploading starts.</p>
  </div>;
}

function FileDetails({ controller, state }: Props & { state: DashboardSnapshot }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const items = controller.getItems().filter(item => filter === 'failed' ? item.status === 'failed' : filter === 'sources' ? !item.hasSource && item.status !== 'completed' : true);
  const pages = Math.max(1, Math.ceil(items.length / 50));
  const current = Math.min(page, pages - 1);
  return <div className="file-details">
    <div className="detail-toolbar"><label htmlFor="file-filter"><ListFilter size={17} aria-hidden="true" />Show</label>
      <select id="file-filter" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}>
        <option value="all">All files</option><option value="failed">Failed files</option><option value="sources">Sources needed</option>
      </select><span className="muted small">{items.length.toLocaleString()} files</span></div>
    <ul className="file-list">{items.slice(current * 50, current * 50 + 50).map(item => <li key={item.id}>
      <div className="file-info"><strong>{item.name}</strong><span>{formatBytes(item.size)} <span aria-hidden="true"> / </span>
        {item.status}{!item.hasSource && item.status !== 'completed' ? ' / select original again' : ''}</span>
        {item.error && <p className="error-text">{item.error}</p>}</div>
      {item.status === 'completed' && item.driveFileId && <a className="icon-button" title={`Open ${item.name} in Drive`}
        aria-label={`Open ${item.name} in Drive`} href={`https://drive.google.com/file/d/${encodeURIComponent(item.driveFileId)}/view`} target="_blank" rel="noopener noreferrer"><ArrowRight size={18} /></a>}
      {!item.attempted && <button className="icon-button" title={`Remove ${item.name} from queue`} aria-label={`Remove ${item.name} from queue`}
        disabled={state.busy || !state.ready || Boolean(state.summary.storageError)} onClick={() => controller.remove(item.id)}><Trash2 size={18} /></button>}
    </li>)}</ul>
    {!items.length && <p className="empty-details">No files in this view.</p>}
    <div className="pagination"><button className="icon-button" aria-label="Previous page" title="Previous page" disabled={!current} onClick={() => setPage(current - 1)}><ArrowLeft size={18} /></button>
      <span>Page {current + 1} of {pages}</span><button className="icon-button" aria-label="Next page" title="Next page" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}><ArrowRight size={18} /></button></div>
  </div>;
}

export function NewBatchControl({ controller, state }: Props & { state: DashboardSnapshot }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const disabled = !state.ready || state.busy || state.summary.enabled || state.summary.active > 0;
  return <section className="new-batch-section" aria-label="Start a new batch">
    {!confirming ? <button className="button secondary" disabled={disabled} onClick={() => { setConfirmed(false); setConfirming(true); }}>
      <FolderPlus size={18} />Start new batch</button> : <form aria-labelledby="reset-title" onSubmit={event => {
      event.preventDefault();
      void controller.startNewBatch(confirmed).then(success => { if (success) { setConfirming(false); setConfirmed(false); } });
    }}>
      <h2 id="reset-title">Discard this batch's local records?</h2>
      <p>This clears {state.summary.total.toLocaleString()} file records, including {state.summary.counts.completed.toLocaleString()} completed entries, saved progress, and the destination. Recovery and duplicate-prevention history for this batch will be lost. Uploading the same files again may create duplicates.</p>
      <p>No original photos or videos and no files already in Google Drive will be deleted. Check Drive before continuing.</p>
      {state.folderId && <p><a href={`https://drive.google.com/drive/folders/${encodeURIComponent(state.folderId)}`} target="_blank" rel="noopener noreferrer">Inspect destination in Drive <ArrowRight size={16} /></a></p>}
      <label className="reset-confirm"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />
        <span>I checked Drive and accept losing this batch's recovery and duplicate-prevention history.</span></label>
      <div className="reset-actions"><button type="button" className="button secondary" disabled={state.busy} onClick={() => { setConfirming(false); setConfirmed(false); }}>Cancel</button>
        <button type="submit" className="button retry" disabled={disabled || !confirmed}><FolderPlus size={18} />Clear records and start new batch</button></div>
    </form>}
    {disabled && <p className="small muted">{!state.ready ? 'Saved storage must open safely before a batch can be replaced.' : state.busy ? 'Wait for the current operation to finish.' : 'Pause uploads and wait for active requests to stop before starting a new batch.'}</p>}
  </section>;
}

export function Dashboard({ controller }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const summary = state.summary;
  const view = dashboardState({ ...state });
  const [details, setDetails] = useState(false);
  const [settings, setSettings] = useState(false);
  const [setupOverride, setSetupOverride] = useState(false);
  const estimator = useRef(new TransferEstimate());
  const [estimate, setEstimate] = useState<{ bytesPerSecond: number; seconds: number } | null>(null);
  useEffect(() => {
    const sample = () => setEstimate(estimator.current.update(controller.getSnapshot().summary));
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [controller]);
  const started = summary.total > 0 && (state.destinationLocked || summary.missingSources > 0);
  const setup = !started || setupOverride;
  const sourceDisabled = !state.ready || state.busy || summary.enabled || summary.active > 0 || Boolean(summary.storageError);
  const selectionDisabled = !state.ready || state.busy || summary.missingSources > 0 || Boolean(summary.storageError);
  const blockers = view.blockers.filter(item => item.kind !== 'account' || started);
  const begin = () => { controller.start(); setSetupOverride(false); };
  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="../"><img src={logo} alt="" /><span>BatchHarbor</span></a>
      <span className="private-label"><ShieldCheck size={16} aria-hidden="true" />Direct to your Drive</span>
      <span className={`connection ${state.online ? '' : 'offline'}`} title={state.online ? 'Browser reports online' : 'Browser reports offline'}>
        {state.online ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{state.online ? 'Online' : 'Offline'}</span></span>
    </header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">{setup ? 'YOUR NEXT BATCH' : 'BATCH OVERVIEW'}</p>
        <h1>{!state.ready ? view.title : setup ? 'A little setup. A lot uploaded.' : view.title}</h1></div>
        {started && <button className="text-button" onClick={() => setSetupOverride(!setupOverride)}>{setupOverride ? 'Back to progress' : 'Batch settings'}<ArrowRight size={16} /></button>}
      </div>
      {!state.online && <div className="notice warning" role="status"><WifiOff size={21} /><div><strong>Connection interrupted</strong><p>Keep this page open. Uploads retry automatically; permanent failures remain available under Retry Failed.</p></div></div>}
      {blockers.length > 0 && <section className="recovery-panel" aria-labelledby="recovery-title">
        <div className="section-heading"><div className="heading-with-icon"><TriangleAlert size={21} /><h2 id="recovery-title">{summary.missingSources ? 'Your batch is saved. Reconnect the files.' : 'Before you continue'}</h2></div></div>
        {blockers.map(blocker => <div className="recovery-step" key={blocker.kind}>
          <p>{blocker.message}</p>
          {blocker.kind === 'sources' && <FilePicker id="recovery-files" label="Select originals again" recovery disabled={sourceDisabled} onFiles={files => void controller.reconnectSources(files)} />}
          {blocker.kind === 'account' && <button className="button secondary" disabled={!state.ready || state.busy || summary.enabled || summary.active > 0} onClick={() => void controller.connect()}><Link2 size={18} />Connect Google</button>}
          {blocker.kind === 'storage' && <button className="button secondary" disabled={state.busy || summary.active > 0} onClick={() => void controller.retryStorage()}><RotateCcw size={18} />Retry saving</button>}
          {blocker.kind === 'startup' && <><button className="button secondary" onClick={() => window.location.reload()}><RefreshCw size={18} />Reload saved batch</button>
            <p className="small">Uploads and batch reset remain disabled until storage opens safely. Reloading does not clear saved records.</p></>}
        </div>)}
        {summary.missingSources > 0 && <p className="small">Choose the same photos and videos, including completed ones if easier. Completed files are skipped. Reconnecting does not upload anything until you resume.</p>}
      </section>}
      {state.selectionMessage && (setup || summary.missingSources > 0) && <p className="selection-message" role="status">{state.selectionMessage}</p>}
      {setup ? <section className="setup-layout" aria-label="Batch setup">
        <div className="setup-step"><div className="step-heading"><span className="step-number">01</span><h2>Choose your photos &amp; videos</h2></div>
          <div className="selection-summary"><div className="selection-icon"><ImagePlus size={30} /></div><div><strong>{summary.total.toLocaleString()}</strong><span>files selected <span aria-hidden="true"> / </span> {formatBytes(summary.totalBytes)}</span></div></div>
          <FilePicker id="select-files" label={summary.total ? 'Add more files' : 'Select photos & videos'} disabled={selectionDisabled} onFiles={files => controller.select(files)} />
          <p className="small muted">Your media goes directly to Google Drive, never through our servers.</p>
        </div>
        <div className="setup-step"><div className="step-heading"><span className="step-number">02</span><h2>Choose where they go</h2></div><Destination controller={controller} state={state} /></div>
      </section> : <section className="progress-section" aria-labelledby="progress-heading">
        <div className="destination-summary"><Folder size={20} /><div><span className="small muted">Uploading to</span><strong>{state.folderName || 'Saved batch destination'}</strong></div>
          {state.folderId && <a className="icon-button" aria-label="Open destination in Drive" title="Open destination in Drive" href={`https://drive.google.com/drive/folders/${encodeURIComponent(state.folderId)}`} target="_blank" rel="noopener noreferrer"><ArrowRight size={20} /></a>}</div>
        <div className="progress-heading"><div><h2 id="progress-heading">{view.complete ? 'All files uploaded' : 'Batch progress'}</h2><p>{summary.counts.completed.toLocaleString()} of {summary.total.toLocaleString()} files complete</p></div>
          <strong className="percentage">{formatPercent(summary)}<span>%</span></strong></div>
        <progress value={summary.confirmedBytes} max={summary.totalBytes || 1} aria-label="Google-confirmed upload progress" />
        <div className="progress-meta"><span>{formatBytes(summary.confirmedBytes)} / {formatBytes(summary.totalBytes)}</span>
          <span>{view.complete ? 'Confirmed by Google' : summary.enabled ? estimate ? formatRemaining(estimate.seconds) : 'Calculating remaining time' : 'Resume to estimate time'}</span></div>
        <dl className="stats"><div><CheckCircle2 size={20} /><dd>{summary.counts.completed.toLocaleString()}</dd><dt>Completed</dt></div>
          <div><Upload size={20} /><dd>{(summary.counts.preparing + summary.counts.uploading + summary.counts.retrying).toLocaleString()}</dd><dt>Active</dt></div>
          <div><LoaderCircle size={20} /><dd>{summary.remaining.toLocaleString()}</dd><dt>Remaining</dt></div>
          <div className={summary.counts.failed ? 'has-failures' : ''}><TriangleAlert size={20} /><dd>{summary.counts.failed.toLocaleString()}</dd><dt>Failed</dt></div></dl>
        {summary.enabled && <p className="small muted">{summary.counts.queued.toLocaleString()} queued{summary.counts.retrying ? ` / ${summary.counts.retrying} retrying` : ''}{estimate ? ` / ${formatBytes(estimate.bytesPerSecond)}/s` : ''}</p>}
        {view.complete && <div className="completion-note"><Check size={20} /><p>Verify your files in Drive before removing any originals from your device.</p></div>}
      </section>}
      <div className="operation-area"><WakeControl controller={controller} state={state} />
        <p className="awake-note">Keep this page open and your phone plugged in during uploads.</p>
        <div className="primary-actions">
          {summary.enabled ? <button className="button primary" onClick={() => controller.pause()}><Pause size={21} />Pause All</button> :
            <button className="button primary" disabled={!view.canResume} aria-describedby={!view.canResume && !view.complete ? 'resume-reason' : undefined} onClick={begin}>{view.complete ? <CheckCircle2 size={21} /> : started ? <Play size={21} /> : <Upload size={21} />}{view.complete ? 'All uploaded' : started ? 'Resume upload' : 'Upload All'}</button>}
          {summary.counts.failed > 0 && <button className="button retry" disabled={!view.canRetry} onClick={() => { controller.retryFailed(); setSetupOverride(false); }}><RotateCcw size={20} />Retry Failed ({summary.counts.failed.toLocaleString()})</button>}
        </div>
        {!summary.enabled && !view.canResume && !view.complete && <p className="blocked-reason" id="resume-reason">{state.startupError ? 'Startup failed. Review the message above and reload to retry.' : state.busy ? 'Wait for the current operation to finish.' : !summary.total ? 'Select files, connect Google, and choose a destination to begin.' :
          summary.remaining === summary.missingSources ? 'Resume is unavailable until you select the originals again.' :
          !state.connected ? 'Connect Google to enable upload.' : !state.folderId ? 'Choose a destination to enable upload.' :
          summary.counts.failed ? 'Use Retry Failed to retry failed entries.' : view.blockers[0]?.message || 'Waiting for active requests to stop.'}</p>}
        {state.actionMessage && <p className="action-message" role="status">{state.actionMessage}</p>}
      </div>
      {started && !setup && <div className="add-more-row"><FilePicker id="add-files" label="Add more files" disabled={selectionDisabled} onFiles={files => controller.select(files)} /><span className="small muted">Same batch. Same destination.</span></div>}
      {state.selectionMessage && !setup && !summary.missingSources && <p className="selection-message" role="status">{state.selectionMessage}</p>}
      {summary.total > 0 && <NewBatchControl controller={controller} state={state} />}
      <section className="secondary-section"><button className="disclosure" aria-expanded={details} aria-controls="file-details" onClick={() => setDetails(!details)}>
        <span><ListFilter size={20} />Files &amp; failures <span className="count-label">{summary.total.toLocaleString()}</span></span><ChevronDown size={20} className={details ? 'rotated' : ''} /></button>
        {details && <div id="file-details"><FileDetails controller={controller} state={state} /></div>}</section>
      <section className="secondary-section"><button className="disclosure" aria-expanded={settings} aria-controls="recovery-settings" onClick={() => setSettings(!settings)}>
        <span><ShieldCheck size={20} />Recovery &amp; device storage</span><ChevronDown size={20} className={settings ? 'rotated' : ''} /></button>
        {settings && <div id="recovery-settings" className="storage-settings"><p className="storage-state"><ShieldCheck size={18} />{state.storageMessage}</p>
          <p className="small muted">Keep this page open until the batch finishes. The saved list contains records, not your photos or videos. If file access is lost, reconnecting originals is an optional recovery step, not guaranteed recovery. Uploads cannot continue while this page is closed.</p>
          {summary.remaining > 0 && <FilePicker id="replace-sources" label="Reconnect original files" recovery disabled={sourceDisabled} onFiles={files => void controller.reconnectSources(files)} />}
          <button className="button secondary" disabled={!state.ready || state.busy} onClick={() => void controller.protectStorage()}><ArrowDownToLine size={18} />Request storage protection</button>
          <p className="small" role="status">{state.retentionMessage || 'Optional. The browser decides whether to protect saved records from automatic cleanup. This does not preserve access to your media.'}</p>
          {state.retentionMessage.includes('not granted') && <p className="small">Your queue is still saved normally. You can keep uploading. Browser cleanup or clearing site data may remove recovery records.</p>}
        </div>}</section>
      <footer><span><ShieldCheck size={15} />No backend. No saved tokens.</span><nav aria-label="Footer"><a href="../privacy/">Privacy</a><a href="../terms/">Terms</a><a href="../phase2/">Test page</a></nav></footer>
    </main>
  </div>;
}