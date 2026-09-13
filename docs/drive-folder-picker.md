# Existing Google Drive folders

Implemented for the `/app/` dashboard on 2026-09-13. Google Cloud configuration
and real authenticated Picker testing are required before calling it deployed-ready.
The Phase 1/2 harness dropdowns remain limited to app-authorized folders.

## Configuration

Follow [README setup](../README.md#existing-drive-folders). The Picker API, browser
API key, numeric App ID (project number), and OAuth client must belong to the same
Google Cloud project. Do not use an OAuth client secret or a service account.
GitHub repository variables `GOOGLE_PICKER_API_KEY` and `GOOGLE_PICKER_APP_ID` are
mapped to Vite build variables by the Pages workflow. Values are compiled into the
public JavaScript. An absent key or invalid project number produces a visible error,
not a broader scope request. Existing upload/folder creation still works.

Google's current guide requires website-restricted keys to allow both the app's
site and `https://docs.google.com/*`, and API restrictions for Picker and Drive.
Confirm restrictions in the console; do not share unrestricted keys in reports.
Changes to variables require a new build/deployment, not just a browser reload.

## Behavior and safeguards

- **Browse Google Drive** uses the already authorized account's token. No second
  OAuth flow, broader Drive scope, or independent account switch is added.
- The Google view includes folders, enables folder selection, filters to folder
  MIME type and user ownership, and uses list mode. There is no upload view or
  multi-select feature. Own nested folders need not have been created by this app.
- Google Picker grants per-item access with `drive.file`. Authenticated `files.get`
  then verifies the chosen folder is real, not trashed, and writable for children.
  A selection is not permission to list/read all existing descendants.
- Cancel/error preserves the previous destination. Library loading times out after
  15 seconds; the page also provides Cancel folder selection. Disposing the controller
  cancels loading/dialog work and ignores any late returned folder. Cancellation
  also aborts the subsequent Drive metadata request, unblocks controls promptly,
  and ignores a verification response that arrives late.
- No browsing after upload fixes the destination, even when paused. Start new batch
  is the explicit way to change destinations, with the existing record-loss warning.
- The dashboard alone allows inline CSS to accommodate the hosted Picker stylesheet.
  `script-src` additionally permits `apis.google.com`; `frame-src` permits
  `docs.google.com`. Inline JavaScript and eval remain blocked. No wildcard Google
  hosts or speculative gstatic/Drive script exceptions are added. Real iframe/CSP
  behavior must be checked on the deployed origin before adding other exceptions.

## Verification

Automated tests cover owned-folder Picker configuration, missing configuration,
scope/token preservation, cancellation, loader failure, invalid callback IDs,
unwritable/non-folder/trashed selections, authentication failure, immutable batch
destinations, and late replies after closing. Mocked responses do not establish
Google's real grant behavior or iPhone dialog layout.

The local production-build browser check used synthetic configuration and mocked
Google: cancel preserved the old folder; a non-writable folder was rejected;
cancel during verification unblocked controls; the API-verified name replaced
untrusted Picker metadata. A synthetic nine-byte upload completed with the chosen
existing folder as its parent, and Browse disabled after starting the batch.
The narrow setup screenshot showed wrapped controls without overlap; integrated
browser scrolling/pointer automation required DOM activation for some actions.
This is not a physical iPhone touch test.

Separately, the real unauthenticated Google API loader and Picker module loaded
under the built page's CSP, including injected Picker styles, with zero observed
CSP violations. No real token or media was used. This verifies library loading,
not the authenticated iframe, per-folder grant, or Google API-key configuration.

After configuring Cloud and deploying:

1. Connect your account, then Browse Google Drive. Find an existing nested folder
   created outside BatchHarbor. Cancel first and confirm the old selection remains.
2. Select the folder. Confirm its real name and Open in Drive destination match.
3. Upload one disposable file and verify it is inside that folder, not Drive root
   or a newly created folder. Keep the source. No long stress test is needed.
4. Check phone dialog scrolling, search/navigation, close/cancel, and rotation.
   Google documents a minimum Picker size of 566 by 350; narrow-phone behavior is
   not assumed from desktop tests or forced undersized setSize arguments.
5. Check expiry or revoked folder access fails visibly, preserving the current
   destination. Confirm the browse action disables once uploading starts.

## Authoritative references

Checked 2026-09-13:

- [Picker integration and prerequisites](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Current configuration example and API-key restrictions](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample)
- [Drive scopes and per-file grants](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Enable folder selection](https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setselectfolderenabled)
- [Include folders](https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setincludefolders)
- [Owned-by-me filter](https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setownedbyme)
- [List mode with drive.file](https://developers.google.com/workspace/drive/picker/reference/picker.docsviewmode)
- [Picker size limits](https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setsize)

Public `apis.google.com/js/api.js` and its hosted Picker module were inspected:
the module injects inline `.picker-dialog` CSS and uses `docs.google.com/picker`.
This is implementation evidence, not a permanent CSP contract from Google.