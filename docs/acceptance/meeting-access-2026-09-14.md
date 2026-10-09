# 会议链接访问故障：2026-09-14

## 故障证据

- 用户报告会议开启一段时间后，新设备打开会议链接缓慢或显示 Cloudflare Host 错误，最近发生于当天午后。
- Cloudflare Domain Dashboard（过去 24 小时，GMT+8）显示 23 次回源连接失败；状态排行含 9 次 522、8 次 525。成功到达源站的请求没有源站 5xx。
- LAX 节点的当前会议接口：14 次请求，连接失败率 21.43%，p95 29.1 秒。LAX 的 ICE 配置接口：34 次请求，连接失败率 14.71%，p95 44.7 秒。
- Caddy 在 9 月 13 日和 14 日记录了向 Cloudflare 发送前端脚本时 `connection reset by peer`。本地静态上游开始响应约 2 毫秒。
- 排查时 API、web、Caddy、LiveKit、coturn 均健康，连续运行 6 天；CPU 负载约 0.01，可用内存约 877 MiB，磁盘剩余约 33 GiB，conntrack 33/65536。未发现近期 OOM/conntrack 内核异常。
- 直接用正确域名/SNI 访问源站，会议页面和完整 JS 均返回 200，HTTPS 证书校验正常，`/health/ready` 返回 ready。

结论：已证实 Host 错误发生在 Cloudflare 到源站的 TCP/TLS 连接阶段，不是源站应用返回 5xx。具体中间网络丢包位置未取证；也没有证据证明会议运行时长本身导致源站资源耗尽。

## 访问链路调整

- 用户明确同意推荐方案后，将 `meet.babagan.cloud` 的 A 记录从 Proxied 改为 DNS only，地址和原链接保持不变，保留 Caddy HTTPS。
- Cloudflare 控制台保存完成；独立 DNS-over-HTTPS 查询返回源站 A 记录、TTL 300 秒；服务器解析及 HTTPS 访问确认直连，健康检查约 0.13 秒。
- rtc、turn 仍使用原先的 DNS only 记录；媒体服务配置没有变化。
- 这意味着会议域名不再经过 Cloudflare 的代理安全与缓存功能；应用鉴权和 HTTPS 保留。
- 旧文档、`firewall-attestation.sh` 和完整部署流程中的 `meet proxied` 检查仍是旧方案。后续完整部署须先更新并验证相应证据检查，不应为通过旧检查而恢复橙云。

## 独立的客户端重试缺陷

API 12 小时日志包含 5,676 次 401；Cloudflare 显示同一参会浏览器请求 ICE 配置约 5,600 次。源码在初始获取、定期刷新及 offer 触发的刷新失败后每 2 秒无限重试，没有区分失效会话。

修复在单次 join effect 内锁定 HTTP 401/403/404/410，取消相关重试/刷新定时器，丢弃待处理信令，阻止过期请求结果重新启动刷新。新的 join effect 可重新获取凭据；临时 503/网络异常仍可重试。这一缺陷增加了无效流量，但未证实它导致上述 TCP/TLS 回源故障。

验证：新增 5 项回归测试，修改前明确复现一分钟内数十次多余请求；修改后全部 532 项前端测试、目标文件 ESLint、TypeScript/Vite 构建通过。独立审查未发现高置信度问题。构建保留已有的大 JS chunk 提示。

## 发布与回滚

线上基线为 `39de3d802f383a55fdebaf85a005d0de436340d6`，目录 `/opt/babagan-web-meeting`。仅上传本次 `meeting-room-page.tsx` 补丁；线上修改前文件 SHA256 与本地基线一致，补丁与修改后文件均校验 SHA256，未上传其他未提交修改。

- 补丁 SHA256：`9d2c25e96ea83816e488fcf91a71ad423488a2e06e93111825081c103e5218ce`
- 修改后页面源码 SHA256：`75477a21745691d454b44d45fef8cf900bb6f43b20939a62bbc623aa6f99e4c1`
- 目标镜像：`babagan-meeting-web:ice-session-retry-20260914`
- Compose overlay：`var/releases/ice-session-retry-20260914.override.yml`，追加在基线 release overlay 之后。
- 保留原基线镜像。网页回滚使用原 Compose 与基线 release overlay，省略本次 overlay，执行 `up -d --no-deps web`。
- DNS 回滚可将 meet 恢复 Proxied，但会重新引入已发现的回源链路问题。

发布于当天约 21:43 GMT+8 完成，仅重建 web 容器，其他服务仍保持运行。线上 JS 为 `assets/index-BrIlJeSV.js`（服务器基线与本地其他未提交改动不同，因此不要求整个 JS hash 与本地构建相同）。

最终验证：

- 新镜像构建退出码 0，web 健康，API/Caddy/LiveKit/coturn 均健康。
- 公网新脚本返回 200，994,451 字节；指定正确 SNI 的直连 HTTPS ready 连续 3 次 200，耗时 0.21–0.28 秒。
- 内置浏览器新请求正常打开 `/create` 页面。首次首页请求遇到重定向缓存问题，使用新请求后正常；本机存在返回 198.18.* 地址的 DNS 代理，默认解析访问仍有偶发 TLS 失败，固定源站地址的对照访问正常。未更改用户的本机代理设置。
- 原 `deployment-smoke.sh` 的健康/网页/有鉴权 ICE/cross-origin 拒绝检查通过，但其立即在 open 回调关闭连接的 WebSocket 检查报错，完整脚本退出 1，不能记录为完整冒烟通过。
- 独立探针使用新签发的短期 Token，连接 `wss://meet.babagan.cloud/rtc`，确认 `WS_OPEN_OK` 和 `WS_JOIN_MESSAGE_OK`，随后关闭连接并清理测试房间。这验证了带鉴权的实际信令握手与首条入会消息。

没有完成真实多设备长时会议验收；不能据短时 HTTP 和信令检查声称已覆盖所有网络和长会场景。页面长期开着的旧客户端须刷新才会载入停止 401 重试的修复。
