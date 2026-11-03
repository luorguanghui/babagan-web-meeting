# Cloudflare 脱敏日志与健康检查

部署日期：2026-11-03，Cloudflare Workers Free。

## 运行方式

`babagan-p2p` 通过 `gateway-entry.mjs` 包装 fetch；SFU 路径由 `sfu-gateway.mjs` 强制鉴权，原房间及 TURN 实现保存在 `legacy-room-worker.mjs`。
包装器通过内部 Service Binding `DIAGNOSTICS` 向 `babagan-observability` 发送经过白名单约束的事件。
日志 Worker 的 workers.dev、预览 URL 和自定义公网路由均关闭。

原网关的原始请求日志及追踪继续关闭。这是必要的隐私边界：原接口可能在查询参数中携带令牌，
Cloudflare 会在自定义 console 日志上附加当前请求的 URL 元数据。
独立日志 Worker 只看到固定的 `https://diagnostics.internal/event`，没有原始请求上下文。

日志字段仅包含接口类别、HTTP 方法枚举、状态码、耗时、结果类别以及固定生成的摘要。
不记录原 URL、查询参数、会议或会话 ID、IP、Cookie、Authorization、请求/响应体、异常文本、SDP 或媒体。
正常且耗时小于 2 秒的请求采样 1%；HTTP 4xx/5xx、异常和慢请求记录 100%。日志写入失败不改变原响应。
此通道覆盖网关 HTTP 处理，不收集房间 Durable Object 的内部事件和浏览器媒体统计。

## 健康检查

Cron：`*/5 * * * *`（UTC；每五分钟一次）。固定检查：

| 名称 | 地址 | 成功条件 |
|---|---|---|
| api-live | `https://meet.babagan.cloud/health/live` | 200，`status=ok` |
| api-ready | `https://meet.babagan.cloud/health/ready` | 200，`status=ready` |
| gateway-health | `https://p2p.babagan.cloud/health` | 200，`service=babagan-p2p` |

每个请求 8 秒超时，响应体最多读取 4 KiB，不跟随重定向。三次检查并发执行，输出三条检查记录和一条汇总。
检查结果为 `ok`、`http_error`、`invalid_response`、`timeout` 或 `network_error`。
这能检查 API 进程、数据库/LiveKit 控制连接与网关入口，不能证明真实 WebRTC 发布、订阅、TURN 或媒体质量正常。
当前没有邮件、短信或聊天通知投递，也没有连续失败计数；通过 Cloudflare 日志查看失败和恢复记录。

## 查看结果

控制台：Workers & Pages → `babagan-observability` → Observability。

- `event = health_check`：各端点检查。
- `event = health_summary`：整轮检查，`failures > 0` 表示异常。
- `event = gateway_request`：网关事件；筛选 `route`、`status`、`outcome`。

不要只看面板的 Worker Errors：HTTP 406 等业务响应不会自动计为 Worker 运行时异常。

## 免费额度

健康检查每天 288 轮，产生 1,152 条日志，另加网关采样/异常记录。全部 Worker 共用账号额度；
按本次观察到的网关约 2 万请求/日估计，有空间容纳新增调用，但异常率升高会增加日志量。
截至部署日，Workers Free 为每日 10 万请求；Workers Logs 为每日 20 万事件、保留 3 天。
没有开通付费套餐、R2、D1、KV 或收费通知服务。
官方已公告 2026-12-01 日志计费迁移到 Observability，届时复核免费限额。

## 本地验证与部署

```powershell
node --test infra/cloudflare-observability/observability.test.mjs
npx wrangler@4.156.2 deploy --config infra/cloudflare-observability/wrangler.jsonc
```

上面的 deploy 只更新日志 Worker。网关包装器须从当前线上版本重新取得原模块并核对 SHA-256、部署版本及全部绑定，
保留兼容日期、原 Durable Object 命名空间、限流器和 secrets，再以最小模块集合部署。
不要直接在此目录运行未指定配置的 deploy，也不要将旧快照覆盖到已经更新的线上版本。

**旧网关备份含历史内嵌凭据，只保存在被 Git 忽略的 `/var/` 下。当前源码已移除这些凭据，部署时必须保留 Worker Secrets。**
本次受保护备份目录：`var/cloudflare-observability-20261103/`。
其中包含原版本、配置、源文件、上传结果和验证记录。日志代码本身没有凭据。

## 回滚

原网关版本：`4f9eab7f-27b2-4f3f-b86e-4f6cdd7b972a`。
本次网关版本：`937d6392-154b-4dd0-b7ce-87c958fe0f45`。

需要回滚时先核对当前版本仍为本次部署版本，以免覆盖后续更新；通过控制台 Deployments 回滚至原版本，
并核对原四个绑定、原始日志关闭状态以及 `/health` 返回正常。无需重建或删除原 Durable Object。
若只暂停健康检查，移除日志 Worker 的 Cron 触发器即可；如果要停用整个日志 Worker，应先移除网关的调用/绑定。

参考：[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、
[Observability 定价](https://developers.cloudflare.com/observability/pricing/)。

## SFU 网关凭据

Worker Secrets：`CALLS_APP_ID`、`CALLS_APP_TOKEN`、`SFU_GATEWAY_TOKEN`。服务器的 `CLOUDFLARE_SFU_GATEWAY_TOKEN` 必须与第三项一致，独立于 SFU App Secret。只保存于 mode-600 生产配置，不下发浏览器、不写日志、不提交 Git。

新版本先更新 API、确认认证请求成功，再启用网关强制鉴权。强制鉴权后，不要单独回滚到不发送鉴权头的旧 API。详见 `docs/acceptance/sfu-gateway-security-2026-11-03.md`。
