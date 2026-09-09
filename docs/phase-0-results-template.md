# Phase 0 result — pending

Copy for each device/run. Leave untested fields as **not tested**, never as pass. Use non-identifying sample labels and review screenshots before sharing.

## Run

- Date/time and tester:
- Device model, OS version/build, browser/version:
- Page URL and code revision:
- Baseline or experiments page:
- Normal Safari tab / private tab / Home Screen / other:
- Charging, battery percentage, low-power mode, auto-lock setting:
- iCloud Photos/download settings and media locally available or cloud-backed:
- Picker route (Photo Library / Files / other):
- Sample label, media formats, expected count/bytes:
- Minimum free-space reserve and maximum selection byte budget:
- Confounders (other downloads, storage calculation delay, other apps):

## Storage baseline — no content reads

| Observation | Time / elapsed | Safari Documents & Data (with units) | Change from baseline | Device free space | Notes |
| --- | --- | --- | --- | --- | --- |
| Before selection | | | | | |
| After one selection | | | | | |
| After tab closure | | | | | |
| After Safari force-quit | | | | | |
| After reboot, if needed | | | | | |
| Later observation, if needed | | | | | |

- Preparation duration and delivered count/total bytes:
- Completion, cancellation, stall, or mismatch:
- Did a stopping condition occur? Which one?
- Any repeat selection or independent cleanup (record separately):
- Storage conclusion: not tested / inconclusive / retained growth observed / no retained growth observed within stated interval:

## Progressive selection usability

| Sample count / bytes | Native selection gestures | Preparation time | Returned count / bytes | Responsiveness / storage | Result |
| --- | --- | --- | --- | --- | --- |
| 10 | | | | | Not tested |
| 100 | | | | | Not tested |
| 500 | | | | | Not tested |
| 1,000 (only if justified) | | | | | Not tested |

- HEIC / MOV / Live Photo / RAW representations actually returned:
- Largest tested file and total batch:
- Untested sizes/formats:

## Separate experiments

New selection/time/sample for this run:

| Bounded-read observation | Actual elapsed time | Reported bytes / error | Page survived or selection lost? |
| --- | --- | --- | --- |
| Immediately | | | |
| After 5 minutes foreground | | | |
| After 30 minutes foreground | | | |
| After planned multi-hour foreground interval | | | |
| After brief app switch | | | |
| After manual lock/unlock | | | |
| After reload / tab close / force-quit (separate cases) | | | |

| Wake Lock observation | UI state / error | Physical screen behavior | Duration / notes |
| --- | --- | --- | --- |
| API support and initial request | | | |
| Visible beyond auto-lock interval | | | |
| User disables | | | |
| Hide and restore | | | |
| Manual lock and unlock | | | |
| Multi-hour foreground run | | | |

## Decision

- Overall status: **pending** / inconclusive / observed limitation / sufficient evidence for bounded next phase:
- Proceed to isolated Drive spike / hold / stop and reconsider:
- Evidence supporting decision:
- Maximum count/bytes/duration actually validated:
- Failures, open questions, required follow-up:
- Android physical testing: **deferred unless this run supplies evidence**:
- Accepted finding linked from `PROJECT.md`:

This result does not establish background upload capability, whole-file integrity, Drive resumability, or behavior on other devices/OS versions.
