import { GoogleAuth, DriveFolders } from './google.mjs';
import { DriveUpload } from './drive-upload.mjs';

const byId = (id) => document.getElementById(id);
const auth = new GoogleAuth();
const folders = new DriveFolders(auth);
let file = null;
let upload = null;
let busy = false;
let connected = false;

function render() {
  byId('connect').disabled = busy || Boolean(upload?.running);
  byId('connect').textContent = connected ? 'Reconnect Google' : 'Connect Google Drive';
  byId('file').disabled = Boolean(upload) || busy;
  byId('folder-name').disabled = !connected || busy || Boolean(upload) || Boolean(folders.pendingName);
  for (const id of ['folders', 'create-folder', 'refresh-folders']) {
    byId(id).disabled = !connected || busy || Boolean(upload);
  }
  byId('upload').disabled = !connected || busy || Boolean(upload) || !file || !byId('folders').value;
  byId('pause').disabled = !upload?.running;
  byId('resume').disabled = !upload || upload.running || busy || !connected || !['paused', 'failed'].includes(upload.state);
  if (!upload) return;
  byId('progress').max = file.size;
  byId('progress').value = upload.confirmedBytes;
  const percent = (100 * upload.confirmedBytes / file.size).toFixed(1);
  byId('progress-text').textContent = `${upload.confirmedBytes.toLocaleString()} / ${file.size.toLocaleString()} bytes confirmed (${percent}%)`;
  byId('upload-status').textContent = upload.error
    ? `${upload.state}: ${upload.error.message}` : upload.state;
  byId('file-id').textContent = upload.fileId ? `Drive file ID for this test: ${upload.fileId}` : '';
  if (upload.state === 'completed') {
    byId('result').href = `https://drive.google.com/file/d/${encodeURIComponent(upload.fileId)}/view`;
    byId('result').hidden = false;
  }
}

function failure(error, target) {
  if (error.auth) {
    auth.invalidate();
    connected = false;
    byId('auth-status').textContent = 'Authorization needed. Reconnect with the same Google account, then resume.';
  }
  byId(target).textContent = error.message || 'The operation failed. Try again.';
}

function showDestination() {
  const select = byId('folders');
  byId('folder-status').textContent = select.value
    ? `Destination: ${select.selectedOptions[0].textContent}` : 'Choose a folder or create a test folder.';
  byId('folder-link').hidden = !select.value;
  if (select.value) byId('folder-link').href = `https://drive.google.com/drive/folders/${encodeURIComponent(select.value)}`;
  render();
}

async function loadFolders(preferred = byId('folders').value) {
  const items = await folders.list();
  const select = byId('folders');
  select.replaceChildren(new Option('Choose a destination', ''));
  for (const item of items) select.add(new Option(`${item.name} (${item.id})`, item.id));
  select.value = items.some((item) => item.id === preferred) ? preferred : '';
  showDestination();
}

byId('connect').addEventListener('click', async () => {
  // connect() invokes Google's popup before its first await, preserving the tap gesture.
  busy = true;
  render();
  byId('auth-status').textContent = 'Waiting for Google authorization…';
  try {
    const user = await auth.connect();
    connected = true;
    byId('auth-status').textContent = `Connected as ${user.emailAddress || user.displayName || 'your Google account'}.`;
    if (!upload) await loadFolders();
  } catch (error) {
    failure(error, 'auth-status');
  } finally { busy = false; render(); }
});

byId('refresh-folders').addEventListener('click', async () => {
  busy = true; render();
  try { await loadFolders(); }
  catch (error) { failure(error, 'folder-status'); }
  finally { busy = false; render(); }
});

byId('create-folder').addEventListener('click', async () => {
  busy = true; render();
  byId('folder-status').textContent = 'Creating a test folder in My Drive…';
  try {
    const folder = await folders.create(byId('folder-name').value);
    // Retain a confirmed destination even if a subsequent list request would fail.
    const select = byId('folders');
    if (![...select.options].some((option) => option.value === folder.id)) {
      select.add(new Option(`${folder.name} (${folder.id})`, folder.id));
    }
    select.value = folder.id;
    showDestination();
  } catch (error) { failure(error, 'folder-status'); }
  finally { busy = false; render(); }
});

byId('folders').addEventListener('change', showDestination);
byId('file').addEventListener('change', () => {
  file = byId('file').files[0] || null;
  // Keep one live File in memory and clear the native input's restorable selection.
  // This is a mitigation informed by Phase 0, not a guarantee against Safari crashes.
  byId('file').value = '';
  if (file?.size === 0) {
    file = null;
    byId('selection').textContent = 'Choose a non-empty test file. Empty files are outside this spike.';
  } else {
    byId('selection').textContent = file
      ? `${file.name} · ${file.size.toLocaleString()} bytes (${(file.size / 1_000_000).toFixed(2)} MB)` : 'No file selected.';
  }
  render();
});

async function run() {
  try { await upload.start(); }
  catch (error) { failure(error, 'upload-status'); }
  finally { render(); }
}

byId('upload').addEventListener('click', () => {
  if (upload || !file || !byId('folders').value) return;
  upload = new DriveUpload({
    file, folderId: byId('folders').value, getToken: () => auth.getToken(),
    onChange: (current) => {
      if (current.error?.auth) failure(current.error, 'upload-status');
      render();
    },
  });
  void run();
});
byId('pause').addEventListener('click', () => { upload?.pause(); render(); });
byId('resume').addEventListener('click', () => { if (upload && !upload.running) void run(); });

function showNetwork() {
  byId('network').textContent = navigator.onLine
    ? 'Browser reports online. Actual connectivity is checked by upload requests.'
    : 'Browser reports offline. Reconnect to continue.';
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
window.addEventListener('pagehide', () => upload?.pause());
showNetwork();
render();
