# Babagan 高质量共享发送端

观看者直接使用普通会议网页，无需安装。只有发送屏幕画面的电脑需要本机组件。

## 安装与启动

1. 打开 `https://meet.babagan.cloud/native`，下载 Windows 安装器。
2. 点击“安装并创建快捷方式”。安装器先检查 Babagan 已安装版本和系统 PATH。兼容的 Node.js 24、支持 ddagrab dup_frames 的 FFmpeg 直接复用；仅缺失或不兼容的依赖从 Babagan 服务器下载固定版本 Node.js 24.15.0、FFmpeg 9.0.2，并验证 SHA-256。无需安装 pnpm、PowerShell 7，也不修改全局 PATH 或系统 FFmpeg。
3. 双击桌面“Babagan 高质量共享”，在专用 Edge 窗口内创建或加入会议。
4. 选择“本机原生采集”“动态 1080p60”“自动”编码，在浏览器选择器中选中唯一的整个屏幕。电脑声音仍通过浏览器授权。
5. 网页停止共享、浏览器停止共享或离开会议都会停止采集。托盘菜单可打开会议、查看诊断日志、退出本机组件。

适用于 Windows 10 / 11 x64、已安装 Edge、一个活动显示器。DXGI 是 Windows 自带接口，安装器不安装显卡驱动。不支持的显示器布局仍可选择“浏览器采集”。第一次使用按 Edge 的正常提示选择本机网络与屏幕权限；安装器不关闭浏览器或系统安全功能。

默认每名观看者最高 10 Mbps。手动选择会保存，停止再共享、换画质、增减观看者、网络变好均不会自动提高所选上限。P2P／TURN 每名观看者分别占用上行，多路总和仍受既有 40 Mbps 预算限制；LiveKit 回退不会越过所选上限，Cloudflare SFU 只上传一路。音频、协议开销、重传和瞬时关键帧峰值不等同于视频编码器目标码率。

自动编码优先采用硬件 AV1；不具备该能力时保留 H.264 回退。相同码率下不同编码格式的动态清晰度可能不同，不能把 AV1 的实测结果视为 H.264 或 VP8 的保证。

## 中断恢复和诊断

组件识别 DXGI 访问丢失、设备重置、桌面访问暂时拒绝及显示输出参数变化，在原授权和原共享流内重建采集。最多 8 次、每次恢复窗口最多 20 秒；每次重新核对显示器布局。保留原来的画面尺寸，必要时等比缩放并留边。停止共享、授权轨道结束或显示器布局不支持时不继续重试。

如果仍退出共享，托盘“查看诊断日志”打开 `%LOCALAPPDATA%/Babagan/NativeShare/logs`。日志只记录启动、恢复、退出等事件，不记录画面或连接令牌。浏览器授权轨道本身结束时，仍然尊重浏览器停止行为，不会绕过授权继续采集。

无新画面时最多每秒一次保活，单独计为 refreshFrames，不作为真实采集帧或运动 60fps。

## 文件位置与更新

安装目录：`%LOCALAPPDATA%/Babagan/NativeShare`；专用 Edge 配置：`%LOCALAPPDATA%/Babagan/MeetingEdge`。日常 Edge 配置与默认浏览器不变。启动器运行时在托盘显示；后台采集组件空闲 30 分钟自动退出。

更新时先停止共享、退出托盘组件，再运行新版安装器。安装器将新版放在独立版本目录，最后更新桌面和开始菜单快捷方式。旧版本目录保留，已安装依赖直接复用，不重复下载或解压。下载新增的依赖存放在 NativeShare/runtime，共享给后续版本；归档按校验值缓存。runtime.json 保存实际使用的依赖路径。

旧开发脚本仍供开发者使用，需要自行提供 Node.js、兼容 FFmpeg 和 PowerShell 7；成员应使用网页安装器和桌面快捷方式。

## 构建和发布

Windows 构建机运行 `pwsh -File scripts/build-native-installer.ps1`，再运行 `node scripts/prepare-native-download.mjs`。准备脚本验证安装器与两份运行依赖的固定 SHA-256，生成网页静态下载资源。随后构建网页并按网页发布流程部署；API、音视频服务器无需变更。依赖清单、来源、许可证和原始归档一并保留在下载目录。

当前安装器尚未使用受信任的发布者数字签名。Windows 下载后首次运行可能显示 SmartScreen 提示，请核对本站来源和 SHA-256 后自行判断。图标与产品名不能替代代码签名，自签名证书也不能让其它电脑自动信任。

## 导出一次断流诊断（待发布的本地实现）

此功能需要包含故障时间线改动的网页和本机组件；当前线上安装器尚未因本次工作更新。

1. 使用本机原生采集发起一次共享。发生中断后，先不要再次共享或刷新页面，也不要退出本机组件。
2. 打开会议的共享设置，点击“导出上一次原生共享诊断”。即使已经回到未共享状态，这个入口仍可使用。
3. 浏览器下载 `babagan-native-diagnostic.json`。这是本地下载，不会自动上传或发给他人。需要反馈时自行附上文件，并另外说明当时进行了什么操作。
4. 文件中的 `helperStatus=available` 表示已取回同一次辅助进程采集的时间线。`not-correlated` 表示没有拿到辅助进程的诊断编号（可能是旧版组件、请求尚未返回或选择阶段失败）；`unavailable` 表示组件已退出、记录过期/被淘汰或无法访问/读取；`invalid` 表示已解析的响应不符合诊断结构；`no-attempt` 表示当前页面尚未发起原生共享。缺失不表示辅助进程没有发生故障。

诊断以一次共享尝试为单位，可能包含连续故障及恢复。浏览器只保留当前页面最近一次原生共享尝试，下一次原生共享会替换记录，刷新会丢失记录。本机组件最多保留四次尝试，每条时间线最多 256 个事件，已结束的记录在最后事件后最多保留 30 分钟（访问时清理）；活动尝试不会因安静超过 30 分钟被清除。记录只在内存，组件退出后无法从此接口恢复。旧托盘日志仍可在 `%LOCALAPPDATA%/Babagan/NativeShare/logs` 查看。

每份时间线有独立 `id`、UTC `startedAt`、单调时钟相对毫秒 `elapsedMs`、序号 `seq` 和丢弃旧事件计数 `dropped`。浏览器先向本机组件发起最多 750 毫秒的授权能力确认；新版组件接受浏览器生成的诊断编号，因此首帧前超时或取消也能关联。未确认能力时保留旧版 start 请求格式，若画面 HTTP 响应含有效诊断编号则以其关联。浏览器与 helper 的 `id` 可能相同或不同，不按“最后一条”猜配。`dropped > 0` 表示前段记录已截断。两个进程的起点不同，墙钟可能调整，不能把它们的毫秒值直接比较或据此断言因果。连接编号仅在该次尝试内计数，不是成员身份。

导出只含白名单事件、固定错误码、进程退出码/信号、恢复次数、显示器数量、屏幕尺寸/DPR观察和连接状态。不含画面、音频、原始 stderr/异常文本、路径、窗口标题、设备名称、会议/成员标识、令牌、URL、IP、SDP 或 ICE 信息。导出响应最多 128 KiB，组件请求最多等待 2 秒，失败时仍可下载浏览器部分。不会记录逐帧事件，也不会扩大自动恢复范围。

### 如何区分故障

| 观察顺序/字段 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| `process_exit`，`expectedStop=false`，非零 `exitCode` 或 `signal` | 采集子进程非预期结束 | 无已知 DXGI 证据时不能归因为显示变化 |
| `capture_error/capture_access_lost`，`evidence` 为 `access_lost/device_removed/device_reset/access_denied/output_changed` | 匹配到对应的固定 FFmpeg/DXGI 特征，允许现有有界恢复 | 不证明某个应用/游戏导致，`access_denied` 也不等同于浏览器撤销权限 |
| `recovering → starting → first_frame → resumed` | 重试产生新帧，同一共享流继续 | 不保证真实游戏、所有显示模式或每秒恒定 60fps |
| `failed`，`capture_recovery_timeout` 或 `capture_recovery_exhausted` | 恢复窗口/次数耗尽 | 后续 `stopped` 是清理，不能解释成用户主动停止 |
| `display_check` 的数量不是 1，或 `UNSUPPORTED_SOURCE` | 本机布局验证不通过 | 不能确定显示器为何变化；数量不是完整拓扑 |
| `permission_ended → track_ended → share_track_ended/share_stop` | 浏览器授权哨兵先结束，必须停止采集 | 浏览器没有提供结束原因，不能区分点击浏览器停止、授权撤销、来源消失等 |
| `user_stop/leave/page_cleanup → share_stop/track_stop` | 网页操作或页面清理先发起停止 | 单独 `track_stop` 只是程序调用，不能一律解释为用户点击 |
| `native_error/native_closed`，helper 无记录 | 本地流/组件不可用 | 单靠网页不能区分本机服务崩溃、请求被阻断和进程退出 |
| `delivery_failed/protocol_error` | 浏览器帧写入或协议解析路径失败 | 不是 DXGI 错误证明 |
| `webrtc_state` 的 `failed/disconnected`，随后 `webrtc_fallback` | 发送连接问题及回退动作；`stateKind` 区分 ICE/connection，`transport` 区分 P2P/Cloudflare | 不是本地采集停止证明；LiveKit 的 `meeting_state` 是会议连接概况，不是私有媒体 PC 细节 |
| `completed/capture_eof`，退出码 0 | 源自行结束（常见于有限合成源） | 仍不等于用户正常停止共享 |

`native_open` 仅表示浏览器本地通道开始请求，`native_ready` 才表示首帧交付。`permission_denied` 表示选择请求返回 NotAllowedError，可能包括用户取消，不能推断永久撤权。

`display_observation` 只是浏览器在开始、窗口 resize、方向 change 时观察到的屏幕尺寸/DPR变化；窗口 resize 而屏幕参数不变不会重复记录。它不是 Windows WM_DISPLAYCHANGE、HDR、刷新率、显卡驱动或 DXGI 的完整通知。

### 尚需真实 Windows 验证

在用户愿意复现时，分别收集普通应用启动、窗口/无边框/独占全屏切换、分辨率/缩放/刷新率/HDR切换、显示器插拔、锁屏/UAC安全桌面和驱动重置的诊断。保留浏览器停止按钮、网页停止按钮、会议离开三个正常对照组。多显示器应被当前单屏约束拒绝，不能绕过授权继续采集。

本次自动化只使用隔离的 Node 子进程、合成视频、loopback HTTP 和模拟浏览器轨道/连接，没有启动真实游戏、共享用户桌面或操作生产服务。尚未证明真实 Windows 场景恢复，也未重新测量 1080p60 吞吐。没有新增运行中“无帧但进程尚活着”的 watchdog；整页/组件同时崩溃时内存时间线可能丢失，仍需结合已有启动器日志及用户复现描述。
