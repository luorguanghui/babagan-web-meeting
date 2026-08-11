# P2P 生产加固验证记录

日期：2026-08-11（Asia/Hong_Kong）
验证分支：`feature/p2p-screen-share-hybrid`

## 自动化结果

| 验证 | 结果 | 证据范围 |
|---|---|---|
| `pnpm lint` | 通过，0 error / 0 warning | 全仓 ESLint |
| `pnpm typecheck` | 通过 | contracts、API、Web |
| `pnpm test` | 通过，32 个文件、432 个测试 | API、contracts、Web 单元与集成测试 |
| `pnpm build` | 通过 | contracts、API、Web 生产构建 |
| P2P Playwright（Chrome） | 4/4 通过 | 回环 P2P 媒体播放、`media-ready`、无 Cookie 401、跨站 Origin 403、非共享者 offer 拒绝 |
| P2P Playwright（Edge） | 4/4 通过 | 与 Chrome 相同矩阵 |
| 完整本地 Playwright | 8 通过、4 跳过、0 失败 | 双浏览器 P2P 全通过；容量与主持人用例需要真实 LiveKit，按条件跳过 |
| `bash -n scripts/smoke-test.sh` | 通过 | 冒烟脚本语法；未对生产地址执行 |
| 规范过期项扫描 | 通过 | 规范文档无真实公网 IPv4、自动上报、旧 ICE 缓存配置或按状态撤销 SFU 发布的生产声明 |

生产 Web 构建仍有一个既有非阻塞警告：主 JS chunk 约 913 kB（gzip 约 255 kB），超过 Vite 的 500 kB 提示阈值。它不影响本次 P2P 正确性，但后续可单独做代码分割。

## 本地浏览器证据的边界

本地 Playwright 使用编译期 `VITE_E2E_FAKE_LIVEKIT=true`，只把 LiveKit SDK 的发布/取消发布副作用替换为成功结果，以保留“LiveKit 发布成功后才启动 P2P”的生产顺序。P2P 信令、offer/answer/ICE、候选选择、RTP、视频解码、`media-ready` 与浏览器播放均为 Chrome/Edge 之间的真实回环 WebRTC。

没有 `E2E_BASE_URL` 时，依赖真实 LiveKit 连接与参与者事件的容量、麦克风和主持人 Playwright 用例会明确跳过；指向部署环境后必须重新运行且不得使用假发布标志。

## 尚未执行的生产验收

以下项目不能由本机回环或假 LiveKit 证明，部署前仍是必做项：

1. 在目标服务器使用固定的 LiveKit Server v1.11.0 digest，执行更新后的 `scripts/smoke-test.sh`，核对已认证 STUN 响应及跨站 WebSocket 403。
2. Chrome 与 Edge 跨两个真实公网/NAT 环境验证 host/srflx 直连、CGNAT/禁 UDP 回退及首帧无黑屏交接。
3. 1–5 人分别用 5/8/10 Mbps 档位验证共享者实际上行预算，并确认 LiveKit 麦克风优先不受挤压。
4. 跑满两小时稳定性、5 人 1080p60、浏览器休眠/唤醒、网络切换及服务器重启矩阵。
5. 在设置 `E2E_BASE_URL` 与管理密码的真实部署上运行完整 Playwright，要求容量和主持人用例不再跳过。

因此，本记录证明代码级生产加固与本机双浏览器 P2P 路径通过；不宣称已经完成真实公网 NAT、目标 LiveKit 或长稳负载验收。
