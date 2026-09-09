# Phase 0 device testing

Status: **real-device results pending; the feasibility gate has not passed.** This harness does not implement Google authentication or uploads. See [PROJECT.md](../PROJECT.md) for the phase requirements and copy the [results template](phase-0-results-template.md) for each run.

## Pages and evidence

- [Selection baseline](../phase0/index.html): native multiple-file media picker and metadata display only. JavaScript does not read file contents. Use this page for the storage experiment.
- [Separate experiments](../phase0/experiments.html): explicit bounded reads of the first selected file and Screen Wake Lock controls. Use only after recording the baseline. Selection here is another selection and may consume storage again.

Neither page sends media or selection metadata to a server. The static host receives ordinary page/asset requests. Do not publish personal filenames or identifying screenshots in test reports.

Checked 2026-09-08: [WebKit bug 318572](https://bugs.webkit.org/show_bug.cgi?id=318572) remains **NEW**, with no resolution. The reporter describes Photos-picker storage growth even without JavaScript content reads, persisting after tab closure, force-quit, and reboot. Reported devices include iPhone 16 Pro / iOS 26.5 and iPad mini 6 / iPadOS 18.6.2. This report motivates testing; it does not establish behavior on every device.

## Controlled iPhone/iPad storage test

1. Open the baseline page as a normal Safari tab using a trusted HTTPS static host. Record the URL, code revision, device model, OS/build, browser version, date/time, charging state, and iCloud Photos/download settings. Keep Home Screen and private-browsing runs separate.
2. Choose a backed-up, non-sensitive sample of approximately **200–500 MB**, preferably one known video. Do not start with your library. If storage is already tight, postpone the test. Record a minimum free-space reserve before starting and allow headroom for another copy of the entire sample plus normal device use. This is a precaution, not a proven safe bound.
3. Record Settings → General → iPhone Storage → Safari → Documents & Data, and total device free space. On iPad use the corresponding iPad Storage view. Record the time and displayed units; take a private screenshot if useful. Let the view finish calculating and note any unstable readings. Website Data for one origin is a different measurement.
4. Return to the baseline. Choose **Photo Library**, select the controlled sample once, and wait for preparation to finish. Record preparation time, delivered file count, total bytes, MIME types, and whether the picker completed, cancelled, stalled, or returned fewer files than expected. Record the chosen picker route; Files-provider tests are separate runs.
5. Without reselecting, record Safari Documents & Data and free space again, with elapsed time. Merely opening Settings hides Safari; record that lifecycle transition.
6. Close the test tab and remeasure. Then force-quit Safari and remeasure. If storage remains elevated, reboot and remeasure. Use consistent observation intervals where practical and record the actual intervals; a delayed Settings refresh is not proof of retained or reclaimed bytes.
7. Compare each reading with the initial baseline. Record inconclusive or rounded measurements honestly. Repeat a controlled selection only if the first run stayed within the recorded storage budget and you understand its result.

**Stop further selections** if retained growth is comparable to the sample, storage crosses your reserve, the picker fails or stalls, Safari is evicted, or the device becomes unstable. Preserve observations and discuss the feasibility decision before scaling. Do not intentionally fill the device. Closing a tab or clearing the page's selection is not a promise of storage recovery.

The bug reporter says clearing Safari history and website data reclaimed storage. This is not part of the routine test: it can remove browsing data and sign-ins. The harness does not perform cleanup, delete source media, or offer a destructive recovery action. Record any independently chosen cleanup separately because it changes the baseline.

## Selection usability and gradual scaling

After the storage baseline supports continuing, use small, non-sensitive media to try 10 items, then 100, then 500 and 1,000 only when preceding results justify the increase. Set a byte budget as well as an item count. Record picker gestures actually available, time to select/prepare, selected versus delivered counts, responsiveness, and storage at each stage. A thousand tiny files does not validate multi-gigabyte videos.

Record what the picker exposes for HEIC, MOV, Live Photos, and optional RAW/DNG samples; do not assume one library item equals one returned file. Large videos and several-thousand-item stress tests remain pending until smaller tests support them.

## Separate readability and Wake Lock experiments

Use `experiments.html` in a new, recorded run with a small sample. Keep the initial storage experiment free of content reads.

For readability, explicitly run the bounded-read control on the first selected file immediately, then after 5 minutes, 30 minutes, and a planned multi-hour foreground interval. Record actual intervals, reported byte count, and errors. Repeat after briefly switching apps and after manually locking/unlocking. A successful small read establishes only that slice's readability at that moment; it does not verify a whole file or upload. Reload/close/force-quit tests should record that the page loses its selection and requires reselection; reselection is a new run, not proof that the previous File survived.

For Wake Lock, record API availability and whether requesting it succeeds. Leave the page visible beyond the device's normal auto-lock interval and observe the physical screen. Test turning the control off, briefly hiding/restoring the page, and manually locking/unlocking. Record reported active/released/error state and reacquisition behavior. Extend to a supervised multi-hour foreground run, plugged in, after the short tests succeed.

The API requires a secure context and can be rejected or released by the browser/system, including when the document becomes inactive or hidden. The UI must reflect actual acquisition and release, and unsupported devices need a manual keep-awake fallback. Screen Wake Lock does not grant background execution. See [MDN Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API), checked 2026-09-08.

## Platform checklist and gate

| Platform | Required Phase 0 observations | Evidence status |
| --- | --- | --- |
| iPhone/iPad Safari | Storage baseline, native picker, progressive count/bytes, bounded readability, Wake Lock/lifecycle | Pending physical runs |
| Android Chrome | Same sample progression, native picker, device/browser storage where measurable, readability, Wake Lock/lifecycle | Deferred until hardware is available |
| Desktop Chrome/Edge and macOS Safari | Metadata correctness, cancellation/reselection, bounded reads, Wake Lock where supported | Record actual browser/version when run |
| Other supported browsers | Same applicable checklist | Pending |

Do not infer Android behavior from iOS results or mobile feasibility from desktop checks. Network interruption, OAuth expiry, resumable offsets, pause/resume, duplicate prevention, and persistent upload recovery belong to later upload phases.

Record a decision in the result and link accepted findings from `PROJECT.md`: **proceed to the isolated Drive spike**, **hold for more evidence**, or **stop and reconsider because of observed storage/lifecycle behavior**. A proceed decision requires real-iPhone evidence across the Phase 0 questions and clearly bounded limitations; it does not certify production safety or untested batch sizes. No real-device pass is implied by shipping this harness.
