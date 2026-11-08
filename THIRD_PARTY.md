# 第三方声明

FrameLab 源码使用 MIT 许可。该许可不替代随附二进制、依赖代码、字体、LUT
或个人音乐的各自许可。

## 原生 FFmpeg

- 分发方：Gyan Doshi，https://www.gyan.dev/ffmpeg/builds/
- 固定版本：FFmpeg 8.0.1 essentials build
- 下载：https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip
- 压缩包 SHA-256：`e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673`
- 上游项目与源码：https://ffmpeg.org/ 和 https://ffmpeg.org/releases/
- 分发方源码 / 构建信息：https://github.com/GyanD/codexffmpeg
- 随原生二进制一起分发的 GPL 许可文件：
  `resources/native/FFmpeg-LICENSE.txt`

该构建包含启用 GPL 的组件。再分发二进制时必须保留随附许可，并履行适用的
源码分发义务。FFmpeg 项目的许可 / 法律说明页为
https://ffmpeg.org/legal.html。随附二进制的许可不得表述为 MIT。

## 桌面与界面

Electron 使用 MIT 许可；Chromium 及其包含的组件有单独的声明文件。分发时
须保留 Electron 目录中的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。
React、React DOM、Lucide React 与 Zod 使用 MIT 许可。再分发依赖代码时须
保留已安装包中的声明文件。构建与测试依赖列在 `package.json` 中，并由
`package-lock.json` 锁定版本。

## 媒体、字体与模型

本仓库不包含任何作为免费许可素材提供的商业配乐、创作者音频合集、用户视频、
语音模型、LUT 或字体文件。本地登记的音乐会记录其来源与授权状态；未知权利
保持为未知。创作者的推荐或使用说明不构成公开上传或再分发的授权。字体与
模型的许可由实际提供方负责。
