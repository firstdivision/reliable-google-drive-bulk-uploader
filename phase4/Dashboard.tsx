import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, Clock, Coffee, Folder,
  FolderPlus, ImagePlus, Link2, ListFilter, Pause, Play, RefreshCw, RotateCcw, Settings,
  ShieldCheck, TriangleAlert, Trash2, Upload, WifiOff } from 'lucide-react';
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

export function Destination({ controller, state }: Props & { state: DashboardSnapshot }) {
  const [browsing, setBrowsing] = useState(false);
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
    {state.folderId && <div className="destination-summary"><Folder size={24} aria-hidden="true" />
      <div><span className="field-caption">Selected folder</span><strong>{state.folderName || 'Saved batch destination'}</strong></div>
      <a className="icon-button" aria-label="Open destination in Drive" title="Open destination in Drive" href={`https://drive.google.com/drive/folders/${encodeURIComponent(state.folderId)}`} target="_blank" rel="noopener noreferrer"><ArrowRight size={18} /></a>
    </div>}
    {pinned && <p className="small muted">This batch's destination is fixed because uploading has started.</p>}
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
  const readPage = () => typeof window !== 'undefined' && ['#destination', '#settings'].includes(window.location.hash) ? window.location.hash : '#batch';
  const [page, setPage] = useState(readPage);
  const heading = useRef<HTMLHeadingElement>(null);
  const estimator = useRef(new TransferEstimate());
  const [estimate, setEstimate] = useState<{ bytesPerSecond: number; seconds: number } | null>(null);
  useEffect(() => {
    const navigate = () => { controller.cancelFolderBrowse(); setPage(readPage()); };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [controller]);
  useEffect(() => { heading.current?.focus(); }, [page]);
  useEffect(() => {
    const sample = () => setEstimate(estimator.current.update(controller.getSnapshot().summary));
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [controller]);
  const started = summary.total > 0 && (state.destinationLocked || summary.missingSources > 0);
  const sourceDisabled = !state.ready || state.busy || summary.enabled || summary.active > 0 || Boolean(summary.storageError);
  const selectionDisabled = !state.ready || state.busy || summary.missingSources > 0 || Boolean(summary.storageError);
  const blockers = view.blockers.filter(item => item.kind !== 'folder' && (item.kind !== 'account' || started));
  const filesReady = summary.total > 0 && !summary.missingSources;
  const destinationReady = state.connected && Boolean(state.folderId);
  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="../"><img src={logo} alt="" /><span>BatchHarbor</span></a>
      <a className="icon-button" href="#settings" aria-label="Settings" title="Settings"><Settings size={22} /></a>
    </header>
    <main>
      {page !== '#batch' && <a className="back-link" href="#batch"><ArrowLeft size={19} />Back to batch</a>}
      <div className="page-heading"><h1 ref={heading} tabIndex={-1}>{page === '#destination' ? 'Destination folder' : page === '#settings' ? 'Settings' : !state.ready ? view.title : 'Upload to Google Drive'}</h1></div>
      {page === '#destination' && <section aria-label="Destination folder"><Destination controller={controller} state={state} />
        <a className="button primary destination-done" href="#batch">{destinationReady ? 'Done' : 'Back to batch'}<Check size={19} /></a>
      </section>}
      {page === '#batch' && <>
      {!state.online && <div className="notice warning" role="status"><WifiOff size={21} /><div><strong>Connection interrupted</strong><p>Keep this page open. Uploads retry automatically; permanent failures remain available under Retry Failed.</p></div></div>}
      {blockers.length > 0 && <section className="recovery-panel" aria-labelledby="recovery-title">
        <div className="section-heading"><div className="heading-with-icon"><TriangleAlert size={21} /><h2 id="recovery-title">{summary.missingSources ? 'Your batch is saved. Reconnect the files.' : 'Before you continue'}</h2></div></div>
        {blockers.map(blocker => <div className="recovery-step" key={blocker.kind}>
          <p>{blocker.message}</p>
          {blocker.kind === 'sources' && <FilePicker id="recovery-files" label="Select originals again" recovery disabled={sourceDisabled} onFiles={files => void controller.reconnectSources(files)} />}
          {blocker.kind === 'account' && <a className="button secondary" href="#destination"><Link2 size={18} />Connect Google</a>}
          {blocker.kind === 'storage' && <button className="button secondary" disabled={state.busy || summary.active > 0} onClick={() => void controller.retryStorage()}><RotateCcw size={18} />Retry saving</button>}
          {blocker.kind === 'startup' && <><button className="button secondary" onClick={() => window.location.reload()}><RefreshCw size={18} />Reload saved batch</button>
            <p className="small">Uploads and batch reset remain disabled until storage opens safely. Reloading does not clear saved records.</p></>}
        </div>)}
        {summary.missingSources > 0 && <p className="small">Choose the same photos and videos, including completed ones if easier. Completed files are skipped. Reconnecting does not upload anything until you resume.</p>}
      </section>}
      <section className="checklist" aria-label="Batch setup">
        <div className="checklist-row" aria-label={filesReady ? 'Photos and videos selected' : 'Photos and videos required'}>
          <span className="checklist-icon media-icon"><ImagePlus size={27} aria-hidden="true" /></span>
          <div className="checklist-copy"><span className="step-caption"><span className={`step-status ${filesReady ? 'step-complete' : ''}`}>{filesReady ? <Check size={13} aria-label="Complete" /> : '1'}</span>Photos &amp; videos</span>
            <strong>{summary.total ? `${summary.total.toLocaleString()} ${summary.total === 1 ? 'file' : 'files'} selected` : 'Select your files'}</strong>
            {summary.total > 0 && <span className="checklist-meta">{formatBytes(summary.totalBytes)} total{summary.missingSources > 0 ? ' / originals needed' : ''}</span>}
          </div>
          <FilePicker id="select-files" label={summary.total ? 'Add more' : 'Select'} disabled={selectionDisabled} onFiles={files => controller.select(files)} />
        </div>
        <a className="checklist-row destination-link" href="#destination" aria-label={destinationReady ? `Destination folder: ${state.folderName || 'Saved batch destination'}` : 'Set up destination folder'}>
          <span className="checklist-icon folder-icon"><Folder size={27} aria-hidden="true" /></span>
          <div className="checklist-copy"><span className="step-caption"><span className={`step-status ${destinationReady ? 'step-complete' : ''}`}>{destinationReady ? <Check size={13} aria-label="Complete" /> : '2'}</span>Destination folder</span>
            <strong>{state.folderId ? state.folderName || 'Saved batch destination' : 'Choose a folder'}</strong>
            <span className="checklist-meta">{state.connected ? state.accountLabel : 'Connect Google'}</span>
          </div><span className="checklist-action">{state.folderId ? 'View' : 'Set up'}<ChevronRight size={18} aria-hidden="true" /></span>
        </a>
      </section>
      {state.selectionMessage && (!summary.total || summary.missingSources > 0) && <p className="selection-message" role="status">{state.selectionMessage}</p>}
      {started && <section className="progress-section" aria-labelledby="progress-heading">
        <div className="progress-heading"><div><h2 id="progress-heading">{view.complete ? 'All files uploaded' : view.title}</h2><p>{summary.counts.completed.toLocaleString()} of {summary.total.toLocaleString()} files complete</p></div>
          <strong className="percentage">{formatPercent(summary)}<span>%</span></strong></div>
        <progress value={summary.confirmedBytes} max={summary.totalBytes || 1} aria-label="Google-confirmed upload progress" />
        <div className="progress-meta"><span>{formatBytes(summary.confirmedBytes)} / {formatBytes(summary.totalBytes)}</span>
          <span>{view.complete ? 'Confirmed by Google' : summary.enabled ? estimate ? formatRemaining(estimate.seconds) : 'Calculating remaining time' : 'Resume to estimate time'}</span></div>
        <dl className="stats"><div><CheckCircle2 size={20} /><dd>{summary.counts.completed.toLocaleString()}</dd><dt>Completed</dt></div>
          <div><Upload size={20} /><dd>{(summary.counts.preparing + summary.counts.uploading + summary.counts.retrying).toLocaleString()}</dd><dt>Active</dt></div>
          <div><Clock size={20} /><dd>{(summary.counts.queued + summary.counts.paused).toLocaleString()}</dd><dt>Waiting</dt></div>
          <div className={summary.counts.failed ? 'has-failures' : ''}><TriangleAlert size={20} /><dd>{summary.counts.failed.toLocaleString()}</dd><dt>Failed</dt></div></dl>
        {summary.enabled && <p className="small muted">{summary.counts.queued.toLocaleString()} queued{summary.counts.retrying ? ` / ${summary.counts.retrying} retrying` : ''}{estimate ? ` / ${formatBytes(estimate.bytesPerSecond)}/s` : ''}</p>}
        {view.complete && <div className="completion-note"><Check size={20} /><p>Verify your files in Drive before removing any originals from your device.</p></div>}
      </section>}
      <div className="operation-area"><WakeControl controller={controller} state={state} />
        <div className="primary-actions">
          {summary.enabled ? <button className="button primary" onClick={() => controller.pause()}><Pause size={21} />Pause All</button> :
            <button className="button primary" disabled={!view.canResume} aria-describedby={!view.canResume && !view.complete ? 'resume-reason' : undefined} onClick={() => controller.start()}>{view.complete ? <CheckCircle2 size={21} /> : started ? <Play size={21} /> : <Upload size={21} />}{view.complete ? 'All uploaded' : started ? 'Resume upload' : 'Upload All'}</button>}
          {summary.counts.failed > 0 && <button className="button retry" disabled={!view.canRetry} onClick={() => controller.retryFailed()}><RotateCcw size={20} />Retry Failed ({summary.counts.failed.toLocaleString()})</button>}
        </div>
        {!summary.enabled && !view.canResume && !view.complete && <p className="blocked-reason" id="resume-reason">{state.startupError ? 'Startup failed. Review the message above and reload to retry.' : state.busy ? 'Wait for the current operation to finish.' : !summary.total ? 'Select files, connect Google, and choose a destination to begin.' :
          summary.remaining === summary.missingSources ? 'Resume is unavailable until you select the originals again.' :
          !state.connected ? 'Connect Google to enable upload.' : !state.folderId ? 'Choose a destination to enable upload.' :
          summary.counts.failed ? 'Use Retry Failed to retry failed entries.' : view.blockers[0]?.message || 'Waiting for active requests to stop.'}</p>}
        <p className="awake-note">Keep this page open and your device plugged in. Uploads cannot continue while the page is closed.</p>
      </div>
      {summary.total > 0 && <section className="secondary-section"><button className="disclosure" aria-expanded={details} aria-controls="file-details" onClick={() => setDetails(!details)}>
        <span><ListFilter size={20} />Files &amp; failures <span className="count-label">{summary.total.toLocaleString()}</span></span><ChevronDown size={20} className={details ? 'rotated' : ''} /></button>
        {details && <div id="file-details">{state.selectionMessage && !summary.missingSources && <p className="selection-message" role="status">{state.selectionMessage}</p>}<FileDetails controller={controller} state={state} /></div>}</section>}
      </>}
      {page === '#settings' && <section aria-label="Recovery and device storage">
        <h2>Recovery &amp; device storage</h2>
        <div className="storage-settings"><p className="storage-state"><ShieldCheck size={18} />{state.storageMessage}</p>
          <p className="small muted">Keep this page open until the batch finishes. The saved list contains records, not your photos or videos. If file access is lost, reconnecting originals is an optional recovery step, not guaranteed recovery. Uploads cannot continue while this page is closed.</p>
          {summary.remaining > 0 && <FilePicker id="replace-sources" label="Reconnect original files" recovery disabled={sourceDisabled} onFiles={files => void controller.reconnectSources(files)} />}
          <button className="button secondary" disabled={!state.ready || state.busy} onClick={() => void controller.protectStorage()}><ArrowDownToLine size={18} />Request storage protection</button>
          <p className="small" role="status">{state.retentionMessage || 'Optional. The browser decides whether to protect saved records from automatic cleanup. This does not preserve access to your media.'}</p>
          {state.retentionMessage.includes('not granted') && <p className="small">Your queue is still saved normally. You can keep uploading. Browser cleanup or clearing site data may remove recovery records.</p>}
        </div>
        {summary.total > 0 && <NewBatchControl controller={controller} state={state} />}
      </section>}
      {state.actionMessage && <p className="action-message" role="status">{state.actionMessage}</p>}
      <footer><span><ShieldCheck size={15} />Direct to your Drive</span><nav aria-label="Footer"><a href="../privacy/">Privacy</a><a href="../terms/">Terms</a></nav></footer>
    </main>
  </div>;
}