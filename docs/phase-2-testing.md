# Phase 2 batch queue

Status: implemented with automated synthetic tests; real Drive/iPhone batch
validation pending. Phase 1's user-reported single-file pass is not a batch pass.

After publishing, open [the Phase 2 page](https://batchharbor.killfly.com/phase2/)
over HTTPS. Use the same OAuth origin and test-account setup as
[Phase 1](phase-1-testing.md). The new page imports the existing Phase 1 protocol,
authorization, folders, and wake-lock code; serve both directories together.

## Boundaries

- No backend, new OAuth scopes, token storage, IndexedDB, or media staging.
- Two concurrent uploads by default. Each worker uses bounded 8 MiB slices;
  concurrency and aligned chunk size are configurable at engine construction.
- Automatic transient retries/backoff and offset probes come from the existing
  Drive uploader. A failed file does not prevent unrelated queued files running.
- Authorization failure pauses the batch. Reconnect with the original account,
  then Resume. Permission/quota failures require corrective action, not endless retries.
- Pause aborts requests; slots are not reused until aborted workers settle.
- Retry Failed reuses each failed worker/session/file identity and resumes paused
  work. Completed entries never restart. Resume alone does not retry permanent failures.
- Completed source references are released; completion/selection metadata stays
  in memory. No source or Drive files are deleted.
- Add More appends to the fixed destination and starts automatically while the
  batch is running. Before a file starts, it can be removed locally.
- Selection deduplication uses name, size, MIME type, and modification time,
  including completed entries. Identical metadata can hide distinct content;
  changed picker metadata can allow repeat content. No whole-file hashing occurs.
- Empty/invalid files are reported and skipped. Details show at most 50 rows.
- Progress counts only Google-confirmed bytes. It may decrease if an expired
  session must restart, or its percentage may decrease after Add More.
- State exists only in this tab. Reload/termination recovery is Phase 3; keep
  the page visible. Wake Lock does not provide native background execution.

## Real-device sequence

Begin with 3–5 disposable files totaling roughly 200–500 MB, not your library.
Use different samples from previous tests to avoid confusing existing Drive copies.

1. Select files, then Add More with an overlapping selection. Check selected
   count/total size and skipped-duplicate count. Open details and remove an
   unstarted file. Confirm only the local queue changes.
2. Connect Google and create/select an app-accessible test folder. Enable Keep
   Awake, start Upload All, and confirm no more than two files are active.
3. Verify aggregate progress and completed-file count, then open completed files
   in Drive and check name, size, destination, and contents.
4. With enough queued work remaining, Pause All during a chunk. Confirm no new
   queued file starts. Resume, including one immediate Pause/Resume sequence.
   Verify stable Drive IDs and eventual completion without duplicates.
5. Repeat with a brief genuine network interruption (disable cellular fallback).
   Observe retrying and confirmed-offset recovery. If retries exhaust, restore
   connectivity and use Retry Failed. Already completed files must not restart.
6. Add a few more files while running. Verify they join the same destination;
   add an already completed selection again and check it is skipped when its
   metadata matches.
7. When authorization actually expires, verify the whole batch pauses instead of
   failing every queued file. Reconnect with the same account and Resume. Test
   a different-account reconnect only with accounts you control; it must be
   rejected. Record this as **not exercised** if no token expiry occurs.
8. Confirm one completed Drive file per unique queue entry. Verify all files
   open/play. Disable Keep Awake after finishing.

Do not manufacture a permission failure by deleting Drive content. Automated
tests cover permanent failures, exhausted retries, and auth expiry with mocks.
Never publish tokens, session URLs, personal filenames, or private Drive details.

## Results to record

- Date, code revision, device, OS/browser version, local vs iCloud-backed source.
- File count, total bytes, largest file, approximate duration, peak active count.
- Added/skipped/removed counts and final completed/failed counts.
- Confirmed offsets and unchanged Drive IDs around pause/network interruptions
  (keep IDs private; record a match/mismatch result in public notes).
- Duplicate count, file content/size verification, auth recovery if exercised.
- Wake Lock state, Safari storage/instability observations, and any error status.

On unexpected Safari closure, inspect the destination before retrying in a fresh
tab. Phase 0's selected-tab restoration limitation still applies. A passing small
batch does not establish thousands-of-files, multi-hour, or restart reliability.

## Automated and local-browser evidence — 2026-09-09

- Dependency-free Node tests cover the queue, real protocol integration with
  mocked responses, and UI controls using browser API doubles. Synthetic
  5,000-file selections exercise metadata-only deduplication and bounded detail rendering.
- The integrated desktop browser at a 390 × 844 viewport completed a synthetic
  three-file batch with mocked Google authorization/fetch responses. One forced
  permanent failure left two completed files; Retry Failed completed the third
  with three reserved IDs total and four upload/probe requests. No real Google
  account or media transfer was involved. No horizontal page overflow was observed.
- Initial local loading with the real GIS script emitted an inline-style CSP
  warning. A `securitypolicyviolation` event identified
  `https://accounts.google.com/gsi/client` as the source (`style-src-elem`, blocked
  inline style). The functional impact was not established; the existing Phase 1
  CSP was retained rather than weakened. Verify real authorization on the
  deployed HTTPS origin during the device sequence above.

These checks do not exercise native iPhone/Android picker behavior, real Google
CORS/OAuth, physical Wake Lock, or batch interruption recovery on a device.

## Android checklist (physical validation deferred)

Repeat selection/Add More, overlapping-selection counts, app-accessible folder
choice, batch pause/resume, real network interruption, same-account reconnect,
duplicate checks, foreground Wake Lock, and visibility/lifecycle observations on
Android Chrome when hardware is available. Do not infer a pass from desktop or iPhone.