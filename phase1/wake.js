'use strict';

// Same tested wake-lock behavior as the Phase 0 experiment.
const wakeButton = document.getElementById('wake');
const wakeStatus = document.getElementById('wake-status');
let enabled = false;
let lock = null;
let requesting = false;
let resumeRequested = false;

async function acquireLock() {
  if (!enabled || lock || requesting || document.visibilityState !== 'visible') return;
  resumeRequested = false;
  requesting = true;
  wakeStatus.textContent = 'Requesting screen wake lock…';
  try {
    const acquired = await navigator.wakeLock.request('screen');
    if (!enabled || document.visibilityState !== 'visible') {
      await acquired.release();
      wakeStatus.textContent = enabled ? 'Not active while the page is hidden.' : 'Keep Awake is off.';
      return;
    }
    if (acquired.released) {
      wakeStatus.textContent = 'Not active: the browser released the lock before acquisition completed.';
      return;
    }
    lock = acquired;
    wakeStatus.textContent = 'Active — screen wake lock acquired.';
    acquired.addEventListener('release', () => {
      if (lock !== acquired) return;
      lock = null;
      wakeStatus.textContent = enabled
        ? 'Released by browser/system. Return to this page or disable and re-enable to retry.'
        : 'Keep Awake is off.';
      if (resumeRequested) void acquireLock();
    });
  } catch (error) {
    wakeStatus.textContent = enabled ? `Not active: ${error.message}. Keep the device awake manually; disable and re-enable to retry.` : 'Keep Awake is off.';
  } finally {
    requesting = false;
    // Honor a visibility return that arrived while acquisition/release was pending.
    // Each return permits one attempt; denial or release alone does not retry forever.
    if (resumeRequested) void acquireLock();
  }
}

wakeButton.addEventListener('click', async () => {
  enabled = !enabled;
  wakeButton.setAttribute('aria-pressed', String(enabled));
  wakeButton.textContent = enabled ? 'Disable Keep Awake' : 'Enable Keep Awake';
  if (enabled) {
    await acquireLock();
  } else {
    resumeRequested = false;
    const previousLock = lock;
    lock = null;
    wakeStatus.textContent = 'Keep Awake is off.';
    try { await previousLock?.release(); }
    catch (error) { wakeStatus.textContent = `Release could not be confirmed: ${error.message}`; }
  }
});

function showVisibility() {
  document.getElementById('visibility').textContent = `Page ${document.visibilityState} at ${new Date().toLocaleTimeString()}.`;
  if (document.visibilityState === 'visible') {
    if (enabled) resumeRequested = true;
    void acquireLock();
  }
}
document.addEventListener('visibilitychange', showVisibility);
if (!window.isSecureContext || !('wakeLock' in navigator)) {
  wakeButton.disabled = true;
  wakeStatus.textContent = 'Unavailable. Use HTTPS and a supporting browser, or keep the screen awake manually.';
} else {
  wakeStatus.textContent = 'Supported; currently off.';
}
showVisibility();
