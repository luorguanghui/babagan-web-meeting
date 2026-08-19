# 部署文档更新设计

## 目标

把部署知识集中到一套与仓库脚本一致的操作指南中，覆盖两条可复现路径：

1. 已有服务器上的增量更新；
2. 空白 Debian 12 服务器上的首次部署。

文档以当前生产域名和端口为默认示例，同时把仓库地址、应用目录、服务器公网 IP、私网 relay IP 和受保护文件路径写成可替换变量。所有命令都必须对应现有脚本或已在生产机验证过的手工步骤，不把设计计划中的 `bootstrap-server.sh`、`prepare-release.sh` 当成现有命令。

## 文档结构

- `docs/04-deployment-and-operations.md` 作为唯一主流程，包含准备、首次部署、更新、验收、失败处理、回滚、备份和日常运维。
- `docs/runbooks/deployment-record.md` 改成与当前 `deploy.sh` 参数、网络证明、动态冒烟 Token 和发布记录一致的证据模板。
- `docs/runbooks/rollback-record.md` 补充“待处理事务”和 Token 有效期检查，明确不自动回滚，避免失败后重复部署造成状态混乱。

## 关键流程

### 已有服务器更新

先在本地完成测试、确认完整 SHA，再通过远端 Git 或 Git bundle 把提交传到服务器。服务器端先检查当前发布记录、待处理事务、内存和磁盘；必要时在已知停机窗口停止 Compose 以满足 2 GiB 主机的内存门槛。只有在没有未处理事务时才运行 `scripts/deploy.sh`。

`deploy.sh` 仍是唯一的发布状态机：只接受完整 SHA，先完成只读预检，再创建 SQLite 校验备份和 mode 600 的 pending 记录，构建镜像、执行迁移、启动并等待健康检查。`deployment-smoke.sh` 会为一次性会议现场签发短期 LiveKit Token，因此旧的静态 Token 不再决定 RTC 冒烟是否成功。

### 空白服务器首次部署

按固定顺序完成：

1. Debian 12、Docker Engine/Compose、Git、SQLite、curl、`ss` 和 UFW；
2. 阿里云安全组、UFW、DNS、Cloudflare Full (strict)；
3. 仓库 checkout、生产环境文件和 mode 600 的密钥；
4. API 镜像构建，用镜像内的 Argon2id 生成管理员密码哈希；
5. Caddy 先取得 `turn.babagan.cloud` 证书，再为 coturn 设置只读证书可读权限；
6. 生成一次性的冒烟/回滚 Token，创建准确的网络和 Cloudflare 证据文件；
7. 使用 `--bootstrap-empty` 执行第一次受保护发布；
8. 验证五个 Compose 服务、健康端点、ICE `Cache-Control: no-store`、P2P Origin 拒绝、RTC WebSocket 和公网禁用端口。

首次部署不伪造 predecessor、数据库备份或镜像 provenance。若首次候选失败，只能使用 `--recover-pending-deploy` 的受保护恢复路径，且恢复后明确保持“没有发布”的状态。

## 安全与失败策略

- 文档只展示变量名、路径和命令，不记录真实密码、Token、API secret 或公网 IP。
- 生产 `.env`、发布记录、备份、证据和 Token 文件必须为 600；目录为 700。
- 发布失败后先读取 `var/releases/pending-release.env`、容器日志和健康状态；不自动 rollback，也不在 pending 存在时直接重跑 deploy。
- 需要向前修复时，保留并归档 pending 证据后再运行新 SHA；需要恢复时，rollback 目标必须是记录中的直接 predecessor，且确认参数必须重复完整 SHA。
- 回滚前重新生成或验证短期 LiveKit Token；冒烟 Token 过期时不能靠旧文件继续回滚。

## 验证

文档变更完成后执行 Markdown 目标文件检查、`git diff --check`，并运行现有 deployment shell regressions，确保示例参数、端口、证据字符串和脚本接口没有漂移。
