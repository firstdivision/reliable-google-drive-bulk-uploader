# BatchHarbor

A planned mobile-first, static web app for uploading large photo/video batches directly from the browser to Google Drive. Reliability, resumability, privacy, and clear aggregate progress are the priorities. There is no application backend.

## Current status

**The deployed phone app completed a user-reported 200-file, 3.32 GB upload in about 14 minutes.** A separate 1,535-file selection reached the queue after a long picker delay; that batch was not uploaded to completion. Further long upload tests are deferred at the user's request. Open [BatchHarbor](https://batchharbor.killfly.com/app/) and see the [results and checklist](docs/phase-4-testing.md). These reports do not establish production-scale reliability. [iPhone observations](docs/phase-0-iphone-16-pro-ios-26.6.1.md) retain the selected-tab restoration limitation.

**Browser-only by choice:** keep the upload page open and active until the batch
finishes. Pause/resume and retries work while the originals remain accessible.
Recovery after closing/reloading or losing file access is best-effort: saved
records do not preserve access to your photos. Reselecting originals is an
optional fallback, not the expected workflow for thousands of files. Keep Awake
does not guarantee continued execution. Startup now has a 15-second deadline with
a stage-specific error and non-destructive reload. The latest deployed-phone test
was reported working well; the earlier stall's cause remains unconfirmed. See the
[device notes](docs/phase-4-testing.md).

**Start new batch** appears below the upload controls when a batch has records.
Pause first, inspect Drive, then explicitly confirm clearing local recovery and
duplicate-prevention history. No originals or Drive files are deleted, but uploading
the same files again may create duplicates. Reset is unavailable until saved storage
opens safely; it does not bypass a startup failure.

- `phase0/index.html`: metadata-only picker baseline with count, exact total bytes, and paginated filenames/types/sizes. No file-content reads.
- `phase0/experiments.html`: separate, explicit 64 KiB readability checks and Screen Wake Lock controls.
- Neither page uploads or persists media or selection metadata. Both use local assets only and block script network connections with Content Security Policy.
- `phase1/`: Google authorization, app-accessible destination folders, and a one-file resumable upload with pause and interruption recovery. State is limited to the current tab.
- `phase2/`: multi-file queue with two concurrent uploads, selection deduplication, batch pause/resume, Retry Failed, and aggregate confirmed progress. Phase 3 adds IndexedDB metadata, original-account binding, source reselection with bounded fingerprints, durable identity checkpoints, and an exclusive cross-tab lock. Media and tokens are never persisted. The basic mobile test page reuses Phase 1's protocol, authentication, and wake lock.
- `phase4/`: React/TypeScript dashboard built with Vite to `/app/`, with setup/progress views, explicit source/account recovery, confirmed-byte ETA, Keep Awake toggle, and bounded file details. It shares the Phase 2 queue and saved database; close the test page before opening the dashboard.

## Run the dashboard

Use Node.js 22 (CI), or a compatible Node.js 20.19+ installation:

```sh
npm ci
npm run dev
```

Open the URL Vite prints, normally `http://127.0.0.1:5173/app/`. Vite runs only as a
development server, not an application backend. Real Google sign-in requires an
authorized OAuth origin; use the deployed HTTPS site for device tests. Home/legal
links target the assembled site, not the isolated Vite development root.

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

The production dashboard is emitted to `dist/app/`. Pages assembles it with the
homepage, policies, assets, and existing harnesses. Only the local Vite server
permits local WebSocket connections for development. The dashboard allows inline
styles for Google's Picker UI, but inline scripts and `unsafe-eval` remain blocked.

## Existing Drive folders

Connect Google, then use **Browse Google Drive** to select an existing folder you
own or that is shared with you, including folders not previously used with BatchHarbor. The selected folder
is checked for permission to add files. The existing dropdown remains a shortcut
for already authorized folders. No broader OAuth scope is requested: Picker grants
access to the chosen folder under `drive.file`, not all existing files inside it.
The destination stays fixed once a batch starts; use Start new batch to change it.

The site owner must configure Google Picker before the browsing button can work:

1. In the same Google Cloud project as the current OAuth web client, enable
	**Google Picker API** and **Google Drive API**.
2. Create a browser API key with **Websites** application restrictions. Allow
	`https://batchharbor.killfly.com/*` and `https://docs.google.com/*`, plus only
	local origins you intend to test. Restrict the key to **Google Picker API** and
	**Google Drive API**, as Google's current setup guide specifies.
3. Find the numeric **project number** in Cloud project settings. This is the
	Picker App ID, not the textual project ID or OAuth client ID.
4. In GitHub repository **Settings > Secrets and variables > Actions > Variables**,
	set `GOOGLE_PICKER_API_KEY` and `GOOGLE_PICKER_APP_ID`. Rebuild/redeploy Pages.
	These are browser-visible configuration values, never an OAuth client secret.
5. For local development, set `VITE_GOOGLE_PICKER_API_KEY` and
	`VITE_GOOGLE_PICKER_APP_ID` in a root `.env.local` file using [.env.example](.env.example).
	Restart Vite after changes. The OAuth client's authorized JavaScript origins
	must also include the local origin for real sign-in.

Without this configuration the app explains that browsing is unavailable; existing
authorized folders and folder creation still work. See [Picker setup and checks](docs/drive-folder-picker.md).

## Run the harness

The existing Phase 0-3 harness pages still need no npm dependencies or build step. For desktop inspection:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory phase0
```

Open `http://localhost:8000/`. This serves static files only; it is a development tool, not an application backend.

The [BatchHarbor homepage](https://batchharbor.killfly.com/) describes the application and links its public policies. The [Pages workflow](.github/workflows/pages.yml) builds and publishes the dashboard under `/app/`, alongside the Phase 0, Phase 1, and Phase 2 pages under `/phase0/`, `/phase1/`, and `/phase2/`, on pushes to `main` or when manually dispatched. Plain HTTP over a LAN is not sufficient for the Wake Lock experiment. To inspect Phase 2 locally, serve the repository root rather than only its subdirectory: it imports shared modules from Phase 1.

The [live Phase 1 Drive spike](https://batchharbor.killfly.com/phase1/)
is deployed alongside it. Follow the [Phase 1 test procedure](docs/phase-1-testing.md).
The public OAuth client ID is frontend configuration; no client secret is used.

OAuth consent-screen links:

- [Privacy Policy](https://batchharbor.killfly.com/privacy/)
- [Terms of Service](https://batchharbor.killfly.com/terms/)

The original project logo is stored at `assets/brand/reliable-uploader-logo.png`.

Follow the [device test procedure](docs/phase-0-testing.md) and copy the [results template](docs/phase-0-results-template.md). Begin with a controlled 200–500 MB sample, not an entire library. Stop if storage growth persists or the device becomes unstable. The harness cannot measure Safari Documents & Data; record that manually in Settings.

## Checks

Requires Node.js 20+ for the dependency-free automated checks:

```sh
node --check phase0/baseline.js
node --check phase0/experiments.js
node --check phase1/app.mjs
node --check phase1/google.mjs
node --check phase1/drive-upload.mjs
node --check phase1/wake.js
node --check phase2/app.mjs
node --check phase2/upload-queue.mjs
node --check phase2/queue-store.mjs
node --test tests/*.test.cjs
node --test tests/*.test.mjs
```

These use synthetic files and browser API doubles. They do not establish Safari picker, storage, or physical screen behavior. The plain-JavaScript harnesses deploy directly; use the npm checks above for Phase 4's typed controller, React UI, linting, and production build.

## Roadmap and constraints

Next: MVP readiness review against the existing success criteria. Further long upload tests are deferred, not marked passed. Recovery requires retained browser metadata, the original sources, and the original Google account; it does not provide background uploading. Saved records may be evicted or cleared. Android physical batch/recovery validation and larger completed transfers remain unverified.

The intended application stack is React/TypeScript with Vite, IndexedDB, Google Identity Services, Drive REST API v3, and optional Screen Wake Lock. Media must travel directly to Google; completed files must stay completed across retries. Browser wake locks do not provide native background execution.

iPhone/iPad Safari is the primary validation target. Android Chrome is a first-class target with physical testing deferred until hardware is available. Desktop Chrome/Edge and macOS Safari are also targets.

[PROJECT.md](PROJECT.md) is the canonical specification. [AGENTS.md](AGENTS.md) defines coding-agent guardrails.
