# Cloudflare SFU、连续共享与 Worker 发布记录

## 当前部署

- 应用代码：`e88a22bdba5792336e62550cd9033e50aeafde69`，2026-10-10 21:54:44 香港时间完成部署验证。
- 发布目录：`/opt/babagan-web-meeting/var/releases/update-20261010T135316Z-3791978`。
- 发布状态：`deployed-and-verified`，`cloudflareSfuApiVerified=true`，无未解决的部署标记。
- API、Web、Caddy、LiveKit、coturn 五个服务健康。公网脚本 `/assets/index-DKIRQZzJ.js` 与容器文件 SHA-256 一致：`fa943b13d0894262edf8b8f9a7eb10047381448cbd0601cc14d005bba35953f3`。
- 回滚脚本：发布目录下的 `rollback.sh`。生产环境文件权限为 `0600`；原配置及数据库备份保留在受保护目录。

## 最终配置选择

用户最后选择保持现有 `babagan-p2p` Worker 的代码、应用 ID 和密钥配置不变。项目后端设置：

```dotenv
CLOUDFLARE_SFU_GATEWAY_URL=https://p2p.babagan.cloud/api/sfu
P2P_TURN_PROVIDER=coturn
```

当前生产环境不再包含 `CLOUDFLARE_SFU_APP_ID` / `CLOUDFLARE_SFU_APP_SECRET`。应用后端调用现有 Worker 的会话路径，不发送服务器 Authorization header；Worker 自己提供已有的 SFU 凭证。浏览器只访问项目的已认证接口，媒体仍直接连接 Cloudflare SFU。没有部署或修改 Worker 代码；也未删除账户中的旧 SFU 应用。

直连模式仍可通过成对设置 App ID/Secret、清空 gateway 来启用。部署检查验证当前实际选择的模式，不能使用原 Cloudflare TURN 的豁免跳过检查。

## 修复与证据

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| Cloudflare TURN 已移除，仍显示提供方下拉框 | 固定使用服务器 coturn，移除提供方选择，保留观看者 TURN 接收路径 | UI 回归；真实设置页确认无该控件 |
| 停止时提前变成 idle，旧清理可影响新发布 | 增加 stopping 状态；等待旧发布及权限释放后才开始新捕获 | 快速 stop/start 回归先失败、修复后通过 |
| 四位观看者被会议级锁串行阻塞 | 按成员串行、成员间并发；同步预留容量，清理不嵌套等待其他成员锁 | 四条各 17 秒协商回归通过；失败关闭后换共享者并结束会议不死锁 |
| 15 秒前端截止早于后端分配预算 | 会话 HTTP 截止改为 45 秒，无自动分配重试 | 17 秒成功响应回归通过 |
| 已有候选但某个 STUN 请求未结束，ICE 等待误失败 | 有候选时在有界截止后继续；仍检查 connected 和实际发送视频 | 发布、订阅候选回归；真实 Edge 发布成功 |
| 停止后旧 SFU 会话永久停留在清理队列 | 仅在已拥有资源的检查/关闭操作收到明确 `410/session_error` 时退役记录 | 真实停止再发布返回 cleanup503；旧会话 GET/close 确认 410；回归修复后新发布返回 200 |
| 服务器直连 SFU 不稳定，发布冒烟失败 | 复用用户现有 Worker 路由；Worker 配置保持原样 | 服务器无凭证调用 Worker 返回 201；最终部署会话与能力检查通过 |

`410/session_error` 的处理依据 [Cloudflare 会话错误语义](https://developers.cloudflare.com/realtime/sfu/observability/error-codes/)；不把其他状态、权限错误、网络失败或未确认结果当成资源已关闭。

## 已进行的浏览器验证及限制

真实 Edge 浏览器使用合成的 1920×1080 连续运动画面及音频测试，不捕获用户桌面。此前 Worker 发布版本验证了单观看者、四观看者、晚加入、H.264 视频与 Opus 音频接收，以及发布端始终只有一个 video sender；60fps 档实际提交 `min/ideal/max=60`、`detail` 提示。

同一台机器同时运行一个发布页面和四个解码页面会增加本地负载：单发布采样曾为 61fps，五页面采样约为发送 40fps、接收 34–41fps。这些结果证明传输和一路编码行为，不是不同设备条件下稳定 60fps 的承诺。

在最终 `e88a22b` 版本复测中，发布成功，三位观看者正常接收，一位首次订阅出现 503，显式重试未确认恢复。随后用户明确要求将功能复测交由用户进行，助手停止继续媒体测试。最终版本的连续多轮重新共享、不同设备帧率及订阅稳定性仍由用户复测，不标记为全部通过。

助手已离开所有诊断成员，删除自己创建的测试会议并关闭诊断浏览器；未结束用户会议。

## 自动检查

- Worker 路由集成时全量 862 项测试通过，类型检查、lint、生产构建通过。
- 最后过期会话修复：API 全量 268 项通过（之后再增加一项不确定分配检查）；最终路由 28 项及独立审查聚焦 46 项通过。
- 更新器 16 项回归通过；Windows 文件锁检查跳过，真实 Linux 发布路径验证成功。
- 部署冒烟覆盖仅 gateway 配置、失败阻止发布及临时会议清理。实际服务器 Compose 渲染检查通过。

合并记录：[SFU 主功能 #13](https://github.com/luorguanghui/babagan-web-meeting/pull/13)、[ICE 截止 #15](https://github.com/luorguanghui/babagan-web-meeting/pull/15)、[重启/并发 #16](https://github.com/luorguanghui/babagan-web-meeting/pull/16)、[现有 Worker #17](https://github.com/luorguanghui/babagan-web-meeting/pull/17)、[过期清理 #18](https://github.com/luorguanghui/babagan-web-meeting/pull/18)。
