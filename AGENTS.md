# AGENTS.md

## Purpose

This file defines how AI coding agents should work in this repository.

Before making architectural, product, security, or browser-compatibility decisions, read **`PROJECT.md`**. `PROJECT.md` is the canonical specification for what this project is intended to do. `README.md` is human-facing orientation and may be less detailed.

The primary objective is to deliver the project described in `PROJECT.md` without quietly changing the product to make implementation easier.

## Non-Negotiable Architecture

Unless the user explicitly changes the requirements:

1. **No application backend.** The app is a static frontend application.
2. **Media bytes travel directly from the user's browser to Google Drive.** Do not proxy or stage photos/videos through infrastructure controlled by this project.
3. **The application is mobile-first and cross-platform.** iPhone/iPad Safari is the highest-risk compatibility target; Android Chrome is a first-class target even when a physical Android test device is not currently available.
4. **Reliability is more important than maximum throughput.** Prefer resumability, correctness, clear state, and recoverability over aggressive parallelism.
5. **Google Drive resumable uploads are the core transfer mechanism.** Do not replace them with ordinary whole-file uploads for convenience.
6. **Large batches are normal.** Design for thousands of files and multi-gigabyte videos. Do not optimize only for demo-sized selections.
7. **Do not depend on File System Access API for core functionality.** It may be used only as optional progressive enhancement.
8. **Do not claim native-style background execution.** Screen Wake Lock helps keep the device active but does not turn a web page into a native background uploader.
9. **Do not delete source photos or existing Drive content.** Any destructive feature requires an explicit product decision and safeguards.
10. **Do not weaken privacy claims.** If implementation would cause media to pass through another server, stop: that conflicts with the product architecture.

If a requested implementation conflicts with these constraints, surface the conflict rather than silently working around it.

## How to Work

Work autonomously on implementation details that are consistent with `PROJECT.md`.

You may choose without approval:

- internal TypeScript types and module boundaries
- component decomposition
- test structure
- naming of private/internal functions
- small dependency choices when they do not alter architecture or privacy
- retry/backoff implementation details consistent with Drive guidance
- refactors that preserve behavior and make testing easier
- accessibility and responsive-layout improvements

Do **not** independently change:

- the zero-backend requirement
- the direct browser-to-Google data path
- supported-platform priorities
- security/privacy boundaries
- user-visible destructive behavior
- OAuth scope strategy toward broader permissions without a documented need
- the meaning of completed/failed/resumable queue states
- MVP scope in a way that removes a requirement from `PROJECT.md`

When an implementation discovery invalidates an assumption in `PROJECT.md`, document the evidence and update the relevant project decision rather than coding around the contradiction.

## Autonomous Execution

When given a broad task such as "build Phase 1" or "implement the upload engine":

1. Read the relevant sections of `PROJECT.md`.
2. Inspect the existing repository before creating replacements.
3. Break the work into small verifiable units.
4. Implement the smallest complete vertical slice first.
5. Run tests, type checking, linting, and the production build as applicable.
6. Fix failures caused by your changes.
7. Update documentation when behavior, constraints, or known limitations change.
8. Report what was completed, what was verified, and any unresolved external/platform risks.

Do not stop merely because a task is large. Make reasonable implementation decisions within these guardrails and continue until the requested scope is complete or an external blocker genuinely prevents progress.

## Subagents / Delegation

If the current agent environment supports subagents, parallel agents, or delegated research, use them when doing so reduces risk or speeds independent work.

Good delegation boundaries include:

- **Browser/platform research:** iOS Safari, Android Chrome, WebKit bugs, Wake Lock, picker behavior.
- **Google API research:** current OAuth guidance, Drive resumable-upload semantics, status probing, error/retry behavior, folder selection.
- **Implementation:** an isolated module such as IndexedDB persistence, queue state machine, Drive uploader, or UI component set.
- **Testing/review:** adversarial review of retry, pause/resume, duplicate prevention, token expiry, and state transitions.
- **Security/privacy review:** verify that no media or sensitive credential is accidentally sent to project infrastructure or analytics.

Delegated work must remain within the same architecture. A subagent is not authorized to redesign the product.

The lead/parent agent remains responsible for integration. Do not blindly merge delegated output: inspect it, reconcile conflicts, run tests, and ensure the final result obeys `PROJECT.md` and this file.

If the environment does **not** support subagents, perform the same work sequentially. Do not invent or simulate unavailable agents.

## Research Rules

For behavior that depends on current browser or Google API semantics, verify against current authoritative documentation or reproducible tests rather than relying on memory.

Prefer sources in this order:

1. Google Drive / Google Identity official documentation
2. WebKit / Apple developer documentation and WebKit bug tracker
3. standards documentation such as MDN for web APIs
4. reputable open-source implementations for implementation ideas

Open-source code may inform implementation, but verify licenses before copying substantial code. Prefer clean implementations based on documented protocols.

Record significant browser quirks and externally confirmed limitations in `PROJECT.md` or focused documentation under `docs/`.

## Phase Discipline

`PROJECT.md` defines phased work. Respect it.

In particular, **Phase 0 iOS feasibility testing exists to test a potentially serious Safari file-picker storage issue before trusting giant real-world batches.** Do not declare the browser architecture production-safe merely because desktop testing succeeds.

When no Android hardware is available, keep Android support standards-compliant and maintain testable platform-neutral code. Do not invent Android-specific conclusions that have not been verified.

## Upload Engine Rules

Keep transfer logic outside React components. React should render and control the upload system; it should not own the protocol implementation.

The upload engine should have explicit, testable state transitions. At minimum account for:

- queued
- preparing
- uploading
- paused
- retrying
- failed
- completed

Rules:

- Only count bytes confirmed by Google as uploaded.
- Pause active requests with abort semantics and preserve resumable state.
- Resume from Google's confirmed offset, not a guessed local offset.
- Retry transient failures with bounded exponential backoff and jitter.
- Do not endlessly retry permanent authentication, permission, or malformed-request failures.
- Completed files must never be requeued by `Retry Failed`.
- Avoid accidental duplicate Drive files across retries/restarts.
- Do not load entire multi-gigabyte files into memory; use `Blob`/`File.slice()` or equivalent bounded chunks.
- Treat queue persistence separately from live `File` access. Persisted metadata does not imply the browser will retain access to selected media after a lifecycle event.

## Frontend / UX Rules

The preferred UI is the **batch dashboard** described in `PROJECT.md`.

Optimize the normal flow for:

> Select a very large batch → choose destination → Upload All → keep awake → walk away → return to progress/results.

Prioritize aggregate information over thousands of filenames. Failed-file details may be secondary, but **Retry Failed** must be obvious.

Use large touch targets and accessible controls. Keep the interface understandable on a phone during a multi-hour transfer.

The **☕ Keep Awake** feature should use the Screen Wake Lock API when available and clearly indicate whether it is active. Fall back gracefully when unavailable.

## Dependencies

Prefer a small dependency surface.

Before adding a dependency, determine whether:

- the browser/platform already provides the capability
- the dependency materially reduces correctness/security risk
- it works in the supported mobile browsers
- it changes bundle size or lifecycle behavior meaningfully
- its license is compatible with the project

Do not add a backend-oriented framework or service merely to simplify an otherwise browser-native operation.

## Testing Expectations

New behavior should be testable without requiring thousands of real personal photos.

Where practical, cover:

- queue state transitions
- retry classification and backoff
- pause/resume
- chunk boundary calculations
- committed-offset reconciliation
- duplicate prevention
- persistence serialization/deserialization
- token-expiry recovery paths
- selection deduplication
- formatting/aggregate progress calculations

Use synthetic files/blobs and mocked HTTP responses for automated tests. Reserve real-device testing for browser/OS behavior that cannot be simulated faithfully.

Before considering a substantive change complete, run the repository's available:

- unit tests
- type checker
- linter
- production build

Do not claim a browser behavior is verified unless it was actually tested on that browser/device or supported by authoritative evidence.

## Definition of Done

A task is done when:

- requested behavior is implemented
- existing behavior is not knowingly broken
- relevant automated checks pass
- failure paths are handled rather than hidden
- user-facing limitations are clear
- documentation is updated where needed
- architecture still conforms to `PROJECT.md`

A successful demo is not sufficient if the implementation loses resumability, creates duplicates, leaks media to another server, or works only for tiny files.

## Documentation Ownership

Use these files as follows:

- **`README.md`** — concise human-facing overview, setup, development, and current status.
- **`PROJECT.md`** — canonical product specification, architecture, constraints, phases, risks, and accepted decisions.
- **`AGENTS.md`** — instructions and guardrails for AI coding agents.

If additional detailed design documents become necessary, place them under `docs/` and link them from `PROJECT.md` rather than letting important decisions live only in chat logs.
