import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard } from '../phase4/Dashboard';
import type { DashboardController, DashboardSnapshot } from '../phase4/controller';

function render(overrides: Partial<DashboardSnapshot> = {}) {
  const state: DashboardSnapshot = { ready: true, busy: false, connected: false, startupError: '',
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
  return { html: renderToStaticMarkup(createElement(Dashboard, { controller })), detailsReads };
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
  assert.match(html, /Start new batch/);
});

test('startup failure and offline status are visible without private HTML injection', () => {
  const { html } = render({ ready: false, busy: true, online: false, startupError: '<script>private</script>' });
  assert.match(html, /Connection interrupted/);
  assert.match(html, /&lt;script&gt;private&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>private/);
  assert.match(html, /Batch unavailable/);
  assert.match(html, /Reload saved batch/);
  assert.match(html, /Reloading does not clear saved records/);
  assert.match(html, /<button class="button secondary" disabled="">.*?Start new batch/);
});

test('wake control distinguishes requested state from actual acquisition', () => {
  const { html } = render({ wake: { supported: true, enabled: true, active: false, message: 'Released by browser/system.' } });
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /Released by browser\/system/);
  assert.doesNotMatch(html, /wake-strip wake-active/);
});