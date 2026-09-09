'use strict';

const picker = document.getElementById('files');
const summary = document.getElementById('summary');
const eventStatus = document.getElementById('event');
const metadata = document.getElementById('metadata');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
let rows = [];
let page = 0;
const pageSize = 100;

function renderPage() {
  metadata.replaceChildren();
  const start = page * pageSize;
  metadata.start = start + 1;
  for (const file of rows.slice(start, start + pageSize)) {
    const item = document.createElement('li');
    item.textContent = `${file.name} — ${file.type || '(MIME type unavailable)'} — ${file.size.toLocaleString()} bytes`;
    metadata.append(item);
  }
  previous.disabled = page === 0;
  next.disabled = start + pageSize >= rows.length;
  document.getElementById('page').textContent = rows.length
    ? `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length.toLocaleString()}`
    : 'No metadata to display.';
}

picker.addEventListener('change', () => {
  // Copy metadata only. Never read contents, generate previews, or retain extra File references.
  rows = Array.from(picker.files, ({ name, type, size }) => ({ name, type, size }));
  const bytes = rows.reduce((total, file) => total + file.size, 0);
  summary.textContent = `${rows.length.toLocaleString()} files · ${bytes.toLocaleString()} bytes (${(bytes / 1_000_000).toFixed(2)} MB)`;
  eventStatus.textContent = `Picker change received at ${new Date().toLocaleTimeString()}.`;
  page = 0;
  renderPage();
});

picker.addEventListener('cancel', () => {
  eventStatus.textContent = `Picker cancel event at ${new Date().toLocaleTimeString()}. Selection unchanged. This event does not establish why no new selection was returned.`;
});

document.getElementById('clear').addEventListener('click', () => {
  picker.value = '';
  rows = [];
  page = 0;
  summary.textContent = 'Selection cleared.';
  eventStatus.textContent = 'Page references released; Safari storage reclamation is not confirmed.';
  renderPage();
});
previous.addEventListener('click', () => { page -= 1; renderPage(); });
next.addEventListener('click', () => { page += 1; renderPage(); });
