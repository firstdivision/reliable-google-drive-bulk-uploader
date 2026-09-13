import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard, Destination, NewBatchControl } from '../phase4/Dashboard';
import type { DashboardController, DashboardSnapshot } from '../phase4/controller';

function render(overrides: Partial<DashboardSnapshot> = {}) {
  const state: DashboardSnapshot = { ready: true, busy: false, connected: false, startupError: '',
    startupProgress: null,
    actionMessage: '', selectionMessage: '', storageMessage: 'Queue metadata saved', retentionMessage: '',
    folderId: 'saved-folder', folderName: 'Saved batch destination', destinationLocked: true,
    folders: [], accountLabel: '', online: true,
    wake: { supported: true, enabled: false, active: false, message: 'Keep Awake is off.' },
    summary: { total: 5000, totalBytes: 50000, confirmedBytes: 10000, remaining: 4000,
      counts: { queued: 0, preparing: 0, uploading: 0, retrying: 0, paused: 4000, failed: 0, completed: 1000 },
      missingSources: 4000, resumableSources: 0, retryableSources: 0, active: 0, enabled: false,
      authRequired: false, unstarted: 0, storageError: null, saving: false }, ...overrides };
  let detailsReads = 0;
  const controller = { getSnapshot: () => state, subscribe: () => () => {},
    getItems: () => { detailsReads++; return []; } } as unknown as DashboardController;
  return { html: renderToStaticMarkup(createElement(Dashboard, { controller })), detailsReads, state, controller };
}

test('restored dashboard prominently exposes source reselection and account recovery', () => {
  const { html, detailsReads } = render();
  assert.match(html, /Your batch is saved. Reconnect the files./);
  assert.match(html, /Select originals again/);
  assert.match(html, /Connect Google/);
  assert.match(html, /aria-describedby="resume-reason"/);
  assert.match(html, /Resume is unavailable until you select the originals again/);
  assert.match(html, /1,000 of 5,000 files complete/);
  assert.equal(detailsReads, 0, 'closed details do not copy the 5,000-file list');
  assert.match(html, /href="#settings" aria-label="Settings"/);
  assert.match(html, /Resume upload<\/button>[^]*?Start new batch<\/button>/);
  assert.doesNotMatch(html, /Request storage protection|Browse Google Drive/);
});

test('startup failure and offline status are visible without private HTML injection', () => {
  const { html } = render({ ready: false, busy: false, online: false, startupError: '<script>private</script>' });
  assert.match(html, /Connection interrupted/);
  assert.match(html, /&lt;script&gt;private&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>private/);
  assert.match(html, /Batch unavailable/);
  assert.match(html, /Reload saved batch/);
  assert.match(html, /Reloading does not clear saved records/);
  const recovery = html.match(/<section class="recovery-panel"[^]*?<\/section><\/div>/)?.[0];
  assert.ok(recovery);
  assert.match(recovery, /<button class="button secondary">[^]*?Start new batch<\/button>/);
  assert.equal((html.match(/Start new batch<\/button>/g) || []).length, 1);
  const { state, controller } = render({ ready: false, busy: true });
  const settings = renderToStaticMarkup(createElement(NewBatchControl, { controller, state }));
  assert.match(settings, /<button class="button secondary" disabled="">.*?Start new batch/);
});

test('startup shows the current stage and elapsed time without fake percentages or a warning panel', () => {
  const { state } = render();
  const summary = { ...state.summary, total: 0, missingSources: 0 };
  for (const elapsedSeconds of [0, 6]) {
    const { html } = render({ ready: false, busy: true, summary,
      startupProgress: { message: 'Reading saved file records and upload progress...', elapsedSeconds } });
    assert.match(html, /aria-label="Opening batch progress"/);
    assert.match(html, /role="status" aria-atomic="true"/);
    assert.match(html, /Reading saved file records and upload progress/);
    assert.match(html, new RegExp(`role="timer" aria-live="off">${elapsedSeconds} seconds elapsed`));
    assert.match(html, /No photos or videos are being uploaded/);
    assert.equal(html.includes('Still waiting for the browser'), elapsedSeconds >= 5);
    assert.doesNotMatch(html, /recovery-panel|Opening saved batch\.\.\.|aria-valuenow/);
  }
  assert.doesNotMatch(render().html, /startup-progress|seconds elapsed/);
  assert.doesNotMatch(render({ ready: false, startupError: 'Storage failed.',
    startupProgress: { message: 'Stale stage', elapsedSeconds: 15 } }).html, /startup-progress|Stale stage/);
});

test('wake control distinguishes requested state from actual acquisition', () => {
  const { html } = render({ wake: { supported: true, enabled: true, active: false, message: 'Released by browser/system.' } });
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /Released by browser\/system/);
  assert.doesNotMatch(html, /wake-strip wake-active/);
});

test('main page keeps both checklist steps visible and requires files and a connected destination', () => {
  const { state } = render();
  for (const total of [0, 2]) {
    for (const connected of [false, true]) {
      for (const folderId of ['', 'folder']) {
        const { html } = render({ connected, folderId, destinationLocked: false,
          summary: { ...state.summary, total, totalBytes: total * 10, confirmedBytes: 0, remaining: total,
            missingSources: 0, resumableSources: total,
            counts: { ...state.summary.counts, completed: 0, paused: 0, queued: total } } });
        assert.match(html, /Photos &amp; videos/);
        assert.match(html, /Destination folder/);
        assert.match(html, /href="#destination"/);
        assert.doesNotMatch(html, /<select|Browse Google Drive|Reconnect<|<progress/);
        assert.match(html, /Upload All<\/button>[^]*?<button class="button secondary">[^]*?Start new batch<\/button>/);
        const button = html.match(/<button class="button primary"([^>]*)>.*?Upload All<\/button>/);
        assert.ok(button);
        assert.equal(button[1].includes('disabled'), !(total && connected && folderId));
      }
    }
  }
});

test('destination view uses only account connection and Google Picker for folder selection', () => {
  for (const connected of [false, true]) {
    for (const destinationLocked of [false, true]) {
      const { state, controller } = render({ connected, destinationLocked });
      const html = renderToStaticMarkup(createElement(Destination, { controller, state }));
      assert.match(html, /Google account/);
      assert.match(html, /Browse Google Drive/);
      assert.match(html, /Open destination in Drive/);
      assert.doesNotMatch(html, /<select|Refresh folders|New folder|Folder name/);
      const browseButton = html.match(/<button\b[^>]*>[^]*?Browse Google Drive<\/button>/)?.[0].split('</button>').at(-2);
      assert.ok(browseButton);
      assert.equal(browseButton.includes('disabled'), !connected || destinationLocked);
    }
  }
});

test('active main page retains checklist and exposes pause and retry without settings clutter', () => {
  const { state } = render();
  const { html } = render({ connected: true, summary: { ...state.summary, enabled: true, active: 3,
    missingSources: 0, retryableSources: 3,
    counts: { queued: 3994, preparing: 0, uploading: 3, retrying: 0, paused: 0, completed: 1000, failed: 3 } } });
  assert.match(html, /Photos &amp; videos/);
  assert.match(html, /Destination folder/);
  assert.match(html, /Pause All/);
  assert.match(html, /Retry Failed \(3\)/);
  assert.match(html, /3,994<\/dd><dt>Waiting/);
  assert.match(html, /<button class="button secondary" disabled="">[^]*?Start new batch<\/button>/);
  assert.doesNotMatch(html, /Browse Google Drive|Request storage protection/);
});