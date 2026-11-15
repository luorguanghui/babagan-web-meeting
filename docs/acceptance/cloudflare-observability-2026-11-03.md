# Cloudflare 安全提示核对与脱敏监控

日期：2026-11-03，香港时间。用户授权依次核对安全提示、开启脱敏日志和健康检查，优先使用免费额度。

## 安全核对

- 原有三个 Critical 提示涉及 `meet`、`rtc`、`turn.babagan.cloud`，原扫描时间 2026-10-31 21:03:08。
- 提示详情仅说明 TCP 3389 连接成功，没有提供 RDP 协议握手或实际扫描 IP。
- 复扫前确认三个业务 DNS 记录均指向迁移后的服务器，并保持 DNS only。
- 本机 DNS 返回 198.18.0.0/15 范围的代理地址，单纯 TCP connect 成功不足以判断真实端口开放。
  对当前公网 IP 发起不带凭据的 RDP 协商探测没有收到协议响应，此结果也不单独作为关闭证明。
- 22:02 在 Cloudflare 免费额度内发起一次完整复扫。复扫更新后的活动列表不再包含三条 RDP 提示，
  Critical 从 3 降为 0，活动发现从 10 降至 7。没有手动归档、忽略或标记误报。
- 复扫仍记录了账号安全与站点配置建议。本次检查期间没有更改 DNS、主机防火墙或媒体网络。
- 实际 HTTPS 响应核对：meet 返回 HSTS `max-age=31536000; includeSubDomains`；rtc、turn 当前未返回该头。
- 源码审查另发现现有 SFU 网关存在历史内嵌凭据和缺少网关访问鉴权的问题；本次保持业务协议兼容，
  后续应与项目 API 一起设计鉴权、迁移到 Secrets 并轮换旧凭据，不能只改一端导致会议中断。

## 实施

- 新建内部 `babagan-observability` Worker，无公网地址、预览或自定义路由。
- 原网关仅增加 fetch 观察包装器与 `DIAGNOSTICS` Service Binding，原模块内容逐字节保留。
- 原 `CREATE_LIMITER`、`ROOMS`、`TURN_API_TOKEN`、`TURN_KEY_ID` 绑定验证保持不变。
- 原网关原始日志/追踪关闭；内部日志 Worker 开启持久日志、关闭调用自动日志、追踪和 Issues。
- 正常请求 1% 采样，慢请求及 HTTP 错误完整记录。原请求 URL 和上下文不传到日志 Worker。
- 每 5 分钟检查 API live、API ready、Worker health，并记录结构化检查与汇总。未配置外部消息通知。

## 验证

- 7 项针对性 Node 测试通过；独立代码审查无阻断项。
- Wrangler 生产打包及部署成功，确认无公网 URL，Cron 为 `*/5 * * * *`。
- 网关已部署版本为 `937d6392-154b-4dd0-b7ce-87c958fe0f45`，原版本为 `4f9eab7f-27b2-4f3f-b86e-4f6cdd7b972a`。
- 三个公网健康接口手动验证返回 200 且内容匹配。本机默认 Python User-Agent 曾收到 403，换为普通浏览器 User-Agent 后成功。
- 已在控制台观察到真实网关日志，附加元数据仅包含固定内部 URL，没有原会议 URL；其中 SFU tracks-close 重复返回 406，保留为后续调查线索。
- 上传源码及原绑定验证结果、受保护源备份与恢复材料保存在 `/var/cloudflare-observability-20261103/`，不进入 Git。
- 日志 Worker 最终版本为 `d0d593a8-734a-42df-8baa-f0f3ed1ba4d9`。
- 首轮定时任务于香港时间 **22:20:08.095** 写入日志：`api-live`、`api-ready`、`gateway-health` 三项均为 `ok`，
  汇总 `health_summary ok`。这验证了 Cloudflare 边缘定时执行与日志落库，不仅是本机手动请求。

安全复扫截图：`output/cloudflare-observability-20261103/security-rescan.jpg`。
首轮健康检查截图：`output/cloudflare-observability-20261103/health-checks-ok.jpg`。
配置、测试和运维说明见 `infra/cloudflare-observability/README.md`。

SFU 凭据迁移、网关鉴权与 406 清理问题的处理见[后续修复记录](sfu-gateway-security-2026-11-03.md)。
