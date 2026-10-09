# P2P 持续 TURN：候选记录与数值 STUN 修复

## 已确认事实

用户提供本机 Edge 154 的两种导出：WebRTC Internals 仅保留当前 PC，RTCStatsDump 还包含已关闭 PC；两份均来自同一台共享端，不能当作双方日志。RTCStatsDump SHA256 为 `5c9c596e89ee4c2c03cdf8bcf8911b15444ac22259545f9db587ea7785fb72bd`。

19:31:47 至 19:37:45（香港时间）的 8 个屏幕 PC 均使用允许全部候选的策略，均收到 answer 和远端候选。非中继候选对累计 366 次 requestsSent，responsesReceived 为 0；选中连接均至少一侧为 relay。共享端物理 WLAN 未生成 srflx 候选，采集到的 srflx 均来自虚拟接口。没有发现 addIceCandidate 的失败事件。连接在约 32、8、33、62、63、62、68 秒被应用关闭并重建，持续重建没有改变直连检查失败的结果。

这份采样包含开启的 Mihomo TUN；用户明确说明日常会议默认不使用 Clash，并要求不处理 Clash 网卡。本轮保持其所有代理与网络设置不变，不能用该采样推断用户日常网络，也不能把存在虚拟网卡本身等同于故障。

两次只读 STUN 对照复现：同一个绑定 WLAN 的 UDP socket，访问 coturn 域名或 Cloudflare STUN 域名均超时，DNS 结果为 fake-IP；访问同一 coturn 服务器的真实数值地址，61–65ms 返回匹配事务的 Binding 成功。Mihomo socket 可收到域名响应。该差异证明此采样中的域名路径无法为物理 WLAN 完成地址发现，并证明数值地址可恢复该发现步骤；尚不等于证明双方公网候选对一定连通。

## 项目侧修复

- Docker Compose 从已有、受部署校验的 `TURN_EXTERNAL_IP` 加入 `stun:<公网 IPv4>:3478`，保留原有配置。coturn 本来就监听该 UDP 端口，不增加端口或权限。
- Cloudflare 凭据获取成功时也保留独立的本地/配置 STUN 地址，并去重；实际 TURN provider、凭据和到期时间保持原语义。
- 同时包含 `p2p-retry-lifecycle-local-2026-10-08.md` 中已复现并修复的重试生命周期问题，避免凭据准备失败时关闭现有 PC，以及迟到请求覆盖新的健康 PC。

## 验证状态

新增 Cloudflare provider 保留数值 STUN 的回归用例在修复前失败，修复后通过。最终全量 45 个文件、844 项通过；修改的 TypeScript 文件 ESLint、网页 TypeScript 检查通过，独立复审没有剩余可操作问题。生产构建和部署结果待补充。

生产验证应确认真实认证 ICE 响应包含数值地址、运行源码与镜像可追溯、其他服务实例保持不变。最终直连验收必须由两端刷新页面重新共享后的实际候选对证明；若仍用 TURN，应继续分析新导出，不能因增加 STUN 就声明问题解决。
