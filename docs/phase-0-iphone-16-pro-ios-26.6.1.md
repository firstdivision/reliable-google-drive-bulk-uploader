# Phase 0 observation — iPhone 16 Pro, iOS 26.6.1

Recorded 2026-09-09 from the user's manual test report. This is user-observed
device evidence, not an agent-operated browser test. For the initial run, exact observation times,
elapsed intervals, Safari build, device free space, and loaded code revision were
not recorded. The run concerns the Phase 0 selection baseline in Safari; all
selected items were videos chosen through Photo Library. Local versus iCloud-backed
media availability, video formats, file counts, and largest individual file are unknown.

| Observation | Safari Documents & Data | Change from initial baseline |
| --- | --- | --- |
| Before selection | 214.9 MB | — |
| After first selection, reported as at least 1,000 MB | 260.5 MB | +45.6 MB |
| After a second selection, reported as an additional 2,191.09 MB | 345.3 MB | +130.4 MB |
| After closing the tab and then closing Safari | 233.2 MB | +18.3 MB |

The second selection increased the displayed storage by 84.8 MB. Closing the tab
and Safari was followed by a 112.1 MB decrease. There was no separate reading
between those two closure steps; the report does not identify which step caused
the decrease or specify whether closing Safari meant force-quitting it.

The baseline page replaces the previous selection. The reported selection sizes
describe two picker operations, not a simultaneously retained queue or a known
amount of unique media. The first size is approximate. No reboot or subsequent
delayed reading was reported.

## Additional timed run

Reported subsequently for the same device context. Times are reproduced as supplied;
the run date/timezone and exact page revision were not separately confirmed.

| Time | Observation | Safari Documents & Data | Change from 00:22 baseline |
| --- | --- | --- | --- |
| 00:22 | Before selection | 238.5 MB | — |
| 00:23 | Selected 66 files, 6,577.60 MB | Not measured | — |
| 00:24 | After selection | 375.1 MB | +136.6 MB |
| 00:28 | Doing other tests | 377 MB | +138.5 MB |
| 00:31 | Selected 92 videos, 7,295.05 MB | Not measured | — |
| 00:32 | After selection | 536.7 MB | +298.2 MB |
| 00:32 | Closed tab and Safari | Not measured | — |
| 00:33 | After closure | 338 MB | +99.5 MB |

The last selection was followed by a 159.7 MB increase relative to 00:28. Storage
dropped 198.7 MB after closure, about two thirds of the peak increase in this run.
The 99.5 MB residual was measured only one minute after closure; its longer-term
persistence is unknown. Other tests between readings are a confounder, and their
actions/results have not been provided. Closure mechanics remain unspecified.

The two selection operations total 13,872.65 MB of reported media, but overlap is
unknown and they are not one simultaneous batch. The largest reported selection
is 92 videos / 7,295.05 MB. No individual file sizes, preparation durations, or
readability/Wake Lock results were supplied with that timed sequence. Later
readability observations are recorded separately below. Do not interpret the file
counts as proof of thousands-of-files usability or the total bytes as one multi-GB file.

## Readability and Safari reopening observations

The user reported successful bounded reads, including after leaving Safari,
opening Reddit, and switching back to Safari. The elapsed interval, sample size,
and number of repetitions were not recorded. This establishes readability of the
tested slice in that surviving page, not whole-file integrity or long-duration access.

After fully closing Safari and reopening it, the page never loaded and Safari
displayed “A problem repeatedly occurred” with the page address. The user clarified
that this appeared on reopening, before any read button could be tapped. Record
this as a **page restoration/loading failure**, not a caught file-read exception.
The cause is undetermined; a selected-file restoration problem, browser defect,
or other cause has not been established.

In a follow-up comparison, the user opened the experiments page in a fresh tab
without selecting a file, fully closed Safari, and reopened it: the page loaded
successfully. The user then selected one small video and repeated the closure/
reopening procedure: it did not work. The exact failure text for this repeat was
not separately supplied. This associates the observed failure with prior media
selection in this comparison; it does not establish the mechanism or prove all
selected files will cause failure. Exact sample size, repetition count, and whether
a bounded read or Wake Lock was used before closure were not specified.

The user confirmed both follow-up checks succeeded:

- After the restored tab failed, opening the experiments URL in a fresh tab loaded successfully.
- Selecting a small video, tapping Clear selection, and then fully closing/reopening Safari loaded successfully.

Together, these observations associate the failure with restoring a page that
retains a media selection and demonstrate a fresh-tab recovery route for this
test. They do not establish the browser's internal failure mechanism. Clearing
before closure is a successful diagnostic control, not a guarantee of crash
recovery; the user cannot be required to anticipate an unexpected browser kill.
The harness does not persist a queue, so fresh-tab recovery here restores page
access, not selected files or upload progress.

## Keep Screen Awake observation

The user reports that Keep Screen Awake is working on this device. With auto-lock
set to **30 seconds** and Keep Screen Awake enabled, the physical screen remained
on from **12:37 AM to 12:40 AM** (approximately three minutes, six configured
auto-lock intervals). This is a user-observed short foreground success. The
screen was still on at the final observation; this is not a measured maximum.
Acquisition/release UI states and reacquisition after hiding/restoring Safari
were not specified. Multi-hour operation and lifecycle recovery are not
established by this report.

## Thirty-minute foreground and app-switch test

The user confirmed that the instructed test worked: select a video, enable Keep
Awake, read the first 64 KiB, keep Safari visible for 30 minutes without reselecting,
and read the first 64 KiB again. The instructions also included switching apps,
returning, and checking Keep Awake reacquisition and another read. The overall
success report covers that sequence; separate timestamps, UI messages, and sample
size were not supplied. This is a user-reported pass, not an instrumented
measurement or proof of whole-file integrity or multi-hour operation.

## Interpretation and remaining work

These readings do not reproduce persistent storage growth approximately equal to
the selected media size on this device/run. Most of the observed increase subsided
after closure. The residual increases (18.3 MB initially, 99.5 MB in the timed run)
are unexplained; neither zero retained growth nor a leak can be established from
these measurements alone. This is not evidence
that the reported WebKit issue is fixed across devices or versions.

**Decision: sufficient real-iPhone evidence to proceed to a bounded Phase 1 Drive
spike, with the restoration limitation retained.** Controlled storage observations,
the 30-minute foreground test, and demonstrated fresh-tab recovery support testing
one-file transfers. This does not establish production safety or large-library
reliability. The spike must not assume source access survives Safari termination.

- Optional later storage reading with elapsed time can clarify the residual increase.
- Selections of 66 files and 92 videos are reported; native gesture usability and higher file counts remain unmeasured.
- Bounded reads before/after 30 minutes and after switching apps succeeded by user report. Multi-hour checks remain pending.
- Fully closing/reopening Safari with a selection produced a page-loading failure. Empty-page and cleared-selection restoration succeeded, and a fresh tab recovered page access after failure. Root cause and robustness of a future uploader's recovery remain unresolved.
- Keep Screen Awake passed the reported 30-minute foreground and app-switch sequence; multi-hour validation remains pending.
- Android physical validation remains deferred.

Use the [test procedure](phase-0-testing.md) for the remaining experiments. This
observation does not validate uploads, multi-gigabyte individual files, thousands
of files, or production safety.
