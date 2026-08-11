# 部署与运维

## 1. 目标环境

| 项目 | 当前配置 |
|---|---|
| 云平台 | 阿里云轻量应用服务器 |
| 地域 | 华中 1（武汉） |
| 操作系统 | Debian 12.10 |
| 计算 | 2 核 CPU、2 GiB 内存 |
| 存储 | 40 GiB 系统盘 |
| 网络 | 200 Mbps 峰值公网带宽，无固定月流量额度 |
| 域名 | `babagan.cloud` |

服务器公网 IP 只在 DNS 和部署环境配置中维护，不写入应用源码、镜像或公开日志。

## 2. DNS 和 TLS

Cloudflare 当前应保持：

| 记录 | 类型 | 代理 | 目标 |
|---|---|---|---|
| `meet.babagan.cloud` | A | Proxied | 服务器公网 IP |
| `rtc.babagan.cloud` | A | DNS only | 服务器公网 IP |
| `turn.babagan.cloud` | A | DNS only | 服务器公网 IP |

Cloudflare SSL/TLS 设置为 Full (strict)。`meet` 的浏览器侧证书由 Cloudflare Universal SSL 提供；源站和所有灰云主机使用公众信任的 ACME 证书。Caddy 必须能续期 `meet`、`rtc`，并为需要证书的直接服务保留证书文件。

证书申请期间若橙云影响 ACME 验证，使用 DNS-01 挑战或临时将目标记录切换为 DNS only；切换行为必须纳入受控部署步骤并在验证后恢复。

## 3. 防火墙

### 3.1 阿里云入站规则

| 协议 | 端口 | 来源 | 用途 |
|---|---:|---|---|
| TCP | 22 | 管理员固定 IP | SSH 管理 |
| TCP | 80 | 公网 | ACME HTTP 验证及 HTTPS 跳转 |
| TCP | 443 | 公网 | HTTPS/WSS（含 P2P 信令，复用 `/api/*` 反代，无新增端口） |
| TCP | 3478 | 公网 | coturn TURN/TCP，供无法使用 UDP 的自定义屏幕共享连接 |
| TCP | 5349 | 公网 | coturn TURN/TLS，使用 `turn.babagan.cloud` 公网证书 |
| TCP | 7881 | 公网 | LiveKit RTC/TCP 回退 |
| UDP | 443 | 公网 | LiveKit 媒体路径的 TURN/UDP（P2P 本身不复用其凭据） |
| UDP | 3478 | 公网 | coturn TURN/UDP 分配入口 |
| UDP | 49160–49200 | 公网 | coturn 屏幕共享中继端口池（最多 41 个并发 allocation） |
| UDP | 50000–60000 | 公网 | WebRTC 直接媒体（麦克风；回退时屏幕） |

当前固定的 LiveKit Server v1.11.0 不提供可复用的通用 ICE 凭据接口，因此自定义屏幕共享使用独立 coturn。API 通过 `P2P_STUN_URLS` 下发 STUN，并使用 TURN REST HMAC 为已认证参与者签发 600 秒凭据；无法直连时先走 coturn，coturn 也不可用时仍由始终发布的 LiveKit 屏幕安全网接管。不得直接开放 API、SQLite、LiveKit 7880、容器管理端口或监控管理接口。出站允许 DNS、NTP、ACME、系统更新和必要镜像仓库访问。

### 3.2 主机防火墙

主机防火墙与阿里云规则保持一致，默认拒绝其他入站流量。Docker 发布端口必须明确绑定，不依赖容器默认行为；部署后从外部端口扫描确认未额外暴露服务。

## 4. Docker Compose 拓扑

- `caddy`：发布 TCP 80/443，挂载配置、数据和证书卷。
- `api`：仅加入内部网络，挂载 SQLite 数据卷和只读 secret。
- `livekit`：主机网络模式或等效低开销网络；发布 RTC/TURN 端口。
- `coturn`：主机网络模式；固定 `4.17.2-r0` 摘要；只读挂载 Caddy 证书卷；仅使用 3478、5349 和 49160–49200，不占用 LiveKit UDP 443。
- `web`：构建产物由 Caddy 直接提供，不常驻单独 Node 开发服务器。

生产环境禁止使用浮动镜像标签。镜像以版本号和不可变摘要固定，升级前记录当前摘要。

## 5. 配置原则

### 5.1 Caddy

- `meet.babagan.cloud`：`/api/*` 反代 API，其他路径提供 SPA，并设置安全响应头。
- `rtc.babagan.cloud`：反代 LiveKit 7880，保留 WebSocket Upgrade 和真实协议头。
- `turn.babagan.cloud`：保持 DNS only；Caddy 为该主机名申请公众信任的证书并把证书卷只读提供给 coturn。
- 禁用服务器侧 UDP 443 的 HTTP/3，给 TURN/UDP 使用。
- 启用压缩仅针对静态文本资源，不对媒体流做处理。

### 5.2 LiveKit

- 配置节点公网 IP 发现或显式外部 IP。
- 信令端口 7880 仅内部访问。
- RTC/TCP 7881，UDP 范围 50000–60000。
- TURN/UDP 使用 443。
- 不启用 Redis、多节点、Egress、Ingress、SIP、Agent 和 Prometheus 公网监听。
- 日志级别生产使用 `info`，禁止记录 Token 和 SDP 中的敏感标识。

### 5.3 API

- 单进程运行，SQLite 使用 WAL 模式和合理 busy timeout。
- 数据库迁移在服务就绪前完成，失败则不接收流量。
- 健康检查必须区分存活和就绪。
- 严格限制请求体大小、并发、超时和密码尝试频率。
- `P2P_TURN_SECRET` 与 coturn 的 `TURN_SHARED_SECRET` 必须完全相同、至少 32 字符且权限为 600；浏览器只接收参与者绑定的短期凭据，响应设置 `Cache-Control: no-store`。

### 5.4 coturn

- 监听 3478/UDP+TCP 和 5349/TCP；禁用 DTLS 与管理 CLI；relay 端口严格限制为 49160–49200/UDP。
- `TURN_EXTERNAL_IP` 使用服务器公网 IPv4，`TURN_RELAY_IP` 使用实例私网 IPv4；ECS 的端口映射必须保持 relay 端口号不变。
- 禁止 relay 访问 loopback、RFC1918、链路本地、云元数据和组播地址，避免把 TURN 变成内网代理。
- Caddy 证书续期后在无活动会议窗口执行 `docker compose restart coturn`，随后验证 5349/TCP；短暂重启不会影响 LiveKit 语音和 SFU 安全网。

## 6. 首次部署顺序

1. 更新 Debian 安全补丁并建立非 root 管理用户。
2. 配置 SSH 密钥、阿里云防火墙和主机防火墙。
3. 安装 Docker Engine 与 Compose 插件并验证版本。
4. 创建应用目录、持久卷目录和权限受限的 secrets。
5. 验证 DNS 记录及 `rtc`/`turn` 直连解析。
6. 启动 Caddy 并确认 ACME 证书成功。
7. 启动固定 digest 的 LiveKit v1.11.0，验证内部健康与公网候选地址。
8. 确认 Caddy 已生成 `turn.babagan.cloud` 证书，启动固定摘要 coturn，并验证 3478/UDP+TCP、5349/TCP 与 49160–49200/UDP。
9. 运行数据库迁移，启动 API 和静态 Web；确认已认证 `/ice-servers` 同时返回 STUN、三条 TURN URL、短期 username/credential 和 `Cache-Control: no-store`。
10. 执行 HTTP、WSS、P2P 直连、强制 TURN 中继、SFU 回退和 5 人冒烟测试。
11. 验证 P2P 信令端点：无 Cookie、缺失 Origin、跨站 Origin 均拒绝升级；有 Cookie 且同源可加入房间名单，offer/answer/ice/media-ready 转发正常。
12. 在两端真实公网环境验证 `P2P 直连`、`TURN 中继` 和 `SFU 中转` 标签与统计持续更新（见 `05` 文档 §4.3）。
13. 将 Cloudflare 设置为 Full (strict)，验证完整访问路径。

## 7. 发布与回滚

每次发布：

1. 在非生产环境构建并运行自动化测试。
2. 生成带版本号和摘要的镜像。
3. 备份 SQLite，并记录当前镜像、配置和数据库版本。
4. 拉取新镜像，执行向前兼容迁移。
5. 滚动重建非媒体组件；LiveKit升级安排在无活动会议时。
6. 运行冒烟测试和 5 人快速测试。
7. 观察 15 分钟 CPU、内存、错误率和连接成功率。

回滚时恢复旧镜像和兼容数据库版本。禁止在有活动会议时进行破坏性数据库迁移或 LiveKit 重启。

## 8. 备份与恢复

- SQLite 每日在线一致性备份，保留最近 7 份。
- Caddy 数据、配置、Compose 文件和版本清单每日备份。
- 不备份媒体，因为系统不生成媒体文件。
- 备份文件加密，权限限制为管理员，禁止放进 Web 可访问目录。
- 每月至少执行一次恢复演练，验证能在空白目录恢复服务。

## 9. 监控与告警

| 指标 | 告警条件 |
|---|---|
| CPU | 5 分钟平均 >80% |
| 内存 | 已用 >1.8 GiB 或发生 OOM/交换抖动 |
| 磁盘 | 使用率 >80% |
| 公网带宽 | 持续 >50 Mbps 或出现突发（P2P 直连不消费云端屏幕下行；TURN 和 SFU 都会消耗服务器上下行，应结合界面 transport 标签判断） |
| API | 5xx 比例 >2%/5 分钟 |
| LiveKit | 连接失败率 >5%/5 分钟 |
| P2P 回退率 | 会议结束后聚合的回退率 >50%（人工观察项，用于评估直连穿透质量） |
| 证书 | 距到期 <21 天仍未续期 |
| 备份 | 连续 24 小时没有成功备份 |

日志使用 JSON、UTC 时间和关联 ID，按大小与天数轮转。应用日志默认保留 14 天，安全审计默认保留 30 天。

## 10. 日常运维

- 每周检查系统安全更新、容器健康、磁盘和证书状态。
- 每周检查 coturn allocation 数、relay 端口余量和 3478/5349 可达性；Caddy 续期 `turn` 证书后安排 coturn 重启并复测 TLS allocation。
- 每月演练一次创建、5 人加入、共享（含 P2P 直连与回退）、弱网回退和结束会议。
- 依赖升级前阅读变更说明，并在测试环境完成兼容性验证。
- 出现质量问题时收集匿名连接统计（含 P2P 建立成功率、回退率）和浏览器 `webrtc-internals` 导出；必须先征得用户同意，不收集媒体内容。
- 前端与 API 同时发布时优先保证 P2P 信令与回退路径的兼容：旧前端无 P2P 客户端时自动走 LiveKit 回退路径，不影响会议。

