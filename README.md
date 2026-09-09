# Reliable Google Drive Bulk Uploader

A planned mobile-first, static web app for uploading large photo/video batches directly from the browser to Google Drive. Reliability, resumability, privacy, and clear aggregate progress are the priorities. There is no application backend.

## Current status

**Phase 1 Google Drive spike implemented; real Drive testing pending.** [iPhone 16 Pro / iOS 26.6.1 observations](docs/phase-0-iphone-16-pro-ios-26.6.1.md) support the bounded next phase while retaining the selected-tab restoration limitation.

- `phase0/index.html`: metadata-only picker baseline with count, exact total bytes, and paginated filenames/types/sizes. No file-content reads.
- `phase0/experiments.html`: separate, explicit 64 KiB readability checks and Screen Wake Lock controls.
- Neither page uploads or persists media or selection metadata. Both use local assets only and block script network connections with Content Security Policy.
- `phase1/`: Google authorization, app-accessible destination folders, and a one-file resumable upload with pause and interruption recovery. State is limited to the current tab.

## Run the harness

No npm dependencies or build step are required. For desktop inspection:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory phase0
```

Open `http://localhost:8000/`. This serves static files only; it is a development tool, not an application backend.

For an iPhone/iPad, open the [live Phase 0 harness](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/) in Safari. GitHub Pages serves the Phase 0 files at the site root and Phase 1 under `/phase1/`, all over HTTPS. The [Pages workflow](.github/workflows/pages.yml) checks both before publishing on pushes to `main`, or when manually dispatched. Plain HTTP over a LAN is not sufficient for the Wake Lock experiment.

The [live Phase 1 Drive spike](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/phase1/)
is deployed alongside it. Follow the [Phase 1 test procedure](docs/phase-1-testing.md).
The public OAuth client ID is frontend configuration; no client secret is used.

OAuth consent-screen links:

- [Privacy Policy](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/privacy/)
- [Terms of Service](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/terms/)

The original project logo is stored at `assets/brand/reliable-uploader-logo.png`.

Follow the [device test procedure](docs/phase-0-testing.md) and copy the [results template](docs/phase-0-results-template.md). Begin with a controlled 200–500 MB sample, not an entire library. Stop if storage growth persists or the device becomes unstable. The harness cannot measure Safari Documents & Data; record that manually in Settings.

## Checks

Requires Node.js 20+ for the dependency-free automated checks:

```sh
node --check phase0/baseline.js
node --check phase0/experiments.js
node --check phase1/app.mjs
node --test tests/*.test.cjs
node --test tests/*.test.mjs
```

These use synthetic files and browser API doubles. They do not establish Safari picker, storage, or physical screen behavior. No TypeScript checker, linter, or production build is configured for this small plain-JavaScript harness; deploy its static files directly.

## Roadmap and constraints

After real-iPhone Phase 0 validation: isolated Google Drive resumable-upload spike → upload engine → persistence/recovery → mobile batch dashboard → progressive stress tests.

The intended application stack is React/TypeScript with Vite, IndexedDB, Google Identity Services, Drive REST API v3, and optional Screen Wake Lock. Media must travel directly to Google; completed files must stay completed across retries. Browser wake locks do not provide native background execution.

iPhone/iPad Safari is the primary validation target. Android Chrome is a first-class target with physical testing deferred until hardware is available. Desktop Chrome/Edge and macOS Safari are also targets.

[PROJECT.md](PROJECT.md) is the canonical specification. [AGENTS.md](AGENTS.md) defines coding-agent guardrails.
