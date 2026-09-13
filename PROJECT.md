# PROJECT — Cross-Platform Photos & Videos → Google Drive Reliable Web Uploader

> **Canonical project specification.** This file records the product intent, architectural decisions, constraints, risks, and implementation phases. AI agents should read this before making architectural or product decisions. When implementation discoveries change an accepted decision, update this file in the same change.

The public application brand is **BatchHarbor**. “Google Drive” may be used to
describe the supported destination, but it is not part of the application name.
The project is independent and is not affiliated with or endorsed by Google.
The public site uses the verified custom domain `batchharbor.killfly.com`; OAuth
JavaScript origins and public policy URLs must use its HTTPS origin.

## Project Goal

Build a **frontend-only web application**, ideally React/TypeScript, that lets users on phones and computers select a very large batch of photos and videos using the browser/OS-native picker and upload them **directly from the browser to a chosen Google Drive folder**.

The primary design target remains **iPhone/iPad Safari**, because that is the original problem to solve and likely the platform with the most browser-specific constraints. However, the application should be architected as a standards-based, cross-platform uploader that also works well on Android browsers and desktop browsers without maintaining separate codebases.

The primary use case is not interactive file management. It is:

> Select hundreds or thousands of photos/videos, start the transfer, leave the iPhone plugged in with the page open, and come back later to see progress. Failed files should be easy to retry.

There should be **no application backend**. The web host serves only static HTML/CSS/JavaScript. Photo/video bytes must travel directly from the user's browser to Google Drive.

---

## Core Product Principles

1. **Frontend only.** No Node/Express API, database server, proxy upload service, S3/R2 staging, or application server.
2. **Direct transfer.** Media bytes go from Safari directly to Google Drive over HTTPS.
3. **Designed for huge batches.** Thousands of files, including large MOV files, are a first-class use case.
4. **Walk-away operation.** Once configured, the user should be able to tap Upload All and mostly ignore the application.
5. **Reliability over cleverness.** Resume interrupted uploads, automatically retry transient failures, clearly expose permanent failures, and avoid duplicate Drive files.
6. **Cross-platform, mobile-first.** Primary validation target is current iPhone/iPad Safari, but Android Chrome and modern desktop browsers should be supported by design.
7. **Progressive enhancement.** Build the core uploader on broadly supported web standards; use platform-specific APIs only as optional enhancements.
8. **Privacy.** The application host never receives or stores the user's media.


---

## Proposed Architecture

```text
┌──────────────────────────────┐
│       React Web App          │
│   Static HTML/CSS/JS only    │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
Native OS/browser    Google OAuth
file/media picker    in browser
       │                │
       ▼                ▼
Browser File       Google access
objects            token
       │                │
       └───────┬────────┘
               ▼
       Persistent Upload Queue
        IndexedDB + memory
               │
               ▼
       Google Drive resumable
           upload sessions
               │
               ▼
          Google Drive
```

Suggested stack:

- React
- TypeScript
- Vite
- IndexedDB for queue metadata/persistence
- Google Identity Services for OAuth
- Google Drive REST API v3
- Screen Wake Lock API
- Static hosting (GitHub Pages, Cloudflare Pages, Netlify, Vercel static hosting, etc.)

Do not introduce a backend unless a later requirement makes one unavoidable.

---

## Cross-Platform File Selection

Use a standard HTML multiple-file input so each operating system/browser can invoke its native media/file picker:

```html
<input
  type="file"
  accept="image/*,video/*"
  multiple
/>
```

The user should be able to use whatever bulk-selection gestures the current native picker provides. The web application cannot implement or modify gestures inside Apple's, Google's, Samsung's, or other OS-level pickers.

Expected behavior by platform:

- **iPhone/iPad Safari:** native Apple Photos/file picker; this is the highest-risk compatibility target.
- **Android Chrome:** native Android media/file picker; should be treated as a first-class supported target even if immediate physical-device testing is unavailable.
- **Samsung Internet / Android Firefox:** best-effort support using the same standards-based flow.
- **Desktop Chrome/Edge/Safari/Firefox:** native file picker support; useful for large desktop photo/video batches as a secondary use case.

Do **not** make the File System Access API a core dependency because it is not consistently available on mobile. It may be used later as an optional desktop enhancement.

### Selection UX

The application should support:

- Select Photos & Videos
- Add More
- Display number of selected items
- Display total selected bytes when practical
- Deduplicate repeated selections
- Allow removal before upload
- Avoid loading entire photos/videos into JavaScript memory
- Work from `File`/`Blob` slices wherever possible

Potential file identity fields:

- filename
- size
- MIME type
- `lastModified`
- optional lightweight fingerprint when needed

Do not hash entire multi-gigabyte videos unless there is a compelling reason.

---


## Platform Support Strategy

The app should use a single React/TypeScript codebase and a common upload engine across platforms.

### Tier 1 Targets

- iPhone/iPad Safari
- Android Chrome
- Desktop Chrome/Edge
- macOS Safari

### Tier 2 / Best-Effort Targets

- Samsung Internet
- Firefox for Android
- Desktop Firefox

### Shared Core Capabilities

These features should be implemented using broadly supported standards:

- `<input type="file" multiple>`
- `File` / `Blob`
- `File.slice()`
- `fetch()`
- `AbortController`
- IndexedDB
- Google Identity Services
- Google Drive REST API v3
- Screen Wake Lock API where supported

The Drive resumable-upload engine, queue state machine, retry logic, duplicate prevention, and dashboard should be platform-neutral.

### Platform-Specific Risk Profile

**iOS/iPadOS Safari** is expected to need the most compatibility testing because of:

- aggressive tab/page suspension
- loss of live `File` access after a browser/page lifecycle event
- native Photos picker behavior
- the WebKit storage-growth bug documented later in this plan
- limits on reliable background execution

**Android Chrome** is expected to work with the same architecture and may prove more forgiving for long-running transfers, but this must not be assumed without testing. Because no Android test device is currently available, implementation should avoid iOS-specific assumptions and keep an explicit Android test checklist for later validation.

**Desktop browsers** should mostly work from the same core implementation and can be used as an early development/debugging environment, but desktop success must not be treated as proof that mobile behavior is correct.

### Progressive Enhancement

Feature-detect optional APIs rather than user-agent-sniffing wherever practical. Example:

```ts
const supportsWakeLock = "wakeLock" in navigator;
```

Do not fail the core uploader just because an enhancement is unavailable. For example, if Screen Wake Lock is unsupported, show a warning recommending that the user keep the device awake manually.

## Google Authentication

Use Google Identity Services in the browser.

Requirements:

- OAuth web client
- Request only the Drive scopes actually required
- No OAuth client secret embedded in the frontend
- Keep access tokens in memory where practical
- Gracefully reacquire authorization when tokens expire
- Never persist Google passwords or other user credentials

The application should allow the user to choose a Google Drive destination folder.

Decision (2026-09-13, expanded after user feedback): use Google Picker for browsing
existing owned and "Shared with me" folders, retaining only `drive.file`.
Leave the ownership filter unset so both are included, as documented by Google.
The REST dropdown cannot enumerate all Drive
folders under that scope; it remains a shortcut for already authorized folders.
Picker uses the current account's in-memory token, a folder-only list view, and
single selection. After selection, verify `files.get` metadata: matching ID, folder
MIME type, not trashed, and `capabilities.canAddChildren`. Do not trust Picker names
or infer access to every pre-existing descendant. No media upload view is added.

Browse is available only before a batch's destination is fixed. Cancellation,
verification failure, and late callbacks after disposal cannot replace the current
destination. Missing API-key/project-number configuration is shown explicitly;
Google Cloud setup and real Picker/device checks remain external prerequisites.
The user reports configuring and redeploying Picker successfully for owned folders.
Shared-folder selection still needs a real-account check. "Shared with me" folders
are distinct from Workspace Shared drives; a dedicated Shared drives view and
shared-drive upload support are not introduced by this change.

The dashboard CSP adds `apis.google.com` scripts and `docs.google.com` frames.
Google's hosted Picker module injects inline CSS, so dashboard `style-src` allows
`'unsafe-inline'`; this is a deliberate style-only relaxation, not an inline-script
or eval exception. The module's changing hosted CSS makes a pinned stylesheet hash
brittle; a hardcoded nonce is not a security solution. Script restrictions, Google-only
connections, direct media transfer, and other harness policies remain intact.
See [Google folder Picker setup, evidence, and tests](docs/drive-folder-picker.md).

---

## Google Drive Upload Strategy

Use **Google Drive resumable uploads** rather than simple multipart uploads.

For each file:

1. Create Drive file metadata/resumable upload session.
2. Save the resumable session URI in queue state.
3. Upload the file in chunks using `File.slice()`.
4. Track only bytes Google confirms as committed.
5. If interrupted, query the resumable session for its committed range.
6. Resume from Google's confirmed offset.
7. Mark complete only after Drive confirms completion.

Conceptual request:

```js
const chunk = file.slice(start, end);

await fetch(sessionUrl, {
  method: "PUT",
  headers: {
    "Content-Range": `bytes ${start}-${end - 1}/${file.size}`
  },
  body: chunk,
  signal: abortController.signal
});
```

Chunk size should be configurable internally. Benchmark reasonable values on iPhone and, when available, Android rather than assuming desktop-optimal sizes.

### Concurrency

Start conservatively with approximately **2–3 concurrent uploads** on mobile. Make this an internal setting initially.

Allow concurrency tuning by platform later if testing shows that Android or desktop browsers can safely handle more parallel uploads.

Avoid starting dozens of simultaneous uploads.

---

## Queue Model

Suggested model:

```ts
type UploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "paused"
  | "retrying"
  | "failed"
  | "completed";

interface UploadItem {
  localId: string;

  // The live File object may only be available for the current browser session.
  file?: File;

  name: string;
  size: number;
  mimeType: string;
  lastModified: number;

  driveFolderId: string;
  driveFileId?: string;
  uploadSessionUrl?: string;

  uploadedBytes: number;
  status: UploadStatus;
  retryCount: number;
  lastError?: string;
}
```

Persist durable metadata in IndexedDB.

Do not assume a persisted IndexedDB record guarantees that Safari will retain access to the original user-selected `File` after the page/browser is destroyed.

---

## Pause / Resume

### User Pause

Use `AbortController` to stop active HTTP requests.

When paused:

- abort current chunk requests
- preserve resumable session URI
- preserve last confirmed Drive byte offset
- change item state to paused

When resumed:

- query Google for committed bytes if necessary
- continue from the confirmed offset

### Network Failure

Automatically retry transient errors using exponential backoff with jitter.

Examples of retryable situations:

- temporary loss of network
- 408
- 429
- appropriate Google 5xx responses

Do not endlessly retry obviously permanent authorization, permission, unsupported-file, or invalid-request failures.

### Retry Failed

The dashboard must have a prominent **Retry Failed** button.

Retry Failed should requeue failed items without disturbing completed items.

---

## Browser/Page Restart Recovery

This is an important limitation of a browser-only design.

IndexedDB can retain:

- filename
- size
- timestamps
- status
- Drive file ID
- resumable session URI
- confirmed uploaded bytes
- error state

But Safari may no longer provide access to the original selected `File` after the page/browser has been killed.

Design recovery UX such as:

> Previous upload found. 1,284 files still need source access. Select those photos/videos again to reconnect them to the existing upload queue.

Match reselected files using combinations of:

- filename
- size
- `lastModified`
- optional partial fingerprint

If a matching Google resumable session remains valid, resume it instead of creating a new upload.

Research exact Drive resumable-session expiration behavior and handle expired sessions gracefully.

---

## Duplicate Prevention

Duplicate prevention matters because retries/restarts must not silently create multiple copies of the same photo.

Investigate using Google Drive's pre-generated file IDs / caller-supplied file IDs where supported so a queue item has a stable destination identity.

Also maintain local completion records.

A completed queue item must never be uploaded again merely because Upload All or Retry Failed was tapped.

---

## Keep Awake / “Coffee” Feature

Include a user-facing **☕ Keep Screen Awake** toggle.

Use the Screen Wake Lock API rather than fake video playback or game-like tricks.

Conceptually:

```js
let wakeLock: WakeLockSentinel | null = null;

async function enableWakeLock() {
  wakeLock = await navigator.wakeLock.request("screen");
}

async function disableWakeLock() {
  await wakeLock?.release();
  wakeLock = null;
}
```

The wake lock can be released by the browser/system. Reacquire it when appropriate after `visibilitychange` if:

- the page is visible
- uploads are running
- the user enabled Keep Awake

The UI should explain:

> Keep this page open, keep the phone plugged in, and stay connected to Wi-Fi for best results.

Do not claim that a wake lock gives a webpage native iOS background execution privileges.

---

## Preferred UI Direction

The preferred concept is the **large-batch dashboard**, not a detailed file-manager interface.

The visual reference at `assets/design/mobile-dashboard-reference.png` is useful
for the mobile card hierarchy, aggregate progress, large controls, status counts,
and prominent Keep Awake treatment. Its message that users can close the app and
uploads will automatically resume is not an accepted product claim: Safari may
lose live `File` access, and Phase 0 produced a restoration failure with a retained
selection. The implemented dashboard must instead explain the current lifecycle
limits and any source-reselection recovery accurately.

The main upload screen should communicate the state of the entire job at a glance.

Example:

```text
        Uploading to Google Drive

              67%

          3,293 of 4,922 files
          28.4 GB of 42.1 GB
          ~1h 12m remaining

┌──────────┬───────────┬───────────┬──────────┬────────┐
│ Selected │ Completed │ Uploading │ Remaining│ Failed │
│  4,922   │   3,201   │     3     │  1,716   │   2    │
└──────────┴───────────┴───────────┴──────────┴────────┘

        [ Pause ]       [ Retry Failed ]

        ☕ Keep screen awake       ON

        Keep this page open and phone plugged in.
```

Primary philosophy:

> Select everything → Upload All → walk away → return later to see status.

Individual file details should be secondary, perhaps behind a Details screen or expandable section.

### Setup Screen

Before uploading:

1. Select Photos & Videos
2. Connect Google Drive
3. Choose Drive destination
4. Show selection count/size
5. ☕ Keep Screen Awake
6. Upload All

Once the transfer begins, transition to the dashboard.

### Dashboard

Prominently show:

- overall percentage
- files completed / total
- bytes uploaded / total
- current number uploading
- remaining files
- failed files
- approximate remaining time (clearly approximate)
- Pause/Resume
- Retry Failed
- Keep Awake state
- network/authorization problems

Do not clutter the primary screen with thousands of filenames.

---

## Critical Safari/WebKit Risk to Investigate FIRST

Before implementing Google Drive uploads, build a tiny iPhone Safari proof-of-concept to test a potentially serious WebKit issue involving `<input type="file">` and the iOS Photos picker.

A WebKit bug reported in July 2026 describes Safari's **Documents & Data increasing approximately by the size of photo/video assets selected through the Photos picker**, apparently because picker-selected media is materialized into temporary storage and not properly reclaimed.

Reported characteristics include:

- occurs merely from selecting/preparing files; JavaScript does not necessarily need to read them
- storage growth approximately tracks prepared media size
- closing the tab reportedly does not immediately reclaim it
- force-quitting Safari reportedly does not reclaim it
- reboot reportedly does not reclaim it
- repeated selections may accumulate
- reported on an iPhone 16 Pro with iOS 26.5
- also reported on an iPad mini 6 with iPadOS 18.6.2
- clearing Safari history/website data reportedly reclaimed the leaked storage in the report

This is a public bug report, **not proof that every iPhone/iOS version is affected**. Verify on target devices.

Reference:

- WebKit Bug 318572: https://bugs.webkit.org/show_bug.cgi?id=318572

### Phase 0 Test Page

Before writing the uploader, create a trivial page containing only:

```html
<input type="file" accept="image/*,video/*" multiple>
```

plus JavaScript that reports:

- number of selected files
- filenames
- MIME types
- sizes
- total selected bytes

Do **not** read the file contents.

Test procedure on iPhone:

1. Record Safari Documents & Data in iPhone Storage.
2. Open test page.
3. Select a known ~200–500 MB video or a similarly controlled sample.
4. Record storage change.
5. Close the tab.
6. Force-close Safari.
7. Recheck storage.
8. Reboot if needed and check again.
9. Repeat with another controlled selection only if safe.

Also evaluate native iOS Photos picker behavior for selecting hundreds/thousands of items, especially whether the current picker supports efficient drag/swipe multi-selection.

**Do not proceed to a production architecture until this behavior is understood.** It could make enormous browser-based batches unsafe on affected iOS versions.

---

## Additional iOS/Safari Risks

Test rather than assume:

- maximum practical number of files returned by the Photos picker
- behavior with thousands of `File` objects
- huge MOV files
- HEIC
- Live Photos and what resources the HTML picker exposes
- RAW/DNG if relevant
- memory pressure
- Safari tab eviction
- wake lock behavior over multi-hour transfers
- screen dimming/locking
- Wi-Fi changes
- switching apps briefly
- incoming phone calls
- OAuth token expiry during a long job
- IndexedDB persistence
- storage eviction
- Google resumable-session recovery
- service worker interactions
- PWA/Home Screen behavior versus normal Safari tab

Do not rely on a service worker to magically provide native-style long-running background uploads on iOS.

---

## Suggested Implementation Phases

### Phase 0 — iOS Feasibility Tests

Implementation status (2026-09-08): the dependency-free static harness is available
at `phase0/index.html`, with separate bounded-read and Wake Lock experiments at
`phase0/experiments.html`. See the [device test procedure](docs/phase-0-testing.md)
and [results template](docs/phase-0-results-template.md). WebKit bug 318572 remains
NEW as checked on that date; this is external reported evidence, not local device
validation. Initial user-reported [iPhone 16 Pro / iOS 26.6.1 storage observations](docs/phase-0-iphone-16-pro-ios-26.6.1.md)
were recorded on 2026-09-09: the tested video selections did not show persistent
growth approximately equal to selected media size, and most observed growth
subsided after closing the tab and Safari. **Phase 0 decision: sufficient real-iPhone evidence
for a bounded Phase 1 Drive spike, with documented limitations.** A subsequent
user-reported 30-minute foreground test passed: initial/repeat bounded reads,
screen staying awake, and app-switch recovery checks. Higher selection counts,
whole-file integrity, and multi-hour operation remain unverified. This decision
does not establish production safety.
Keep Screen Awake kept the physical screen on for approximately three minutes
(12:37–12:40 AM) with a 30-second auto-lock setting, as observed by the user.
The later 30-minute sequence included successful app-switch/reacquisition checks
by overall user report; exact UI states were not recorded.
Follow-up user reports confirm bounded reads after switching to Reddit and back,
but fully closing/reopening Safari produced “A problem repeatedly occurred” before
the page loaded or a read was requested. This unresolved page restoration/loading
failure is recorded in the same device report; its cause is not established.
A follow-up comparison reopened the experiments page successfully with no file
selected, but failed after selecting one small video. This associates failure
with prior selection in that test, without establishing a cause. The user then
confirmed that a fresh tab loads after the failure, and that clearing the
selection before closing Safari allows successful reopening. This demonstrates
page-access recovery for the harness, not retained source access or upload state.
Future recovery must not depend on the user clearing a selection before an
unexpected browser termination.
Android physical validation remains deferred. The bounded Drive spike proceeds on
the recorded real-iPhone evidence, not on harness completion or automated checks alone.

Build the smallest possible static test page.

Validate:

- native photo/video multi-selection UX
- large batch selection
- reported Safari Documents & Data issue
- whether selected files remain usable for long periods
- Wake Lock API behavior

Stop and reconsider architecture if selection itself causes unacceptable storage consumption.

### Phase 1 — Google Drive Spike

Implementation status (2026-09-09): the static Phase 1 spike is available under
`phase1/`. It uses Google Identity Services' browser token model with `drive.file`,
creates or lists app-accessible destination folders, reserves a stable Drive file
ID, and uploads one file in resumable 8 MiB chunks. It supports same-tab pause,
confirmed-offset probing, bounded transient retries, reauthorization with account
pinning, and session-expiration reconciliation. See the [Phase 1 test procedure](docs/phase-1-testing.md).
Real Google Drive/iPhone testing passed by user report on 2026-09-09: connection
and test-folder creation, small-file upload and content/size verification,
larger-video pause/resume with stable file identity, network interruption recovery,
and one completed Drive file per test. See the [reported results](docs/phase-1-testing.md#reported-results-2026-09-09)
for evidence limits. This clears the gate for Phase 2, not production or
browser-restart reliability. Tokens, live files, session URLs, and progress are
deliberately not persisted in this spike.

Without React polish:

- Google browser OAuth
- choose/test a Drive folder
- upload one small file
- upload one large video using resumable upload
- intentionally interrupt connection
- resume from confirmed offset

### Phase 2 — Upload Engine

Implementation status (2026-09-09): `phase2/upload-queue.mjs` coordinates the
existing `DriveUpload` protocol with an in-memory queue, configurable concurrency
(default two) and aligned chunk size (default 8 MiB), batch pause/resume,
bounded protocol retries, Retry Failed, stable destination identities, and
incremental confirmed-byte/state totals. Authorization failure pauses the entire
batch; explicit same-account reconnection and resume retain each upload identity.
Completed entries retain metadata for deduplication but release live source references.

The separate static test page under `phase2/` supports Add More, metadata-based
selection deduplication, removal of unstarted entries, aggregate progress, and
50-row paginated failure/file details. Matching name, size, MIME type, and
modification time is a heuristic, not proof of identical contents. Retry Failed
also resumes paused work; ordinary Resume does not requeue permanent failures.
The destination stays fixed once a batch starts. No operation deletes sources
or existing Drive content. Empty files are explicitly skipped in this test.

Decision: retain dependency-free JavaScript modules for this engine/test slice,
reusing the real-device-tested Phase 1 protocol rather than combining this phase
with a React/Vite migration. The intended full application stack remains
React/TypeScript; engine logic stays independent of UI. IndexedDB/restart
recovery remains Phase 3 and the full dashboard remains Phase 4. A small real-device
batch pass was reported by the user on 2026-09-13, clearing the gate to Phase 3;
individual checklist results and device details were not separately supplied.
Android physical validation remains pending; see the [Phase 2 test procedure and
results](docs/phase-2-testing.md) for evidence limits. This is not validation of
large batches, multi-hour transfers, or restart recovery.

Implement:

- queue
- configurable chunking
- concurrency limit
- pause/resume
- automatic retries
- exponential backoff
- error classification
- retry failed
- duplicate prevention
- accurate progress accounting

Keep upload logic independent of React UI.

### Phase 3 — Persistence / Recovery

Product decision (2026-09-13, after initial Phase 4 testing): the user explicitly
chose to keep the browser-only application rather than pursue a native app.
The primary workflow is select a batch, upload, and keep the page open and active
until completion. Wake Lock is a best-effort aid, not an execution guarantee.
Same-session pause/resume, transient-failure recovery, confirmed progress, and
duplicate prevention remain core requirements while source access is available.

Recovery after reload, tab closure, or lost source access is best-effort, not a
core reliability promise. Reconstructing a selection of thousands of originals
is not an acceptable normal workflow. Retain saved metadata and optional source
reconnection for cases where it is practical, but do not present metadata as
durable access to media or require users to rely on reselection for large batches.
This decision clarifies the recovery scope of earlier phase requirements; it does
not authorize removing persistence, clearing old batches automatically, staging
media, adding a backend, or deleting source/Drive files.

Implementation status (2026-09-13): implemented in the existing `phase2/` batch
page and modules, keeping the deployment URL stable. The plain-JavaScript engine
remains independent of UI; the React/TypeScript dashboard is still Phase 4.
See [Phase 3 testing and decisions](docs/phase-3-testing.md) for the device
procedure, verified protocol references, and evidence limits.

Accepted decisions:

- Store a versioned IndexedDB snapshot of queue metadata, original Drive account
  permission ID, fixed destination, stable file IDs, resumable session URLs,
  confirmed progress, sanitized errors, bounded source fingerprints, and
  completed records. Do not store media, live File objects, or OAuth tokens.
- Await committed metadata checkpoints before file creation and media requests;
  request strict IndexedDB write durability. Coalesce concurrent snapshot saves.
  Storage failure pauses uploads and requires an explicit successful save retry.
  Invalid/unsupported records block startup without silently replacing them.
- Restore unfinished work paused or failed with missing source access. Match exact
  name/size/type/modification time and, for previously prepared files, SHA-256 of
  at most the first/last 64 KiB. This is not proof of whole-file equality.
  Changed/ambiguous/unreadable sources are rejected, not added as new uploads.
- Verify the saved account before accepting a fresh token. Probe Google before
  resuming; reconcile an expired session against the same reserved Drive ID.
  Completed entries stay completed and retain selection deduplication metadata.
- Require an exclusive Web Lock for the persisted batch's tab lifetime. A second
  tab cannot read/replace the queue or start uploads. Feature-detect the API and
  block this recovery page safely when unavailable; no unsafe competing-writer
  fallback. MDN lists current Tier 1 support (Safari/iOS 15.4+, Chrome 69+).
- Browser storage retention is not guaranteed. Optional storage protection can
  be denied. No background execution, source retention, Safari kill/reboot, or
  production-scale reliability is claimed. The Phase 0 limitation remains.
- This slice retains one saved batch with a fixed account/destination and bounded
  detail rendering; batch-history management is not introduced here.

Automated checks and an integrated desktop-browser reload/reselection flow with
real IndexedDB/Web Locks and mocked Google passed. On 2026-09-13 the user confirmed
resuming after reopening Safari and reselecting originals, then reported all
requested checks working and asked to proceed to Phase 4. See the
[reported Phase 3 results](docs/phase-3-testing.md#reported-results---2026-09-13).
This is not an instrumented pass: exact device/revision, independent per-case
results, force-kill/reboot, Android, and actual token/session expiry remain
unverified unless separately recorded.

Implement IndexedDB queue metadata.

Test:

- reload
- tab close/reopen
- Safari kill
- phone reboot
- expired OAuth token
- expired Drive resumable session
- source `File` access loss
- user reselect/reconnect workflow

### Phase 4 — Mobile UI

Implementation status (2026-09-13): React/TypeScript dashboard in `phase4/`, built
with Vite to `/app/`. The public homepage links to the dashboard. Existing
Phase 0-3 pages remain available; `/app/` shares the Phase 2 IndexedDB database
and exclusive writer lock, so there is no migration or competing upload engine.

Accepted implementation decisions:

- Keep protocol and queue outside React. A typed controller owns auth, lifecycle,
  storage, wake lock, and coalesced snapshot notifications. React subscribes via
  `useSyncExternalStore`; details are only materialized when opened, 50 rows/page.
- Short setup transitions to aggregate progress, completion/active/remaining/failed
  counts, confirmed bytes, Pause/Resume and prominent Retry Failed (including while
  healthy transfers continue). Source-backed eligibility uses incremental queue
  counters, not repeated scans of the full list. No new upload states are introduced.
- Recovery shows missing source access and account connection as separate steps.
  Disabled Resume has a visible explanation. Saved metadata does not imply saved
  media access; the storage-protection denial explains that ordinary saving remains.
- ETA uses recent confirmed-byte progress, begins after five seconds of observations,
  and resets on pause, retry, offset rollback, or changed batch size. Stalled progress
  yields no estimate. The percentage does not round to 100% before all files complete.
- A feature-detected switch controls Screen Wake Lock; actual acquisition/release is
  displayed separately from the requested setting. No background execution claim.
- Fonts and icons are bundled locally (DM Sans/Manrope, OFL; Lucide, ISC; React/Vite,
  MIT). No analytics, media storage, scope changes, or application backend. The later
  existing-folder enhancement lazily loads Google's hosted Picker in addition to GIS.
  Added build dependencies are frontend tooling only.
- Production CSP retains Google-only connection destinations. Vite development
  alone allows local WebSockets; inline styles are allowed for Picker as documented
  above. CI installs locked
  dependencies, runs tests/typecheck/lint, builds static assets, and publishes `/app/`.
- One saved batch, fixed destination, and completed deduplication records remain.
  Batch history is not introduced. Following explicit user approval on 2026-09-13,
  **Start new batch** may discard that batch's local records only after confirmation
  of lost recovery/duplicate-prevention history and a warning to inspect Drive.
  It requires successful startup, exclusive writer ownership, no active uploads,
  and no other controller operation. Pending saves drain before an empty snapshot
  commits atomically. Only then are in-memory queue, account binding, destination,
  and pending folder identity replaced. Save failure keeps the old queue. Cleanup
  waits for reset writes and cannot repersist the old batch after a committed reset.
  Originals and remote Drive files are never deleted; reset makes no Google request.
- Startup has a 15-second deadline covering lock acquisition and storage open/read.
  Timeout names the pending stage and leaves uploads/reset disabled, with a
  **Reload saved batch** action. Late responses cannot restore records, install
  persistence, or enable uploads in the failed controller. No automatic data reset
  or unsafe lock bypass is allowed. Browser suspension or a blocked main thread can
  delay the timer; this is not a native watchdog or proof of the phone stall's cause.

See [Phase 4 testing](docs/phase-4-testing.md) for verification and remaining device
checks. On 2026-09-13, after deploying startup hardening and guarded reset, the user
reported the deployed dashboard working well on their phone. This is an overall
user-reported Phase 4 pass, not an instrumented or per-case validation. The exact
revision, device/OS, batch size, and exercised failure paths were not supplied.
The prior startup stall's cause remains unconfirmed; the latest report does not
indicate a continuing blocker. Proceed with progressive keep-open tests beginning
at 10 controlled files; do not infer production-scale or Android reliability.

Build the batch-oriented dashboard.

Optimize for:

- one-handed setup
- huge touch targets
- glanceable progress
- minimal interaction once upload begins
- clear failed-file recovery

### Phase 5 — Stress Testing

Progress (2026-09-13): after the keep-open test and requested Drive count/size/
duplicate checks, the user reported "that all worked", then clarified "I uploaded
195 files". This corrects the earlier assumed 10-file batch size and covers the
100-file stage as a user-reported pass, not independently measured evidence.
Exact bytes, duration, revision, and device/OS were not supplied for that batch.

Further user-reported results (2026-09-13, deployed phone app):

| Check | Reported result |
| --- | --- |
| Completed upload | 200 files, 3.32 GB as reported |
| Start / initial estimate | 10:53am / 13 minutes |
| Progress | 50% at 11:01am; 100% at 11:07am |
| Elapsed time | Approximately 14 minutes; one minute longer than the initial estimate |
| Drive verification | User verified 200 files uploaded |
| Larger selection | 1,535 files successfully added to the queue after a long wait for the Photos picker to close |

The 200-file report does not separately confirm content/size/duplicate checks for
each file. The 1,535-file batch was not uploaded to completion; picker delay was
not timed or diagnosed. Exact build, device/OS, media mix, and storage impact were
not supplied. These are user reports, not agent-operated measurements.

The user explicitly chose to defer further long-running upload tests and move on.
Do not request another 1,000-file upload as a prerequisite for continued development.
This is a decision to defer testing, not evidence of completed large-batch transfers
or production safety. Next: review MVP readiness against the existing success
criteria and document remaining release/platform risks without expanding features.

Progressive targets (larger transfer stages deferred, not passed):

- 10 files
- 100 files
- 1,000 files
- several thousand files
- batches containing multi-GB MOV files
- tens of GB total

Do not jump immediately to a user's entire irreplaceable library.

---

## Suggested Project Structure

```text
src/
  app/
    App.tsx

  auth/
    googleAuth.ts

  drive/
    driveApi.ts
    createUploadSession.ts
    uploadChunk.ts
    queryUploadSession.ts
    folderPicker.ts

  upload/
    UploadManager.ts
    UploadWorker.ts
    RetryPolicy.ts
    QueueStore.ts
    fileIdentity.ts
    types.ts

  persistence/
    indexedDb.ts

  wakeLock/
    wakeLock.ts

  components/
    SetupScreen.tsx
    BatchDashboard.tsx
    ProgressRing.tsx
    UploadSummary.tsx
    FailedUploads.tsx
    KeepAwakeToggle.tsx

  hooks/
    useUploadQueue.ts
    useWakeLock.ts
    useGoogleAuth.ts

  utils/
    formatBytes.ts
    formatDuration.ts
```

Prefer plain modules/classes for the transfer engine rather than embedding networking logic in React components.

---

## Security / Privacy Requirements

- HTTPS only
- media must upload directly from browser to Google
- do not send filenames/media to application analytics by default
- do not store OAuth access tokens longer than necessary
- no Google client secret in frontend
- use least-privilege Google scopes
- clearly tell users where files are going
- never delete source iPhone photos
- never delete/overwrite Drive files without explicit behavior and safeguards

Published user-facing documents:

- Privacy Policy: `legal/privacy/index.html`, deployed at `/privacy/`
- Terms of Service: `legal/terms/index.html`, deployed at `/terms/`

These documents must be updated before implementation changes how Google user data
is accessed, used, stored, retained, or shared. The privacy policy explicitly
states compliance with the Google API Services User Data Policy, including Limited
Use requirements. The original project logo is at
`assets/brand/reliable-uploader-logo.png`; it intentionally avoids Google brand marks.

A useful privacy message in the UI:

> Your photos and videos go directly from this device to Google Drive. This website does not upload or store copies on its own servers.

Only make this claim if the implementation actually preserves that architecture.

---

## Success Criteria for MVP

The MVP succeeds when an iPhone user can:

1. Open the site in Safari.
2. Select a large batch of photos/videos.
3. Authenticate to Google.
4. Choose a Drive folder.
5. Enable ☕ Keep Awake.
6. Tap Upload All.
7. See accurate aggregate progress.
8. Experience a network interruption without restarting completed data/files unnecessarily.
9. Pause and resume.
10. Automatically retry transient failures.
11. See a count of failed files.
12. Tap Retry Failed.
13. Finish with every file either confirmed uploaded or clearly identified as failed.

The app should remain understandable when the queue contains **5,000+ files**.

---

## Non-Goals for Initial Version

Do not initially build:

- iCloud account integration
- native iOS app
- server-side uploads
- photo editing
- gallery organization
- synchronization/deletion between Photos and Drive
- automatic background backup of newly taken photos
- AI classification
- complex album mapping

Solve **reliable bulk transfer** first.

---

## Open Questions / Research Tasks

1. Reproduce or disprove WebKit Bug 318572 on current target iPhones.
2. Determine practical Photos-picker batch limits on current iOS.
3. Confirm efficient native bulk-selection gestures available through Safari's file picker.
4. Determine exactly what Live Photos appear as through HTML file input.
5. Choose Google OAuth scopes with minimum required access.
6. Choose Drive folder-selection implementation.
7. Verify current Drive resumable-session lifetime and recovery semantics.
8. Verify whether caller-generated/pre-generated Drive IDs are suitable for duplicate prevention in this exact upload flow.
9. Benchmark chunk sizes and concurrency on real iPhones.
10. Determine the most reliable strategy when Safari loses the live `File` object but IndexedDB still contains queue/session metadata.
11. Test whether installing as a Home Screen web app materially improves lifecycle/wake-lock behavior.
12. Test iOS behavior when storage is low before allowing giant selections.

---

## References

- Google Drive API — Upload file data / resumable uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Google Drive API — Create/manage files: https://developers.google.com/workspace/drive/api/guides/create-file
- Google Picker for web: https://developers.google.com/workspace/drive/picker/guides/overview
- Google Identity Services: https://developers.google.com/identity/gsi/web
- Screen Wake Lock API: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- WebKit Safari 16.4 features / Wake Lock: https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- WebKit Bug 318572 (Photos picker / Safari storage issue): https://bugs.webkit.org/show_bug.cgi?id=318572

---

## Instructions to Coding Agent

Start with **Phase 0**, not the complete React application.

Create a minimal, static iPhone Safari test harness that lets us verify the native Photos picker and the suspected Safari storage issue before committing to the architecture.

Keep the code intentionally small and auditable. Do not introduce a backend.

Once Phase 0 has been manually validated on a real iPhone, proceed to a separate Google Drive resumable-upload spike. Do not prematurely combine OAuth, React UI, persistence, service workers, and upload logic into one implementation.

The central engineering objective throughout the project is:

> Make uploading several thousand iPhone photos and videos to Google Drive boring, reliable, resumable, and easy to leave unattended.


## Cross-Platform Validation Matrix

Use the same test corpus and scenarios across platforms whenever possible.

Recommended test scenarios:

1. 10 small photos
2. 100 mixed photos/videos
3. 500+ files
4. 1,000+ files when practical
5. one multi-gigabyte video
6. Wi-Fi interruption mid-file
7. pause/resume during an active chunk
8. access-token expiration/re-authorization
9. page hidden and restored
10. browser force-closed and reopened
11. duplicate selection / Add More
12. several deliberate failed uploads followed by Retry Failed
13. Keep Awake enabled for a long-running batch
14. low-storage condition

Track results at minimum for:

| Platform | Browser | Status | Notes |
|---|---|---|---|
| iPhone/iPad | Safari | Primary test target | Physical testing available |
| Android | Chrome | Required target | Physical testing deferred until device is available |
| Android | Samsung Internet | Best effort | Test later |
| Android | Firefox | Best effort | Test later |
| Windows/Linux | Chrome/Edge | Supported | Good development baseline |
| macOS | Safari/Chrome | Supported | Good secondary baseline |
| Desktop | Firefox | Best effort | Test later |

When an Android device becomes available, repeat the same high-volume and interruption tests used for iOS. Keep platform-specific workarounds isolated behind small adapters/helpers rather than branching the entire application.
