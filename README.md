# BatchHarbor

A planned mobile-first, static web app for uploading large photo/video batches directly from the browser to Google Drive. Reliability, resumability, privacy, and clear aggregate progress are the priorities. There is no application backend.

## Current status

**Phase 2 upload engine implemented; real-device batch testing pending.** The [Phase 1 results](docs/phase-1-testing.md#reported-results-2026-09-09) cover small-file upload, larger-video pause/resume, network interruption recovery, and duplicate checks. [iPhone 16 Pro / iOS 26.6.1 observations](docs/phase-0-iphone-16-pro-ios-26.6.1.md) retain the selected-tab restoration limitation.

- `phase0/index.html`: metadata-only picker baseline with count, exact total bytes, and paginated filenames/types/sizes. No file-content reads.
- `phase0/experiments.html`: separate, explicit 64 KiB readability checks and Screen Wake Lock controls.
- Neither page uploads or persists media or selection metadata. Both use local assets only and block script network connections with Content Security Policy.
- `phase1/`: Google authorization, app-accessible destination folders, and a one-file resumable upload with pause and interruption recovery. State is limited to the current tab.
- `phase2/`: in-memory multi-file queue with two concurrent uploads, selection deduplication, batch pause/resume, Retry Failed, authorization recovery, and aggregate confirmed progress. A basic mobile test page reuses Phase 1's protocol, authentication, and wake lock. Follow the [Phase 2 test procedure](docs/phase-2-testing.md).

## Run the harness

No npm dependencies or build step are required. For desktop inspection:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory phase0
```

Open `http://localhost:8000/`. This serves static files only; it is a development tool, not an application backend.

The [BatchHarbor homepage](https://batchharbor.killfly.com/) describes the application and links its public policies. The [Pages workflow](.github/workflows/pages.yml) checks and publishes the Phase 0, Phase 1, and Phase 2 pages under `/phase0/`, `/phase1/`, and `/phase2/` on pushes to `main`, or when manually dispatched. Plain HTTP over a LAN is not sufficient for the Wake Lock experiment. To inspect Phase 2 locally, serve the repository root rather than only its subdirectory: it imports shared modules from Phase 1.

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
node --test tests/*.test.cjs
node --test tests/*.test.mjs
```

These use synthetic files and browser API doubles. They do not establish Safari picker, storage, or physical screen behavior. No TypeScript checker, linter, or production build is configured for this small plain-JavaScript harness; deploy its static files directly.

## Roadmap and constraints

Next: validate Phase 2 with small real-device batches, then persistence/recovery → full mobile batch dashboard → progressive stress tests. Queue state and completed-file deduplication currently last only for this tab; reloading is not a supported recovery action.

The intended application stack is React/TypeScript with Vite, IndexedDB, Google Identity Services, Drive REST API v3, and optional Screen Wake Lock. Media must travel directly to Google; completed files must stay completed across retries. Browser wake locks do not provide native background execution.

iPhone/iPad Safari is the primary validation target. Android Chrome is a first-class target with physical testing deferred until hardware is available. Desktop Chrome/Edge and macOS Safari are also targets.

[PROJECT.md](PROJECT.md) is the canonical specification. [AGENTS.md](AGENTS.md) defines coding-agent guardrails.
