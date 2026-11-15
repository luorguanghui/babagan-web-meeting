# Cloudflare SFU 与 TURN 的 H.264 偏好统一

日期：2026-11-01。接续已部署版本 `146b0f1b7c5fb0e4f382517c089e2dd2876112f9`。

用户要求 Cloudflare SFU 和 TURN 使用同样的编码设置。本次将 H.264 profile 排序抽到 `video-codec-preference.ts`，P2P／TURN 和 Cloudflare SFU 发布均在创建 offer 前调用。

- 显式 H.264 优先浏览器已声明的 High／Constrained High、packetization-mode 1。
- 保留 Baseline、Main、其他视频编码及 RTX/FEC 回退；不修改 SDP profile-level-id，不强制对端接受 High。
- 自动编码与 VP8 选择保持原语义。缺少能力查询、匹配编码或设置 API 时保留浏览器默认行为。
- 仅调整视频编解码器偏好，轨道内容提示、音频、用户码率、目标帧率以及各路径原有分辨率／帧率降级策略不变。
- TURN 本来就共用 P2P 的浏览器发送器，前次版本已经应用 High 偏好；本次增加 ICE 失败重建的回归覆盖，避免后续分叉。

Cloudflare SFU 的独立排序此前仍为 Baseline 在前。新回归在旧代码失败，统一 helper 后通过。测试在 `createOffer` 时确认 High 已排在前，并检查音频未受影响、motion/music 提示和 20 Mbps/60fps 发布参数保留。

验证：74 个测试文件、970 项测试通过，Web 类型检查与生产构建通过，六个修改／新增 TypeScript 文件 ESLint 通过；独立只读审查无阻断问题。构建入口为 `/assets/index-DURNPioU.js`，SHA-256 `0d29cdeef8225e4cded638e0b66859bcfb8341fad32493ca7684cda29e5651eb`。

这验证的是客户端协商偏好和生命周期调用，不是 Cloudflare 真实媒体协商一定选择 High 的证明。[Cloudflare 官方文档](https://developers.cloudflare.com/realtime/sfu/)说明其转发端点发布的 WebRTC 媒体；最终 profile 仍须与 SFU 和接收端协商。本次未宣称新的帧率提升或已解决原生采集 60fps。

## 发布

2026-11-01 18:23（香港时间）开始增量发布，提交 `8e92b1c851eb645c298ea9dc69bfe7ae2f75b08b`，父版本为 `146b0f1b7c5fb0e4f382517c089e2dd2876112f9`。继续采用已验证的本地静态产物；服务器核对源码 Git 对象和产物 SHA-256 后仅替换 web。上传包 SHA-256 为 `5b4dd716126e9da595ddf26e226a9796e51164b01647ff227916522765c1c2ce`。

首次预检因基线源码目录引用错误而停止，未切换任何服务；修正该路径并核对部署脚本 SHA-256 `98e467ee6db41410706da8ad813c88f1a50502db7d9c7c049a2fdc6134e00e8f` 后重新执行成功。保留了原始失败日志；没有绕过来源检查。

发布及回滚记录位于 `/opt/babagan-web-meeting/var/releases/update-20261101T102353Z-sfu-turn-prebuilt/`，包含 `release.json`、数据库备份和 `rollback.sh`。五服务健康，公网 JS 与预期哈希一致，编码资源／隔离头及 RTC／Cloudflare SFU 冒烟检查通过；API、Caddy、LiveKit、coturn 容器保持原身份。共享端与观看端需刷新并重新共享。

发布源码已通过增量 Git bundle 取回并核验；发布提交 `8e92b1c` 后续已合入 GitHub `main`。
