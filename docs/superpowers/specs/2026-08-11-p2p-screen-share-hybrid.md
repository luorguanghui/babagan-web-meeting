# P2P 屏幕共享混合模式设计

日期：2026-08-11
状态：已确认（在 2026-08-07 总体设计基础上增补，替代其"屏幕媒体全部经 LiveKit SFU 转发"的决策）

## 背景

生产环境的屏幕共享经 LiveKit SFU 云端转发，云端为阿里云武汉轻量服务器（2 核 2 GiB、200 Mbps 峰值带宽、无 SLA）。实际运行中**云端带宽波动导致接收方画面不稳定**。一台共享者设备曾在家庭公网 IPv4（已脱敏，湖北移动）环境测得 1 Gbps 有线链路和约 100 Mbps 稳定上行；该测量仅证明此环境可直连，不作为所有共享者的通用上行保证。

## 决策

**混合模式**：麦克风音频保持 LiveKit SFU（5 人全部音频经云端仅约 1 Mbps）；屏幕共享（视频 + 音频）优先浏览器间 P2P 直连（1:N 星型），直连失败自动回退 LiveKit SFU，任何观看者体验不劣于现状。

## 架构

- 云端 Fastify 新增 P2P 信令 WebSocket（`wss://meet.babagan.cloud/api/v1/meetings/:slug/p2p`，复用 `/api` 反代，不新增端口），只做鉴权、在线名单与 SDP/ICE 转发，零媒体可见性。
- ICE 配置经 `GET /api/v1/meetings/:slug/ice-servers` 获取；当前 LiveKit Server v1.11.0 不提供可复用的通用 ICE 凭据接口，服务端返回启动时校验的 `P2P_STUN_URLS`。
- 共享者对每名观看者各建一条 `RTCPeerConnection`，同一连接发布屏幕视频 + 屏幕音频（音画同步硬约束）。
- 共享者先发布并全程保留 LiveKit 屏幕安全网，再启动 P2P。观看者确认直连 RTP 与解码帧后发送 `media-ready`，渲染 P2P 首帧后取消本地 LiveKit 订阅；协商超时 8 秒、ICE failed 或 RTP 5 秒无进展时重新订阅 LiveKit，保留旧源至新源首帧。
- P2P 码率档位 5/8/10 Mbps（默认 8），按在线观看人数联动建议；SFU 回退档位 10/13/15 Mbps 不变。

## 权限与安全

- 信令握手同时校验参与者安全 Cookie 与同源 `Origin`；服务端强制"仅共享者发 offer、应答与 `media-ready` 仅能回共享者"。
- P2P 直连媒体 DTLS-SRTP 加密，云端对直连媒体零可见性（隐私优于 SFU）；对端可见彼此直连 IP 属 WebRTC 固有特征，UI 与文档说明。
- SDP、ICE 候选与凭据不落日志；消息 64 KiB 上限与速率限制。

## 质量目标

- 直连可用时，云端带宽波动不影响接收画面；共享建立 3 秒内开始协商，回退切换画面中断 ≤2 秒。
- 每条 P2P 连接独立拥塞控制，观看者弱网仅该路降码率，不连坐。
- 直连成功且取消 LiveKit 订阅的现代观看者不再消耗对应云端屏幕下行；实际降幅取决于旧客户端、协商中和回退观看者数量，不预设固定峰值。

## 运行边界

- 单会议 ≤5 人、一个共享者；手机端可观看、不验收共享；不承诺对 CGNAT 且无 IPv6 观看者的直连。
- 客户端代理/TUN 软件（如 Mihomo）可能劫持媒体 UDP，需直连规则或临时关闭。

## 关联文档

详细设计 `docs/07-p2p-screen-share-design.md`；实现规格、测试、安全、部署变更见 `docs/03`–`docs/06` 相应更新；实施计划 `docs/superpowers/plans/2026-08-11-p2p-hybrid-implementation.md`。
