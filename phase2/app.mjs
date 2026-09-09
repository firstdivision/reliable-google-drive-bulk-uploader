import { GoogleAuth, DriveFolders } from '../phase1/google.mjs';
import { UploadQueue } from './upload-queue.mjs';

const byId = (id) => document.getElementById(id);
const auth = new GoogleAuth();
const folders = new DriveFolders(auth);
let busy = false;
let connected = false;
let page = 0;
let renderTimer = null;
const PAGE_SIZE = 50;
const queue = new UploadQueue({ getToken: () => auth.getToken(), onChange: (current) => {
  if (current.authRequired && connected) {
    failure({ auth: true, message: 'Batch paused for authorization. Reconnect with the same account, then resume.' });
  }
  scheduleRender();
} });

function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${value.toFixed(2)} ${units[index]}`;
}

// Coalesce concurrent progress notifications; never build thousands of DOM rows.
function scheduleRender() {
  renderTimer ??= setTimeout(() => { renderTimer = null; render(); }, 100);
}

function render() {
  const state = queue.summary;
  const counts = state.counts;
  byId('connect').disabled = busy || state.active > 0 || state.enabled;
  byId('connect').textContent = connected ? 'Reconnect Google' : 'Connect Google Drive';
  byId('files').disabled = busy;
  byId('folder-name').disabled = !connected || busy || Boolean(queue.folderId) || Boolean(folders.pendingName);
  for (const id of ['folders', 'create-folder', 'refresh-folders']) {
    byId(id).disabled = !connected || busy || Boolean(queue.folderId);
  }
  byId('upload').disabled = busy || !connected || state.enabled ||
    !byId('folders').value || !(counts.queued + counts.paused + (state.authRequired ? counts.failed : 0));
  byId('upload').textContent = queue.folderId ? 'Resume / Upload queued' : 'Upload All';
  byId('pause').disabled = !state.enabled;
  byId('retry').disabled = busy || !connected || !counts.failed;
  byId('clear').disabled = !state.unstarted;
  const percent = state.totalBytes ? 100 * state.confirmedBytes / state.totalBytes : 0;
  byId('percent').textContent = `${percent.toFixed(1)}%`;
  byId('progress').max = state.totalBytes || 1;
  byId('progress').value = state.confirmedBytes;
  byId('progress-text').textContent = `${formatBytes(state.confirmedBytes)} of ${formatBytes(state.totalBytes)} confirmed by Google`;
  byId('progress').title = `${state.confirmedBytes.toLocaleString()} / ${state.totalBytes.toLocaleString()} bytes confirmed`;
  for (const [id, value] of Object.entries({ selected: state.total, completed: counts.completed,
    active: counts.preparing + counts.uploading + counts.retrying, remaining: state.remaining, failed: counts.failed })) {
    byId(id).textContent = value.toLocaleString();
  }
  const status = state.authRequired ? 'Authorization needed — batch paused.' :
    state.enabled ? `Uploading · ${counts.retrying} retrying · ${counts.queued} queued` :
    state.active ? 'Pausing — waiting for active requests to stop.' :
    counts.paused ? 'Paused. Keep this tab open to retain the batch.' :
    counts.failed ? 'Batch finished with failures. Review details and use Retry Failed.' :
    state.total && counts.completed === state.total ? 'Batch complete. Verify your files in Drive.' : 'Ready when you are.';
  if (byId('batch-status').textContent !== status) byId('batch-status').textContent = status;
  renderDetails();
}

function renderDetails() {
  if (!byId('details').open) return;
  const failedOnly = byId('failed-only').checked;
  const items = [...queue.items.values()].filter((item) => !failedOnly || item.status === 'failed');
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const rows = [];
  for (const item of items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const row = document.createElement('li');
    const text = document.createElement('p');
    text.textContent = `${item.name} · ${formatBytes(item.size)} · ${item.status} · ${item.confirmedBytes.toLocaleString()} bytes confirmed`;
    row.append(text);
    if (item.error) {
      const error = document.createElement('p');
      error.className = 'error';
      error.textContent = item.error.message || 'Upload failed.';
      row.append(error);
    }
    if (item.driveFileId) {
      const identity = document.createElement('p');
      identity.textContent = `Drive file ID: ${item.driveFileId}`;
      row.append(identity);
    }
    if (item.status === 'completed') {
      const link = document.createElement('a');
      link.textContent = 'Open completed file in Drive';
      link.href = `https://drive.google.com/file/d/${encodeURIComponent(item.driveFileId)}/view`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
    }
    if (!item.attempted) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove from queue';
      remove.setAttribute('aria-label', `Remove ${item.name} from queue`);
      remove.addEventListener('click', () => { queue.remove(item.id); render(); });
      row.append(remove);
    }
    rows.push(row);
  }
  byId('items').replaceChildren(...rows);
  byId('page').textContent = `Page ${page + 1} of ${pages} · ${items.length.toLocaleString()} ${failedOnly ? 'failed files' : 'files'}`;
  byId('previous').disabled = page === 0;
  byId('next').disabled = page >= pages - 1;
}

function failure(error, target = 'action-status') {
  if (error.auth) {
    auth.invalidate();
    connected = false;
    queue.pause();
    byId('auth-status').textContent = 'Authorization needed. Reconnect with the original Google account, then resume.';
  }
  byId(target).textContent = error.message || 'The operation failed. Try again.';
}

function showDestination() {
  const select = byId('folders');
  byId('folder-status').textContent = select.value
    ? `Destination: ${select.selectedOptions[0].textContent}` : 'Choose or create an app-accessible folder.';
  byId('folder-link').hidden = !select.value;
  if (select.value) byId('folder-link').href = `https://drive.google.com/drive/folders/${encodeURIComponent(select.value)}`;
  render();
}

async function loadFolders(preferred = byId('folders').value) {
  const items = await folders.list();
  const select = byId('folders');
  select.replaceChildren(new Option('Choose a destination', ''));
  for (const item of items) select.add(new Option(item.name, item.id));
  select.value = items.some((item) => item.id === preferred) ? preferred : '';
  showDestination();
}

byId('connect').addEventListener('click', async () => {
  busy = true;
  render();
  byId('auth-status').textContent = 'Waiting for Google authorization…';
  try {
    // Keep the popup call in the user gesture, before any awaited work.
    const user = await auth.connect();
    connected = true;
    byId('auth-status').textContent = `Connected as ${user.emailAddress || user.displayName || 'your Google account'}.`;
    byId('action-status').textContent = 'Connected. Upload or resume when ready.';
    if (!queue.folderId) await loadFolders();
  } catch (error) { failure(error, 'auth-status'); }
  finally { busy = false; render(); }
});

byId('refresh-folders').addEventListener('click', async () => {
  busy = true; render();
  try { await loadFolders(); }
  catch (error) { failure(error, 'folder-status'); }
  finally { busy = false; render(); }
});

byId('create-folder').addEventListener('click', async () => {
  busy = true; render();
  try {
    const folder = await folders.create(byId('folder-name').value);
    const select = byId('folders');
    if (![...select.options].some((option) => option.value === folder.id)) select.add(new Option(folder.name, folder.id));
    select.value = folder.id;
    showDestination();
  } catch (error) { failure(error, 'folder-status'); }
  finally { busy = false; render(); }
});

byId('folders').addEventListener('change', showDestination);
byId('files').addEventListener('change', () => {
  const result = queue.add(byId('files').files);
  // Retain live File objects in the engine, not the native input's restorable selection.
  // Phase 0 informed this mitigation; it is not a browser-crash recovery guarantee.
  byId('files').value = '';
  byId('selection-status').textContent = `${result.added} added · ${result.duplicates} matching selections skipped · ${result.rejected} empty or invalid files skipped.`;
  render();
});
byId('clear').addEventListener('click', () => {
  for (const item of queue.items.values()) if (!item.attempted) queue.remove(item.id);
  byId('selection-status').textContent = 'Unstarted files removed from this queue only. No source or Drive files were deleted.';
  render();
});
byId('upload').addEventListener('click', () => {
  try { queue.start(byId('folders').value); byId('action-status').textContent = ''; }
  catch (error) { failure(error); }
  render();
});
byId('pause').addEventListener('click', () => { queue.pause(); render(); });
byId('retry').addEventListener('click', () => {
  try { queue.retryFailed(); byId('action-status').textContent = 'Failed files requeued; paused work resumed. Completed files stay completed.'; }
  catch (error) { failure(error); }
  render();
});
byId('details').addEventListener('toggle', renderDetails);
byId('failed-only').addEventListener('change', () => { page = 0; renderDetails(); });
byId('previous').addEventListener('click', () => { page = Math.max(0, page - 1); renderDetails(); });
byId('next').addEventListener('click', () => { page++; renderDetails(); });

function showNetwork() {
  byId('network').textContent = navigator.onLine
    ? 'Browser reports online. Upload requests verify actual connectivity.'
    : 'Browser reports offline. Restore connectivity; bounded retries will attempt recovery.';
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
window.addEventListener('pagehide', () => queue.pause());
showNetwork();
render();