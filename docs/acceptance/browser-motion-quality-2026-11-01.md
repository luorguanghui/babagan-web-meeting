# Edge 浏览器编码：60fps 采集与运动画质调查

日期：2026-11-01。用户场景为 Edge、整屏、P2P、最高码率 8 Mbps。

## 结论与交付范围

本次改善 P2P 的 H.264 协商和可用码率余量，没有解决浏览器整屏采集稳定输出真实 60fps 的问题，也不承诺复杂运动没有压缩色块。已于 2026-11-01 部署，详见下方发布记录。

- 显式选择 H.264 时，优先浏览器已声明的 High／Constrained High、packetization-mode 1。保留所有 Baseline、Main、其他编码与修复格式作为协商回退，不修改或伪造 profile-level-id。自动编码和 VP8 的排序不变。
- 新增 15／20 Mbps 可选上限，默认仍为 8 Mbps。总预算仍为 40 Mbps；20 Mbps 档位下四个观看者各限 10 Mbps，回到一个观看者时恢复 20 Mbps 上限。WASM 共用档位的预算回归也覆盖新增值。
- 保留已有 min/ideal/max=60 采集请求、contentHint=motion、原始宽高比和直连 1080p 保护。没有增加重复帧、绕过拥塞控制或设定强制最低码率。

## 原因

“请求 60fps”与“实际采到 60fps”是两件事。项目已有 [2026-10-10 采集调查](native-capture-cadence-2026-10-10.md)：编码前 VideoFrame 读取约 32fps，增加 minimum 请求后改善到 51–53fps。对应修复在本次开始前已存在，不能再当成本次的新修复。

本次真实 monitor 轨道报告配置 1920×1080、60fps，但实际采集多在 54–57fps，编码大致跟随采集，NVIDIA H.264 编码耗时约 5ms。此轮桌面内容未固定，不能与合成纹理的编码性能直接比较；它只佐证配置帧率不等于实际供帧。

[Chromium 桌面采集实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/capture/desktop_capture_device.cc) 根据采集耗时及独立 CPU 预算安排下一帧，默认预算为单核的 50%。这是可能的机制依据，不是本机已剖析确认的具体瓶颈。网页不能通过 RTCRtpSender 设置取消这项原生采集预算；编码器有余量也无法恢复没有采集到的帧。

8 Mbps 是上限，不是恒定目标。可重复的本机合成场景中，首次大幅运动会出现目标码率下降、QP 升高、输入帧率正常而编码输出掉帧；限制原因仍可能为 `none`，且无接收丢包。WebRTC 的 [编码码率调整器](https://webrtc.googlesource.com/src/+/refs/heads/main/video/encoder_bitrate_adjuster.cc) 会根据编码超量调整实际分配，另有网络拥塞控制。公开 stats 足以排除“仅因编码耗时超过帧预算”的解释，但不能精确归因于内部某一个控制器。

## 可重复编码对照

Edge 156.0.4314.50，真实 H.264 编解码，本机 host-to-host P2P；1920×1080、固定种子的 16px 彩色纹理平移。每轮新连接，静止 8 秒、运动 15 秒、静止 8 秒、再次运动 15 秒。canvas 输入的实际 media-source 帧率约 54–55fps。使用生产采集控制器（替换输入为 canvas）和生产 P2P 控制器，未模拟 RTP stats。

最终三组有效数据独立顺序运行，没有同时进行编译或自动化测试；Baseline 复核只在诊断夹具中恢复浏览器原先的 Baseline 优先顺序，High 两组直接使用最终生产代码。

| 配置 | 首次运动平均编码 fps | 再次运动平均编码 fps | 再次运动实际 Mbps | 再次运动平均 QP | 输出 |
| --- | ---: | ---: | ---: | ---: | --- |
| Baseline，8 Mbps，复核 | 43.81 | 50.20 | 8.29 | 42.55 | 1920×1080 |
| 最终代码 High，8 Mbps | 50.00 | 51.47 | 8.25 | 39.86 | 1920×1080 |
| 最终代码 High，20 Mbps | 41.40 | 51.87 | 16.73 | 33.94 | 1920×1080 |

High 的实际 `codecId` 对应 `profile-level-id=64001f`，Baseline 复核为 `42001f`。QP 来自每个采样区间的 ΔqpSum/ΔframesEncoded，是量化强度指标，不是像素误差或主观画质评分。瞬时实际码率可能超过上限，RTP 码率控制并非逐秒硬限速。

首次 20 Mbps 运行并未优于 8 Mbps：提高上限不会消除初始带宽爬升或所有突变掉帧；高档位主要为链路稳定后的复杂画面提供更多细节预算。早期原始排序的首次运动均值约 39.93fps，复核为 43.81fps，说明单次测量有波动，不把某个增幅当作普遍保证。

另以真实 PeerConnection 将接收端限制为 Constrained Baseline（`42e01f`），最终发送代码成功协商并产生接收解码输出；该验证仅证明本机格式回退可用，不代表旧浏览器、其他设备的性能验收。

“直接改用 maintain-framerate”的候选被否决：虽缓解掉帧，但浏览器继续降至 480×270，不能满足清晰度要求。这项实验及其代码、测试改动已经撤回，未进入最终实现。

采样数据（已移除采集设备标识）：[browser-motion-quality-2026-11-01.json](assets/browser-motion-quality-2026-11-01.json)。只保留最终有效对照、格式回退及桌面供帧记录；没有将被热更新打断的运行计入结果。诊断夹具保存在本地 `output/playwright/motion-nov.html` 和 `output/playwright/probe-motion-nov.mjs`，不进入产品构建。可从仓库根目录运行：

```powershell
pnpm --filter @meeting/web exec vite ../.. --host 127.0.0.1 --port 5173 --strictPort
# 另一个终端，按顺序执行，测试期间不要编辑源码：
node output/playwright/probe-motion-nov.mjs baseline-repeat
node output/playwright/probe-motion-nov.mjs final8
node output/playwright/probe-motion-nov.mjs final20
node output/playwright/probe-motion-nov.mjs fallback
```

`desktop` 诊断会启动独立可见 Edge 并自动选择整屏，只用于本机供帧观察；其他上述模式为合成输入，不需要屏幕授权。它们都仅通过本机 PeerConnection 传输。

## 使用与后续验收

自动化验证：全量 73 文件、963 项测试通过；contracts 构建、Web 类型检查与生产构建通过；修改的六个 TypeScript 文件 ESLint 通过，`git diff --check` 通过。生产构建保留既有的大 chunk 提示。独立静态审查无阻断问题。

更新网页后重新开始共享，以重新协商编码。先保持动态档及 8 Mbps 对照；一至两名观看者且真实上行充足时，可试 15／20 Mbps，观察编码器目标和实际码率，不能只看设置值。若实际采集仍只有约 50fps，继续修改编码声明不能解决采集源问题；严格的真实 1080p60 需求需要另行验证浏览器原生采集后端或设计原生采集通道。

本机合成回归不等同于用户两端真实网络验收。尚需以用户的实际运动内容记录采集、编码、发送、接收及解码帧率；本次未宣称整屏 60fps 或所有色块已解决。

## 服务器发布记录

2026-11-01 17:01（香港时间）开始网页增量发布，提交 `146b0f1b7c5fb0e4f382517c089e2dd2876112f9`，基于服务器原版本 `26ad7620f48bfa96dacf981f502bd5e73aed144f`，保留其迁移和 API 修复。

服务器可用内存约 900 MiB，低于源码构建门槛，因此采用已在本地构建验收的静态产物。上传包 SHA-256 为 `ab66e2b750de36f37c22fc98f517f3141d02efc2625c97b663723c6d09d7353a`；服务器逐项核对 38 个产物及构建输入的 Git 对象，随后基于原运行网页镜像生成新版运行镜像，没有在服务器编译 Node 项目，也未修改常规更新器门槛。

此次仅替换 web，旧网页实例已停止；API、Caddy、LiveKit、coturn 容器身份保持不变。数据库已备份，旧镜像保留。五个服务 healthy，公网 JS 哈希、WASM 隔离头及编码资源、RTC WebSocket、Cloudflare SFU 冒烟检查通过，pending 已归档。

- 发布记录：`/opt/babagan-web-meeting/var/releases/update-20261101T090142Z-motion-prebuilt/release.json`
- 回滚脚本：同目录 `rollback.sh`，使用旧镜像不可变 ID。
- 公网资源：`/assets/index-Cn5seZPk.js`，SHA-256 `5ea57a031122011195aa77da3ad264acef412bb8139ce78a9280c3f01563d0f6`。
- 发布源码已通过校验后的增量 Git bundle 取回本地，保存在分支 `codex/motion-quality-20261101`；主工作树未切换，未推送 GitHub。后续发布需基于包含该提交的历史，不能直接从旧 main 覆盖线上版本。
- 共享端和观看端均需刷新网页并重新开始共享，才能使用新协商策略。浏览器端真实帧率和画质仍需用户场景验收。
