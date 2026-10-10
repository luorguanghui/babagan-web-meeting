# Babagan 轻量会议系统

面向单个 4–5 人会议的自托管网页应用，仅提供实时语音、单人屏幕共享和电脑声音共享。系统不包含摄像头、聊天、录制、文件传输或其他协作功能。

屏幕共享默认使用浏览器编码（默认 H.264）；P2P 路径保留手动 WASM 编码。共享者也可选择 Cloudflare SFU，只上行一份屏幕视频／电脑声音，所有观看者从 SFU 订阅。新增“细节”1080p60/detail档，60fps档选定源后明确请求60fps采集，不保证所有负载下实际达到60fps。

## 已确认的部署环境

- 阿里云轻量应用服务器，华中 1（武汉）
- Debian 12.10 或 Debian 13.x，2 核 CPU、2 GiB 内存、40 GiB 系统盘
- 峰值公网带宽 200 Mbps，无固定月流量额度
- 域名：`babagan.cloud`
- `meet.babagan.cloud`：DNS only，HTTPS/WSS 直连 Caddy，用于网页、API 和 P2P 信令
- `rtc.babagan.cloud`：DNS only，用于 LiveKit HTTPS/WSS 信令
- `turn.babagan.cloud`：DNS only，用于 TURN/UDP

## 已有服务器一键更新

服务器已安装应用时，使用新的增量更新入口；默认从 GitHub `main` 更新 API 和网页，沿用实际运行中的 Compose 配置：

~~~bash
sudo bash scripts/update.sh --app-dir /opt/babagan-web-meeting
~~~

只更新网页可追加 `--web-only`；固定已审查的版本可追加 `--commit <完整 SHA>`。旧服务器还没有此脚本时，先按 [部署指南 §4](docs/04-deployment-and-operations.md#4-已有服务器一键更新) 的首次安装命令获取更新器。脚本检查活动会议、在线备份数据库、构建独立候选、执行鉴权冒烟并记录回滚入口，保留主工作树和现有媒体服务。

[高动态共享修复与上线记录](docs/acceptance/motion-content-hint-investigation-2026-10-09.md)：标准／动态模式在发布前使用 `motion` 内容提示，分辨率优先模式保留 `detail`；新增实际采集、编码、发送和接收统计。真实设备是否稳定达到 60 fps 仍需实际会话验收。

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
- 麦克风语音经 LiveKit 单节点 SFU 转发；屏幕共享默认P2P直连，无法直连时经服务器coturn中继；观看者仍可显式选择LiveKit SFU。
- Cloudflare SFU由共享者在共享前选择，最多四名观看者订阅同一份视频与电脑声音，发布端不再逐观看者编码。失败明确显示，不自动建立P2P／LiveKit屏幕副本。
- TURN 中继固定使用服务器 coturn，无需选择提供方。停止共享期间显示“正在停止共享”，旧发布和共享权限释放完成后才能再次开始；不同观看者的 SFU 协商独立进行。
- 项目移除Cloudflare TURN凭据生成、选择器与探测控制。API保留coturn（3478/UDP+TCP、5349/TLS、49160–49200/UDP中继端口池）；旧Cloudflare TURN偏好回退自动/coturn。
- Cloudflare SFU配置`CLOUDFLARE_SFU_APP_ID`和`CLOUDFLARE_SFU_APP_SECRET`，秘密仅后端读取；鉴权和会话请求直连Cloudflare，不使用代理。未配置时入口说明不可用。
- 共享者发给观看者的 P2P `offer` 会携带实际 `turnProvider` metadata；观看者会据此重新拉取匹配 provider 的 ICE 配置，保证同一轮共享双方使用同一 provider。旧的无 metadata `offer` 仍按 coturn 兼容处理。
- LiveKit 内置 TURN/UDP 443 与 RTC/TCP 7881 作为语音与回退屏幕的媒体兜底。
- Caddy 负责 HTTPS、证书续期和反向代理。
- Docker Compose 统一部署和管理进程。

## 项目边界

首版只验收 Windows 10/11 最新版 Chrome 和 Edge。手机浏览器可作为语音与观看端，但不作为屏幕共享端；macOS、Firefox、Safari 不属于首版兼容范围。
