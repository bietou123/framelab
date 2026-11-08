# FrameLab

A local Windows video editor using Electron, React, TypeScript and native
FFmpeg / FFprobe. The first screen is the editing workbench, not a website.

## Delivery Status

The real two-source DJI export, 26 unit tests, 14 native integration checks,
15 native feature checks and 16 headless renderer interaction checks have
passed. The 16-check Electron IPC diagnostic also passed, but used a
test-only sandbox bypass. Packaged secure Electron startup has since passed
17/17 desktop checks with the production sandbox enabled and the test window
kept fully offscreen. See `TEST_REPORT.md` for the distinction between
processing, renderer, diagnostic and desktop acceptance.

## Run

Open `release/win-unpacked/FrameLab.exe` after building the Windows directory
package. Keep its companion files and `resources` folder alongside the EXE;
the EXE alone is not a standalone distribution. This build needs neither
Node.js nor a browser development server on the user's machine.

Windows build targets also include a complete portable EXE and an NSIS
installer. The optional `FrameLab-0.1.0-win-x64.zip` contains the full directory
package for offline extraction. Do not extract only `FrameLab.exe` from it.
An unsigned build may trigger Windows SmartScreen; it is not code-signed.
An earlier managed test launch failed Electron's installation-directory
sandbox access check before the workbench; that failure did not reproduce on
the packaged acceptance run, so it is treated as environmental (system load /
antivirus timing) rather than a code defect, and is not claimed as root-caused.

The default writable locations are:

| Content | Location |
| --- | --- |
| Projects, autosave, queue and Electron profile | `%LOCALAPPDATA%\FrameLab\data` |
| Thumbnails, waveform data and preview proxies | `data\cache` |
| Export workspaces and error logs | `data\exports` and `data\logs` |
| Audio asset library and source / license catalog | `%LOCALAPPDATA%\FrameLab\audio` |
| Development FFmpeg / FFprobe | `native\bin`, or `FRAMELAB_NATIVE_DIR` |

No automatic fallback is used if the configured data root is unavailable.
`FRAMELAB_DATA_DIR` and `FRAMELAB_AUDIO_DIR` relocate all writable state. Imported media remains
at its original location and is read-only. Adding audio to the library makes
a separate copy; it does not move the source. SHA-256 identifies duplicate
library entries. No media uploads or online music downloads occur in the app.

## Editing

1. Import or drag files into the media bin. Multi-selection and batch import
   use real FFprobe metadata, source thumbnails and audio waveforms.
2. Append the selected clips or drag them onto a matching track. Arrange,
   split, trim or delete clips; lock, mute or hide individual tracks.
3. Select a clip to adjust its source range, crop, rotation, mirror, speed,
   reverse, freeze frame, transform, opacity, volume and color controls.
4. Add music with full-project coverage. Leading / trailing silence removal,
   finite looping, crossfade joins, fades and denoise use native FFmpeg.
5. Add or import SRT subtitles and adjust font, color, outline and placement.
   SRT export is separate from video export.
6. Save `.frameproj` projects. Autosave, recovery, recent projects and missing
   media relinking preserve source references.

Position, scale, opacity and volume keyframes use linear interpolation.
The current video transition is an overlapping dissolve. Multi-track video
supports picture-in-picture. Color controls include exposure, contrast,
saturation, white balance and `.cube` / `.3dl` LUTs.

HEVC or unsupported browser decoding generates a compatible low-resolution
proxy. Export always reads the original media. Native exact-frame previews
cover effects that cannot be reproduced reliably in the browser preview.
Long reverse operations are processed in bounded chunks rather than loading
an entire 4K clip into RAM.

## Export

- `1 GB` means exactly `1,000,000,000` bytes. Successful size-limited output
  must be strictly smaller than the selected byte limit.
- The budget subtracts audio, container overhead and safety margin from the
  actual project duration. The file is checked again after encoding.
- Resolution and rational frame rate are preserved by default, including
  `60000/1001`. Re-encoding is lossy even when these specifications remain.
- H.264, H.265 and detected AV1 encoders are offered only where the installed
  tools and device support them. NVIDIA, Intel and AMD are probed by encoding
  real test frames. Software encoding is a fallback.
- Decoder selection is separate from encoder selection. GPU decoding failures
  can fall back to software decoding without disabling the selected encoder.
- Compatible unedited clips can copy their video streams. Incompatible
  streams or edits require re-encoding. Replacing music can retain video
  stream-copy when compatibility and the size budget permit it.
- HDR re-encoding does not currently promise complete metadata preservation.
  Choose compatible stream-copy or explicitly opt into HDR-to-SDR conversion.
- Export maps only required video / audio streams, excluding attached artwork
  and DJI data. MP4 uses a separate faststart packaging step.
- Encoding, packaging and verification are distinct real stages. Percentages,
  speed, ETA and bytes come from FFmpeg progress; unmeasurable work remains
  indeterminate. Verification must pass before the final output is published.
- Jobs run sequentially. Cancel removes only owned temporary output. Retry
  starts from the beginning, not from a fictional checkpoint. An oversized
  output offers a lower-bitrate re-encode and is not marked successful.

Existing output files and original media are never overwritten. Final files
are published only after size, streams, exact frame rate, frame count,
timestamps, splice boundaries, audio coverage and optional full decode checks.
Full decode verification is enabled by default.

## Build

Use Windows x64 and Node.js 22.12 or later. Run from the project directory:

```powershell
npm.cmd ci
npm.cmd run setup:native
npm.cmd run build
npm.cmd run start
npm.cmd run package:dir
```

`setup:native` downloads the pinned FFmpeg 8.0.1 essentials build into
`native/` (override with `FRAMELAB_NATIVE_ROOT`) and checks its SHA-256. It needs network access and is unnecessary when the native
tools are already present. A packaged build uses `resources/native` first.
`package:dir` creates the runnable directory package. `npm.cmd run package`
also requests portable and NSIS installers; their builder resources may need
network access. The NSIS installer allows an explicit destination directory.
`npm.cmd run test:package` checks the directory package against the current
build and exercises its bundled native tools. `npm.cmd run package:zip`
creates a complete offline ZIP with a SHA-256 sidecar, refusing to overwrite
an existing archive. A custom unused archive name can be supplied with
`npm.cmd run package:zip -- -Name FrameLab-local-win-x64.zip`.

`npm.cmd run dev` starts Vite and Electron for source development. The
production EXE is local and does not depend on that server.

Optional explicit environment overrides:

| Variable | Meaning |
| --- | --- |
| `FRAMELAB_DATA_DIR` | Writable project / cache / state root |
| `FRAMELAB_AUDIO_DIR` | Audio library root |
| `FRAMELAB_NATIVE_DIR` | Directory containing both native EXEs |
| `FRAMELAB_WHISPER_CLI` | Local whisper.cpp CLI path |
| `FRAMELAB_WHISPER_MODEL` | Compatible local speech model path |

Automatic subtitles are unavailable until a local executable and model are
configured. Model execution errors are reported; no cloud fallback is used.

## Verification

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:features
npm.cmd run test:renderer
npm.cmd run test:e2e
npm.cmd run test:e2e:packaged
npm.cmd run test:package
npm.cmd run test:acceptance
```

Tests use genuine generated media and native services, not simulated jobs.
Screenshots and machine-readable results stay in ignored `test-artifacts`.
The renderer test is a headless browser harness, not proof of Electron IPC or
secure desktop startup. It uses installed Edge / Chrome if the Playwright
browser cache is absent; `FRAMELAB_TEST_BROWSER` can select an explicit
Chromium executable. Its layout / 150 percent DPI checks emulate renderer
viewports, verify real screenshot pixel dimensions and inspect actual media
pixels; they do not verify native Windows resizing.
`test:e2e:diagnostic` bypasses the Chromium sandbox only for diagnosis and
must never be counted as secure desktop acceptance. Normal and packaged
Electron tests preserve the sandbox. Desktop test windows remain offscreen
and suppress OS crash dialogs so they do not interrupt other work.

The real acceptance test writes a new output name and refuses to overwrite
one already present. Set `FRAMELAB_ACCEPT_OUT` to an unused output path when
rerunning it. Inputs and music can be explicitly set through
`FRAMELAB_ACCEPT_FIRST`, `FRAMELAB_ACCEPT_SECOND` and `FRAMELAB_ACCEPT_MUSIC`.

## Licenses

Application source is MIT. FFmpeg, Electron, Chromium and other dependencies
retain their own licenses; see `THIRD_PARTY.md`. Personal media, the local
asset catalog and music with unconfirmed rights are not shipped with the app.
Being a popular BGM or being recommended by a creator is not a music license.
