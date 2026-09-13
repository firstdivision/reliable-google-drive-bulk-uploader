# Phase 3 persistence and recovery

Status: implemented on 2026-09-13; automated checks and a user-reported recovery
pass are recorded below. Android and separately verified kill/reboot/expiry cases
remain pending. The newer Phase 4 dashboard shares these recovery records.

## Reported results - 2026-09-13

The user explicitly reported that the file list survived closing/reopening Safari
and uploads resumed after reselecting the originals. Storage protection was denied;
normal metadata saving and recovery still worked. After being asked to verify
completed files/sizes/duplicates and try a small reload-during-upload case, the user
reported "Everything is working" and requested Phase 4.

This is an overall user-reported pass, not an agent-operated or instrumented test.
The final checks were not individually enumerated; exact file counts, sizes,
revision, device/OS version, offsets, and duration were not supplied. Do not infer
force-kill/reboot, Android, actual auth/session expiry, or production-scale coverage.

**Decision: proceed to Phase 4, the mobile batch dashboard.** The reselection
confusion is a concrete UX finding: remembered records and live source access must
be distinguished, with a visible explanation when Resume is blocked.

The recovery page remains at [the batch URL](https://batchharbor.killfly.com/phase2/).
Locally, serve the repository root so Phase 1 imports remain available. Use HTTPS
on devices. The page loads saved state before enabling selection or authorization.

## What is saved

- One versioned batch snapshot in IndexedDB, database `batchharbor-queue`.
- Filename, size, media type, modification time, status, attempted flag, confirmed
  bytes, sanitized error classification, stable Drive file ID and session URL.
- Original Google Drive permission ID and fixed destination folder ID.
- SHA-256 of at most the first and last 64 KiB, computed before an item's first
  upload, and retained with its metadata. No entire-video hashing.
- Completed identities for duplicate prevention across reloads.

Media bytes, live File objects, OAuth tokens, account names and email addresses
are not saved. Session URLs and metadata are private: do not include them in
public logs or screenshots. Nothing is staged on the application host.

Identity and session checkpoints finish before dependent network requests.
IndexedDB writes request strict durability; browser/OS guarantees still apply.
Concurrent saves are coalesced and each checkpoint waits for its own revision.
Storage failures pause requests, leave in-memory identities intact, and expose
**Retry saving queue**. Restore storage access, retry saving, then explicitly
resume. Do not reload to fix a failed save without first inspecting Drive.

The page holds an exclusive Web Lock until its document is destroyed. A second
tab is blocked; close the owning tab and reload the second to recover. Unsupported
locking or unavailable/corrupt storage blocks startup rather than starting a new
unprotected batch. There is no cross-browser/device queue synchronization.

## Recovery behavior and limits

Unfinished records return paused or failed and require source reselection.
Completed records never need sources and cannot be restarted by Retry Failed.
Exact name, size, type, and modification time must match; previously prepared
files also need a matching sampled fingerprint. Ambiguous, changed, unreadable,
and unmatched selections are reported without being added as new uploads.
Matching sampled blocks does not prove identical middle content in a large file.
Picker metadata changes may prevent matching; use the same originals and picker
route. Do not work around a mismatch by blindly uploading a fresh copy.
Reselection can also replace an unreadable live source in a paused tab while
preserving the original Drive identity and progress; a reload is not required.

Reconnect the original Google account, then Resume or Retry Failed as appropriate.
Reselection and sign-in do not automatically start transfers. Available sources
can resume while other entries still need sources; Add More remains disabled
until all missing sources are resolved. The destination stays fixed for this
saved batch, including after all files complete. The newer `/app/` dashboard offers
a guarded **Start new batch** action once storage opens safely and uploads stop.
It explicitly discards local recovery and deduplication records, never originals
or Drive files. Batch history remains deferred; clearing browser site data also
loses recovery records. See [the dashboard checklist](phase-4-testing.md).

Google's status probe, not the locally saved offset, determines where a restored
session continues. For an expired session, the uploader first checks the reserved
Drive ID for a matching completed file. Otherwise it starts a new session with
the same ID. A conflict is verified, never overwritten or assigned a fresh ID.

Storage protection is optional and may be denied. Browser eviction, explicit
site-data clearing, or storage/OS failure can lose records. Keep independent
originals and inspect Drive before restarting if the saved queue is absent.
No background uploading or retained source-file access is promised.

## Small real-device sequence

Start on iPhone Safari with 3-5 disposable files totaling about 200-500 MB in a
separate app-accessible Drive folder. Do not begin with a whole photo library.
Record device/OS/browser, code revision, source picker/local versus iCloud,
file count, total bytes, largest file, and initial Safari storage observations.

1. Select and upload. Let one file complete and another make confirmed progress.
   Pause All. Wait for active requests to stop and the saved-metadata message.
2. Reload. Verify counts, completed entries, saved destination, and missing-source
   count. No upload should start and no old token should remain usable.
3. Reconnect sources with an overlapping selection that includes the completed
   file. It should be skipped, not uploaded again. Unrelated files must be reported
   unmatched, not added. Reconnect the same Google account and explicitly resume.
4. Check exactly one Drive file per unique entry, unchanged IDs across recovery,
   correct sizes/destination, and playable/openable contents. Keep IDs private;
   record only match/mismatch in public results.
5. Repeat using close-tab/reopen. In a separate small run, test reload during an
   active transfer, without relying on a pagehide save, and verify the same IDs.
6. Open a second tab while the first owns the batch. It must block selection and
   uploads. Close the first, reload the second, and recover normally.
7. With controlled samples only, separately test Safari termination and a phone
   reboot. Record source reaccess, recovery results, storage growth, and any
   selected-tab restoration failure. Stop on persistent growth or instability;
   Phase 0's limitation remains relevant.
8. When actual OAuth expiry occurs, verify same-account reconnection and resume.
   A different account you control must be rejected. Record actual token/session
   expiry as **not exercised** unless it occurs; mocked tests are not device passes.
9. Exercise **Request storage protection** and record granted/denied/unavailable.
   Never clear real queue data to manufacture a test failure. Storage quota,
   transaction failure, invalid snapshots, and expired sessions have mock coverage.
10. Disable Keep Awake after finishing and verify final files in Drive again.

Record each case separately, with pass/fail/not exercised, final completed/failed
counts, duplicate count, source-match results, and Safari stability observations.
Repeat on Android Chrome when hardware is available; do not infer an Android pass
from desktop or iPhone evidence.

## Automated and local-browser evidence

Dependency-free Node tests cover versioned snapshots, atomic invalid-record
rejection, duplicate remote IDs, coalesced-save completion races, transaction
commit/abort behavior, original-account binding, missing sources, fingerprint
mismatches, completed-record retention, and storage-failure upload gating.
Protocol mocks cover expired sessions, ambiguous responses, and reconciliation
against a reserved ID without another allocation. Page doubles cover restored
controls, corrupt storage, and tab-lock rejection.

On 2026-09-13 the integrated desktop browser used real IndexedDB and Web Locks
with two synthetic files and mocked Google identity/HTTP responses. One file
completed; another stopped after 8 MiB of confirmed progress. Reload retained the
completion and destination, required one source, and rejected a wrong account.
After reselection, Retry Failed probed Google and sent only the remaining bytes.
Two files used exactly two reserved IDs. A second real browser tab was blocked.
The 390 x 844 mobile viewport had no horizontal overflow and the brand image loaded.

The initial real GIS script still emitted the previously recorded inline-style
CSP warning. Its effect on real authorization remains unverified; CSP was not
weakened. No personal media or real Google transfer was used for these checks.
These results do not establish physical Safari kill/reboot, storage pressure,
multi-hour operation, or large-batch performance.

## Protocol and platform references

Checked 2026-09-13:

- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads):
  session URI expiry after one week; status probes return 200/201, 308 with Range,
  or 404 for expired sessions. Pre-generated IDs support retry without duplicates;
  successful prior creation produces 409 on retry.
- [MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API):
  same-origin exclusive coordination, `ifAvailable`, and callback-promise lifetime.
  Listed support includes Safari/iOS 15.4+ and Chrome/Android Chrome 69+.
- [MDN persistent storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist):
  the request may be denied; availability is feature-detected.
- [MDN IndexedDB transactions](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction):
  strict durability is requested for write checkpoints, not treated as an absolute
  guarantee against storage loss.