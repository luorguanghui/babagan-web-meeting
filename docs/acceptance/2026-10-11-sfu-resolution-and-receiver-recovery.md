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

- 用户最终要求保留 `maintain-framerate`。Cloudflare 发送器沿用所选画质档的 `degradationPreference`，撤回候选版本中的强制 `maintain-resolution` 和 `scaleResolutionDownBy=1`，恢复原 UI 提示。标准/动态档仍允许浏览器为保持帧率自适应降低分辨率；detail60/flow 档仍按各自选项工作。
- 独立的接收健康采样每秒串行运行。持续新的视频字节到达而 6 秒没有任何新解码帧，或连接持续 disconnected 约 5 秒/failed，请求替换该观看者会话。关闭旧会话完成后再订阅当前 publication；每个 publication 最多自动重建两次，失败保留显式重试入口。协商 HTTP 出错或分配结果不确定时不盲目重试。
- 静态无数据、后台页面、超过 2.5 秒的采样挂起、统计 SSRC/计数器重置均清除判定基线，避免把暂停时间计入持续卡顿。停止和过期回调不会重建连接。
- 接收解码 FPS 优先计算最近帧计数增量；面板新增最近采样的收到包、丢包、NACK/PLI。切换 SSRC 后码率重新建立基线，避免旧会话的字节差影响新会话。

## 验证

- 分辨率策略、持续有数据无解码、持续断连、恢复串行/次数上限、解码统计测试先观察到对应失败，再实现修复。
- 独立审查发现后台定时器挂起边界；新增 60 秒无采样跳跃回归先失败，修复后通过。最终审查无剩余可操作发现。
- 最终 `pnpm test`：62 个文件，877 项测试通过，包含保留两种所选发送策略的回归。
- Web 类型检查、全仓 lint、Web 生产构建、`git diff --check` 通过。构建保留现有大 bundle 提示。
- 初始候选版本的本机真实 Chromium/WebRTC H.264 编码/解码测试采用强制分辨率保护，末段 10 次采样全部保持 1920×1080，编码 FPS 46–53，解码帧数从 34 增长到 674。它仅验证本机参数与真实编码行为。用户后续撤回此策略，因此该结果不是最终 `maintain-framerate` 版本的分辨率保持承诺。
- 本机夹具与原始采样保留在忽略的 `output/playwright/sfu-resolution-probe.html`、`sfu-resolution-probe.json`；截图为同目录 `sfu-resolution-probe.png`。

## 发布状态

用户已授权保留 `maintain-framerate`、部署其余恢复与统计修复。最终候选只更新 Web，API/媒体服务器/Worker 不需变更。发布后两端刷新并重新共享，使用原高动态画面检查最近解码与接收帧率和最近丢包；原设备的卡顿复测另行验收。

### 2026-10-11 最终上线

- 应用提交：`b162c78a242d5111cb9d60cebdc31bc22b802219`，2026-10-11 01:21:20 香港时间完成验证。
- 发布目录：`/opt/babagan-web-meeting/var/releases/update-20261010T172004Z-3846242`；`current-update.json` 状态为 `deployed-and-verified`，`services=["web"]`。
- 公网脚本 `/assets/index-BcATFqDB.js` 的 SHA-256：`a8d3fbbe372f6d542701af86b1af9245915b354bf5794c5a4d7d0776d0dfc108`。发布脚本核对其与运行容器一致，另从本机独立下载公网脚本确认相同摘要及新增接收恢复代码。服务器 Docker 构建产物与本机 Windows 构建的文件名/摘要不同，发布身份以服务器源码提交、运行容器与公网匹配为依据。
- 五个服务健康；API、Caddy、LiveKit、coturn 容器 ID 与部署前一致，仅 Web 更新。无 `update-pending.json`，Cloudflare SFU API 冒烟验证为 true；公网网页与 `/health/ready` 均返回 200。
- 运行版本源码仍是 `parameters.degradationPreference = options.degradationPreference`，标准/动态档保持 `maintain-framerate`。
- 数据库备份、旧镜像及回滚脚本已保留。回滚脚本为发布目录下 `rollback.sh`。部署日志：`/opt/babagan-web-meeting/var/releases/sfu-receiver-recovery-20261011.log`。
- 本地截图证据：`output/sfu-release/deployment-proof.png`。未将用户设备的实际卡顿复测标记为已通过。
