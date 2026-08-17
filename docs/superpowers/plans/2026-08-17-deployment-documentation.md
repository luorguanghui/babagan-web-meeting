# 部署文档更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 Babagan 的部署知识整理成与当前生产脚本一致、可复用且可验证的中文更新/首次部署指南。

**Architecture:** 以 `docs/04-deployment-and-operations.md` 为唯一主流程，按“共同准备 → 空白服务器首次部署 → 已有服务器更新 → 验收 → 失败处理/回滚 → 日常运维”组织。两个 runbook 只保留证据字段和恢复命令模板，引用主流程而不重复发明脚本行为。所有示例使用 `babagan.cloud`，用显式变量表示应用目录、仓库、IP 和受保护文件。

**Tech Stack:** Markdown、Bash deployment scripts、Docker Compose、Git bundle、Debian 12、UFW。

## Global Constraints

- 只记录仓库中实际存在的脚本和已在生产机验证过的手工步骤。
- 不把设计计划中的 `scripts/bootstrap-server.sh` 或 `scripts/prepare-release.sh` 写成可用命令。
- 生产 `.env`、发布记录、备份、证据和 Token 文件使用 mode `600`；对应目录使用 mode `700`。
- `scripts/deploy.sh` 是唯一发布状态机，必须使用完整 40 位 SHA，并保留 1.1 GiB 可用内存门槛。
- 部署冒烟使用临时会议和现场签发的 LiveKit Token；静态 Token 文件只保留给现有脚本接口和 rollback 兼容，不作为 RTC 可靠性依据。
- pending 事务存在时不得重复运行 deploy；失败后不自动回滚。
- 不记录真实密码、Token、API secret 或目标服务器公网 IP。

---

### Task 1: 重写主部署与运维指南

**Files:**
- Modify: `docs/04-deployment-and-operations.md`

**Interfaces:**
- Consumes: `infra/.env.production.example`、`infra/docker-compose.yml`、`scripts/deploy.sh`、`scripts/deployment-smoke.sh`、`scripts/rollback.sh`、`scripts/backup.sh`、`scripts/restore.sh`。
- Produces: 一份能按顺序执行的中文主指南，包含当前生产默认值和可替换变量。

- [ ] **Step 1: 保留并校准架构基线**

保留目标服务器、DNS、Cloudflare、端口、Compose 服务和安全原则；把端口表扩展为当前 UFW/安全组实际需要的 TCP `80,443,3478,5349,7881` 与 UDP `443,3478,49160–49200,50000–60000`，并说明内部 LiveKit `7880` 只允许 Docker bridge 到宿主机，不作为公网入站。

- [ ] **Step 2: 添加“共同准备”章节**

明确变量约定：`APP_DIR=/opt/babagan-meeting`、`PUBLIC_HOST=meet.babagan.cloud`、`RTC_HOST=rtc.babagan.cloud`、`TURN_HOST=turn.babagan.cloud`、`TARGET_IP` 和 `TURN_RELAY_IP` 必须由操作者替换。说明仓库可通过 `git clone` 或经校验的 Git bundle 到达服务器，并要求工作树干净、记录 `git rev-parse HEAD`。

- [ ] **Step 3: 添加“从零部署”可执行顺序**

写出 Debian 12 基础依赖、Docker 官方仓库安装、目录/权限、UFW、安全组、DNS、Cloudflare Full (strict)、`.env.production` 生成和密钥保护步骤。说明管理员密码必须从 mode-600 文件读取，并通过已构建的 API 镜像内 Argon2id 生成 `ADMIN_PASSWORD_HASH`，不把明文写入 shell 历史或文档。

补充首次启动前的 Caddy 证书准备：先以 `--no-deps caddy` 取得 `turn.babagan.cloud` 证书，确认 Caddy 数据卷中的证书和私钥可被 coturn 容器读取，再停止并移除预启动容器；记录 Docker bridge 到宿主机 `7880` 的内部 UFW 规则。明确首次发布必须使用 `--bootstrap-empty`，并给出证据文件的精确内容和 mode `600` 设置。

- [ ] **Step 4: 添加“已有服务器更新”可执行顺序**

按本地测试 → 确认完整 SHA → Git fetch 或增量 bundle → 服务器只读预检 → 检查 pending/current release → 可选停止 Compose 释放内存 → `scripts/deploy.sh` → 健康/冒烟/记录验收的顺序书写。给出当前脚本的完整命令行参数，包括 `--target-ip`、`--smoke-token-file`、`--network-evidence`、`--cloudflare-evidence`、`--allow-public-ssh` 和可选 `--env-file`。

明确部署脚本会先备份 SQLite、写 pending、构建镜像、迁移、健康等待，然后由 `deployment-smoke.sh` 动态创建临时会议并签发 LiveKit Token；成功后 pending 被归档为完成记录，失败后停在 pending 状态。

- [ ] **Step 5: 添加验收、失败处理和回滚章节**

给出五个 Compose 服务健康检查、`/health/live`、`/health/ready`、首页 200、认证 ICE 的 TURN/STUN 与 `Cache-Control: no-store`、P2P 跨站 403、RTC WebSocket 和公网 3000/7880 阻断验证命令。

说明失败后先读取 pending、容器日志和备份 checksum；不重复 deploy、不自动 rollback。向前修复时先保留/归档 pending 证据，恢复时只允许记录的直接 predecessor，并要求回滚前检查/重新生成有效 Token。加入 `backup.sh`、`restore.sh` 的安全使用规则。

- [ ] **Step 6: 运行主文档静态检查**

执行：

```bash
rg -n "bootstrap-empty|deployment-smoke.sh|Cache-Control|pending-release|Git bundle|1.1 GiB|no automatic rollback" docs/04-deployment-and-operations.md
git diff --check
```

预期：所有关键流程词出现，且无空白/尾随空格错误。

- [ ] **Step 7: Commit**

```bash
git add docs/04-deployment-and-operations.md
git commit -m "docs: document update and first deployment flows"
```

### Task 2: 对齐部署证据记录模板

**Files:**
- Modify: `docs/runbooks/deployment-record.md`

**Interfaces:**
- Consumes: `scripts/deploy.sh` 的证据校验和发布记录字段。
- Produces: 与当前网络端口、Cloudflare 证明、动态冒烟 Token 和 `--bootstrap-empty` 行为一致的证据模板。

- [ ] **Step 1: 更新必需证据**

把安全组和主机防火墙示例改为包含 `3478`、`5349`、`49160–49200` 的精确字符串；同时保留 restricted SSH 和显式 `--allow-public-ssh` 两种证据格式。

- [ ] **Step 2: 更新受保护文件与成功输出**

写明 `.env.production`、evidence、token、pending/current/release record、backup 和 checksum 的路径/权限要求，补充 `DEPLOY SUCCEEDED`、五服务健康和 smoke output 的保存位置。说明部署 smoke 会现场生成短期 Token，不能用过期静态 Token 判断 RTC 故障。

- [ ] **Step 3: 更新首次部署和发布命令**

分别给出普通更新命令和带 `--bootstrap-empty` 的空白服务器命令，要求 SHA 与 checked-out `HEAD` 相等。补充成功后应保留 `current-release.env`、release record、backup 和 completed pending record。

- [ ] **Step 4: 检查模板无秘密和无矛盾**

执行：

```bash
rg -n "replace-with|token|secret|SHA|bootstrap-empty|3478|5349|49160" docs/runbooks/deployment-record.md
git diff --check
```

确认只有路径、占位符和字段名，没有真实凭据或把模板标成已执行事实。

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/deployment-record.md
git commit -m "docs: align deployment evidence record"
```

### Task 3: 对齐回滚与 pending 事务 runbook

**Files:**
- Modify: `docs/runbooks/rollback-record.md`

**Interfaces:**
- Consumes: `scripts/rollback.sh`、`scripts/backup.sh`、`scripts/restore.sh` 的参数和 provenance 约束。
- Produces: 明确的 guarded rollback、pending recovery 和不自动回滚规则。

- [ ] **Step 1: 写清 rollback 前置条件**

要求当前 release record 存在且目标必须是记录中的直接 predecessor；确认参数重复完整 SHA；禁止活动会议中恢复；先确认 Token 未过期且 mode `600`。

- [ ] **Step 2: 写清 pending recovery**

给出 `--recover-pending-deploy` 的完整命令、候选 SHA 与 predecessor SHA 的区别、bootstrap candidate volume/marker 的保护检查，并说明失败时保留额外数据库备份和容器日志。

- [ ] **Step 3: 写清成功/失败后的记录保留**

列出 rollback log、两份数据库备份、checksum、override 文件、镜像 ID 和健康/smoke 输出；明确不删除旧镜像、不删除备份、不使用 `git reset --hard` 作为服务器恢复步骤。

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/rollback-record.md
git commit -m "docs: clarify guarded rollback workflow"
```

### Task 4: 全量文档验证与交付

**Files:**
- Verify: `README.md`、`docs/04-deployment-and-operations.md`、`docs/runbooks/deployment-record.md`、`docs/runbooks/rollback-record.md`。

- [ ] **Step 1: 检查链接和脚本接口**

确认 README 的部署文档链接仍然有效；用 `rg` 对照文档中每个脚本名称和参数，确保没有写入不存在的选项或脚本。

- [ ] **Step 2: 运行验证命令**

```bash
bash scripts/http-headers.test.sh
bash scripts/deployment-smoke.test.sh
bash scripts/deployment-scripts.test.sh
git diff --check
git status --short
```

预期：三个 regression 脚本均成功，`git diff --check` 成功，工作树只包含本次文档提交前后可解释的变更。

- [ ] **Step 3: 最终复核**

逐段检查：首次部署是否能从空白主机开始、更新是否先检查 pending、Token 是否不再被描述为长期静态值、Caddy/coturn 证书是否有明确前置步骤、回滚是否保留备份且不自动执行。

- [ ] **Step 4: Commit**

```bash
git add docs/04-deployment-and-operations.md docs/runbooks/deployment-record.md docs/runbooks/rollback-record.md
git commit -m "docs: complete deployment operations guide"
```

## Self-review checklist

- 主流程覆盖首次部署、更新、验收、失败、回滚、备份和日常运维。
- 所有命令对应仓库中的现有脚本或已验证手工步骤。
- 未把未来计划脚本伪装成现有能力。
- 没有真实密码、Token、API secret 或服务器公网 IP。
- 文档中的证据字符串与 `scripts/firewall-attestation.sh` 完全一致。
