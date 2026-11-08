# FrameLab 测试报告

## 范围

本报告把原生处理、无头渲染检查和安全 Electron 桌面验收区分开。无头渲染通过
不等于 Electron 通过。完整原始结果与源媒体保留在被忽略的本地目录中。

## 记录结果

| 套件 | 记录结果 | 证据 |
| --- | --- | --- |
| 单元、协议与存储 | 26 项通过，2026-11-08 复跑 | `tests/core.test.ts`、`tests/storage.test.ts`、`tests/app-protocol.test.ts` |
| 原生集成 | 14 项通过，2026-11-08 07:39 CST | `test-artifacts/integration-results.json` |
| 原生功能回归 | 15 项通过，2026-11-08 07:48 CST | `test-artifacts/feature-results.json` |
| 带原生服务的无头渲染 | 16 项通过，2026-11-08 08:02 CST | `test-artifacts/renderer-results.json` |
| 屏幕外 Electron IPC 诊断 | 16 项通过，2026-11-08 08:03 CST；绕过沙箱，不算安全启动验收 | `test-artifacts/e2e-diagnostic-results.json` |
| 真实 DJI 导出 | 通过，含完整解码 | `test-artifacts/acceptance-results.json` |
| 安全 Electron 启动（源码构建） | 早前生产模式运行失败（见下文）；已被打包版运行取代 | `test-artifacts/e2e-results.json` |
| 包完整性及包内原生工具 | 6 项通过，2026-11-08；不算安全启动验收 | `test-artifacts/package-results.json` |
| 打包版安全 Electron 启动 | 17 项通过，2026-11-08；`secureStartupVerified=true`、`nativeWindowResizingVerified=true`、`errors=[]`、窗口全程屏幕外 | `test-artifacts/e2e-packaged-results.json` |

原生集成覆盖无音频源、有限长度全片音乐、替换音乐后的视频流复制、软件
两遍编码、变换、字幕、不同源帧率、竖屏媒体、有界倒放、定格、损坏输入、
磁盘空间拒绝、取消清理，以及原始素材与源文件字节一致。磁盘空间拒绝使用
注入的空闲空间读数，不会真的塞满用户磁盘。

原生功能检查测量导出像素与 PCM / 解码音频：减速音频在真实结尾处、AAC
封装、裁剪后的有限交叉淡化循环、音频任务取消与缓存复用、画中画、位置
动画、不透明度混合、重叠溶解与精确预览一致性、帧缓存清理、LUT、曝光 /
饱和度、暖 / 冷白平衡、显式 HDR 转 SDR，以及不改变片段 ID 的源重链接。

无头渲染检查覆盖导入、HEVC 代理、排序、撤销 / 重做、指针移动与裁剪、
切分 / 删除、轨道状态、关键帧控件、音乐、字幕、保存 / 自动保存、真实导出
进度、取消、移动预览像素和布局。截取尺寸包括 1480x960、1100x740、820x620、
150% 缩放下的 1140x870，以及 390x844。测试断言截图 PNG 尺寸和实际设备像素比，
包括 760x580 CSS 像素在 150% 密度下截取为 1140x870 物理像素。这些明确是
模拟的渲染器视口，不是 Windows 原生窗口缩放。由于 Playwright 浏览器缓存
缺失，本次运行使用无头 Edge 157.0.4341.42。它不验证原生文件对话框、生产
preload IPC 或普通 Electron 启动。

独立的 Electron 诊断调用真实 preload 和 IPC、原生导出、取消以及相同的模拟
布局。其测试进程使用 `--no-sandbox --disable-gpu`，结果明确记录
`secureStartupVerified: false` 和 `nativeWindowResizingVerified: false`。
过时的音频 / 帧预览取消在 IPC 日志中可见；没有未捕获的渲染器异常。为了让
该诊断通过，没有修改生产安全设置。

## 真实 DJI 验收

约 3 分 02 秒的源素材放在前面。两个输入都是 4096x2160，精确帧率
`60000/1001`，合计 17,484 帧。用户选择的个人配乐覆盖整个时间线。

| 字段 | 实测输出 |
| --- | --- |
| 文件 | 用户 Downloads 目录中的本地文件；不随程序分发 |
| 大小 | 985,118,116 字节，严格小于 1,000,000,000 |
| 时长 | 291.6914 秒 |
| 分辨率 | 4096x2160 |
| 帧率 | 60000/1001 |
| 帧与包数量 | 17,484 |
| 视频 / 音频 | HEVC / AAC |
| 编码器 | hevc_nvenc |
| 视频码率预算 | 26,548 kbps |
| 音频结束点 | 291.691 秒 |
| 拼接边界 | 182.6658166667 秒 |
| 边界最大时间戳间隙 | 0.016684 秒，一帧 |
| 时间戳顺序 | 单调 |
| 完整视频与音频解码 | 通过 |
| 校验问题 / 警告 | 无 |
| 处理与验证实际耗时 | 657.031 秒 |

这是一次受大小约束的有损编码，保留了源分辨率和帧率，但不是无损修复，也不
承诺感知完全一致。记录中的导出早于最新的功能修复；那些修复由更新的专项回归
覆盖，而不是宣称做了第二次真实 4K 导出。

## 桌面启动问题记录

记录中的生产模式与软件渲染 Electron 测试在工作台验收之前失败。一个空的
`about:blank` 窗口在没有加载任何媒体时也能复现。基线日志
`test-artifacts/electron-crash-probe/log-managed-baseline-44576.txt` 记录了
渲染器 `launch-failed`、退出码 `49`（Chromium 受限令牌创建失败），以及 GPU
退出 `-1073741515`（`0xC0000135`）和 `ERR_FAILED`。证据把沙箱子进程启动
问题与媒体解码区分开，但没有定位到某个缺失的 DLL。产品保持
`sandbox: true`、`contextIsolation: true` 和 `nodeIntegration: false`。

早前的生产模式失败作为历史保留，且没有通过削弱产品安全设置来解决。之后
的打包版运行（`scripts/test-desktop.ps1 -Packaged`）在 2026-11-08 以生产
沙箱开启的状态通过 17/17 项桌面检查：`mode=electron-packaged`、
`secureStartupVerified=true`、`nativeWindowResizingVerified=true`、
`errors=[]`、`consoleErrors=[]`。每次缩放都断言窗口四条边不在任何显示器
范围内。以后再出现失败，不得通过悄悄改成浏览器托管应用或关闭生产沙箱来
绕过。

新构建的可执行文件早前曾在 Electron 的 `install_dir_access.cc:52` 检查中
失败，退出码 `2147483651`（`0x80000003`）。其诊断说应用目录有 AppContainer
包 SID 条目，但缺少沙箱启动所需的有效 `ALL APPLICATION PACKAGES` 读取
权限。随后一次只读 `Get-Acl` 检查已经显示存在显式的 `ALL APPLICATION
PACKAGES` 读 / 执行条目，但安全重试仍复现同样的致命诊断。受管启动上下文的
有效访问权限仍未解决；仅凭可见 ACL 不能证明已修复。没有添加 ACL 授权、
没有提权、没有使用外部启动绕过，也没有改动生产沙箱。这与更早的空窗口
渲染器退出码 `49` 是不同的两个问题，均如实记录而非隐藏。之后一次独立的
静默安装加屏幕外启动没有复现该失败；按环境性原因（系统负载 / 防病毒时机）
处理，不宣称已定位根因或已证明确实修复。

## 打包验证

6 项包检查验证 Windows PE 可执行文件、必需的 Electron 运行时文件与许可
声明；个人媒体 / 素材库 / 活动状态未进入 ASAR；与当前 main、preload、渲染器
和文档逐字节一致；静态生产安全设置未变；包内原生工具的 SHA-256 一致；以及
由包内可执行文件完成真实的 6 帧 H.264 编码、FFprobe 元数据读取与完整解码。

该验证不启动桌面 UI，并明确记录 `secureStartupVerified: false`。目录包必须
带配套文件一起分发。离线 ZIP 构建包含完整目录，并在发布前检查必需的压缩包
条目，同时生成 SHA-256 校验文件。

安装器执行与便携自解压启动已于 2026-11-08 实际检查：两者都在
`FRAMELAB_TEST=1` 下从屏幕外启动；静默 NSIS 安装到自定义 `/D` 目录并以
退出码 0 结束；卸载以退出码 0 结束，没有残留进程或目录。任何包都不包含
个人配乐。

## 未验证的硬件与模型

当前机器的 NVIDIA 编码路径已在真实 4K 导出中实际使用。Intel QSV、AMD AMF
和 AV1 的可用性在运行时检测，但本报告没有在物理设备上验收。未配置模型的
本地语音识别正确地保持不可用；安装模型后的转写尚未验收。没有可续传编码。
