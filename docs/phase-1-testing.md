# Phase 1 Google Drive spike

Status: implementation complete; real Google Drive testing pending.

Open the [Phase 1 test page](https://firstdivision.github.io/reliable-google-drive-bulk-uploader/phase1/)
in Safari. This spike uses the non-sensitive `drive.file` scope. It can create new
files and work with folders created or explicitly authorized through this app; it
cannot browse every existing folder in Drive. Google Picker integration is deferred.

The OAuth client must allow the JavaScript origin `https://firstdivision.github.io`.
Enable the Drive API, configure the consent screen for external testing, and add
the test account. No client secret is used or shipped.

## Test sequence

1. Connect Google Drive and confirm the displayed account.
2. Create the default Phase 1 test folder. Open its Drive link and confirm it exists.
3. Select a small, disposable photo or video and upload it. Confirm the displayed
   Drive file ID, destination, name, byte size, and playable/readable contents.
4. Record the result before reloading. This phase intentionally keeps session,
   token, file, and upload state in memory only.
5. Reload and choose a different, larger test video. Start the upload, pause while
   a chunk is active, and resume. Confirm progress resumes from Google's committed
   offset and the Drive file ID stays unchanged.
6. Repeat with a brief network interruption. Turning off Wi-Fi may leave cellular
   connectivity active. Restore connectivity and allow bounded automatic retries;
   use Resume / Retry if they are exhausted.
7. If authorization expires, reconnect using the same Google account and resume.
8. Confirm one completed Drive file exists for each test and that it opens correctly.

Do not close or reload Safari during an active test. Page-restart persistence and
source reconnection belong to Phase 3. If Safari closes unexpectedly, inspect Drive
using the recorded file ID before retrying; this spike does not yet recover state
across page restarts.

Record HTTP/status messages, file sizes, confirmed offsets before and after each
interruption, stable file IDs, elapsed time, and duplicate count. Do not publish
access tokens, resumable session URLs, personal filenames, or screenshots containing
private Drive information.

## Implementation boundaries

- Media bytes go from the browser directly to `www.googleapis.com`.
- The uploader uses 8 MiB chunks aligned to Drive's 256 KiB requirement.
- Only offsets confirmed by Drive count as progress. Ambiguous requests trigger a
  session-status probe before more media is sent.
- Transient failures use bounded retry/backoff; authorization and permanent errors
  stop for user action.
- A pre-generated Drive file ID is reused across creation retries to reduce duplicate
  risk. Completion is accepted only after ID, byte size, and parent match.
- Tokens, source files, folder choice, and session URLs are never persisted in this phase.

Passing this test supports building the queue engine. It does not establish batch,
browser-restart, multi-hour, or production reliability.
