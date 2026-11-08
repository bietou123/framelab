# FrameLab Test Report

## Scope

This report separates native processing, headless renderer checks and secure
Electron desktop acceptance. A headless renderer pass is not an Electron pass.
Full raw results and source media remain in ignored local directories.

## Recorded Results

| Suite | Recorded result | Evidence |
| --- | --- | --- |
| Unit, protocol and storage | 26 tests passed, rerun 2026-11-08 | `tests/core.test.ts`, `tests/storage.test.ts`, `tests/app-protocol.test.ts` |
| Native integration | 14 checks passed, 2026-11-08 07:39 CST | `test-artifacts/integration-results.json` |
| Native feature regression | 15 checks passed, 2026-11-08 07:48 CST | `test-artifacts/feature-results.json` |
| Headless renderer with native services | 16 checks passed, 2026-11-08 08:02 CST | `test-artifacts/renderer-results.json` |
| Offscreen Electron IPC diagnostic | 16 checks passed, 2026-11-08 08:03 CST; sandbox bypassed, not secure startup acceptance | `test-artifacts/e2e-diagnostic-results.json` |
| Real DJI export | Passed, including full decode | `test-artifacts/acceptance-results.json` |
| Secure Electron startup (source build) | Earlier production-mode run failed (recorded below); superseded by the packaged run | `test-artifacts/e2e-results.json` |
| Package integrity and bundled native tools | 6 checks passed, 2026-11-08; not a secure-start acceptance | `test-artifacts/package-results.json` |
| Packaged secure Electron startup | 17 checks passed, 2026-11-08; `secureStartupVerified=true`, `nativeWindowResizingVerified=true`, `errors=[]`, window fully offscreen | `test-artifacts/e2e-packaged-results.json` |

Native integration covers no-audio sources, finite full-length music, video
stream-copy with new music, software two-pass encoding, transforms,
subtitles, different source frame rates, portrait media, bounded reverse,
freeze frame, damaged input, disk-space rejection, cancel cleanup and
byte-identical original sources. Disk-space rejection uses an injected
free-space reading; it does not fill the user's real drive.

Native feature checks measure exported pixels and PCM / decoded audio:
slowed audio at its actual end, AAC packaging, trimmed finite crossfade loops,
audio-work cancellation and cache reuse, picture-in-picture, animated position,
opacity blending, overlapping dissolve and exact-preview agreement, frame
cache cleanup, LUTs, exposure / saturation, warm / cool white balance, explicit
HDR-to-SDR conversion, and source relinking without changing clip IDs.

Headless renderer checks cover import, HEVC proxies, sorting, undo / redo,
pointer moving and trimming, split / delete, track states, keyframe controls,
music, subtitles, save / autosave, genuine export progress, cancel, moving
preview pixels and layout. Captured sizes include 1480x960, 1100x740, 820x620,
1140x870 at 150 percent scale and 390x844. The screenshot PNG dimensions and
actual device pixel ratio are asserted, including 760x580 CSS pixels captured
as 1140x870 physical pixels at 150 percent density. These are explicitly
emulated renderer viewports, not native Windows resizing. This run used
headless Edge 157.0.4341.42 because the Playwright browser cache was absent.
It does not validate native file dialogs, production preload IPC or normal
Electron startup.

The separate Electron diagnostic exercises the actual preload and IPC,
native export, cancellation and the same emulated layouts. Its test process
uses `--no-sandbox --disable-gpu`, and its result explicitly records
`secureStartupVerified: false` and `nativeWindowResizingVerified: false`.
Cancellation of obsolete audio / frame previews is visible in IPC logs;
there were no uncaught renderer exceptions. Production security settings
were not changed to make this diagnostic pass.

## Real DJI Acceptance

The approximately 3-minute-02-second source comes first. Both inputs are
4096x2160 with the precise frame rate `60000/1001` and have 17,484 frames in
total. The user-selected personal soundtrack covers the whole timeline.

| Field | Measured output |
| --- | --- |
| File | Local user file in the Downloads directory; not shipped or bundled |
| Size | 985,118,116 bytes, strictly below 1,000,000,000 |
| Duration | 291.6914 seconds |
| Resolution | 4096x2160 |
| Frame rate | 60000/1001 |
| Frames and packets | 17,484 |
| Video / audio | HEVC / AAC |
| Encoder | hevc_nvenc |
| Video bitrate budget | 26,548 kbps |
| Audio endpoint | 291.691 seconds |
| Splice boundary | 182.6658166667 seconds |
| Maximum boundary timestamp gap | 0.016684 seconds, one frame |
| Timestamp ordering | Monotonic |
| Complete video and audio decoding | Passed |
| Validation issues / warnings | None |
| Processing and verification wall time | 657.031 seconds |

This is a size-constrained lossy encode preserving source resolution and frame
rate, not lossless restoration or a guarantee of perceptual equality. The
recorded export predates the latest feature fixes; those fixes are covered
by the newer focused regression rather than a claimed second real 4K export.

## Desktop Startup Limitation

The recorded production-mode and software-rendering Electron tests failed
before workbench acceptance. An empty `about:blank` window also reproduced
the failure without loading any media. The baseline log
`test-artifacts/electron-crash-probe/log-managed-baseline-44576.txt` records
renderer `launch-failed`, exit code `49` (Chromium restricted-token creation
failure), plus GPU exits `-1073741515` (`0xC0000135`) and `ERR_FAILED`.
The evidence separates a sandbox child-process startup problem from media
decoding. It does not identify a particular missing DLL. The product keeps
`sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`.

The earlier production-mode failure is kept below as history and was not
resolved by weakening the product's security settings. A later packaged run
(`scripts/test-desktop.ps1 -Packaged`) passed 17/17 desktop checks on
2026-11-08 with the production sandbox enabled: `mode=electron-packaged`,
`secureStartupVerified=true`, `nativeWindowResizingVerified=true`,
`errors=[]` and `consoleErrors=[]`. Each resize step asserted that all four
window edges stayed outside every display. Do not resolve a future failure
by silently switching the deliverable to a browser-hosted application or by
disabling the production sandbox.

The freshly built executable failed earlier in Electron's
`install_dir_access.cc:52` check, with exit code `2147483651` (`0x80000003`).
Its diagnostic says the application directory has an AppContainer package SID
entry but lacks an effective `ALL APPLICATION PACKAGES` read permission for
the sandbox launch. A subsequent read-only `Get-Acl` inspection already showed
an explicit `ALL APPLICATION PACKAGES` read / execute entry, yet the secure
retry reproduced the same fatal diagnostic. The managed launch context's
effective access remains unresolved; the visible ACL alone does not prove
this is repaired. No ACL grants, elevation, external launch bypass or
production sandbox changes were applied. This is distinct from the earlier
empty-window renderer exit `49` and is recorded rather than hidden. A later
independent silent install plus offscreen launch did not reproduce the
failure; it is treated as environmental (system load / antivirus timing), not
as root-caused or proven fixed.

## Packaging Verification

The six package checks validate the Windows PE executable, required Electron
runtime files and license notices; exclusion of personal media / library /
live state from ASAR; byte-for-byte agreement with current main, preload,
renderer and documentation; unchanged static production security settings;
SHA-256 equality of bundled native tools; and real six-frame H.264 encoding,
FFprobe metadata plus complete decoding by the bundled executables.

This verification does not launch the desktop UI and explicitly records
`secureStartupVerified: false`. The directory must be distributed with its
companion files. The offline ZIP build includes the complete directory and
checks required archive entries before publishing it with a SHA-256 sidecar.
Installer execution and a portable self-extracting launch have since been
checked on 2026-11-08: both started offscreen with `FRAMELAB_TEST=1`, the
silent NSIS install exited 0 into a custom `/D` directory, and uninstall
exited 0 leaving no process or directory behind. No personal soundtrack is
included in any package.

## Unverified Hardware And Models

The current machine's NVIDIA encoding path was exercised on the real 4K
export. Intel QSV, AMD AMF and AV1 availability are detected at runtime but
not accepted on physical devices in this report. Local speech recognition
without a configured model is correctly unavailable; transcription with an
installed model has not been accepted. There is no resumable encoding.
