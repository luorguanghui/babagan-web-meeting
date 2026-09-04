# Babagan 轻量会议系统

面向单个 4–5 人会议的自托管网页应用，仅提供实时语音、单人屏幕共享和电脑声音共享。系统不包含摄像头、聊天、录制、文件传输或其他协作功能。

## 已确认的部署环境

- 阿里云轻量应用服务器，华中 1（武汉）
- Debian 12.10 或 Debian 13.x，2 核 CPU、2 GiB 内存、40 GiB 系统盘
- 峰值公网带宽 200 Mbps，无固定月流量额度
- 域名：`babagan.cloud`
- `meet.babagan.cloud`：Cloudflare 橙云，用于网页和 API
- `rtc.babagan.cloud`：DNS only，用于 LiveKit HTTPS/WSS 信令
- `turn.babagan.cloud`：DNS only，用于 TURN/UDP

## 文档索引

1. [产品需求规格](docs/01-product-requirements.md)
2. [技术架构](docs/02-technical-architecture.md)
3. [实现规格](docs/03-implementation-specification.md)
4. [部署与运维](docs/04-deployment-and-operations.md)
5. [测试与验收](docs/05-test-and-acceptance.md)
6. [安全与隐私](docs/06-security-and-privacy.md)
7. [P2P 屏幕共享混合模式设计](docs/07-p2p-screen-share-design.md)
8. [经确认的总体设计](docs/superpowers/specs/2026-08-07-web-meeting-design.md)
9. [经确认的 P2P 混合模式设计](docs/superpowers/specs/2026-08-11-p2p-screen-share-hybrid.md)
10. [测试驱动实施计划](docs/superpowers/plans/2026-08-07-web-meeting-implementation.md)
11. [P2P 混合模式实施计划](docs/superpowers/plans/2026-08-11-p2p-hybrid-implementation.md)

部署操作从 [部署与运维](docs/04-deployment-and-operations.md) 开始：其中分别说明已有服务器更新和 Debian 12/13 空白服务器首次部署；[部署证据记录](docs/runbooks/deployment-record.md) 与 [回滚记录](docs/runbooks/rollback-record.md) 用于保存目标服务器证据和受保护恢复记录。

## 核心技术决策

- React + TypeScript 构建网页界面。
- Node.js + Fastify 提供会议、权限、Token API 与 P2P 信令（WebSocket）。
- SQLite 保存短期会议元数据，不保存媒体。
- 麦克风语音经 LiveKit 单节点 SFU 转发；屏幕共享（视频 + 音频）优先浏览器间 P2P 直连，无法直连时经 coturn 或 Cloudflare TURN 中继。初始协商彻底失败或已建立的直连失效时可回退 LiveKit；已确认的 TURN relay 不会自动切换 SFU，但观看者仍可手动选择 SFU。
- P2P 屏幕共享使用可切换的 TURN provider：共享者在每次开始共享前可选“自动 / 服务器 coturn / Cloudflare TURN”，该选择保存在当前浏览器的 `babagan.screen-turn-provider`，并只作用于下一次共享。
- API 默认保留 coturn（3478/UDP+TCP、5349/TLS、49160–49200/UDP 中继端口池），也支持服务端调用 Cloudflare Realtime TURN 生成短期凭据；`/api/v1/meetings/:slug/ice-servers` 会返回 `availableTurnProviders`、本次实际 `turnProvider` 和到期时间，Cloudflare 暂时不可用时回退 coturn。
- 共享者发给观看者的 P2P `offer` 会携带实际 `turnProvider` metadata；观看者会据此重新拉取匹配 provider 的 ICE 配置，保证同一轮共享双方使用同一 provider。旧的无 metadata `offer` 仍按 coturn 兼容处理。
- LiveKit 内置 TURN/UDP 443 与 RTC/TCP 7881 作为语音与回退屏幕的媒体兜底。
- Caddy 负责 HTTPS、证书续期和反向代理。
- Docker Compose 统一部署和管理进程。

## 项目边界

首版只验收 Windows 10/11 最新版 Chrome 和 Edge。手机浏览器可作为语音与观看端，但不作为屏幕共享端；macOS、Firefox、Safari 不属于首版兼容范围。
