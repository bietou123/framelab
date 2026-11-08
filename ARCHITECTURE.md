# FrameLab

## Architecture

- Electron main: file dialogs, read-only source access, native FFprobe JSON, bounded FFmpeg jobs, asset catalog, projects and recovery.
- Preload: a typed IPC API; context isolation and sandbox enabled; no renderer Node access.
- React / TypeScript: media bin, genuine video previews, inspectors and a multi-track timeline.
- Shared model: frame-rational timing, immutable edits, export planning, subtitles and validation contracts.
- Native FFmpeg: finite music preparation, video processing, separate faststart packaging and complete verification. Original inputs are never modified.

## Delivery Stages

- [x] Stage 1 processing: import, real metadata, ordered splice, finite soundtrack, decimal-byte size budget, measured progress, verification, cancellation and queue. The real DJI export passed.
- [x] Stage 2 implementation: multi-track edits, transform / color / keys, dissolve transitions, SRT, autosave / recovery / relink and compatible preview proxies. Native feature regression passed.
- [x] Processing and renderer verification: 26 unit tests, 14 native integration checks, 15 native feature pixel / audio checks, 16 headless renderer checks and the two real DJI sources. Layout screenshots use explicit viewport / DPI emulation and verified PNG dimensions, not native window resizing.
- [x] IPC diagnosis: 16 actual Electron preload / IPC checks with a test-only sandbox bypass. This does not satisfy secure desktop acceptance.
- [x] Desktop acceptance: packaged secure Electron startup passed 17/17 desktop checks on 2026-11-08 with the production sandbox enabled (`secureStartupVerified=true`, `nativeWindowResizingVerified=true`), windows kept fully offscreen. Renderer-host tests remain a separate, weaker check.
- [x] Local package verification: the Windows directory package passed six integrity / native smoke checks, including current build comparison and bundled FFmpeg / FFprobe encoding / full decoding. Build instructions, architecture and test report are included. Complete offline ZIP and installer targets are available through the build scripts. No personal media or asset catalog may enter a public release.

## Boundaries

Preserving resolution, frame rate and color metadata during lossy encoding is not lossless. Stream-copy is offered only when edits and parameters allow it. File size is validated before success. Progress during faststart is indeterminate unless FFmpeg supplies a measurable timestamp; completion is never simulated. There is no advertised resumable encoding.

The current HDR re-encoding path requires an explicit SDR conversion choice. It does not claim complete HDR metadata preservation. Compatible HDR stream-copy remains separate. Local speech recognition requires a configured whisper.cpp executable and model; no cloud recognition is used.

Secure desktop acceptance remains separate from package integrity. Earlier
managed-host runs recorded renderer restricted-token failures and a
packaged-install-directory access fatal error; both are documented in
`TEST_REPORT.md`. The later packaged run passed secure startup and native
resizing without weakening production security settings. Neither a browser
harness nor the sandbox-bypassed diagnostic is counted as a startup pass.
