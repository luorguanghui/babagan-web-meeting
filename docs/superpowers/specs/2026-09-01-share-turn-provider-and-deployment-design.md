# 共享级 TURN 提供商选择与新服务器部署设计

日期：2026-09-01  
状态：已获对话确认，待文件复核

## 1. 背景与现状

本次目标是把当前 Babagan 会议项目部署到新建的阿里云 ECS，并让共享者在每次开始共享屏幕前选择本次 P2P 屏幕共享使用的 TURN 中继：服务器上的 coturn，或 Cloudflare Realtime TURN。

只读检查得到以下事实：

- 新实例公网 IPv4 是用户当前实例提供的地址，私网地址为 `172.19.196.130`；系统为 Debian 13.6，2 核、2 GiB 内存、40 GiB 系统盘。
- 新实例尚未安装 Docker，未运行 Babagan 容器，只有 SSH 监听。
- Cloudflare 区域 `babagan.cloud` 目前有四条 A 记录；`meet` 为 Proxied，`rtc` 与 `turn` 为 DNS only，三条记录仍指向旧源站。
- Cloudflare Realtime TURN 列表中已有 `babagan-turn-production-v2`，但列表页不提供其长期 TURN API Token/Secret 的恢复入口。
- 当前代码已经支持通过 `P2P_TURN_PROVIDER` 选择单一默认 TURN provider，并能显示实际 coturn/Cloudflare provider；共享界面还没有按本次共享选择 provider 的能力。
- 当前工作树已有用户自己的未跟踪部署包、验收输出和文档变更；本设计及后续实现只修改任务所需文件，不清理或覆盖这些既有内容。

会议数据库只保存短期会议元数据，不保存媒体。新服务器采用空白部署，不自动迁移旧服务器 SQLite；旧服务器在新站点验收完成前保持不动，作为回退参考。

## 2. 目标与非目标

### 目标

1. 共享者在开始共享前可选择“自动”“服务器 coturn”或“Cloudflare TURN”。
2. 选择按一次屏幕共享生效，共享进行中不可改变；所有观看者在该次共享中获取与共享者一致的 TURN provider。
3. `auto` 使用服务器的默认 provider，并在 Cloudflare 临时不可用时回退到 coturn；页面和诊断面板显示实际使用的 provider。
4. 保留观看者现有的“自动 / TURN / SFU”传输偏好；其中“TURN”只控制是否强制 relay，不改变共享者选定的 provider。
5. 在 Debian 13 新实例上运行五个 Compose 服务：Caddy、API、LiveKit、coturn 和 web。
6. 正确切换 DNS、证书、安全组、UFW 和生产环境变量，并完成线上健康、ICE、WebSocket、TURN 和会议验收。

### 非目标

- 不把 TURN API Token/Secret 放到 Git、前端 bundle、浏览器 localStorage、日志或聊天记录。
- 不让浏览器直接调用 Cloudflare TURN 管理 API；浏览器只取得短期 ICE 凭据。
- 不改变音频仍由 LiveKit SFU 承载的架构。
- 不修改根域名 A 记录，除非执行中发现 Caddy 或用户明确要求根域名也迁移。
- 不释放或删除旧服务器，不删除 Cloudflare 现有 TURN 应用。
- 不把任意观看者的独立 provider 选择作为本次功能；provider 以共享者本次共享的选择为准。

## 3. 方案比较与决策

### 方案 A：只保留部署级环境变量

`P2P_TURN_PROVIDER` 决定整台服务器唯一的 provider。实现风险最低，但每次共享不能选择，无法满足本次需求。保留作为兼容基础和 `auto` 的默认值来源，不单独采用。

### 方案 B：共享级 provider，并在 offer 中同步（采用）

共享者开始共享时向 API 请求指定 provider 的 ICE 配置；API 返回实际 provider。共享者把实际 provider 作为 offer 元数据转发给每个观看者，观看者按该 provider 请求自己的短期 ICE 凭据。Cloudflare 不可用时 API 回退 coturn，并在响应及 offer 中报告 coturn。

该方案把 provider 选择绑定到实际共享会话，双方不会因各自 localStorage 偏好不同而拿到不同 TURN 服务；同时保留现有 P2P、TURN、SFU 和 LiveKit 安全网状态机。

### 方案 C：每个观看者独立选择 provider

观看者可以各自选 coturn 或 Cloudflare，但共享者和观看者可能建立在不同 TURN 服务上，且需要扩展房间状态、协商协议和混合 provider 语义。复杂度与失败面明显增加，不采用。

## 4. 运行时架构

### 4.1 配置语义

继续保留 `P2P_TURN_PROVIDER=coturn|cloudflare`，将其明确为 `auto` 的默认 provider，而不是唯一允许使用的 provider。

- coturn 配置始终由 `P2P_STUN_URLS`、`P2P_TURN_URLS`、`P2P_TURN_SECRET` 和 `TURN_SHARED_SECRET` 提供。
- Cloudflare 配置由 `CLOUDFLARE_TURN_KEY_ID`、`CLOUDFLARE_TURN_API_TOKEN`、`CLOUDFLARE_TURN_TTL_SECONDS` 和可选 `CLOUDFLARE_TURN_CONNECT_IPS` 提供。
- Cloudflare Key ID 与 API Token 必须成对出现；默认 provider 为 cloudflare 时两者必须存在，默认 provider 为 coturn 时允许不配置 Cloudflare，但新生产部署为了开放 UI 两个选项会配置两者。
- API 只把 `turnProvider`、`availableTurnProviders`、短期 ICE username/credential 和到期时间返回客户端；长期 API Token/Secret 永不返回。

### 4.2 ICE API

扩展现有认证接口：

```text
GET /api/v1/meetings/:slug/ice-servers
GET /api/v1/meetings/:slug/ice-servers?turnProvider=coturn
GET /api/v1/meetings/:slug/ice-servers?turnProvider=cloudflare
```

响应继续包含 `iceServers`、实际 `turnProvider` 和 `turnCredentialsExpiresAt`，新增不含秘密的 `availableTurnProviders`。

- 未指定或指定 `auto` 时使用 `P2P_TURN_PROVIDER`。
- 指定 coturn 时直接生成参与者绑定的 HMAC-SHA1 临时凭据。
- 指定 Cloudflare 时由 API 服务端调用 Cloudflare 的 `generate-ice-servers` 接口。
- Cloudflare 请求失败、响应无可用 ICE server 或凭据不完整时回退 coturn，并将实际 provider 写为 `coturn`；不会返回一个声称使用 Cloudflare 的错误配置。
- 每次请求仍要求有效参与者 Cookie、同源 Origin、API 速率限制和 `Cache-Control: no-store`。
- 无效 provider 由 query schema 拒绝，不进入 provider 实现。

### 4.3 P2P 信令同步

在现有 `offer` 信令消息上增加可选的 `turnProvider: coturn|cloudflare` 字段。该字段只由当前共享者的 P2P controller 发送，服务端继续沿用“只有当前共享者可发送 offer”的权限规则，并原样转发给目标观看者。

共享者 controller 的每个 session 保存 API 返回的实际 provider，并在 offer、自动重试和 viewer retry 时发送该值。观看者收到 offer 后：

1. 如果 offer 携带的 provider 与当前 ICE 配置不同，先按指定 provider 获取配置。
2. 如果凭据即将到期，先刷新同一 provider 的配置。
3. 使用同一 provider 的 ICE server 创建/重建 PeerConnection。
4. 继续根据观看者的 `auto`、`turn`、`sfu` 偏好决定 `iceTransportPolicy` 和是否接受 P2P offer。

旧的无 `turnProvider` offer 仍按 coturn 兼容处理。

### 4.4 前端选择器

新增 `ScreenShareTurnProviderPreference = auto | coturn | cloudflare`，独立于已有的 `ViewerTransportPreference`。

- 选择器位于“音频与共享设置”中，出现在屏幕共享相关设置旁。
- `auto`、服务器 coturn、Cloudflare TURN 使用中英文文案，并根据 API 的 `availableTurnProviders` 隐藏未配置的 Cloudflare 选项。
- 选择保存到本设备的 localStorage，初始默认值为 `auto`；存储不可用时只保留当前页面会话选择。
- `screenShareActive` 或 `screenShareBusy` 时禁用选择器；下一次共享开始前才能更改。
- 共享者开始共享时，controller 根据当前选择请求相应 ICE 配置；选择 `auto` 时不带 provider query，让服务端默认值统一生效。
- 共享者和观看者的顶部状态、WebRTC 统计面板继续显示实际链路；TURN 状态显示 `TURN 中继 · coturn` 或 `TURN 中继 · Cloudflare`。
- 观看者看到的“TURN 中继”选择增加说明：provider 由共享者本次共享选择，观看者的选项只决定是否使用 relay。

### 4.5 故障与安全网

- Cloudflare 管理 API 暂时不可达：ICE API 回退 coturn，offer 携带实际 coturn，会议继续建立。
- coturn relay 不可用、P2P 协商超时、ICE failed 或 RTP 停流：沿用现有 LiveKit SFU 安全网和首帧切换逻辑。
- Cloudflare 和 coturn 都不可用：不阻断进会，但 P2P 失败后使用 LiveKit 屏幕轨道；错误信息不包含长期凭据。
- provider query、offer metadata 和 `availableTurnProviders` 均视为不可信输入，服务端只接受枚举值，客户端不以 metadata 绕过会议鉴权。

## 5. 新服务器部署架构

### 5.1 目标主机与发布

- 目标为当前新建 ECS，使用已确认的公网 IPv4 和私网 IPv4；实际值只写入服务器受保护环境文件，不写入 Git 文档。
- 部署脚本从仅允许 Debian 12 改为允许 Debian 12 或 Debian 13，并保留 Docker、内存、磁盘、DNS、镜像 digest、数据库和发布 provenance 检查。
- 新服务器作为空白主机初始化，创建 `/opt/babagan-meeting` 和受保护的 `/root/babagan-secrets`、`/root/babagan-protected`。
- 通过 GitHub 远端或经校验的 Git bundle 同步已测试的完整 SHA；不把生产环境文件、密钥或数据库放进 bundle。
- 首次部署使用 `--bootstrap-empty`，先生成 mode 600 的生产 env、管理员 Argon2id 哈希、TURN 随机密钥、网络/Cloudflare 证据和 smoke token，再执行受保护发布。
- 旧服务器保持运行到新站点线上验收完成；新服务器失败时不重复运行存在 pending 事务的 deploy，按现有 rollback runbook 处理。

### 5.2 Compose 与证书

继续使用现有五服务 Compose：

- Caddy：80/443、ACME、网页/API/LiveKit 反向代理。
- API：内部 3000，SQLite 使用 `api-data` volume。
- LiveKit：host network，7880 内部信令、7881/TCP、UDP 443、50000–60000 媒体端口。
- coturn：host network，3478 UDP/TCP、5349/TCP TLS、49160–49200 UDP relay 端口。
- web：内部 8080，提供 Vite 构建后的静态页面。

首次部署先让 Caddy 根据 DNS 取得 `meet`、`rtc`、`turn` 的证书，再以只读方式向 coturn 暴露 `turn` 证书。证书文件和目录权限只为 coturn 读取所需范围；证书续期后受控重启 coturn。

### 5.3 DNS、代理与端口

Cloudflare 区域只改动指向旧服务器的业务 A 记录：

- `meet.babagan.cloud`：改为新公网 IP，保持 Proxied。
- `rtc.babagan.cloud`：改为新公网 IP，保持 DNS only。
- `turn.babagan.cloud`：改为新公网 IP，保持 DNS only。
- 根域名 A 记录保持现状。

Cloudflare SSL/TLS 保持 Full (strict)。阿里云安全组和 UFW 同步允许：

```text
TCP: 22, 80, 443, 3478, 5349, 7881
UDP: 443, 3478, 49160-49200, 50000-60000
```

不开放 TCP 3000、7880、Docker 管理端口、coturn CLI 或监控端口。当前安全组 SSH 为公网来源时保留该规则避免锁定管理会话，并使用 deploy.sh 的 public SSH evidence waiver；不在不知道管理公网 IP 的情况下收紧 SSH 来源。

### 5.4 Cloudflare TURN 凭据

优先使用已有 `babagan-turn-production-v2` 的受保护凭据，前提是凭据可以在不写入聊天、日志或 Git 的情况下取得。如果旧凭据无法恢复，则在 Cloudflare Realtime TURN 页面创建名为 `babagan-turn-production-v3` 的新应用，保留 v2 不动，并只在创建结果显示的一次性窗口中取得新的 Key ID 和 API Token/Secret。

长期 Cloudflare TURN API Token/Secret 只进入服务器 `infra/.env.production` 的 mode 600 文件。输入或粘贴该秘密到服务器前，必须在动作发生前再次确认目标是当前新 ECS，避免把秘密发送到错误主机或聊天窗口。

生产默认设为 `P2P_TURN_PROVIDER=coturn`，因此未选择时优先使用服务器 relay；Cloudflare 选项同时可用，页面可以在每次共享前切换。

## 6. 测试与验收

### 6.1 TDD 顺序

实现前先为每个行为写失败测试并确认失败原因：

1. API 配置允许 coturn 默认同时携带 Cloudflare 配置，拒绝 Cloudflare 配置半缺失。
2. ICE query 能选择 provider、报告实际 provider、公开可用 provider 列表，并在 Cloudflare 失败时回退 coturn。
3. P2P contract、signaling client 和 server 转发 offer 的 `turnProvider` metadata。
4. sharer controller 发送实际 provider，viewer 在 provider 不同于缓存时刷新对应 ICE 配置。
5. 前端 selector 读写 localStorage、隐藏不可用选项、共享进行中禁用，并保留现有 viewer transport 逻辑。
6. deployment smoke 能验证默认 coturn 和显式 Cloudflare ICE response，不泄漏长期 token。

随后运行现有全部测试、lint、typecheck、build、shell regression 和 `git diff --check`。

### 6.2 线上验收

发布后必须取得新鲜输出证明：

- 五个 Compose 服务均 healthy，`/health/live` 返回 `{"status":"ok"}`，`/health/ready` 返回 `{"status":"ready"}`，首页返回 HTTP 200。
- `meet`、`rtc`、`turn` DNS 分别符合 Proxied、DNS only、DNS only 和新公网 IP。
- API 认证 ICE 请求默认返回 coturn，并包含 `Cache-Control: no-store`；显式 Cloudflare 请求返回 Cloudflare，包含短期 username/credential；服务端日志与响应不包含 Cloudflare 长期 Token。
- 7880/3000 从公网不可达，7881/TCP、UDP 443、3478、5349 和 relay/media 端口按拓扑可达。
- 至少一次会议中验证自动 P2P、强制 TURN、SFU 回退；TURN 状态标签与 candidate pair/统计一致。
- 关闭测试会议并记录部署 SHA、镜像 ID、健康检查、smoke 输出和 DNS/安全组证据；不记录密码、Token、SDP、ICE candidate 或媒体内容。

## 7. 回滚与恢复

- 代码发布失败：保留 `pending-release.env`、备份和候选容器状态，按既有受保护恢复流程处理，不直接重复 deploy。
- 新站点健康但业务验收失败：先恢复旧 DNS A 记录到旧源站，确认旧站点仍可用，再分析新主机；不删除新数据卷或旧服务器。
- DNS 切换后发现 Caddy/TURN/LiveKit 失败：只回退三条业务 DNS 记录的原内容和代理状态；Cloudflare TURN 应用不删除。
- 新部署验收完成后，旧服务器仍保留一段观察期；只有用户另行要求时才执行停机、释放或数据迁移。

