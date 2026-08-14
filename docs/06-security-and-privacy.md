# 安全与隐私设计

## 1. 保护目标

- 未授权用户不能创建、管理或加入受密码保护的会议。
- 普通成员不能获得主持人或屏幕共享权限。
- 密码、Cookie、LiveKit Secret 和 Token 不得泄露。
- 会议音频和屏幕内容不落盘、不进入日志、不用于分析。
- 服务应抵抗小规模暴力尝试、链接扫描和常见 Web 攻击。

## 2. 威胁模型

| 威胁 | 主要控制 |
|---|---|
| 猜测会议链接 | 至少 128 位随机熵的 slug、统一失败响应 |
| 暴力猜管理/会议密码 | Argon2id、每 IP/会议限速、指数退避和审计 |
| 主持人会话窃取 | Secure/HttpOnly/SameSite Cookie、短时效、结束即撤销 |
| Token 重放 | 短 TTL、绑定房间与身份、移除时撤销权限并断开 |
| 越权屏幕共享 | 服务端共享锁、LiveKit 发布来源限制、权限更新审计 |
| P2P 信令越权（P2P 新增） | WS 握手校验参与者 Cookie 与同源 Origin；服务端强制"仅共享者发 offer、应答与 media-ready 仅能回共享者"；非法目标拒绝 |
| P2P 信令放大/滥用（P2P 新增） | 消息 64 KiB 上限、单连接速率限制、在线表仅限本会议成员 |
| SDP/ICE 泄露（P2P 新增） | 日志禁用 SDP 全文、ICE 候选与配置；信令经 WSS 加密；仅下发 STUN URL 与参与者绑定的短期 TURN 凭据（TTL 600 秒） |
| XSS/CSRF | React 安全渲染、CSP、Origin 检查、SameSite Cookie |
| SQL 注入 | 参数化语句、Schema 校验、数据库最小权限 |
| 媒体窃听 | HTTPS/WSS、ICE、DTLS-SRTP、证书严格校验；P2P 直连媒体不经服务器；经 coturn TURN 中继时 coturn 只转发加密 SRTP 包、不解密、不落盘 |
| 对端 IP 暴露（P2P 新增） | WebRTC 直连固有特征，UI 与文档说明；不使用媒体外流量，DTLS 指纹防劫持 |
| 资源耗尽 | 单房间/5 人、请求大小限制、连接和密码限速 |
| 容器/主机入侵 | 最小镜像、非 root、只读文件系统、补丁、端口白名单 |
| 日志泄露 | 字段白名单、敏感字段脱敏、权限和保留期 |

## 3. 身份与权限

### 3.1 管理密码

生产环境只保存 `ADMIN_PASSWORD_HASH`，使用 Argon2id 参数满足当时服务器可接受的约 200–500ms 校验成本。启动或配置工具在受控终端生成哈希，明文不进入 Compose、Shell 历史或代码仓库。

### 3.2 主持人会话

- 使用密码认证后产生 256 位随机 Token。
- 浏览器 Cookie 名使用 `__Host-` 前缀，设置 `Secure; HttpOnly; SameSite=Strict; Path=/`。
- 数据库保存 Token 的 SHA-256 哈希。
- 会话有效期不超过会议有效期，结束会议后立即撤销。

参与者会话采用独立的 256 位随机 Token、哈希存储和 `__Host-` 安全 Cookie。它只能为原会议和原身份刷新短期 LiveKit Token；成员被移除、会议结束或会议到期时立即撤销。

### 3.3 会议密码

使用 Argon2id 和独立随机 salt。加入失败不说明是会议存在性、密码还是权限细节造成的内部差异；UI 只显示适当的用户级错误。

### 3.4 LiveKit Token

- API Secret 只存在服务器 secret 中。
- Token 只允许一个房间和一个唯一身份，有效期固定为 5 分钟。
- 默认允许订阅和麦克风发布，禁止摄像头、数据和屏幕来源。
- 主持人授权后才由 Server API 增加屏幕来源。
- 完整重连使用安全的参与者会话 Cookie 获取新 Token；被移除成员的会话立即撤销。
- LiveKit Webhook 发现被撤销身份重新连接时立即移除，限制旧 Token 的短暂重放窗口。
- Token 不写入 URL、日志、分析事件或持久浏览器存储。

## 4. Web 安全

最低响应头：

- `Content-Security-Policy`：仅允许自身脚本/样式、批准的 WSS 和媒体连接。
- `Strict-Transport-Security`：确认全站 HTTPS 稳定后启用。
- `X-Content-Type-Options: nosniff`。
- `Referrer-Policy: no-referrer`。
- `Permissions-Policy`：仅顶层自身来源使用麦克风和屏幕捕获相关能力。
- `frame-ancestors 'none'` 或等效防点击劫持策略。

API 只接受 `https://meet.babagan.cloud` 的浏览器来源。修改请求验证 `Origin` 和 JSON Content-Type；P2P WebSocket GET 握手也必须显式验证同源 `Origin`，缺失或跨站来源返回 403。所有入口限制请求体、字段长度、连接时间和并发。

## 5. 传输与证书

- Cloudflare 到源站使用 Full (strict)。
- `rtc` 直接连接必须使用公众信任的有效证书。
- 禁止 TLS 1.0/1.1，启用现代 TLS；证书自动续期并监控。
- WebRTC 媒体使用 DTLS-SRTP。P2P 屏幕媒体（视频 + 音频）在浏览器之间加密传输：直连（host/srflx）不经服务器；经 coturn TURN 中继时 coturn 只转发加密 SRTP 包、无法解密且不落盘。LiveKit 路径（麦克风音频与回退屏幕）中，LiveKit 节点是信任边界，必须限制主机管理员权限。
- P2P 信令（SDP/ICE）经 WSS 传输；客户端以 DTLS 指纹与源校验拒绝未经信令协商的连接，防止第三方伪冒对端。

## 6. 数据最小化与保留

| 数据 | 是否保存 | 保留 |
|---|---|---|
| 音频/屏幕媒体 | 否 | 不落盘；P2P 直连不经云端，经 coturn TURN 中继时仅转发加密 SRTP、不落盘 |
| P2P 信令（SDP/ICE） | 否 | 仅内存转发，不落日志 |
| 真实姓名、手机号、邮箱 | 否 | 不收集 |
| 昵称 | 仅在线状态/短期审计所需 | 会议结束后删除或匿名化 |
| 会议密码 | 仅哈希 | 会议终态后删除 |
| 主持人会话 | 仅 Token 哈希 | 会议终态后删除 |
| 审计事件 | 是，最小字段 | 30 天 |
| 应用日志 | 是，脱敏 | 14 天 |
| 备份 | 加密 | 7 个每日版本 |

产品界面需清楚说明：系统不录制会议。屏幕画面在参与者之间直接传输（网络不支持时经自托管服务器中继）；语音经自托管 LiveKit 服务器实时转发。

## 7. 日志规则

禁止记录：管理密码、会议密码、哈希完整值、Cookie、Authorization、LiveKit Token/Secret、SDP 全文、ICE 候选与凭据、麦克风或屏幕内容。

允许记录：UTC 时间、关联 ID、匿名会议 ID、匿名主体 ID、事件类型、结果、延迟、错误分类和聚合网络质量。公网 IP 如因安全审计确需记录，应截断或哈希，并遵守 30 天上限。

P2P 信令日志只允许记录事件类型（连接建立/断开、offer/answer/ice 计数、权限拒绝），不得记录消息载荷。

## 8. Cloudflare 与源站

`meet` 橙云可使用 Cloudflare WAF、DDoS 防护和速率限制；`rtc` 与 `turn` 灰云会暴露源站 IP，这是 WebRTC 直连设计的已知结果。源站安全不能依赖隐藏 IP，必须依赖防火墙、服务认证、补丁和最小端口。

Cloudflare 不缓存 `/api/*`、会议页面中的个性化响应或任何 Token。静态带哈希资源可以长期缓存，入口 HTML 使用短缓存或不缓存。

## 9. 依赖与主机安全

- 使用受维护的 Debian、Node.js LTS、Caddy、LiveKit 和前端依赖。
- 容器以非 root 运行，删除不需要的 Linux capabilities，设置只读根文件系统和资源限制。
- Secret 使用权限受限文件或 Docker secret，不进入环境转储和诊断包。
- 每周检查安全更新；高危远程漏洞在确认兼容后优先修复。
- SSH 只允许密钥登录，禁止 root 和密码登录，来源限制为管理员网络。

## 10. 事件响应

发现泄露或入侵时：

1. 禁止新会议并保留必要的脱敏日志。
2. 终止活动会议，轮换 LiveKit Secret、Cookie Secret 和管理密码哈希。
3. 审查 Cloudflare、主机、防火墙和应用审计事件。
4. 从可信镜像和配置恢复，验证数据库与备份完整性。
5. 完成安全回归测试后恢复服务。
6. 记录原因、影响范围、修复和预防措施，不在报告中包含会议媒体。
