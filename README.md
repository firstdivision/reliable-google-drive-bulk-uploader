# Reliable Google Drive Bulk Uploader

A planned mobile-first, static web app for uploading large photo/video batches directly from the browser to Google Drive. Reliability, resumability, privacy, and clear aggregate progress are the priorities. There is no application backend.

## Current status

**Phase 0 harness implemented; real-iPhone feasibility validation pending.** Google authentication, uploads, queue persistence, and the React dashboard are not implemented yet.

- `phase0/index.html`: metadata-only picker baseline with count, exact total bytes, and paginated filenames/types/sizes. No file-content reads.
- `phase0/experiments.html`: separate, explicit 64 KiB readability checks and Screen Wake Lock controls.
- Neither page uploads or persists media or selection metadata. Both use local assets only and block script network connections with Content Security Policy.

## Run the harness

No npm dependencies or build step are required. For desktop inspection:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory phase0
```

Open `http://localhost:8000/`. This serves static files only; it is a development tool, not an application backend.

For an iPhone/iPad, open the [live Phase 0 harness](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/) in Safari. GitHub Pages serves only the contents of `phase0/` over HTTPS. The [Pages workflow](.github/workflows/pages.yml) checks the harness and publishes it on pushes to `main`, or when manually dispatched. Plain HTTP over a LAN is not sufficient for the Wake Lock experiment.

Follow the [device test procedure](docs/phase-0-testing.md) and copy the [results template](docs/phase-0-results-template.md). Begin with a controlled 200–500 MB sample, not an entire library. Stop if storage growth persists or the device becomes unstable. The harness cannot measure Safari Documents & Data; record that manually in Settings.

## Checks

Requires Node.js 20+ for the dependency-free automated checks:

```sh
node --check phase0/baseline.js
node --check phase0/experiments.js
node --test tests/*.test.cjs
```

These use synthetic files and browser API doubles. They do not establish Safari picker, storage, or physical screen behavior. No TypeScript checker, linter, or production build is configured for this small plain-JavaScript harness; deploy its static files directly.

## Roadmap and constraints

After real-iPhone Phase 0 validation: isolated Google Drive resumable-upload spike → upload engine → persistence/recovery → mobile batch dashboard → progressive stress tests.

The intended application stack is React/TypeScript with Vite, IndexedDB, Google Identity Services, Drive REST API v3, and optional Screen Wake Lock. Media must travel directly to Google; completed files must stay completed across retries. Browser wake locks do not provide native background execution.

iPhone/iPad Safari is the primary validation target. Android Chrome is a first-class target with physical testing deferred until hardware is available. Desktop Chrome/Edge and macOS Safari are also targets.

[PROJECT.md](PROJECT.md) is the canonical specification. [AGENTS.md](AGENTS.md) defines coding-agent guardrails.
