# Third-Party Notices

FrameLab source uses the MIT license. That license does not replace the
licenses of bundled binaries, dependency code, fonts, LUTs or personal music.

## Native FFmpeg

- Distributor: Gyan Doshi, https://www.gyan.dev/ffmpeg/builds/
- Pinned distribution: FFmpeg 8.0.1 essentials build.
- Download: https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip
- Archive SHA-256: `e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673`
- Upstream project and source: https://ffmpeg.org/ and https://ffmpeg.org/releases/
- Distributor source / build information: https://github.com/GyanD/codexffmpeg
- GPL license shipped alongside the native binaries:
  `resources/native/FFmpeg-LICENSE.txt`.

This build includes GPL-enabled components. Preserve the accompanying license
and applicable source-distribution obligations when redistributing binaries.
The FFmpeg project license / legal page is https://ffmpeg.org/legal.html.
Bundled binary licensing is not described as MIT.

## Desktop And UI

Electron is MIT licensed; Chromium and its included components have separate
notices. Keep `LICENSE.electron.txt` and `LICENSES.chromium.html` from the
Electron directory distribution. React, React DOM, Lucide React and Zod
are MIT licensed. Preserve notices from their installed packages when
redistributing dependency code. Build and test dependencies are listed in
`package.json` and pinned by `package-lock.json`.

## Media, Fonts And Models

No commercial soundtrack, creator audio collection, user video, speech model,
LUT or font file is included as a free licensed asset. Locally cataloged music
records its source and license status. Unknown rights stay unknown. Creator
usage or recommendation does not authorize a public upload or redistribution.
Font and model licenses remain the responsibility of their actual providers.
