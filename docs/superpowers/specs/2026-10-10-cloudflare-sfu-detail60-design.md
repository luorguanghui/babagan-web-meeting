# Cloudflare SFU 与 detail60 设计

## 目标与范围

用户要求移除项目的 Cloudflare TURN 中继方法，增加 Cloudflare Serverless SFU 选项以降低共享者编码压力，并增加1080p60/detail画质档与明确60fps采集约束。既有“后续计划无需逐步确认”适用，继续设计、实现、验证、合并及部署；密钥传输等具体敏感操作仍按工具规则单独确认。

默认浏览器编码、H264、P2P优先保持。服务器coturn与显式LiveKit SFU保留。Cloudflare SFU由共享者在共享前选择；选择后整场屏幕共享统一经过Cloudflare，发布端仅一个video RTP sender和可选一个电脑声音audio sender，关闭P2P和LiveKit屏幕副本，最多四名观看者订阅同一发布。麦克风/会议成员/主持人权限继续LiveKit。软件编码仍可在P2P路径手动选择；Cloudflare路径明确使用浏览器编码且不启用simulcast。

旧Cloudflare TURN配置、凭据生成、信令provider、偏好入口、探测/控制逻辑和运行中的凭据环境变量移除；旧缓存cloudflare TURN选项回退auto/coturn。保留历史验收记录标识历史，不删除Cloudflare账户里的TURN资源。

## 质量与采集

新增质量代码`detail60`：1920×1080目标、frameRate=60、contentHint=detail、degradationPreference=maintain-resolution。既有motion仍60/motion。两种60fps档均在getDisplayMedia用户选定源后applyConstraints请求min/ideal/max=60，不支持则回退ideal=60；选择器请求不放min/exact。沿用源宽高比与1080p短边上限。此请求不保证实际采集/编码60fps，面板显示真实统计。

## 官方集成边界

Cloudflare已存在应用`babagan-sfu`。连接API为`https://rtc.live.cloudflare.com/v1/apps/{appId}`，App Secret仅后端使用；接口域名固定，客户端不能指定URL/appId。发布：sessions/new无body，然后tracks/new提交endpoint offer及local mids，SFU答复answer。接收：新session的tracks/new提交remote publisher session/trackName，SFU答复offer，endpoint answer经renegotiate确认。每条session变更串行化；不盲目重发不确定的分配请求，重建连接。停止用tracks/close(force=true)关闭已知mids，检查单track结果，再关闭浏览器PC。

参考：[Connection API](https://developers.cloudflare.com/realtime/sfu/api/)、[Connection patterns](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/)、[Negotiation](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/)。下载的官方OpenAPI在忽略的诊断工作区留存。

## 项目API（共享contracts固定接口）

所有路由前缀`/api/v1/meetings/:slug/screen-sfu`。所有请求使用现有participant签名cookie、Origin校验、有效会话/会议和频率限制。SDP最多65536字符，mids与sessionId限制长度，body拒绝额外字段。响应不返回密钥和配置代理地址。

- `GET /`：`{available:boolean, publication: CloudflareSfuPublication|null}`；已认证成员可读取，只返回本会议的当前有效发布。
- `POST /publish`：`{sessionDescription:{type:'offer',sdp},tracks:[{kind:'video'|'audio',mid}]}`；要求共享锁持有者，恰好一个video、最多一个audio，唯一mid。响应`CloudflareSfuSessionResponse`：`{sessionId,shareId,sessionDescription,tracks:[{kind,mid,trackName}]}`，tracks由服务端命名。
- `POST /publish/ready`：`{sessionId}`，204。端点应用answer且确认连接后调用；服务端重新校验共享锁与session归属，再将已完成的publication推送给观看者。未ready的分配30秒过期清理。
- `POST /subscribe`：`{shareId}`。订阅由服务端查本会议当前发布，不接受调用者任意publisher sessionId/trackName；禁止跨会话、跨会议、订阅旧generation。响应同`CloudflareSfuSessionResponse`，sessionDescription为offer。
- `PUT /sessions/:sessionId/answer`：`{sessionDescription:{type:'answer',sdp}}`，204；必须本会议、本身份创建的接收session，完成renegotiate后才视为有效订阅。
- `DELETE /sessions/:sessionId`：204；只清理本人会话，可重复停止。发布撤回后广播null并关闭关联订阅，禁止跨用户关闭。

`CloudflareSfuPublication`：`{shareId,sessionId,sharerIdentity,sharerName,tracks:[{kind,trackName}]}`。服务端共享锁是authority，publisher、mids、sessionId归属记录在后端内存；不把凭据/SDP/媒体写入DB或日志。限制每位成员一个发布/一个接收会话，限制每个meeting最多5个连接，未完成/失效会话有超时和清理。停止、撤权、踢出、会议结束、离会需移除发现并关闭资源；后台周期复核持有者和有效成员，弥补客户端离线未执行停止的情况。API关闭时释放服务与timer。

## 发现与前端生命周期

复用已认证P2P信令通道，仅新增server消息`{type:'screen-sfu',publication:...|null}`以及welcome可选`screenSfu`初始快照。房间registry保留publication快照，晚加入/信令重连收到当前发布；新会话只在原生video实际可用后进入共享画面，名称使用服务端sharerName。CF发布存在时不建立或请求P2P/LiveKit屏幕连接；原viewer transport偏好保留用于之后的P2P共享。

前端独立Cloudflare publisher/viewer模块封装PC、同源API、ICE gathering/connection超时、RTP发送参数、codec偏好、共享声音、关闭和统计；页面只协调源模式、授权与stage源。发送端克隆共享轨道，停止CF连接不意外结束原capture。subscribe答案按响应mid映射音/视频到一个stream。代际token淘汰旧异步结果，迟到分配必须清理；每session mutation串行。失败明确显示Cloudflare SFU错误，不静默回P2P增加编码压力。复用有效coturn配置作网络辅助，不再调用Cloudflare TURN凭据API。

原生stats来自CF连接getStats并显示“Cloudflare SFU”，不能显示为P2P/Cloudflare TURN。最多四位观看者时仍只有一份浏览器video编码输出；客户端不负责转码或为每人建立send PC。

## 配置与部署

新增可选成对`CLOUDFLARE_SFU_APP_ID`/`CLOUDFLARE_SFU_APP_SECRET`。用户明确要求SFU鉴权/会话请求不用代理：后端固定HTTPS直连，不提供SFU代理配置。无配置时available=false，UI解释未配置而非空白。不使用旧TURN token代替App Secret。部署API+web并迁移env，P2P_TURN_PROVIDER=coturn；保护性备份env和数据库/镜像，更新器沿用验证与回滚，不绕过活动会议检查。

Cloudflare TURN的旧“暂时忽略连接失败”不等于Cloudflare SFU可以跳过验收：必须验证后端实际SFU鉴权/协商与真实浏览器媒体。服务器到rtc.live.cloudflare.com曾有连接问题，按用户要求检查和解决直连连通性，保持TLS验证；不可擅自改用代理，也不可声称仅单元测试即已上线可用。

## 验收

后续实施调整：用户在直连反复失败后要求复用已有 Worker，并明确保持 Worker 内的凭证和配置。增加受限的可选 `CLOUDFLARE_SFU_GATEWAY_URL`，当前使用现有 `/api/sfu/`；不发送服务器密钥，不自动切换或重试分配，媒体仍直连 SFU。协商改为按成员串行、成员间并发；停止状态等旧权限清理完毕，明确过期会话退出清理队列。详见 [最终发布记录](../../acceptance/2026-10-10-cloudflare-sfu-release.md)。用户接手剩余功能复测，记录中未完成项不得写成通过。

1. 授权/隔离：未登录、非共享者发布、跨会议订阅/关闭、失效shareId、撤权时迟到响应、秘密脱敏。
2. 真实协商/生命周期：publish-answer、subscribe-offer/answer、partial track错误、超时不盲重试、晚加入/重连、停止/踢出/结束清理。
3. 一次编码：1到4名观看者收到画面/声音，发布端仅1 video sender/1session，不产生P2P或LiveKit屏幕副本；真实FPS/bitrate/帧输出采样。
4. detail60：picker合法、选定后明确60fps请求、拒绝回退、detail提示、30档不受影响。
5. 全量测试/lint/build、独立最终审查、实际Cloudflare线上API与浏览器闭环、服务器健康和公共资源身份。
