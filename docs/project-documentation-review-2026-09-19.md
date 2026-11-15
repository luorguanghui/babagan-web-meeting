# 项目与文档检查记录：2026-09-19

## 范围与结论

本次对照当前工作区的前端媒体控制器、API 配置与路由、数据库迁移和仓储、部署/备份脚本及已有故障记录，修正 README、01–07 主文档和部署记录模板。工作区原有未提交代码修改予以保留；核对结果包含这些修改，不代表它们已部署。

`superpowers/specs`、`superpowers/plans`、日期化部署/验收记录和设计截图属于历史材料，保留原始结论和当时的测试数字。执行当前操作应优先使用主文档，同时核对具体发布版本。

## 已修正的差异

| 内容 | 代码或记录依据 | 文档修正 |
|---|---|---|
| 网页/API 拓扑 | [9 月 14 日故障记录](acceptance/meeting-access-2026-09-14.md) | meet 改为 DNS only；架构、部署、安全说明及证据模板一致 |
| 部署脚本限制 | [deploy.sh](../scripts/deploy.sh) | 明示旧脚本仍要求 proxied，不能伪造证据或直接照旧执行 |
| 屏幕质量档位 | [screen-share.ts](../apps/web/src/meeting/screen-share.ts) | flow 现为 1080p30；三档使用 1080p 最大捕获边界，较小源不放大 |
| 直连与 TURN 自适应 | [共享控制器](../apps/web/src/meeting/p2p-share-controller.ts)、[缩放控制器](../apps/web/src/meeting/p2p-adaptive-resolution.ts) | 直连分辨率优先；非 Cloudflare 显式缩放以源短边 1080px 为底线；Cloudflare 策略独立 |
| SFU 安全网 | [混合发布器](../apps/web/src/meeting/screen-share.ts) | 当前常驻发布视频码率上限 10 Mbps，P2P 成功不意味着云端屏幕总流量或可见性为零 |
| 协商与恢复 | [观看控制器](../apps/web/src/meeting/p2p-viewer-controller.ts)、[会议页面](../apps/web/src/pages/meeting-room-page.tsx) | 8 秒是超时基准，可因 ICE 进展延长；TURN 故障尝试重建而非自动转 SFU；会话失效后停止凭据重试 |
| ICE 配置 | [config.ts](../apps/api/src/config.ts) | coturn TTL 必填；补充 Cloudflare 代理配置；开发环境示例补齐必需 TURN 变量 |
| 标识与数据库 | [server.ts](../apps/api/src/server.ts)、[迁移 002](../apps/api/src/db/migrations/002_media_cleanup.sql) | UUIDv4，补充媒体关闭时间字段；过期预留不计容量不等于删除记录 |
| 安全与保留 | [仓储](../apps/api/src/repositories/sqlite-meeting-repository.ts)、[会议服务](../apps/api/src/services/meeting-service.ts)、[备份脚本](../scripts/backup.sh) | 明确会话撤销与物理删除的区别，清理/加密/保留周期不再表述为已实现 |
| 验收标准 | [测试与验收](05-test-and-acceptance.md) | 功能门禁覆盖 FR-001–FR-016；修正超时、媒体流量与质量档位的断言 |

## 尚需实现或现场验证

1. **完整部署检查未适配 DNS only。** `scripts/deploy.sh` 仍严格匹配旧 Cloudflare 证据字符串。应修改该检查及关联测试，再使用正常部署流程；本次未修改部署逻辑，也未操作服务器或 DNS。`firewall-attestation.sh` 本身只核对安全组、主机防火墙与 SSH 证据，Cloudflare 检查实际位于 `deploy.sh`。
2. **数据保留目标尚未落实。** 当前终态会议撤销主持人与参与者会话，但未自动删除会议密码哈希、昵称、会话、过期预留和旧审计记录。安全文档中的删除/匿名化和 30 天审计保留要求仍待实现。
3. **备份加密和调度未内置。** `backup.sh` 创建 mode-600 SQLite 在线快照、完整性校验与 SHA-256，默认保留最近 7 份；没有加密或每日调度逻辑。外部是否另有配置，本次未核验。
4. **实时媒体与线上版本需现场验收。** 本次没有连接生产主机，没有完成 Chrome/Edge 双端公网 NAT、5 人负载、两小时稳定性或部署回滚演练。历史记录里的测试通过不能代替当前版本验收。

## 本次验证

| 检查 | 结果 |
|---|---|
| `pnpm test` | 44 个测试文件、769 项测试全部通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| 文档相对链接 | 扫描 README 与 docs 下 54 份 Markdown，40 个文件相对链接目标均存在（不含外链与锚点验证） |
| `git diff --check` | 通过 |
| `pnpm build` | 通过；Vite 仍提示产物存在超过 500 kB 的 chunk，主 JS 约 995.80 kB（gzip 278.34 kB） |

上述是本地自动化与构建结果，不是完整发布门禁通过的声明。未执行 Linux 部署 Shell 测试、真实浏览器 E2E 或生产冒烟。
