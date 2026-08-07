# 实现规格

## 1. 建议仓库结构

```text
apps/
  web/                  # React + TypeScript
  api/                  # Fastify + SQLite + LiveKit Server SDK
packages/
  contracts/            # API schema、错误码和共享类型
infra/
  caddy/Caddyfile
  livekit/livekit.yaml
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
| `NODE_ENV` | `production`/`test` | 生产固定为 `production` |
| `PUBLIC_BASE_URL` | `https://meet.babagan.cloud` | 固定允许来源 |
| `LIVEKIT_URL` | `wss://rtc.babagan.cloud` | 返回给客户端 |
| `LIVEKIT_INTERNAL_URL` | Docker 内部地址 | 不暴露客户端 |
| `LIVEKIT_API_KEY` | LiveKit Server API Key | Docker secret 或权限 600 文件 |
| `LIVEKIT_API_SECRET` | LiveKit Server API Secret | Docker secret 或权限 600 文件 |
| `ADMIN_PASSWORD_HASH` | 主持人管理密码的 Argon2id 哈希 | 不保存明文 |
| `COOKIE_SECRET` | Cookie 签名密钥 | 至少 32 个随机字节 |
| `DATABASE_PATH` | SQLite 文件路径 | 持久卷、仅 API 可写 |
| `MEETING_TTL_SECONDS` | `86400` | 与 PRD 保持一致 |
| `EMPTY_GRACE_SECONDS` | `600` | 与 PRD 保持一致 |
| `RECONNECT_GRACE_SECONDS` | `30` | 与 PRD 保持一致 |
| `MAX_PARTICIPANTS` | `5` | 服务端强制，不信任客户端 |

启动时必须校验必需配置、密钥长度、URL 协议和目录权限；校验失败直接退出，不带默认弱密钥启动。

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
| GET | `/meetings/:slug` | 公开 | 返回名称、状态、是否需要密码和是否满员 |
| POST | `/meetings/:slug/end` | 主持人 | 结束会议并移除所有成员 |
| POST | `/meetings/:slug/kick` | 主持人 | 按身份移除成员 |
| PUT | `/meetings/:slug/share-grant` | 主持人 | 原子授予唯一共享权限 |
| DELETE | `/meetings/:slug/share-grant` | 主持人 | 撤销或释放共享权限 |

### 4.2 参会

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| POST | `/meetings/:slug/join` | 会议密码 | 校验容量并签发 LiveKit Token |
| POST | `/meetings/:slug/token` | 参与者会话 | 为完整重连签发新的 5 分钟 Token |
| POST | `/meetings/:slug/leave` | 参与者 Token | 提前释放参与状态 |
| GET | `/meetings/:slug/participants` | 房间成员 | 返回最小化成员和共享状态 |

加入响应包含 `participantIdentity`、`participantName`、`livekitUrl`、5 分钟 `token`、`meetingExpiresAt` 和权限摘要，并设置参与者安全 Cookie。会议密码不得出现在响应中。

### 4.3 LiveKit Webhook

`POST /internal/livekit/webhook` 只接收 LiveKit 使用 Server API Secret 签名的事件，并可限制为 Docker 内部来源。它处理参与者加入/离开、轨道发布/取消和房间结束事件，用于清理加入预留、释放共享锁和维护空房时间。签名无效或重复事件不得改变状态；处理逻辑按事件 ID 幂等。

### 4.4 健康检查

- `GET /health/live`：进程存活，不访问外部依赖。
- `GET /health/ready`：SQLite 可读写且 LiveKit Server API 可访问。

## 5. LiveKit 权限

普通成员 Token：

- 允许加入指定房间和订阅。
- 允许发布 `microphone`。
- 禁止 `camera`、数据轨道和屏幕来源。
- 禁止创建其他房间或执行管理 API。
- JWT 有效期固定为 5 分钟；完整重连通过未撤销的参与者安全会话刷新。

共享者通过 LiveKit Server API 的参与者权限更新获得 `screen_share` 和 `screen_share_audio` 发布来源。撤销时先更新服务端权限，再要求客户端停止轨道。后端状态和 LiveKit 状态不一致时，以更严格的权限为准并记录审计事件。

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
- 成员列表显示昵称、麦克风状态、共享者和连接质量。
- 控制栏只包含麦克风、设备、屏幕共享、离开/结束和连接状态。
- 主持人操作通过成员菜单提供，不占用普通成员界面。
- 无共享时显示会议名称和等待状态。

## 7. 媒体实现

### 7.1 音频

请求浏览器启用 `echoCancellation`、`noiseSuppression` 和 `autoGainControl`。编码由 LiveKit/浏览器协商为 Opus。页面必须为远端音频提供用户手势后的播放恢复机制，以处理自动播放限制。

### 7.2 屏幕

- 标准模式：1920×1080 目标、30fps、4–8 Mbps 目标范围。
- 高动态模式：1920×1080 目标、60fps、8–15 Mbps 目标范围。
- 屏幕捕获请求音频，但实际是否返回音频轨道由浏览器和所选来源决定。
- 对文字类内容关闭不必要的平滑缩放；接收端保持原始宽高比。
- 启用自适应流和动态订阅；页面不可见时降低非关键渲染负载。

## 8. 定时任务与恢复

API 每 30 秒执行一次轻量清理：

1. 将过期会议置为 `expired` 并关闭 LiveKit 房间。
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

内部错误返回关联 ID，不返回堆栈、SQL、密钥或内部地址。

## 10. 完成定义

实现只有在以下条件全部满足时才算完成：功能需求逐项通过、API 契约有自动化测试、两种浏览器完成 E2E、5 人 1080p60 负载达标、两小时稳定性通过、部署和回滚在目标服务器演练成功、安全检查没有高危问题。
