# 实现规格

## 1. 建议仓库结构

```text
apps/
  web/                  # React + TypeScript
  api/                  # Fastify + SQLite + LiveKit Server SDK
packages/
  contracts/            # API schema、错误码和共享类型
infra/
  caddy/Caddyfile        # 边缘反代（meet/rtc/turn）
  livekit/livekit.yaml   # LiveKit 配置
  coturn/turnserver.conf # coturn（P2P TURN 中继）
  web/Caddyfile          # web 静态产物服务（:8080）
  docker-compose.yml
scripts/
  backup.sh
  smoke-test.sh
docs/
```

Web 和 API 共用由 JSON Schema 生成的请求/响应类型。所有依赖在实现时锁定精确版本并提交锁文件；升级必须通过完整测试矩阵。

## 2. 配置项

| 环境变量 | 作用 | 安全要求 |
|---|---|---|
| `NODE_ENV` | `production`/`test`/`development` | 生产固定为 `production` |
| `PUBLIC_BASE_URL` | `https://meet.babagan.cloud` | 生产必须为 `https:`，作为固定允许来源 |
| `LIVEKIT_URL` | `wss://rtc.babagan.cloud` | 返回给客户端 |
| `LIVEKIT_INTERNAL_URL` | Docker 内部地址（如 `ws://host.docker.internal:7880`） | 不暴露客户端 |
| `LIVEKIT_API_KEY` | LiveKit Server API Key | Docker secret 或权限 600 文件 |
| `LIVEKIT_API_SECRET` | LiveKit Server API Secret | Docker secret 或权限 600 文件 |
| `ADMIN_PASSWORD_HASH` | 主持人管理密码的 Argon2id 哈希 | 不保存明文 |
| `COOKIE_SECRET` | Cookie 签名密钥 | 至少 32 个随机字节 |
| `DATABASE_PATH` | SQLite 文件路径 | 持久卷、仅 API 可写 |
| `P2P_STUN_URLS` | 逗号分隔的 `stun:`/`stuns:` URL | 启动时严格校验协议 |
| `P2P_TURN_URLS` | 逗号分隔的 `turn:`/`turns:` URL（3478/udp、3478/tcp、5349/tls） | 启动时严格校验协议；指向自托管 coturn |
| `P2P_TURN_SECRET` | 与 coturn `TURN_SHARED_SECRET` 完全相同的 TURN REST 密钥 | 至少 32 字节、权限 600 |
| `P2P_TURN_TTL_SECONDS` | TURN 凭据有效期 | 默认 600，范围 60–3600 |
| `P2P_TURN_PROVIDER` | `coturn` 或 `cloudflare` | 默认 `coturn`；Cloudflare 失败时回退 coturn |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN Key ID | 仅服务端使用，不下发浏览器 |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare TURN Key API Token/Secret（创建 TURN app 时一次性返回；不是 User API Token） | 仅服务端使用，权限 600 |
| `CLOUDFLARE_TURN_TTL_SECONDS` | Cloudflare 短期凭据有效期 | 默认 600，范围 60–86400 |
| `CLOUDFLARE_TURN_CONNECT_IPS` | 可选的 Cloudflare API 出站连接 IP 列表 | 逗号分隔，仅在 DNS 返回地址不可达时配置；服务端保留 `rtc.live.cloudflare.com` 的 TLS SNI/Host |

以下生命周期/容量参数不是环境变量，而是 `AppConfig` 中的版本化常量：会议 24 小时到期（`meetingTtlMs = 86_400_000`）、空房保留 10 分钟（`emptyGraceMs = 600_000`）、断线保留 30 秒（`reconnectGraceMs = 30_000`）、加入预留 60 秒（`reservationTtlMs = 60_000`）、上限 5 人（`maxParticipants = 5`）。

启动时必须校验必需配置、密钥长度、URL 协议和目录权限；校验失败直接退出，不带默认弱密钥启动。P2P 的 8 秒协商、5 秒 ICE 失联、5 秒 RTP 停流阈值，以及 120 秒心跳超时与 120 条/60 秒消息限速，均为 contracts/服务端中的版本化协议常量，不伪装成尚未实现的运行时环境变量。

## 3. 数据模型

### 3.1 `meetings`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 服务端 UUIDv7 |
| `slug` | TEXT UNIQUE | 至少 128 位随机熵的 URL 标识 |
| `name` | TEXT | 1–80 字符 |
| `password_hash` | TEXT NULL | Argon2id；未设置则为空 |
| `status` | TEXT | `created/active/grace/ended/expired` |
| `share_identity` | TEXT NULL | 当前共享者身份 |
| `created_at` | INTEGER | UTC Unix 毫秒 |
| `expires_at` | INTEGER | 创建时间 + 24 小时 |
| `empty_since` | INTEGER NULL | 空房起始时间 |
| `ended_at` | INTEGER NULL | 终止时间 |
| `version` | INTEGER | 乐观并发控制 |

数据库以部分唯一索引保证同一时间最多一个非终态会议。共享者更新必须在事务中比较 `version`，防止并发授权两人。

### 3.2 `host_sessions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 随机会话 ID |
| `meeting_id` | TEXT FK | 所属会议 |
| `token_hash` | TEXT | 256 位随机 Token 的 SHA-256 哈希 |
| `created_at` | INTEGER | 创建时间 |
| `expires_at` | INTEGER | 不晚于会议到期时间 |
| `revoked_at` | INTEGER NULL | 结束或退出后撤销 |

浏览器只持有原始随机 Token 的安全 Cookie，数据库只保存哈希。

### 3.3 `audit_events`

仅保存创建、结束、授权共享、撤销共享、移除成员、重复密码失败和系统错误等事件。字段为事件类型、会议 ID、匿名主体 ID、UTC 时间和不含敏感信息的 JSON 元数据。

### 3.4 `join_reservations`

| 字段 | 类型 | 说明 |
|---|---|---|
| `identity` | TEXT PK | 将写入 LiveKit Token 的唯一身份 |
| `meeting_id` | TEXT FK | 所属会议 |
| `nickname` | TEXT | 已校验的显示昵称 |
| `issued_at` | INTEGER | Token 签发时间 |
| `expires_at` | INTEGER | 60 秒连接预留到期时间 |

加入接口在单进程的会议级互斥锁中，计算 LiveKit 当前身份与未过期预留身份的并集。少于 5 人时才插入预留并签发 Token。LiveKit 的参与者加入 Webhook 删除对应预留；未连接的预留在 60 秒后清理。这样即使多人同时点击加入，也不会签发超过容量的有效入会名额。

### 3.5 `participant_sessions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `identity` | TEXT PK | LiveKit 唯一身份 |
| `meeting_id` | TEXT FK | 所属会议 |
| `nickname` | TEXT | 显示昵称 |
| `token_hash` | TEXT | 参与者会话随机 Token 的 SHA-256 哈希 |
| `expires_at` | INTEGER | 不晚于会议到期时间 |
| `revoked_at` | INTEGER NULL | 被移除或会议结束时撤销 |

加入成功时设置参与者安全 Cookie，LiveKit JWT 有效期为 5 分钟。SDK 正常保持的连接不受 JWT 到期影响；发生需要完整重连的情况时，客户端使用参与者 Cookie 请求新 JWT。主持人移除成员时先撤销参与者会话，再从 LiveKit 移除；Webhook 发现已撤销身份重新连接时立即移除。

## 4. HTTP API

统一前缀 `/api/v1`，请求和响应使用 JSON；所有修改接口验证 `Origin`，主持人接口同时验证安全 Cookie。

### 4.1 主持人和会议

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| POST | `/meetings` | 管理密码 | 原子创建会议并建立会议主持人会话 |
| GET | `/meetings/current` | 公开 | 返回当前非终态会议摘要（无则 `meeting: null`） |
| GET | `/meetings/:slug` | 公开 | 返回名称、状态、是否需要密码和是否满员 |
| GET | `/meetings/:slug/host-session` | 主持人 | 校验主持人会话是否有效（204） |
| POST | `/meetings/:slug/end` | 主持人 | 结束会议并移除所有成员 |
| POST | `/meetings/:slug/admin-end` | 管理密码 | 用管理密码结束会议（无需主持人会话） |
| POST | `/meetings/:slug/kick` | 主持人 | 按身份移除成员 |
| PUT | `/meetings/:slug/share-grant` | 主持人 | 原子授予唯一共享权限 |
| DELETE | `/meetings/:slug/share-grant` | 主持人 | 撤销或释放共享权限 |

### 4.2 参会

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| POST | `/meetings/:slug/join` | 会议密码 | 校验容量并签发 LiveKit Token |
| POST | `/meetings/:slug/token` | 参与者会话 | 为完整重连签发新的 5 分钟 Token |
| POST | `/meetings/:slug/leave` | 参与者会话 | 提前释放参与状态 |
| DELETE | `/meetings/:slug/share` | 参与者会话 | 共享者主动释放自己的共享权限 |
| GET | `/meetings/:slug/participants` | 房间成员 | 返回最小化成员和共享状态 |
| GET | `/meetings/:slug/ice-servers` | 参与者会话 | 返回 P2P STUN 列表与带短期凭据的 coturn TURN 列表 |
| POST | `/meetings/:slug/p2p-stats` | 参与者会话（离会容忍） | 记录匿名 P2P 质量统计（无媒体/SDP/IP/身份） |
| WS | `/meetings/:slug/p2p` | 参与者会话 Cookie + 可信 `Origin` | P2P 信令：房间在线名单、SDP/ICE/`media-ready`/`retry` 转发（协议见 `07` 设计 §4） |

加入响应包含 `participantIdentity`、`participantName`、`livekitUrl`、5 分钟 `token`、`meetingExpiresAt` 和权限摘要，并设置参与者安全 Cookie。会议密码不得出现在响应中。`ice-servers` 响应为 `{ iceServers, turnProvider, turnCredentialsExpiresAt }`；`turnProvider` 表示本次实际使用的 `coturn` 或 `cloudflare`，响应设置 `Cache-Control: no-store`；客户端在建立 P2P 控制器前获取，并在 TURN 标签中显示 provider。

### 4.3 P2P 信令端点行为

- 握手必须携带有效参与者安全 Cookie，且 `Origin` 必须与 `PUBLIC_BASE_URL` 完全一致；缺失、无效或跨站来源均拒绝升级。
- 连接后服务端将 WS 连接注册到会议在线表并广播 `peer-joined`；断开时注销并广播 `peer-left`。客户端发送 `hello` 声明身份，服务端校验其与 Cookie 会话一致。
- 转发规则（服务端强制）：仅当前 `share_identity` 可发送 `offer`；`answer`/`ice`/`bye` 只能发给当前共享者（或由共享者发出）；观看者确认直连视频已解码后向共享者发送 `media-ready`；观看者可用 `retry` 请求共享者为其重建会话并重发 offer；目标必须是同会议在线成员。
- `offer`/`answer`/`ice`/`media-ready` 携带可选 `generation` 字段，用于区分同一次会话的重协商，避免陈旧候选污染重试。
- 共享锁释放（撤销/结束/共享者离开/被移除）时服务端广播 `share-gone`，客户端据此关闭全部 P2P 连接。
- 消息上限 64 KiB；单连接限速 120 条/60 秒；SDP、ICE 候选与凭据不写入日志。
- 心跳：客户端每 25 秒发送 `ping`，服务端以 `pong` 应答；服务端 120 秒未收到任何帧判定失联并关闭（后台标签页计时器节流下仍足够宽松）。
- 服务重启时在线表清空，客户端重连后以 `welcome` 全量恢复；LiveKit 参与者仍在时不影响其语音。

### 4.4 LiveKit Webhook

`POST /internal/livekit/webhook` 只接收 LiveKit 使用 Server API Secret 签名的事件，并可限制为 Docker 内部来源。它处理参与者加入/离开、轨道发布/取消和房间结束事件，用于清理加入预留、释放共享锁和维护空房时间。签名无效或重复事件不得改变状态；处理逻辑按事件 ID 幂等。

### 4.5 健康检查

- `GET /health/live`：进程存活，不访问外部依赖。
- `GET /health/ready`：SQLite 可读写且 LiveKit Server API 可访问；P2P STUN 配置已在进程启动时完成校验。

## 5. LiveKit 权限

普通成员 Token：

- 允许加入指定房间和订阅。
- 允许发布 `microphone`。
- 禁止 `camera`、数据轨道和屏幕来源。
- 禁止创建其他房间或执行管理 API。
- JWT 有效期固定为 5 分钟；完整重连通过未撤销的参与者安全会话刷新。

共享者通过 LiveKit Server API 的参与者权限更新获得 `screen_share` 和 `screen_share_audio` 发布来源。**P2P 混合模式始终先发布并保留 LiveKit 屏幕轨道作为兼容与恢复安全网**。确认 P2P 首帧已经渲染的现代观看者仅在本客户端取消订阅 LiveKit 屏幕；旧客户端继续通过 LiveKit 观看。撤销时先更新服务端权限，再要求客户端停止 LiveKit 轨道与全部 P2P 连接。后端状态和 LiveKit 状态不一致时，以更严格的权限为准并记录审计事件。

## 6. 前端状态与页面

### 6.1 创建页

字段为管理密码、会议名称、可选会议密码。成功后显示普通参会链接、复制按钮和进入主持人会议室按钮。管理密码不进入浏览器持久存储。

### 6.2 入会准备页

- 检查 Windows、Chrome/Edge、HTTPS、WebRTC、麦克风接口。
- 获取设备列表前由用户主动点击“检查设备”。
- 提供麦克风电平条和扬声器测试音。
- 显示昵称、会议密码、静音加入状态和明确的权限说明。

### 6.3 会议室

- 主区域使用 `object-fit: contain` 展示共享屏幕，不裁剪文字内容。
- 观看者端屏幕源为双源渲染：P2P 直连流优先，LiveKit 轨道为回退；切换时不出现重复画面或黑屏超过 2 秒。
- 成员列表显示昵称、麦克风状态、共享者和连接质量。
- 控制栏只包含麦克风、设备、接收音量、屏幕共享（含码率档位选择与在线观看人数联动建议）、离开/结束和连接状态；接收音量分为共享音频和聚合通话音频两路。
- 主持人操作通过成员菜单提供，不占用普通成员界面。
- 无共享时显示会议名称和等待状态。

## 7. 媒体实现

### 7.1 音频

请求浏览器启用 `echoCancellation`、`noiseSuppression` 和 `autoGainControl`。编码由 LiveKit/浏览器协商为 Opus。页面必须为远端音频提供用户手势后的播放恢复机制，以处理自动播放限制。接收端将全部远端 `microphone` 轨道定义为一路“通话音频”，统一应用 0–100% 音量；屏幕音频通过共享舞台媒体元素的原生 `volume` 独立应用 0–100% 音量，并在 P2P、TURN 与 LiveKit 回退之间保持相同设置。两路默认均为 100%，共享音频不做接收端压缩、限幅或固定衰减；设置仅在当前会议页面会话内保留，重新加入或刷新页面后恢复默认值。

### 7.2 屏幕

**传输模式（P2P 优先，LiveKit 回退）**：

- **P2P 直连模式**：共享者对每名观看者各建一条 `RTCPeerConnection`，同一条连接上发布屏幕视频与屏幕音频两条轨道（音画同步硬约束，禁止拆到两条连接）。观看者端若在 8 秒内未收到媒体，通知共享者回退。
- **LiveKit 安全网模式**：共享者先发布 LiveKit 再启动 P2P，并保持发布至共享结束。观看者只有在直连候选对、视频字节与解码帧均确认后才发送 `media-ready` 并切到 P2P；连续检查 RTP，协商超时（8 秒）、ICE `failed` 或 5 秒无 RTP 进展时重新订阅 LiveKit。旧源保留到新源首帧后才关闭，双源可短暂并行用于无黑屏交接，但不会长期双重接收。

**码率**：

- P2P 直连档位：5 / 8 / 10 Mbps，默认 8 Mbps（受共享者上行约束：N 人 × 档位 < 可用上行）。
- SFU 回退档位：保持 10 / 13 / 15 Mbps 不变；常驻 SFU 安全网固定以 10 Mbps 发布。
- 共享开始时按在线观看者数给出建议档位并默认选中（≥4 名观看者建议 5 Mbps，否则 8 Mbps），可手动调整。

**编码与自适应**：

- 三档质量预设：`flow` 1280×720@30fps（弱网优先）、`standard` 1920×1080@30fps（默认）、`motion` 1920×1080@60fps（高动态）；三者均采用 `maintain-resolution`（保分辨率、降帧率），文字可读性优先。
- 每条 P2P 连接独立启用拥塞控制（Transport-CC/REMB），观看者弱网仅该路降码率，不影响其他观看者。
- `degradationPreference: maintain-resolution`（保分辨率、降帧率），文字可读性优先。
- 屏幕捕获请求音频，但实际是否返回音频轨道由浏览器和所选来源决定；P2P 模式下缺失音频轨道时 UI 提示重新选择（与现状一致）。
- 对文字类内容关闭不必要的平滑缩放；接收端保持原始宽高比。
- 页面不可见时降低非关键渲染负载。

**共享端流程**：授权 → 获取屏幕流（含音频）→ 先发布 LiveKit 安全网 → 获取显式 STUN 配置 → 对 P2P 信令在线的观看者发起协商 → 收到其 `media-ready` 后标记直连成功。共享停止/撤销时关闭全部连接、取消 LiveKit 发布并释放共享锁。

## 8. 定时任务与恢复

API 每 30 秒执行一次轻量清理：

1. 将过期会议置为 `expired`，关闭 LiveKit 房间，并通知后关闭对应 P2P 信令房间的全部连接。
2. 查询活动房间人数，维护 `active/grace` 状态。
3. 清理超过 10 分钟的空房。
4. 撤销终态会议的主持人会话和共享锁。
5. 按保留策略清理旧审计记录。

使用数据库锁或单进程互斥防止任务重入。进程启动后立即执行一次恢复清理。

## 9. 错误契约

| 错误码 | HTTP | 用户提示 |
|---|---:|---|
| `MEETING_NOT_FOUND` | 404 | 会议不存在或链接无效 |
| `MEETING_EXPIRED` | 410 | 会议已经结束 |
| `MEETING_FULL` | 409 | 会议人数已满 |
| `INVALID_MEETING_PASSWORD` | 401 | 会议密码错误 |
| `ADMIN_AUTH_FAILED` | 401 | 管理密码错误 |
| `SHARE_ALREADY_ACTIVE` | 409 | 已有人正在共享屏幕 |
| `SHARE_NOT_AUTHORIZED` | 403 | 主持人尚未授权共享 |
| `UNSUPPORTED_CLIENT` | 400 | 请使用 Windows 最新版 Chrome 或 Edge |
| `RATE_LIMITED` | 429 | 尝试过于频繁，请稍后再试 |
| `MEDIA_SERVICE_UNAVAILABLE` | 503 | 媒体服务暂时不可用，请重试 |
| `P2P_FORBIDDEN` | 403 | 当前成员无权发起或应答 P2P 协商（信令层，仅日志，不直接展示） |
| `P2P_PEER_NOT_FOUND` | 404 | P2P 消息目标不在线或不在本会议（信令层，仅日志） |

内部错误返回关联 ID，不返回堆栈、SQL、密钥或内部地址。P2P 信令错误在客户端表现为静默回退或状态提示，不打断会议流程。

## 10. 完成定义

实现只有在以下条件全部满足时才算完成：功能需求（含 FR-015/FR-016）逐项通过、API 契约（含 P2P 信令与 ICE 凭据）有自动化测试、两种浏览器完成 E2E、P2P 直连与回退在真实公网 NAT 场景验证通过、5 人 1080p60 负载达标、两小时稳定性通过、部署和回滚在目标服务器演练成功、安全检查没有高危问题。
