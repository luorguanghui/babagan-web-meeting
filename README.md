# Babagan 轻量会议系统

面向单个 4–5 人会议的自托管网页应用，仅提供实时语音、单人屏幕共享和电脑声音共享。系统不包含摄像头、聊天、录制、文件传输或其他协作功能。

## 已确认的部署环境

- 阿里云轻量应用服务器，华中 1（武汉）
- Debian 12.10，2 核 CPU、2 GiB 内存、40 GiB 系统盘
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
7. [经确认的总体设计](docs/superpowers/specs/2026-08-07-web-meeting-design.md)
8. [测试驱动实施计划](docs/superpowers/plans/2026-08-07-web-meeting-implementation.md)
9. [初始发布验收状态](docs/acceptance/initial-release.md)
10. [部署记录与安全发布步骤](docs/runbooks/deployment-record.md)
11. [回滚记录与演练步骤](docs/runbooks/rollback-record.md)

## 核心技术决策

- React + TypeScript 构建网页界面。
- Node.js + Fastify 提供会议、权限和 Token API。
- SQLite 保存短期会议元数据，不保存媒体。
- LiveKit 单节点 SFU 转发语音与屏幕轨道，不做服务端转码。
- LiveKit 内置 TURN/UDP 443，RTC/TCP 7881 作为 UDP 不可用时的回退。
- Caddy 负责 HTTPS、证书续期和反向代理。
- Docker Compose 统一部署和管理进程。

## 生产发布

生产发布只允许在目标 Debian 12 主机上执行。`scripts/deploy.sh` 会进行严格预检、
可恢复的 SQLite 备份、构建、迁移、健康检查和 HTTPS/WSS 冒烟测试；
`scripts/rollback.sh` 只允许按已记录的前一版本镜像和预发布备份回滚。
两者均要求受保护的 secrets、显式 SHA 确认以及 Cloudflare/防火墙人工证据，且不删除旧镜像或备份。
完整步骤与当前未完成的验收项见[部署记录](docs/runbooks/deployment-record.md)。

## 项目边界

首版只验收 Windows 10/11 最新版 Chrome 和 Edge。手机浏览器可作为语音与观看端，但不作为屏幕共享端；macOS、Firefox、Safari 不属于首版兼容范围。
