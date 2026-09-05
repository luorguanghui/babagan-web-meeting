# Cloudflare TURN 路径探测与屏幕共享自适应设计

日期：2026-09-03

当前覆盖决定（2026-09-05）：操作方明确要求生产构造启用 `control`。
原观察阶段的验收仍未伪装为已完成；部署前若真实双端验证失败，应切回
`observe`。

## 1. 目标

在共享者实际使用 Cloudflare TURN 中继时，使用与 TURN 路径绑定、且不依赖当前屏幕媒体传输上限的主动探测，估计共享者到 Cloudflare TURN 网络的可用传输能力。用户/画质档位定义的目标码率保持不变；探测结果用于提高每名观看者的传输码率上限，并在持续真实拥塞时平滑降低传输上限和像素采样量，以稳定目标帧率。

设计必须消除以下自限流闭环：

```text
媒体传输码率上限低
  -> 实际发送量低
  -> 浏览器带宽估值低
  -> 应用继续降低媒体传输码率上限
```

本文统一使用以下术语：

- `profileTargetBitrateBps`：用户选择的画质档位目标码率；同一次共享中保持不变，是画质恢复基准。
- `transportBitrateCapBps`：应用动态写入 `RTCRtpEncodingParameters.maxBitrate` 的传输码率上限。
- `encoderTargetBitrateBps`：浏览器通过 WebRTC stats 报告的编码器瞬时目标，只读。
- `actualOutgoingBitrateBps`：通过 RTP 字节差计算的实际发送码率，只读。

浏览器 API 只能提高 `maxBitrate` 上限，不能强迫静态画面或低复杂度内容产生额外编码数据。因此本文中的“提高传输码率”指提高 `transportBitrateCapBps`，实际发送码率仍由内容、编码器和 WebRTC 拥塞控制共同决定。

## 2. 非目标和边界

- 不把 `speed.cloudflare.com` 的 HTTPS 上传结果称为 TURN 路径容量，也不再让它参与媒体控制。
- 不声称可以从浏览器精确测量媒体 PeerConnection 的同一个物理 TURN allocation。浏览器和 Cloudflare 均未提供该第一跳的专用带宽测试 API。
- 不强制浏览器发送超过 WebRTC 自身拥塞控制允许的流量。
- 不让一个弱接收端降低其他观看者的传输码率上限或全局 TURN 探测结果。
- 不改变 P2P 直连、coturn 和 LiveKit SFU 安全网的现有策略。
- Cloudflare 模式继续不使用现有的共享总上行预算分配器；每名观看者保持独立 sender 控制。

## 3. 现有系统

共享者为每名观看者创建独立的 `RTCPeerConnection`。每个连接可处于 `p2p`、`turn` 或 `livekit-fallback`。共享者始终保留 LiveKit 屏幕安全网，P2P/TURN 失败的观看者可以单独回退。

Cloudflare TURN 凭据由服务端使用长期 Key ID 与 API Token 生成，浏览器只收到短期 ICE 配置。Cloudflare TURN 使用 Anycast，将 allocation 放置在离 TURN client 最近的可用 Cloudflare 数据中心。

当前实现的问题是：

- 使用 `https://speed.cloudflare.com/__up` 的 HTTPS 测速作为 Cloudflare TURN 控制器输入；该请求不经过 TURN allocation。
- `availableOutgoingBitrate` 是当前 candidate pair 上 WebRTC 拥塞控制的估值，会受当前发送量和接收端反馈影响。
- `actualOutgoingBitrate` 只表示媒体实际产生和发送的字节；静态画面或应用限码会使它低于链路容量。
- 上述数值如果直接成为下降依据，会产生自限流。

## 4. 方案比较与决策

### 4.1 方案 A：浏览器内双 Cloudflare relay 回环

共享者浏览器创建两个临时 `RTCPeerConnection`，两端都使用同一批短期 Cloudflare ICE 配置并强制 `iceTransportPolicy: "relay"`。浏览器在本地交换 SDP 和 ICE，建立不可靠、无序 DataChannel：

```text
浏览器测速发送 PC
  -> Cloudflare TURN allocation A
  -> Cloudflare TURN allocation B
  -> 浏览器测速接收 PC
```

优点：

- 不经过真实观看者，不受其网络影响。
- 探测发送量完全独立于屏幕媒体 `maxBitrate`。
- 不新增服务器服务或公网端口。
- 两个 allocation 由同一客户端通过 Anycast 创建，预期落在同一最近 Cloudflare 数据中心。

限制：

- 不是媒体 PeerConnection 的同一个 allocation。
- 有效载荷同时占用客户端上行和下行，结果是保守的 TURN 路径容量；若客户端下行更差，不能称为纯上行容量。
- Cloudflare 是否允许合法客户端间的 relay-to-relay hairpin 必须用真实短期凭据验证，不能仅依赖 RFC 推断。

### 4.2 方案 B：服务器 Pion 探测 peer

若方案 A 不满足可行性门槛，则使用独立的轻量 Pion WebRTC 服务。共享者创建强制 Cloudflare relay 的 DataChannel，Pion 接收完整探测负载并仅返回小型累计确认。

优点：客户端下行只承载确认消息，更接近上传测量；服务端行为可控。

限制：结果包含 Cloudflare TURN 到阿里云探测服务的路径；需要新服务、认证信令、资源限制和部署配置。当前小内存服务器需要严格控制常驻内存，并避免在目标机上执行高内存 Go 构建。

### 4.3 方案 C：真实观看者连接内探测

在每个媒体 PeerConnection 上增加 DataChannel，可使用与媒体完全相同的 allocation，但结果包含观看者链路，且测速会和媒体共享拥塞控制。该方案违背“弱观看者不能降低全局 TURN 探测”的要求，不采用。

### 4.4 最终决策流程

1. 先实现不进入生产包的方案 A 可行性验证。
2. 方案 A 只有在全部门槛通过时才成为生产实现。
3. 任一硬门槛失败，则删除实验代码并采用方案 B。
4. 两种实现必须提供相同的 `TurnPathProbe` 接口，媒体控制器不依赖具体探测拓扑。

## 5. 方案 A 可行性门槛

真实 Cloudflare 测试必须满足：

- 两个 PeerConnection 都只能选中 `relay` candidate。
- candidate URL 或 provider 元数据必须确认来自 `turn.cloudflare.com`。
- DataChannel 成功打开，并连续完成 2、4、8、16 Mbps 的阶梯传输。
- 每个有效窗口的发送字节、接收字节和累计确认一致；不允许静默丢弃后仍报告高吞吐。
- 三轮探测结果的中位数稳定，离散度不超过 25%。
- 结果与同一设备已知上行能力处于合理数量级；若明显被下行或 hairpin 路径限制，则视为失败。
- 关闭探测后两个 PeerConnection、DataChannel、定时器和 TURN allocation 均释放。
- 实验不能修改生产码率，也不能被打包到最终产物，除非所有门槛通过。

## 6. `TurnPathProbe` 模块

生产探测实现提供以下职责：

- `start(iceConfiguration)`：创建探测拓扑并验证 relay 路径。
- `stop()`：幂等关闭连接、通道、定时器和样本状态。
- `subscribe(listener)`：发布不可变探测快照。
- `requestVerification()`：媒体控制器发现压力时触发短验证窗口，但不能并发启动多个探测。

探测快照包含：

```text
status:
  idle | negotiating | probing | ready | stale | unsupported | error
measuredCapacityBps
stableCapacityBps
probeTargetBps
roundTripTimeMs
lossRatio
selectedProtocol
sampledAt
```

页面和媒体控制器只消费快照，不直接操作探测连接。

## 7. 探测协议

探测使用两个 DataChannel：

- 数据通道：`ordered: false`、`maxRetransmits: 0`
- 控制通道：有序可靠，只传输窗口开始/结束和累计确认
- 二进制 16 KiB 数据块
- 单调递增序号和窗口编号
- 接收端通过控制通道按窗口返回累计接收字节、最高连续序号和丢失数量；不回显完整负载

探测发送端根据 `bufferedAmount` 进行节流，禁止无限写入浏览器队列。一个窗口的有效吞吐为：

```text
confirmedBytes * 8 / windowDurationSeconds
```

窗口在以下任一条件下无效：

- selected candidate 不是已确认的 Cloudflare relay。
- 页面进入后台并发生计时器节流。
- PeerConnection、ICE 或 DataChannel 状态发生迁移。
- `bufferedAmount` 长时间未下降。
- 确认丢失、字节计数倒退或时钟间隔无效。

首次校准使用 `2 -> 4 -> 8 -> 16 -> 32 -> 50 Mbps` 阶梯。每档持续 300–500ms；明显排队、丢包或吞吐不再增长时停止上探。共享期间持续读取轻量统计，每 10 秒运行一次约 500ms 的恢复窗口。媒体压力出现时可以立即请求两个短验证窗口。

`stableCapacityBps` 只使用校准阶梯结束后、同一探测目标下的最近三个有效验证窗口。
三个结果的（最大值 − 最小值）/ 中位数不得超过 25%；否则继续显示探测中，不发布新的稳定容量。
变速的启动阶梯只用于确定验证目标，不进入稳定历史；阶梯结束后立即串行运行三个同目标窗口。单个低样本不能覆盖已验证稳定值。

## 8. 探测生命周期

- `P2pShareController` 在第一名观看者实际进入 `turn + cloudflare` 时启动一份 probe。
- 同一次共享无论有多少 Cloudflare TURN 观看者，都只创建一份 probe。
- 最后一名 Cloudflare TURN 观看者离开、共享停止或控制器关闭时立即停止。
- TURN 凭据刷新、ICE restart、网络切换或 selected candidate 变化时，旧样本变为 `stale`，连接重建。
- 页面隐藏时暂停主动窗口；恢复可见后重新验证，隐藏期间不产生下降决策。
- probe 不由 `MeetingRoomPage` 创建。页面只订阅控制器暴露的快照。

## 9. 控制状态

### 9.1 每次共享的全局状态

- `probeCapacityBps`
- `stableCapacityBps`
- `lastKnownGoodBps`
- `probeTargetBps`
- `lowProbeSamples`
- `healthyProbeSamples`

`probeTargetBps` 永远不从媒体 `maxBitrate`、`actualOutgoingBitrate` 或 `availableOutgoingBitrate` 推导。媒体被限制到低值后，probe 仍按自己的阶梯继续向上验证。

### 9.2 每名观看者的独立状态

- `profileTargetBitrateBps`（固定）
- `transportBitrateCapBps`（动态）
- `scaleResolutionDownBy`
- `bandwidthPressureSamples`
- `healthySamples`
- `lastStableBitrateBps`
- RTT、丢包、发送丢弃、编码限制原因和实际帧率

一个观看者的媒体压力只能修改其对应 sender。

## 10. 提高传输码率

当以下条件持续两个媒体样本：

- `stableCapacityBps >= transportBitrateCapBps * 1.15`
- 当前 sender 没有 `bandwidth` 或 `cpu` 限制
- RTT、丢包和发送队列没有明显增长

则：

```text
newTransportCap = min(
  currentTransportCap * 1.15,
  stableCapacityBps * 0.90,
  50 Mbps
)
```

单次最多增加 15%。该操作不修改 `profileTargetBitrateBps`；只提高 sender 的 `maxBitrate`，为复杂画面、关键帧和高质量编码提供更大的实际传输空间。Cloudflare 官方单 allocation 数据率限制处于约 50–100 Mbps 范围，因此应用上限保持 50 Mbps。

## 11. 降低码率与防死循环

以下信号不能单独降低媒体传输上限：

- 单个低 TURN 探测窗口
- 低 `availableOutgoingBitrate`
- 低 `actualOutgoingBitrate`
- 静态画面导致的低实际帧数或低编码字节
- 缺少统计字段

普通下降必须同时满足：

1. 独立 TURN 验证连续两个窗口低于当前传输上限；以及
2. 当前观看者连续三个媒体样本出现真实压力：`qualityLimitationReason=bandwidth`，或 RTT、丢包、发送丢弃明显恶化，并且实际帧率或编码输出受到影响。

下降公式：

```text
newTransportCap = max(
  currentTransportCap * 0.80,
  min(currentTransportCap * 0.95, lastStableBitrateBps * 0.90),
  1 Mbps
)
```

`lastStableBitrateBps` 缺失时该项按 1 Mbps 处理。该公式保证新传输上限严格低于当前传输上限，单次下降范围为 5%–20%，但 `profileTargetBitrateBps` 始终不变。严重情况（例如帧率低于目标 50% 并伴随高丢包）允许立即执行一次 20% 下降。

下降后 probe 强度不跟随媒体传输上限降低；5 秒后继续独立向上验证。`profileTargetBitrateBps` 继续作为恢复基准；`lastKnownGoodBps` 不能因静态内容或低应用传输上限自然衰减，只能在持续独立低探测和媒体压力共同存在时更新。

## 12. 动态采样与帧率

固定画质目标、动态传输上限和像素采样比例分别控制。只有传输上限低于固定目标时才需要增加采样倍数：

```text
effectiveBudget = min(profileTargetBitrateBps, transportBitrateCapBps)
idealScale = max(1, sqrt(profileTargetBitrateBps / effectiveBudget))
```

并根据源尺寸和分辨率底线进行限制。

规则：

- 保持用户选择的 30 或 60 fps，不通过大幅改变捕获帧率解决网络压力。
- Cloudflare TURN sender 使用 `maintain-framerate`。
- 增加采样倍数（降低像素量）每秒最多 10%。
- 恢复分辨率要求连续 5 个健康样本，每次最多恢复 5%。
- `qualityLimitationReason=cpu` 只调整采样，不降低网络容量判断。
- 静态画面在 `qualityLimitationReason=none` 时不算网络拥塞。
- 正常动态调整保持至少 720p 短边。
- 严重且持续的带宽压力允许进入 540p 紧急层。
- 自动控制永远不允许降到 270p；已知源尺寸时使用短边计算最大采样倍数，保持非标准宽高比。
- 每秒检查 outbound `frameWidth`/`frameHeight`；如果浏览器自身的 `maintain-framerate` 降级使输出短边低于 540p，则触发分辨率硬保护，临时切换为 `maintain-resolution`，直到输出恢复到安全范围。该硬保护优先级高于帧率目标。
- 网络恢复后优先退出 540p 紧急层，再缓慢恢复原始分辨率。

若 540p 仍无法维持目标帧率，控制器保持 540p，固定画质目标仍不改变，由动态传输上限和浏览器拥塞控制决定实际发送；不继续无限降低分辨率。

## 13. 模块边界和现有代码变更

### 新模块

- `cloudflare-turn-path-probe.ts`：探测拓扑、验证、协议和快照。
- `cloudflare-turn-capacity-controller.ts`：纯探测状态归并逻辑。
- `cloudflare-adaptive-encoding.ts`：保留为纯每观看者编码状态机，改为消费稳定 TURN 快照和 sender stats。

### 修改模块

- `p2p-media-health.ts`：增加只读 `encoderTargetBitrate`、发送丢弃、remote inbound RTT/丢包等可信压力字段。
- `p2p-share-controller.ts`：拥有 probe 生命周期，按观看者运行编码状态机，暴露只读快照。
- `meeting-room-page.tsx`：删除 HTTPS probe effect，只订阅和展示 controller 快照。
- `webrtc-stats.ts` / 统计面板：区分固定画质目标、动态传输上限、编码器瞬时目标、实际码率和 RTC 原始估值。

### 删除模块

- `cloudflare-uplink-probe.ts` 及其 HTTPS 上传测试。`speed.cloudflare.com` 不再被生产应用调用。

如果方案 A 失败，`TurnPathProbe` 接口保持不变，具体实现替换为浏览器到 Pion 的信令客户端；编码控制器和页面不需要重写。

## 14. 错误处理

- 探测失败绝不降低媒体码率。
- 最近成功结果保留 60 秒并标记 `stale`。
- 无可信探测时媒体保持用户档位，仅使用持续 sender 压力保护。
- 重试间隔为 5 秒、15 秒、30 秒，之后每 30 秒重试。
- 重试不可并发，停止必须幂等。
- `unsupported` 表示拓扑不被 provider/browser 支持；它是方案 A 可行性失败，不应在生产长期显示。
- 临时 `error` 不等同于 TURN 连接失败。

## 15. 页面和诊断显示

会议室主界面使用：

```text
Cloudflare TURN 路径探测：12.4 Mbps
Cloudflare TURN 路径探测：重测中（上次 12.4 Mbps）
Cloudflare TURN 路径探测暂不可用（不影响 TURN 连接）
```

WebRTC 详细面板分别显示：

- TURN 路径探测容量和更新时间
- 固定画质目标码率
- 动态传输码率上限
- 编码器瞬时目标码率
- 实际发送码率
- RTC 原始 `availableOutgoingBitrate`
- 输出分辨率、帧率和采样倍数
- 编码限制原因
- selected candidate 类型、provider 和 UDP/TCP/TLS 协议

不再使用笼统的“可用上行”混合多个含义。

## 16. 安全和资源限制

- 探测载荷是本地生成的无业务随机字节，不包含屏幕、音频、Cookie、Token 或用户信息。
- TURN 长期 Key/API Token 继续只存在服务端；浏览器只使用现有短期凭据。
- 每次共享最多一组 probe、两个 PeerConnection 和一个发送 DataChannel。
- 单窗口最大 50 Mbps、最长 500ms；探测窗口有总字节上限。
- 共享停止后不得保留定时器、事件监听器或 allocation。
- 如果采用 Pion fallback，信令必须要求已认证会议参与者，服务端限制并发、窗口大小、总字节和会话寿命，且禁止任意地址转发。

## 17. 测试

### 单元测试

- 低媒体传输上限不降低独立 probe 强度。
- 单个低探测、低 RTC 估值、静态画面和缺失字段不触发下降。
- 持续低探测加真实媒体压力才触发最多 20% 下降。
- 网络恢复后按最多 15% 上升。
- 一个观看者的压力不修改其他观看者。
- 采样倍数连续变化，720p 正常底线、540p 紧急底线和禁止 270p。
- CPU 与网络限制分开处理。

### 集成测试

- fake PeerConnection 验证 relay-only、candidate provider 校验、DataChannel 协议和字节确认。
- 同一次共享多个 Cloudflare TURN 观看者只创建一组 probe。
- 凭据刷新、ICE restart、页面隐藏和共享停止正确失效/释放。
- probe error/stale 不降低媒体参数。
- 页面不再请求 `speed.cloudflare.com`。

### 真实浏览器验收

- Edge/Chrome 使用真实短期 Cloudflare 凭据通过方案 A 门槛，或明确记录失败并转向方案 B。
- Cloudflare TURN、coturn、P2P 直连和 SFU 回退均无回归。
- 非标准宽高比保持正确，自动控制不再出现 432×270 或 270p 短边。
- 探测期间目标帧率没有持续明显下降。

## 18. 分阶段上线

1. **可行性门槛**：仅运行方案 A 实验，不进入生产控制。
2. **观察模式**：生产显示 TURN 路径探测结果，但不修改媒体参数；收集手工验收数据。
3. **控制模式**：结果稳定后启用升码率、持续压力下降和动态采样。
4. **回退**：任一阶段发现探测不可信时，禁用 probe 控制，媒体恢复用户档位和现有 sender 压力保护；TURN 连接本身不回退。

## 19. 验收标准

- Cloudflare TURN 模式下不再访问 `speed.cloudflare.com`。
- probe 流量不受媒体传输码率上限限制。
- 媒体传输上限低时，probe 仍能发现更高容量并推动传输上限恢复。
- 固定画质目标在共享期间保持不变。
- 低 RTC 估值或低实际媒体码率不能单独继续压低传输上限。
- 持续真实拥塞能在有界时间内平滑降低传输上限和采样量。
- 一个弱观看者不会降低其他观看者或全局 probe。
- 正常最低 720p，严重弱网最低 540p，禁止自动降到 270p。
- 主界面和详细统计使用明确、不误导的术语。
- 所有连接和资源在停止共享后释放。

## 20. 参考资料

- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
- [Cloudflare Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
- [Cloudflare TURN Analytics](https://developers.cloudflare.com/realtime/turn/analytics/)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [RFC 8656: TURN](https://www.rfc-editor.org/info/rfc8656/)
