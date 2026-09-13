# Phase 4 mobile dashboard

Status: implemented 2026-09-13; automated checks and synthetic desktop-browser
workflow tests passed. Real iPhone/iPad and Android dashboard validation is pending.

Open [BatchHarbor](https://batchharbor.killfly.com/app/) after deployment. Close
other BatchHarbor uploader/test tabs first: the dashboard and `/phase2/` intentionally
share one saved queue and writer lock. Existing recovery data is reused, not reset.

## What changed

- React/TypeScript setup and progress views, with Vite compiling static output.
- Aggregate progress, source-backed Resume/Retry controls, approximate time remaining,
  and a prominent Keep Awake switch with actual acquisition status.
- Separate source reselection and Google reconnection steps after reopening.
- Failure/source filters and 50-row detail pages; no thousands-row default rendering.
- Storage settings are secondary; denied protection explicitly does not mean save
  failure. Same privacy boundary, OAuth scope, durable IDs, and upload protocol.

One saved batch keeps its destination and account. Add More joins it; there is no
batch reset/history UI in this phase. Removing unstarted entries is local only.
Source matching remains metadata plus bounded fingerprints, not whole-file equality.

## Device checklist

Use 3-5 disposable files, about 200-500 MB, before increasing scale.

1. Open `/app/` on Safari. Check readable headings, controls, and no horizontal
   overflow at your preferred text size. Select files and verify count/bytes.
2. Connect Google, choose or create an app-accessible destination, enable Keep Awake,
   and Upload All. Verify transition to progress and the acquired/not-active status.
3. Confirm Pause All stops dispatch. Resume and inspect completed files in Drive.
   Retry Failed must be visible when failures exist and must not restart completions.
4. Pause/save, close the page, reopen. Both source and account requirements should
   be explicit. Select originals again and reconnect; nothing starts before Resume.
5. Include already completed files in reselection. They must be skipped. Attempt a
   different controlled account and confirm rejection. Retain the original Drive IDs.
6. Open Files & failures; exercise filters, pagination, and removal of an unstarted
   entry. No source media or Drive content should be removed.
7. Request storage protection. Denial is allowed; ordinary saving remains. Observe
   offline and authorization messages during a controlled interruption.
8. Open the legacy `/phase2/` page in a second tab. It must be blocked while `/app/`
   owns the saved queue. Close the owner and reload the second tab to recover.
9. Verify exactly one completed Drive file per entry, correct sizes and contents,
   and record any Safari storage growth or instability. Keep the originals.

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
The implementation verification passed all 112 tests, type checking, linting,
production build, legacy script syntax checks, and assembled static link checks.
New coverage includes server-side auth rejection with locally unexpired tokens,
fresh-token preservation, disposal/write draining, tab exclusion, wake races,
source-backed control eligibility, ETA resets, safe rendering, and explicit recovery
messages. Waits use observable conditions for asynchronous file preparation.

Vite emits `dist/app/`. The Pages workflow adds that directory to the existing
static deployment. Node 22 is pinned in CI. The development-only CSP accommodation
is absent from the production HTML; inspect the built page for CSP regressions.

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

The previously documented real GIS inline-style CSP warning remains; production
policy was not weakened. Real Google OAuth on the deployed origin must be retested.
Phase 3's user-reported pass is not a physical-device pass for the React dashboard.