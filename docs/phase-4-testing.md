# Phase 4 mobile dashboard

Status: implemented 2026-09-13; automated checks and synthetic desktop-browser
workflow tests passed. The deployed dashboard received an overall user-reported
phone pass on 2026-09-13. Per-case device coverage and Android validation remain pending.

## Latest user feedback - 2026-09-13

The user initially reported the phone remaining at "Before you continue / Opening
saved batch". After deployment of startup hardening and guarded batch reset, the
user reported: "I tried it on my phone from the deployed site. It is working well."

Record this as an overall user-reported deployed-phone pass at that point, not
proof that startup was fixed. A later report on the same day confirmed that loading
a saved batch still reaches **Batch unavailable**, with no way to start fresh.
The warning now offers guarded **Start new batch** as well as **Reload saved batch**.
The underlying cause and deployed-device recovery remain unverified. The exact revision, phone/OS,
file count/bytes, and individual reset, retry, wake, and failure-path results were
not supplied. Do not infer large-batch, all-lifecycle, iPad, or Android coverage.
Follow-up: after the keep-open test, including requested Drive count, size, and
duplicate checks, the user reported "that all worked", then clarified "I uploaded
195 files". Use 195 as the actual reported batch size, not the previously assumed
10 files. This covers the 100-file stage as a user-reported pass; no exact byte
total, duration, or per-file measurements were supplied for that batch.

The next test completed 200 files (3.32 GB reported): start 10:53am, initial estimate
13 minutes, 50% at 11:01am, and 100% at 11:07am. The user verified 200 files uploaded.
Elapsed time was approximately 14 minutes. Separately, 1,535 files reached the
queue after a long, unmeasured wait for the Photos picker to close. That batch was
not uploaded to completion. See [Phase 5 results](../PROJECT.md#phase-5--stress-testing).
The user chose to defer further long upload tests and move on to MVP readiness;
large-selection success is not a completed-transfer or storage-safety pass.

Startup hardening now stops the wait after 15 seconds of runnable browser time and
reports the pending stage: acquiring the tab lock, opening browser queue storage,
or reading the saved batch. **Reload saved batch** retries without deleting records.
After explicit confirmation, **Start new batch** skips the unreadable saved records,
reacquires the writer lock, and saves an empty batch before enabling file selection.
The warning reports unknown counts instead of claiming there are zero saved files.
Recovery also bounds lock cleanup, storage opening, and saving the empty batch.
Pending startup transactions are aborted on failure; ordinary shutdown still drains
writes. This follows the distinction between IndexedDB
[close](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/close), which
allows existing transactions to finish, and
[abort](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/abort), which
rolls back uncommitted changes. Another tab's lock or unavailable storage cannot be bypassed.
Late responses cannot revive the failed controller. This bounds the UI wait; it
does not establish or repair the underlying Safari failure without device evidence.

Startup now displays the current operation (tab lock, storage opening, saved-record
read, or validation/restoration), an activity indicator, and elapsed seconds. After
five seconds it also acknowledges the wait. Confirmed recovery reset reports saving
the new empty batch. This is local metadata work, not a Drive scan or media upload.
The saved snapshot is read in one IndexedDB operation, so no byte/file percentage is
available; the UI does not invent one. Stage changes are announced politely; elapsed
seconds are not announced every second, and reduced-motion preferences stop the
spinner. Updates and the existing deadline require the browser's event loop to run;
this change neither speeds up storage nor diagnoses the unresolved phone stall.

The user rejected reconstructing large source selections as a normal recovery
workflow and explicitly chose to retain the browser-only app. The primary
acceptance workflow keeps the page open and active through completion. Existing
reselection tests below exercise an optional best-effort fallback, not a promise
of seamless recovery after closing the page. Keep the persistence and duplicate
prevention checks; do not mask startup failures by automatically discarding data.

Open [BatchHarbor](https://batchharbor.killfly.com/app/) after deployment. Close
other BatchHarbor uploader/test tabs first: the dashboard and `/phase2/` intentionally
share one saved queue and writer lock. Existing recovery data is reused, not reset.

## What changed

- React/TypeScript main dashboard with persistent Photos & Videos and Destination
   checklist rows, with Vite compiling static output. Destination has its own view
   for Google connection and Picker; no folder dropdown or custom creation form.
- Aggregate progress, source-backed Resume/Retry controls, approximate time remaining,
  and a prominent Keep Awake switch with actual acquisition status.
- Separate source reselection and Google reconnection steps after reopening.
- Failure/source filters and 50-row detail pages; no thousands-row default rendering.
- Guarded Start new batch appears below upload controls, in storage Settings for loaded batches, and directly in the startup warning. Denied protection explicitly does not mean save
  failure. Same privacy boundary, OAuth scope, durable IDs, and upload protocol.

One saved batch keeps its destination and account. Add More joins it. The user
approved **Start new batch** after reporting the old-batch problem. It requires a
confirmation checkbox and a separate commit action, clears local records including
completed history, and permits a new account/destination. It never deletes originals
or Drive files. It is blocked during uploads and other operations. Failed startup
permits an explicitly confirmed recovery reset without loading the old records;
it can also discard a loaded batch without reselecting missing originals.
Reset waits for prior writes and publishes an empty batch only after its durable
save succeeds. There is no batch-history UI. Removing unstarted entries is local only.
Source matching remains metadata plus bounded fingerprints, not whole-file equality.

## Device checklist

Use 3-5 disposable files, about 200-500 MB, before increasing scale.
For the primary keep-open workflow, run steps 1-3, 6-7, and 9. Steps 4-5 and 8
separately test recovery and tab exclusion; use controlled, easily reselected
sources for those checks.

1. Open `/app/` on Safari. Check readable headings, controls, and no horizontal
   overflow at your preferred text size. Select files and verify count/bytes.
2. Open Destination folder, connect Google, and select a writable folder with Google
   Picker. Return using Done or browser Back; count/bytes must remain unchanged.
   Upload All stays disabled until both checklist steps are complete. Enable Keep
   Awake and upload. Both checklist rows remain above progress; verify actual wake
   acquisition status. Destination browsing must be disabled after uploading starts.
3. Confirm Pause All stops dispatch. Resume and inspect completed files in Drive.
   Retry Failed must be visible when failures exist and must not restart completions.
4. Pause/save, close the page, reopen. Both source and account requirements should
   be explicit. Select originals again and reconnect; nothing starts before Resume.
5. Include already completed files in reselection. They must be skipped. Attempt a
   different controlled account and confirm rejection. Retain the original Drive IDs.
6. Open Files & failures; exercise filters, pagination, and removal of an unstarted
   entry. No source media or Drive content should be removed.
7. Open Settings and request storage protection. Denial is allowed; ordinary saving remains. Observe
   offline and authorization messages during a controlled interruption.
8. Open the legacy `/phase2/` page in a second tab. It must be blocked while `/app/`
   owns the saved queue. Close the owner and reload the second tab to recover.
9. Verify exactly one completed Drive file per entry, correct sizes and contents,
   and record any Safari storage growth or instability. Keep the originals.
10. If startup stalls, keep the page visible for at least 15 seconds. Record the
   visible operation, advancing elapsed time, exact error stage, and loaded revision.
   Check that the activity indicator respects reduced motion. Close other uploader tabs and use
   **Reload saved batch**. Do not clear website data just to collect this evidence.
11. With a disposable loaded batch and uploads paused, open **Settings > Start new batch**.
   Check the counts and warning. Cancel must retain the batch; reopening must
   require a fresh checkbox confirmation. Inspect Drive, then confirm the reset.
   Check that the empty batch survives reload, a new account/destination can be
   chosen, and the original source/Drive files remain. Do not reupload old files
   expecting the discarded duplicate-prevention records to protect them.
12. If **Batch unavailable** appears, use **Start new batch** in that warning.
   Check the unknown-count and duplicate-history warnings. Cancel must preserve
   saved records. After checking Drive, confirm only if discarding local recovery
   history is acceptable. File selection should become available, and the new
   batch should survive reload. If another tab owns the batch or saving fails,
   expect an actionable error with uploads still disabled, not a silent reset.

Record loaded revision, device/OS/browser, sample size/count, results per case,
and any unexercised auth/session expiry. Avoid private filenames, tokens, and session
URLs in shared reports. Do not infer native background uploads or giant-batch safety.

## Automated checks

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

Node tests cover the existing protocol/queue/storage and typed dashboard controller.
The initial implementation verification passed all 112 tests, type checking, linting,
production build, legacy script syntax checks, and assembled static link checks.
New coverage includes server-side auth rejection with locally unexpired tokens,
fresh-token preservation, disposal/write draining, tab exclusion, wake races,
source-backed control eligibility, ETA resets, safe rendering, and explicit recovery
messages. Waits use observable conditions for asynchronous file preparation.

Startup/reset regressions additionally hold lock/open/read stages past the deadline,
release them late, reject reset before startup finishes/during active uploads/without consent,
fail reset saves, and close the controller during a reset commit. Account switching
after reset is tested with the real GoogleAuth implementation and mocked Google.
Normal token invalidation still preserves the original-account restriction.
Recovery regressions cover unreadable/invalid snapshots, a stalled read released
after successful reset, lock exclusion, failed reset-save retry, bounded stalled
saves, pending transaction abort, and a single enabled reset in the startup warning.

The failed-startup reset follow-up passed 138 tests (99 JavaScript, 39 TypeScript),
type checking, linting, and the production build. A fresh local preview origin
with a synthetic unsupported snapshot verified that the warning offers reset,
Cancel preserves records across reload, consent is required again, and confirmed
reset persists an empty batch and enables selection after reload. Geometry checks
at 390px and 1280px found no horizontal/text overflow in recovery controls; warning
and narrow confirmation-button screenshots were inspected. Google requests were
blocked during this test; no real uploads or existing user records were touched.
This is desktop-browser evidence, not verification of the reported phone failure.

The production desktop-browser follow-up used only synthetic files on an isolated
local origin. Cancel retained two entries; confirmed reset survived reload. A
deliberately withheld IndexedDB read-completion event produced the read-stage
timeout (with an accelerated test timer), made no writes, and did not re-enable
uploads when released late. Reload after removing the fault restored the entry,
which could then be reset without originals. A 390px isolated viewport had no
horizontal overflow; mobile screenshot capture was unreliable, so device visual
and touch verification remain pending. No real Google upload was performed.

Vite emits `dist/app/`. The Pages workflow adds that directory to the existing
static deployment. Node 22 is pinned in CI. The development-only CSP accommodation
for local WebSockets is absent from production HTML. The subsequent Google folder
Picker enhancement permits inline styles in the dashboard for Google's injected
CSS; scripts remain strict. See [Picker setup and verification](drive-folder-picker.md).

## Browser evidence and limitations

The integrated desktop browser used real IndexedDB with synthetic media and mocked
Google authorization/HTTP. Reload retained completion and destination, blocked
Resume until source reconnection, rejected a wrong account, and recovered a failed
upload using a status probe and only remaining bytes. Two initial files used two
reserved IDs. A further two-file pause/resume completed without another allocation.
The storage-denial explanation appeared and a 5,004-entry selection rendered only
50 detail rows, with working pagination. No real media was sent to Google.

Narrow and wide screenshots were inspected for wrapping and assets. The integrated
browser resized its actual CSS viewport below the requested dimensions; visible
layouts were checked, not claimed as exact physical iPhone viewport tests. Some
post-resize pointer automation timed out; handlers were verified by DOM activation.
Real touch ergonomics and device wake behavior remain manual checks.

The documented Vite development startup was also exercised: local fonts and logo
loaded and a normal pointer click opened the storage controls without resizing.

The subsequent Google Picker integration deliberately permits inline styles in
production for Google's hosted dialog, while keeping inline scripts prohibited.
The real unauthenticated Picker library loaded without observed CSP violations;
authenticated dialog behavior still needs verification. See
[Drive folder picker](drive-folder-picker.md) for the policy and test evidence.
User-reported uploads on the deployed dashboard establish working sign-in for the
reporting account, not unrestricted OAuth audience access. Console publishing,
test-user restrictions, and applicable verification status must be checked before
broader sharing. The newer phone results are recorded above separately from the
earlier Phase 3 and mocked-browser evidence.