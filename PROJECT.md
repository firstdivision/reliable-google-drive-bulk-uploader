# PROJECT — Cross-Platform Photos & Videos → Google Drive Reliable Web Uploader

> **Canonical project specification.** This file records the product intent, architectural decisions, constraints, risks, and implementation phases. AI agents should read this before making architectural or product decisions. When implementation discoveries change an accepted decision, update this file in the same change.

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

Investigate whether Google Picker is the best folder-selection UX versus a lightweight Drive folder browser implemented through the REST API.

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
validation. **Real-iPhone results are pending and the Phase 0 gate has not passed.**
Android physical validation remains deferred. Do not start the Drive spike on the
basis of harness completion or automated checks alone.

Build the smallest possible static test page.

Validate:

- native photo/video multi-selection UX
- large batch selection
- reported Safari Documents & Data issue
- whether selected files remain usable for long periods
- Wake Lock API behavior

Stop and reconsider architecture if selection itself causes unacceptable storage consumption.

### Phase 1 — Google Drive Spike

Without React polish:

- Google browser OAuth
- choose/test a Drive folder
- upload one small file
- upload one large video using resumable upload
- intentionally interrupt connection
- resume from confirmed offset

### Phase 2 — Upload Engine

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

Build the batch-oriented dashboard.

Optimize for:

- one-handed setup
- huge touch targets
- glanceable progress
- minimal interaction once upload begins
- clear failed-file recovery

### Phase 5 — Stress Testing

Test progressively:

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
