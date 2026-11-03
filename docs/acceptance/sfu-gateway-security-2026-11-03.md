# SFU 网关鉴权、凭据存储与清理修复

日期：2026-11-03，香港时间。基于生产网页版本 `5012ef1` 和 API 版本 `dc07f55` 的隔离工作树实施。

## 已复现的问题

网关此前公开转发 `/api/sfu/*`，没有服务器身份校验，App Secret 内嵌在 Worker 源码中。
后台长期每五秒调用 `tracks/close` 并收到 406。白名单诊断确认 `force=true`、一条轨道、
错误码 `invalid_params`，错误描述固定词为“tracks missing mid track”。
隔离空会话对照测试确认：`mid=""` 返回 `406 invalid_params: tracks[0]: Missing mid in track`，
`mid="0"` 返回 200（不存在的轨道使用逐项 `close_track_error` 表示）。未操作现有会议的媒体资源。

根因是失败的 `tracks/new` 返回空 MID 时，服务仅检查 `typeof mid === 'string'`，
既把空字符串加入清理队列，又过早清除了不确定分配标记。无效关闭请求因此重复发送，
并可能阻塞同一用户重新分配会话。

## 修复

- API 收集和发送 MID 时使用统一非空格式校验；去重，空集合不请求上游。
- 失败分配只要缺少有效 MID，就保留原有 60 秒不确定窗口，继续检查和清理有效的迟到资源。
  没有把所有 406 都当成成功，也没有丢弃真实清理失败。
- 网关使用独立的随机 256 位 `SFU_GATEWAY_TOKEN`；服务器通过受保护配置
  `CLOUDFLARE_SFU_GATEWAY_TOKEN` 发送 Bearer 认证。
- SFU App ID、App Secret 存入 Cloudflare 加密 Secrets：`CALLS_APP_ID`、`CALLS_APP_TOKEN`。
  当前源码中移除旧 SFU 代理分支与内嵌凭据，保留原房间 Durable Object 和 TURN 行为。
- 仅允许固定会话/轨道/协商路径及对应方法，拒绝查询参数、浏览器 Origin 和无效认证。
  上游地址固定，替换身份凭据，不透传浏览器 Cookie 或服务器网关密钥；请求/响应大小受限。
- 临时诊断仅记录枚举、布尔值、数量和固定词表；最终版本移除该诊断。

## 验证与发布顺序

- 回归测试先在旧代码失败（空 MID 被重复排队），修复后通过，且证明有效与迟到 MID 仍被关闭。
- 独立审查发现并修复生产 `startServer` 单独初始化客户端时遗漏网关 Token 的问题，补充真实启动测试。
- API 共 284 项测试、21 个测试文件通过；网关及脱敏日志 13 项 Node 测试通过。
- TypeScript 生产构建、变更 TypeScript 文件 ESLint 与差异检查通过。
- 先备份并在服务器部署会发送新鉴权头的 API；旧 Worker 此时仍兼容该请求。
  确认新 API 健康及 SFU 控制请求成功后，才部署必须鉴权的 Worker。
- 发布助手在变更环境前持久化恢复记录，数据库写锁覆盖最后无会议检查与旧 API 停止，
  再释放锁启动新 API。若出现新会议则中止，保持另外四个服务容器不变。
- API 仅复制六个经过哈希核对的生产 JS 模块，在原不可变镜像上组装，不重新安装依赖。
- 首次发布若失败，在 Worker 收紧鉴权前回滚 API 和配置；收紧后不要单独回滚到不发送 Token 的旧 API。

未升级套餐，未创建付费存储。复用原 SFU 应用以保留已有会话；旧部署快照可能仍含历史 App Secret，
只保存于被 Git 忽略、受保护的目录，不发布到代码仓库。上游 App Secret 的后续轮换应与会话迁移单独协调。

## 生产验收

- API 版本：`1567742db5d44eeb25ddd311871af12f956efaa4`。
- API 发布记录：`/opt/babagan-web-meeting/var/releases/update-20261103T150729Z-sfu-security-prebuilt/`。
  23:07:47 完成 API 激活与冒烟。只重建 API；其余四个容器身份和镜像保持不变。
- 最终网关版本：`e3e61eeb-8818-45e7-985c-e22fa42ef7ce`。
- 最终日志 Worker 版本：`de54af7a-d0b8-4533-b41b-da66f25fa2be`。
- 首次候选检查发现挂载的非敏感测试脚本为 root-only，容器 UID 10001 无法读取，发布在修改生产配置前停止。
  只修正测试脚本可读权限，生产凭据仍保持 mode 600；重建包后完整预检通过。
- 网关切换后的验收发现 Workers 不支持 `redirect: "error"`，曾短暂返回 502。
  已改为 `manual` 并明确拒绝 3xx，保留鉴权和固定上游限制；增加重定向回归测试。
  该问题说明 Node 模拟测试不能替代真实 Workers 验收，没有将这段失败算作成功运行。
- 23:18:46 的生产验证记录确认：合法鉴权可以分配 SFU 会话，空/有效/重复 MID 清理验证通过，
  匿名与错误 Token 均返回 401，网关健康返回 200，五服务健康，其他四容器未重启。
  结果保存在发布目录的 `post-gateway-verification.json`。
- 线上代码逐模块检查确认：不存在旧 App Secret 字面量，不含临时诊断，原始请求日志仍关闭；
  原 TURN、ROOMS、限流绑定及内部日志绑定保留。
- 截图：工作区 `output/sfu-security-20261103/production-verification.jpg`。

## 旧部署的遗留重试

API 切换后至网关收紧前，仍观察到约每五秒一次的匿名关闭请求，最后一条 406 出现在 23:10:01；
鉴权后该类请求改为 401 拦截。不能把“上游不再收到 406”表述成“所有旧调用方已停止”。
当前生产 API 已通过真实鉴权及清理验证。

用户确认旧服务器 `121.199.0.146` 仍保留会议服务但已不再使用。指定该 IP、保持正确 TLS 主机名的
HTTPS 请求确认旧 `/health/live` 仍返回 `ok`。当前登录的阿里云账号没有该旧实例：轻量其他地域均为 0，
ECS 概览无实例。用户随后切换到旧实例所属账号并打开远程终端，确认实例 `i-bp12bqhlxygnar6ocw63` / 主机 `iZbp12bqhlxygnar6ocw63Z` 对应旧 IP。
在线房间数、参与者数和非终态会议数均为 0；旧 API 配置了网关地址，但没有新网关 Token。

23:33:49 完成旧会议栈停用：api、web、caddy、livekit、coturn 五个容器均停止，Docker 重启策略改为 `no`。
另停用并禁止 `babagan-coturn-tls.timer`，关联 service 验证为 inactive。服务器、镜像、原数据库和数据卷保留，没有删除任何服务器或卷。

旧机备份与恢复目录：`/root/babagan-retirement-20261103T153343Z/`，包含原容器身份/重启策略、SQLite 一致性备份、Compose/环境配置备份、`restore.sh` 和结果记录。
数据库备份 SHA-256：`d7f96f722be87e39d0e61b5647968d01a660fee957d164db94ca93a3c1b5a5bc`。恢复旧程序前必须先升级网关鉴权配置。

Cloudflare 对 23:34–23:36 的 `gateway_request sfu-tracks-close` 查询为 0；同一窗口有三条 `health_check ... ok` 及 `health_summary ok`。
这将旧服务停用与旧重试终止对应起来。新生产 `/health/ready` 仍为 ready，网关 `/health` 为 200；旧 IP 的 HTTPS 健康入口已不再提供服务。

上游 SFU App Secret 本轮迁入 Secrets 但未轮换；历史版本和受保护备份中的旧值尚未撤销。
新生成的网关凭据与上游 Secret 独立。此限制已明确保留，后续轮换需结合旧部署停用及会话迁移安排。

旧停用截图：`output/sfu-security-20261103/legacy-retired.jpg`；重试停止截图：`output/sfu-security-20261103/retired-retries-stopped.jpg`。
代码位于隔离分支 `codex/sfu-gateway-security-20261103`；未推送 GitHub，也未覆盖原工作树的既有改动。
