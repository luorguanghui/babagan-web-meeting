# Cloudflare SFU 分辨率与接收卡顿诊断

## 线上基线和证据

通过用户已打开的 Aliyun Workbench 核对运行中的 Web/API 镜像为 `update-e88a22bdba5792336e62550cd9033e50aeafde69-20261010T135316Z`。实际源码位于 `/opt/babagan-web-meeting/var/releases/update-20261010T135316Z-3791978/source`，该目录 Git HEAD 为 `e88a22bdba5792336e62550cd9033e50aeafde69`。应用根目录的旧 Git HEAD 不是运行中的版本。

修改从包含该发布的本地 `b139882` 创建隔离工作区，二者在 `apps/web` 和 `packages/contracts` 中无基线差异。用户原工作目录的未提交修改保持原样。Cloudflare 页面显示 meet/rtc/turn 记录为 DNS only；本轮未修改 DNS、Worker 或账户配置。

## 原因与判断边界

1. `motion` 的发送选项是 `maintain-framerate`，Cloudflare 发布器原样传给浏览器。因此在编码目标受压时允许降低分辨率。单路、无 simulcast，不存在客户端主动选择 720p SFU 层的逻辑。截图的编码器目标 8 Mbps 是媒体目标；RTC 估值 21.75 Mbps 不是编码预算，也不能推翻此前发生过的瞬时拥塞或量化压力。平均编码耗时低不能证明每一帧都满足截止时间。
2. 接收码率来自 `bytesReceived` 差值，不是已解码帧的码率。收到零散包、重传包或无法继续解码的 H.264 数据时，码率仍可变化，而 `framesReceived`/`framesDecoded` 停止增长。累计丢包 874、NACK 981、freezeCount 111 不能当作当前一秒的丢包率。其他接收端正常可排除公共源完全停发，但不能排除单个观看者的下行丢包、SFU 路径或本机解码问题。
3. 旧 Cloudflare 接收会话只在 PC disconnected/failed 时报告错误，不监测“connected 但有数据、无解码进展”，也不自动恢复已建立的接收连接。此次修复这一恢复缺口；没有取得原卡顿期间的连续原始统计，不能宣称原事件唯一由客户端代码引起。

标准依据：[WebRTC 发送参数](https://www.w3.org/TR/webrtc/)、[WebRTC 统计定义](https://www.w3.org/TR/webrtc-stats/)、[Cloudflare SFU 可观测性](https://developers.cloudflare.com/realtime/sfu/observability/)。

## 修改

- Cloudflare 单路视频发送器设置 `scaleResolutionDownBy=1`、`maintain-resolution`，保留用户的码率上限、帧率和内容提示。UI 明示 Cloudflare 路径在码率预算内优先保持采集分辨率；受压时帧率或细节质量仍可能下降。
- 独立的接收健康采样每秒串行运行。持续新的视频字节到达而 6 秒没有任何新解码帧，或连接持续 disconnected 约 5 秒/failed，请求替换该观看者会话。关闭旧会话完成后再订阅当前 publication；每个 publication 最多自动重建两次，失败保留显式重试入口。协商 HTTP 出错或分配结果不确定时不盲目重试。
- 静态无数据、后台页面、超过 2.5 秒的采样挂起、统计 SSRC/计数器重置均清除判定基线，避免把暂停时间计入持续卡顿。停止和过期回调不会重建连接。
- 接收解码 FPS 优先计算最近帧计数增量；面板新增最近采样的收到包、丢包、NACK/PLI。切换 SSRC 后码率重新建立基线，避免旧会话的字节差影响新会话。

## 验证

- 分辨率策略、持续有数据无解码、持续断连、恢复串行/次数上限、解码统计测试先观察到对应失败，再实现修复。
- 独立审查发现后台定时器挂起边界；新增 60 秒无采样跳跃回归先失败，修复后通过。最终审查无剩余可操作发现。
- 最终 `pnpm test`：62 个文件，876 项测试通过。
- Web 类型检查、全仓 lint、Web 生产构建、`git diff --check` 通过。构建保留现有大 bundle 提示。
- 本机真实 Chromium/WebRTC H.264 编码/解码测试，合成 1920×1080 canvas 高动态内容，生产 `CloudflareScreenSession` 发布逻辑对接本机 offer/answer 接收 PC。无真实 Cloudflare 转发；末段 10 次采样全部保持 1920×1080，编码 FPS 46–53，解码帧数从 34 增长到 674。验证参数与真实编码行为，不验证用户网络、不证明稳定 60fps。
- 本机夹具与原始采样保留在忽略的 `output/playwright/sfu-resolution-probe.html`、`sfu-resolution-probe.json`；截图为同目录 `sfu-resolution-probe.png`。

## 发布状态

本轮尚未替换运行中的服务器服务。修复已准备为只更新 Web 的候选版本，API/媒体服务器/Worker 不需变更；上线仍需用户确认。上线后两端刷新并重新共享，使用原高动态画面检查分辨率、最近解码与接收帧率和最近丢包；未把原设备的卡顿复测标记为完成。
