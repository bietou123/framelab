# FrameLab

本地 Windows 视频剪辑工具，使用 Electron、React、TypeScript 和原生
FFmpeg / FFprobe。首屏就是剪辑工作台，不是网页。

## 交付状态

真实双源 DJI 成片导出、26 项单元测试、14 项原生集成检查、15 项原生功能
回归和 16 项无头渲染交互检查均已通过。16 项 Electron IPC 诊断也通过，但
使用了测试专用的沙箱绕过。打包版安全启动随后通过 17/17 项桌面检查，生产
沙箱保持开启，测试窗口全程位于屏幕外。处理、渲染、诊断与桌面验收的区别
见 `TEST_REPORT.md`。

## 运行

构建 Windows 目录包后，打开 `release/win-unpacked/FrameLab.exe`。必须同时
保留配套文件和 `resources` 目录；单独一个 EXE 不是完整分发件。本构建在
用户机器上不需要 Node.js，也不需要浏览器开发服务器。

Windows 构建目标还包括完整的便携 EXE 和 NSIS 安装器。可选的
`FrameLab-0.1.0-win-x64.zip` 包含完整目录包，用于离线解压；不要只从压缩包
里解出 `FrameLab.exe`。未签名的构建可能触发 Windows SmartScreen 提示，
本构建没有做代码签名。早前受管测试环境曾在 Electron 的安装目录沙箱访问
检查处失败，打包版验收未再复现，因此按环境性原因（系统负载 / 防病毒
时机）处理，不宣称已定位根因，也不声称已经彻底修复。

默认可写位置：

| 内容 | 位置 |
| --- | --- |
| 项目、自动保存、队列与 Electron 配置 | `%LOCALAPPDATA%\FrameLab\data` |
| 缩略图、波形数据与预览代理 | `data\cache` |
| 导出工作区与错误日志 | `data\exports` 和 `data\logs` |
| 音频素材库及来源 / 授权目录 | `%LOCALAPPDATA%\FrameLab\audio` |
| 开发用 FFmpeg / FFprobe | `native\bin`，或 `FRAMELAB_NATIVE_DIR` |

配置的数据根不可用时不会自动回退到其他磁盘。`FRAMELAB_DATA_DIR` 和
`FRAMELAB_AUDIO_DIR` 可以把全部可写状态改到别处。

导入的媒体保留在原位置，且只读。加入音频库会复制一份单独的文件，不会移动
源文件。SHA-256 用于识别重复的库条目。应用不上传媒体，也不在线下载音乐。

## 剪辑

1. 把文件导入或拖入素材箱。多选与批量导入使用真实 FFprobe 元数据、源缩略图
   和音频波形。
2. 把选中片段追加到时间线，或拖到匹配的轨道上。可以排列、切分、裁剪或
   删除片段；可以锁定、静音或隐藏单条轨道。
3. 选中片段后调整源范围、裁切、旋转、镜像、速度、倒放、定格、变换、不
   透明度、音量和颜色控制。
4. 添加覆盖整个项目的音乐。首尾静音去除、有限循环、交叉淡化连接、淡入
   淡出和降噪都使用原生 FFmpeg。
5. 添加或导入 SRT 字幕，调整字体、颜色、描边和位置。SRT 导出与视频导出
   相互独立。
6. 保存 `.frameproj` 项目。自动保存、恢复、最近项目和缺失媒体重链接都保留
   源引用。

位置、缩放、不透明度和音量关键帧使用线性插值。当前视频转场是重叠溶解。
多轨视频支持画中画。颜色控制包括曝光、对比度、饱和度、白平衡和
`.cube` / `.3dl` LUT。

HEVC 或浏览器无法解码的媒体会生成兼容的低分辨率代理。导出始终读取原始
媒体。无法在浏览器预览中可靠重现的效果，由原生精确帧预览覆盖。长时间倒放
会分块处理，不会把整个 4K 片段读进内存。

## 导出

- `1 GB` 精确表示 `1,000,000,000` 字节。限长导出成功时，输出必须严格小于
  选定的字节上限。
- 大小预算会从实际项目时长中扣除音频、容器开销和安全余量。编码完成后会
  再次检查文件。
- 默认保留分辨率与有理帧率，包括 `60000/1001`。即使保持这些规格，重新编码
  仍然是有损的。
- 只有在已安装工具与设备支持时，才提供 H.264、H.265 和检测到的 AV1 编码器。
  NVIDIA、Intel 和 AMD 通过编码真实测试帧来探测。软件编码是回退方案。
- 解码器选择与编码器选择相互独立。GPU 解码失败可以回退到软件解码，而不会
  关闭已选编码器。
- 未编辑且兼容的片段可以复制视频流。不兼容的流或经过编辑的内容需要重新
  编码。在兼容性和大小预算允许时，替换音乐也可以保留视频流复制。
- HDR 重编码目前不承诺完整保留元数据。请选择兼容的流复制，或明确选择
  HDR 转 SDR。
- 导出只映射所需的视频 / 音频流，排除附带封面和 DJI 数据流。MP4 使用单独的
  faststart 封装步骤。
- 编码、封装和验证是三个真实的阶段。百分比、速度、剩余时间与字节数来自
  FFmpeg 进度；无法测量的工作保持为不确定状态。必须验证通过才能发布最终
  输出。
- 任务按顺序执行。取消只删除任务自己拥有的临时输出。重试从头开始，而不是
  从虚假的检查点继续。超限输出会提供更低码率的重编码建议，并且不会标记为
  成功。

永远不覆盖已有输出和原始媒体。最终文件只有在大小、流、精确帧率、帧数、
时间戳、拼接边界、音频覆盖以及可选完整解码检查全部通过后才会发布。完整
解码验证默认开启。

## 构建

使用 Windows x64 和 Node.js 22.12 或更高版本。在项目目录中运行：

```powershell
npm.cmd ci
npm.cmd run setup:native
npm.cmd run build
npm.cmd run start
npm.cmd run package:dir
```

`setup:native` 会把固定版本的 FFmpeg 8.0.1 essentials 构建下载到 `native/`
（可用 `FRAMELAB_NATIVE_ROOT` 改变位置），并校验 SHA-256。它需要网络访问；
如果原生工具已经存在，则不需要执行。打包版优先使用 `resources/native`。
`package:dir` 生成可运行的目录包。`npm.cmd run package` 还会请求便携版和
NSIS 安装器；其构建资源可能需要网络访问。NSIS 安装器允许指定安装目录。
`npm.cmd run test:package` 会按当前构建检查目录包，并实际运行包内原生工具。
`npm.cmd run package:zip` 会生成带 SHA-256 校验文件的完整离线 ZIP，并拒绝
覆盖已有压缩包。可以用 `npm.cmd run package:zip -- -Name
FrameLab-local-win-x64.zip` 指定未使用的压缩包名称。

`npm.cmd run dev` 启动 Vite 和 Electron 用于源码开发。生产 EXE 是本地的，
不依赖该服务器。

可选的环境变量覆盖：

| 变量 | 含义 |
| --- | --- |
| `FRAMELAB_DATA_DIR` | 可写项目 / 缓存 / 状态根目录 |
| `FRAMELAB_AUDIO_DIR` | 音频库根目录 |
| `FRAMELAB_NATIVE_DIR` | 同时包含两个原生 EXE 的目录 |
| `FRAMELAB_WHISPER_CLI` | 本地 whisper.cpp CLI 路径 |
| `FRAMELAB_WHISPER_MODEL` | 兼容的本地语音模型路径 |

在配置本地可执行文件和模型之前，自动字幕不可用。模型执行错误会被报告；
没有云端回退。

## 验证

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

测试使用真实生成的媒体和原生服务，不使用模拟任务。截图和机器可读结果保存在
被忽略的 `test-artifacts` 中。渲染器测试是无头浏览器测试，不能证明 Electron
IPC 或安全桌面启动。它在 Playwright 浏览器缓存缺失时使用已安装的 Edge /
Chrome；`FRAMELAB_TEST_BROWSER` 可以指定明确的 Chromium 可执行文件。其布局
与 150% DPI 检查模拟渲染器视口，验证真实截图像素尺寸并检查实际媒体像素；
这些不等于 Windows 原生窗口缩放。
`test:e2e:diagnostic` 仅为诊断而绕过 Chromium 沙箱，永远不能计为安全桌面
验收。正常与打包版 Electron 测试保持沙箱开启。桌面测试窗口始终位于屏幕外，
并抑制系统崩溃弹窗，避免打断其他工作。

真实验收测试会写入新的输出名称，并拒绝覆盖已存在的文件。重跑时用
`FRAMELAB_ACCEPT_OUT` 指定一个未使用的输出路径。输入与音乐可以通过
`FRAMELAB_ACCEPT_FIRST`、`FRAMELAB_ACCEPT_SECOND` 和
`FRAMELAB_ACCEPT_MUSIC` 明确指定。

## 许可

应用源码使用 MIT 许可。FFmpeg、Electron、Chromium 及其他依赖保留各自的
许可；见 `THIRD_PARTY.md`。个人媒体、本地素材目录以及权利未确认的音乐不随
应用分发。一首 BGM 流行，或被创作者推荐，都不等于拥有音乐许可。
