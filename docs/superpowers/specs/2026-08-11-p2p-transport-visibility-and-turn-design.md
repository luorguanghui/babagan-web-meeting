# P2P 链路可见性与同机 TURN 设计

## 目标

修复 P2P 观看端的 WebRTC 统计一直停留在“正在收集”的问题，并在共享画面中明确显示当前媒体链路。为提高复杂 NAT、CGNAT 和受限网络中的自定义 WebRTC 连接成功率，在现有服务器部署独立 coturn，不增加服务器或公网 IP。

## 范围

- 共享画面显示 `P2P 直连`、`TURN 中继`、`SFU 中转`、`混合模式` 或 `正在建立连接`。
- WebRTC 统计读取当前实际承载共享画面的 PeerConnection；P2P/TURN 不再读取已取消订阅的 LiveKit 轨道。
- 当前服务器新增独立 coturn，监听 `3478/UDP+TCP`、`5349/TCP TLS`，使用 `49160–49200/UDP` 作为中继端口范围。
- API 通过现有参与者 Cookie 鉴权后签发短期 TURN REST 凭据。
- 保留 LiveKit 屏幕轨道作为 SFU 安全网；保留 LiveKit TURN/UDP 443，不与 coturn 抢占端口。

不包括新增服务器、第二公网 IP、强制所有连接经过 TURN、音频链路改造或历史统计报表。

## 链路状态模型

观看端状态扩展为：

- `negotiating`：正在建立自定义 PeerConnection。
- `p2p`：选中的 candidate pair 不包含 relay，且视频 RTP 正常增长。
- `turn`：选中的 candidate pair 包含 relay，且视频 RTP 正常增长。
- `livekit`：自定义 PeerConnection 失败或停流，已切换到 LiveKit。

共享端按每位观看者的状态派生整体标识：全部直连显示 `P2P 直连`；全部通过 TURN 显示 `TURN 中继`；存在两种以上已建立路径或有人使用 SFU 时显示 `混合模式`；尚未完成协商显示 `正在建立连接`；没有观看者时显示 `等待观看者`。

`p2p-media-health` 返回 `direct | relay | unknown`，不再把 relay 当作失败。只有没有可用 candidate pair、协商超时、ICE 失败或 RTP 连续停流时才触发 SFU 回退。

## 统计数据流

`P2pViewerController` 暴露当前 PeerConnection 的统计报告；`P2pShareController` 暴露所有处于 P2P/TURN 状态的观看者统计报告。页面根据链路状态选择数据源：

- 观看端 P2P/TURN：读取 viewer controller。
- 共享端 P2P/TURN/混合：读取 share controller，并汇总各观看者 outbound RTP。
- SFU：读取现有 RoomController 的 LiveKit 报告。
- 协商阶段无报告时才显示“正在收集”。

统计轮询仍为每秒一次，失败仅影响诊断显示，不中断会议。

## 界面

链路标识位于共享舞台右上角，使用现有深色半透明会议视觉，不遮挡内容；绿色表示直连，蓝色表示 TURN，灰蓝表示 SFU，琥珀色表示混合或协商。标识带文字而非仅靠颜色，并通过 `role=status`/`aria-live=polite` 通知链路切换。统计面板标题旁同步显示当前模式。

## coturn 与凭据

coturn 使用 host networking，镜像固定版本和 digest，启用 `use-auth-secret`，共享密钥通过受保护环境变量注入。API 为每个已认证参与者生成带到期时间和参与者身份的用户名，并使用 HMAC-SHA1 生成 credential；默认有效期 10 分钟。响应示例：

```json
{
  "iceServers": [
    { "urls": ["stun:turn.babagan.cloud:3478"] },
    {
      "urls": [
        "turn:turn.babagan.cloud:3478?transport=udp",
        "turn:turn.babagan.cloud:3478?transport=tcp",
        "turns:turn.babagan.cloud:5349?transport=tcp"
      ],
      "username": "<expires>:<participant>",
      "credential": "<short-lived-hmac>"
    }
  ]
}
```

`turn.babagan.cloud` 必须保持 DNS-only。Caddy 为该域名取得受信任证书，coturn 以只读方式读取证书；证书续期后通过受控重载或容器重启生效。coturn 限制 realm、用户配额、总配额和中继端口范围，不允许匿名 TURN。

## 部署与安全

阿里云安全组和主机防火墙仅新增：

- `3478/UDP+TCP`
- `5349/TCP`
- `49160–49200/UDP`

不得开放 coturn 管理接口。部署前验证端口未被占用、DNS 指向当前公网 IP、证书域名匹配；部署后使用临时凭据验证 relay candidate，并确认错误、过期和无 Cookie 请求无法获取或使用凭据。

TURN 会消耗服务器双向带宽，因此继续优先 direct candidate，不设置 `iceTransportPolicy: relay`。最多五人场景使用窄中继端口范围和配额，超出容量时保留 SFU 回退。

## 测试与验收

- 单元测试：candidate pair 分类为 direct/relay/unknown；relay RTP 正常时进入 `turn` 而非回退。
- 控制器测试：P2P/TURN 统计报告可读取，关闭后不再返回；RTP 停流仍回退 SFU。
- 页面测试：五种模式文案、混合派生规则、P2P/TURN 使用正确统计源、SFU 使用 LiveKit 统计源。
- API 测试：配置校验、短期凭据 HMAC、Cookie 鉴权、到期时间和响应不泄漏共享密钥。
- 部署测试：Compose 安全约束、固定镜像、端口范围、证书挂载、生产配置和回滚记录。
- 生产验收：分别获得 srflx/host、relay 和 SFU 路径；模式标识与 candidate pair 一致；统计在首个采样周期内出现并持续更新；四个现有服务与 coturn 均健康。

## 失败处理

coturn、证书或凭据请求失败时不阻断加入会议；客户端继续尝试 STUN 直连，失败后使用现有 SFU 安全网。链路切换保留旧画面直到新源首帧，避免黑屏。部署失败保留当前生产版本、数据库备份和受保护事务记录。
