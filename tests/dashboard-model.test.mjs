import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardState, TransferEstimate, formatRemaining, formatPercent } from '../phase4/dashboard-model.mjs';

const summary = overrides => ({ total: 3, totalBytes: 3000, confirmedBytes: 1000, remaining: 2,
  counts: { queued: 0, preparing: 0, uploading: 0, retrying: 0, paused: 2, failed: 0, skipped: 0, completed: 1 },
  missingSources: 2, resumableSources: 0, retryableSources: 0, enabled: false, active: 0, authRequired: false, storageError: null, ...overrides });
const view = overrides => dashboardState({ summary: summary(), ready: true, busy: false,
  connected: false, folderId: 'saved-folder', ...overrides });

test('recovery explains missing sources and authorization together and disables Resume', () => {
  const result = view();
  assert.deepEqual(result.blockers.map(item => item.kind), ['sources', 'account']);
  assert.equal(result.canResume, false);
  assert.match(result.blockers[0].message, /access to the originals is not/);
  assert.equal(view({ connected: true }).canResume, false);
  assert.equal(view({ connected: true, summary: summary({ missingSources: 0, resumableSources: 2 }) }).canResume, true);
});

test('partial source recovery can resume; storage failures and busy state cannot', () => {
  assert.equal(view({ connected: true, summary: summary({ missingSources: 1, resumableSources: 1 }) }).canResume, true);
  assert.equal(view({ connected: true, busy: true, summary: summary({ missingSources: 0 }) }).canResume, false);
  const state = view({ connected: true, summary: summary({ missingSources: 0, storageError: new Error('Storage failed') }) });
  assert.equal(state.canResume, false);
  assert.equal(state.blockers[0].kind, 'storage');
});

test('completed batches do not request source or account recovery', () => {
  const result = view({ summary: summary({ remaining: 0, missingSources: 0 }) });
  assert.equal(result.complete, true);
  assert.equal(result.canResume, false);
  assert.deepEqual(result.blockers, []);
});

test('percentage does not round to complete while even a tiny file remains', () => {
  assert.equal(formatPercent(summary({ totalBytes: 10000000, confirmedBytes: 9999999 })), '99.9');
  assert.equal(formatPercent(summary({ remaining: 0 })), '100.0');
  assert.equal(formatPercent(summary({ total: 0, totalBytes: 0, confirmedBytes: 0, remaining: 0 })), '0.0');
});

test('Retry Failed remains available during uploads; mixed source states cannot enable empty Resume', () => {
  const running = view({ connected: true, summary: summary({ enabled: true, missingSources: 0, retryableSources: 1 }) });
  assert.equal(running.canRetry, true);
  assert.equal(running.canResume, false);
  const mixed = view({ connected: true, summary: summary({ missingSources: 1, resumableSources: 0, retryableSources: 1 }) });
  assert.equal(mixed.canResume, false);
  assert.equal(mixed.canRetry, true);
});

test('ETA uses confirmed bytes and resets on pause, retry, rollback and Add More', () => {
  const estimate = new TransferEstimate();
  const active = overrides => summary({ enabled: true, missingSources: 0, ...overrides });
  assert.equal(estimate.update(active({ confirmedBytes: 0 }), 0), null);
  assert.equal(estimate.update(active({ confirmedBytes: 100 }), 1000), null);
  assert.deepEqual(estimate.update(active({ confirmedBytes: 1000 }), 10000), { bytesPerSecond: 100, seconds: 20 });
  assert.equal(estimate.update(active({ confirmedBytes: 500 }), 11000), null);
  assert.equal(estimate.update(active({ totalBytes: 4000 }), 20000), null);
  assert.equal(estimate.update(summary(), 21000), null);
  assert.equal(estimate.update(active({ counts: { ...summary().counts, retrying: 1 } }), 22000), null);
  assert.equal(formatRemaining(65), 'About 2 min remaining');
  assert.equal(formatRemaining(NaN), 'Calculating remaining time');
});