# 部署与运维

本文件是 Babagan 的主部署指南，覆盖两条路径：

- **已有服务器更新**：服务器已有 Docker、Compose、生产环境文件和当前 release 记录。
- **从零部署**：全新的 Debian 12 服务器，没有 API 数据卷和当前发布记录。

默认域名是 meet.babagan.cloud、rtc.babagan.cloud、turn.babagan.cloud。命令中的 APP_DIR、TARGET_IP、TURN_RELAY_IP 和仓库地址必须替换成目标环境值。真实密码、Token、API secret 和公网 IP 只放在服务器受保护文件中，不进入 Git、命令历史或本文档。

## 1. 拓扑和固定约束

| 项目 | 当前约定 |
|---|---|
| 系统 | Debian 12，推荐 2 核、2 GiB、40 GiB |
| 网页/API | https://meet.babagan.cloud，Cloudflare Proxied |
| LiveKit 信令 | wss://rtc.babagan.cloud，DNS only |
| TURN | turn.babagan.cloud，DNS only |
| 应用目录示例 | /opt/babagan-meeting |
| 发布入口 | scripts/deploy.sh |
| 数据 | Docker volume babagan-meeting_api-data 中的 SQLite |

Compose 服务：caddy（80/443、ACME、反代）、api（内部 3000）、livekit（7880、7881、UDP 443、50000–60000）、coturn（3478、5349、49160–49200）和 web（内部 8080）。

公网入站只允许 TCP 22、80、443、3478、5349、7881，以及 UDP 443、3478、49160–49200、50000–60000。LiveKit 7880 只允许 Docker bridge 内部 API/Caddy 访问，不加入公网安全组。禁止公开 API 3000、SQLite、7880、Docker 管理端口和监控端口。

## 2. 共同准备

~~~bash
export APP_DIR=/opt/babagan-meeting
export PUBLIC_HOST=meet.babagan.cloud
export RTC_HOST=rtc.babagan.cloud
export TURN_HOST=turn.babagan.cloud
export TARGET_IP='<服务器公网 IPv4>'
export TURN_RELAY_IP='<服务器私网 IPv4>'
export REPO_URL='<Git 仓库 URL>'
export RELEASE_SHA='<本次 40 位小写 Git SHA>'
~~~

检查主机和 DNS：

~~~bash
cat /etc/os-release
getent ahostsv4 "$PUBLIC_HOST" "$RTC_HOST" "$TURN_HOST"
df -h "$APP_DIR"
awk '/MemAvailable:/ {print $2 " KiB available"}' /proc/meminfo
~~~

deploy.sh 要求 Debian 12、至少约 1.1 GiB 可用内存和至少 10 GiB 可用磁盘。2 GiB 主机在构建时内存紧张时，可在停机窗口停止 Compose 并释放缓存：

~~~bash
sudo docker compose --env-file "$APP_DIR/infra/.env.production" -f "$APP_DIR/infra/docker-compose.yml" stop
sync
echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
~~~

### 2.1 DNS、Cloudflare、安全组和 UFW

阿里云安全组和 UFW 必须同步开放应用端口；SSH 推荐只允许固定管理 IP：

~~~bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from '<固定管理公网 IP>' to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 443/udp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw allow 50000:60000/udp
sudo ufw --force enable
sudo ufw status verbose
~~~

Cloudflare 必须是：meet Proxied；rtc DNS only；turn DNS only；SSL/TLS 使用 Full (strict)。rtc 和 turn 必须可以直连源站。如果选择公开 SSH，部署命令必须显式加入 --allow-public-ssh，并使用脚本接受的 public SSH 证据字符串。

### 2.2 仓库同步

远端可达时：

~~~bash
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo git clone --branch '<发布分支>' "$REPO_URL" "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
cd "$APP_DIR"
git status --short
git rev-parse HEAD
~~~

远端不可达时，在本地生成经校验的 Git bundle：

~~~bash
# OLD_SHA 是服务器当前已验证的基线 SHA
git bundle create "babagan-deploy-$RELEASE_SHA.bundle" '<发布分支>' "^$OLD_SHA"
git bundle verify "babagan-deploy-$RELEASE_SHA.bundle"
sha256sum "babagan-deploy-$RELEASE_SHA.bundle"
~~~

上传后在服务器校验、fetch 和 checkout：

~~~bash
cd "$APP_DIR"
sha256sum /受保护上传目录/babagan-deploy-<短 SHA>.bundle
sudo git fetch /受保护上传目录/babagan-deploy-<短 SHA>.bundle '<发布分支>'
sudo git checkout --detach '<完整新 SHA>'
test "$(git rev-parse HEAD)" = '<完整新 SHA>'
git status --short
~~~

工作树不得有未解释的源码修改；受保护运行时文件应由 .gitignore 忽略。

## 3. 从零部署 Debian 12

本节只适用于没有 current-release.env、没有 babagan-meeting_api-data volume、没有运行中的 Babagan Compose 栈。已有任一项时改用第 4 节，不得添加 --bootstrap-empty。

### 3.1 安装依赖

Docker Engine 建议按 [Docker 官方 Debian 安装说明](https://docs.docker.com/engine/install/debian/)安装：

~~~bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git sqlite3 iproute2 ufw openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
~~~

旧 standalone babagan-coturn.service 不应与 Compose coturn 并存：

~~~bash
sudo systemctl disable --now babagan-coturn.service
systemctl is-active babagan-coturn.service || true
systemctl is-enabled babagan-coturn.service || true
~~~

### 3.2 生产环境和秘密

~~~bash
sudo install -d -m 700 /root/babagan-secrets /root/babagan-protected
cd "$APP_DIR"
sudo cp infra/.env.production.example infra/.env.production
sudo chmod 600 infra/.env.production
sudoedit infra/.env.production
~~~

至少替换：PUBLIC_BASE_URL、LIVEKIT_URL、LIVEKIT_INTERNAL_URL、LIVEKIT_NODE_IP、LIVEKIT_API_KEY、LIVEKIT_API_SECRET、ADMIN_PASSWORD_HASH、COOKIE_SECRET、P2P_STUN_URLS、P2P_TURN_URLS、P2P_TURN_SECRET、P2P_TURN_TTL_SECONDS=600、TURN_SHARED_SECRET、TURN_EXTERNAL_IP、TURN_RELAY_IP。LIVEKIT_NODE_IP/TURN_EXTERNAL_IP 必须等于 TARGET_IP；P2P_TURN_SECRET/TURN_SHARED_SECRET 必须相同且至少 32 字符；镜像必须保持示例中的批准 digest。

服务器生成随机值，不要把结果贴到聊天或 Git：

~~~bash
sudo bash -c 'umask 077; openssl rand -hex 32 > /root/babagan-secrets/cookie-secret; openssl rand -hex 32 > /root/babagan-secrets/turn-secret'
sudo chmod 600 /root/babagan-secrets/cookie-secret /root/babagan-secrets/turn-secret
sudo stat -c '%a %n' infra/.env.production
~~~

### 3.3 Argon2id 管理员哈希

先构建仅用于准备运行时的 API 镜像，不启动服务：

~~~bash
cd "$APP_DIR"
sudo docker build --pull -f apps/api/Dockerfile -t babagan-meeting-api:bootstrap .
sudo install -m 600 /dev/null /root/babagan-secrets/admin-password
sudoedit /root/babagan-secrets/admin-password
~~~

用项目相同参数生成哈希，管道末端不向终端输出：

~~~bash
set -o pipefail
sudo docker run --rm --network none \
  -v /root/babagan-secrets/admin-password:/run/secrets/admin-password:ro \
  --entrypoint node babagan-meeting-api:bootstrap --input-type=module \
  -e 'import {readFileSync} from "node:fs"; import argon2 from "argon2"; const p=readFileSync("/run/secrets/admin-password","utf8").trimEnd(); process.stdout.write(await argon2.hash(p,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1}));' \
  | sudo tee /root/babagan-secrets/admin-password-hash >/dev/null
sudo chmod 600 /root/babagan-secrets/admin-password-hash
sudoedit infra/.env.production
sudo rm -f /root/babagan-secrets/admin-password
~~~

将哈希填入 ADMIN_PASSWORD_HASH；明文密码不得进入 env、shell 历史或文档。

### 3.4 Caddy 证书和 coturn 权限

coturn 从 Caddy 数据卷读取 turn.babagan.cloud 证书。首次部署先只启动 Caddy，等待证书，再启动完整栈：

~~~bash
cd "$APP_DIR"
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml up -d --no-deps caddy
CADDY_DATA=$(sudo docker volume inspect --format '{{.Mountpoint}}' babagan-meeting_caddy-data)
TURN_CERT_DIR="$CADDY_DATA/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud"
for attempt in $(seq 1 90); do
  if sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.crt" && sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.key"; then break; fi
  sleep 2
done
sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.crt"
sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.key"
sudo find "$CADDY_DATA/caddy/certificates" -type d -exec chmod o+x {} +
sudo chmod o+r "$TURN_CERT_DIR/turn.babagan.cloud.crt" "$TURN_CERT_DIR/turn.babagan.cloud.key"
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml stop caddy
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml rm -f caddy
~~~

预启动 Caddy 会创建 Compose network。只允许 edge bridge 访问宿主机 7880：

~~~bash
EDGE_BRIDGE=$(sudo docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' babagan-meeting_edge)
EDGE_SUBNET=$(sudo docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' babagan-meeting_edge)
sudo ufw allow in on "$EDGE_BRIDGE" from "$EDGE_SUBNET" to any port 7880 proto tcp comment 'babagan-livekit-internal'
~~~

证书续期后重复权限检查，并执行 docker compose restart coturn，验证 5349/TCP。

### 3.5 证据、Token 和首次发布

创建 deploy.sh 接受的 mode-600 证据文件（推荐限制 SSH）：

~~~bash
sudo tee /root/babagan-protected/network.txt >/dev/null <<'EOF'
Alibaba inbound: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted
Host firewall: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted; default deny inbound
EOF
sudo tee /root/babagan-protected/cloudflare.txt >/dev/null <<'EOF'
Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)
EOF
sudo chmod 600 /root/babagan-protected/network.txt /root/babagan-protected/cloudflare.txt
~~~

deploy.sh 仍要求非空的 mode-600 smoke-token-file，主要兼容 rollback；正常 deployment smoke 会现场创建临时会议并签发新 Token。准备一个 24 小时 Token：

~~~bash
sudo bash -c 'umask 077; docker run --rm --network none --env-file /opt/babagan-meeting/infra/.env.production --entrypoint node babagan-meeting-api:bootstrap --input-type=module -e '\''import {AccessToken} from "livekit-server-sdk"; const t=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:"deployment-rollback",ttl=86400}); t.addGrant({room:"deployment-smoke",roomJoin:true}); process.stdout.write(await t.toJwt());'\'' > /root/babagan-secrets/smoke-token; chmod 600 /root/babagan-secrets/smoke-token'
~~~

确认空白条件：

~~~bash
cd "$APP_DIR"
sudo test ! -e var/releases/current-release.env
sudo test ! -e var/releases/pending-release.env
sudo test -z "$(sudo docker volume inspect --format '{{.Mountpoint}}' babagan-meeting_api-data 2>/dev/null || true)"
~~~

首次发布使用完整 SHA 和 --bootstrap-empty：

~~~bash
cd "$APP_DIR"
RELEASE_SHA=$(git rev-parse HEAD)
sudo bash scripts/deploy.sh \
  --confirm-deploy "$RELEASE_SHA" \
  --target-ip '<服务器公网 IPv4>' \
  --smoke-token-file /root/babagan-secrets/smoke-token \
  --network-evidence /root/babagan-protected/network.txt \
  --cloudflare-evidence /root/babagan-protected/cloudflare.txt \
  --bootstrap-empty
~~~

首次失败时只能使用 rollback runbook 的 --recover-pending-deploy；成功恢复结果是“没有发布”，不会猜测 predecessor。

## 4. 已有服务器更新流程

### 4.1 本地测试和 SHA

~~~bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
bash scripts/http-headers.test.sh
bash scripts/deployment-smoke.test.sh
bash scripts/deployment-scripts.test.sh
git diff --check
git status --short
git rev-parse HEAD
~~~

任何测试或构建失败都不要上传。发布 SHA 必须是干净工作树的完整 40 位小写值。

### 4.2 同步、预检和 pending

服务器远端可达时：

~~~bash
cd "$APP_DIR"
git fetch --prune origin '<发布分支>'
git checkout --detach '<完整新 SHA>'
test "$(git rev-parse HEAD)" = '<完整新 SHA>'
git status --short
~~~

使用 bundle 时，按 2.2 节生成并校验后在服务器执行：

~~~bash
cd "$APP_DIR"
sha256sum /受保护上传目录/babagan-deploy-<短 SHA>.bundle
sudo git fetch /受保护上传目录/babagan-deploy-<短 SHA>.bundle '<发布分支>'
sudo git checkout --detach '<完整新 SHA>'
~~~

发布前检查：

~~~bash
cd "$APP_DIR"
sudo sed -n '1,24p' var/releases/current-release.env
sudo test ! -e var/releases/pending-release.env
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml ps
awk '/MemAvailable:/ {print $2 " KiB available"}' /proc/meminfo
df -Pk "$APP_DIR"
~~~

若 pending-release.env 存在，停止并诊断，不重复运行 deploy.sh。保留 pending、容器日志、当前服务状态和备份，再决定归档后向前修复还是 guarded rollback。

### 4.3 执行更新

~~~bash
cd "$APP_DIR"
RELEASE_SHA=$(git rev-parse HEAD)
sudo bash scripts/deploy.sh \
  --confirm-deploy "$RELEASE_SHA" \
  --target-ip '<服务器公网 IPv4>' \
  --smoke-token-file /root/babagan-secrets/smoke-token \
  --network-evidence /root/babagan-protected/network.txt \
  --cloudflare-evidence /root/babagan-protected/cloudflare.txt
~~~

若使用公网 SSH 证据，追加 --allow-public-ssh；非默认 env 文件追加 --env-file /受保护路径/infra.env.production。

deploy.sh 顺序固定为：只读预检 → SQLite 在线备份和 checksum → mode-600 pending → 固定镜像拉取/构建 → 一次性迁移 → 版本化镜像 tag → 启动并等待五服务 healthy → deployment-smoke。smoke 会创建临时会议并现场签发 LiveKit Token，检查健康端点、认证 ICE、Cache-Control: no-store、P2P 跨站 403、RTC WebSocket 和公网 3000/7880 阻断。成功后写 release record、更新 current-release.env，并保存 completed pending record。

### 4.4 更新后验收

~~~bash
cd "$APP_DIR"
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml ps
curl --fail --silent --show-error https://meet.babagan.cloud/health/live
curl --fail --silent --show-error https://meet.babagan.cloud/health/ready
curl --silent --output /dev/null --write-out '%{http_code}\n' https://meet.babagan.cloud/
sudo sed -n '1,32p' var/releases/current-release.env
sudo test ! -e var/releases/pending-release.env
~~~

应看到五服务 healthy、健康端点分别返回 {"status":"ok"} 和 {"status":"ready"}、首页 HTTP 200、current-release.env 为本次 SHA、没有 pending。保留 deploy、compose ps、健康和 smoke 输出到受保护运维记录。

## 5. 失败处理：先诊断，不自动回滚

pending 写入后失败时，current-release.env 仍是已验证基线，pending-release.env 才是事务恢复来源：

~~~bash
cd "$APP_DIR"
sudo sed -n '1,40p' var/releases/pending-release.env
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml ps
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml logs --tail=200 api caddy livekit coturn web
~~~

规则：

- pending 存在时不再次调用 deploy.sh。
- 不因 smoke 失败盲目 rollback；先区分应用、证书、端口、内存、DNS、Token 和迁移问题。
- 候选健康且只需代码修复时，保留原 pending、失败原因和备份 checksum，归档后用新 SHA 前进部署。
- 需要恢复数据和 predecessor 镜像时，只执行下一节和 rollback runbook 的 guarded rollback。
- 任何恢复都保留失败数据库的额外备份，不删除镜像和历史备份。

## 6. 回滚、备份与恢复

已提交版本回滚的目标必须是 current release 记录中的直接 predecessor，两个 SHA 参数必须相同，且不要在活动会议中执行：

~~~bash
cd "$APP_DIR"
TARGET_SHA='<current-release.env 中的 PREVIOUS_RELEASE_SHA>'
sudo bash scripts/rollback.sh \
  --target-release-sha "$TARGET_SHA" \
  --confirm-rollback "$TARGET_SHA" \
  --smoke-token-file /root/babagan-secrets/smoke-token
~~~

回滚前重新生成/验证有效 Token，文件 mode 600。脚本会再次备份当前数据库、校验原备份 checksum 和 predecessor 镜像 ID、恢复 SQLite、启动旧镜像、等待健康并运行 core-only smoke；失败时从额外备份恢复，不删除镜像或备份。

首次候选失败且为 bootstrap-pending 时：

~~~bash
cd "$APP_DIR"
FAILED_SHA='<pending-release.env 中的 CANDIDATE_SHA>'
sudo bash scripts/rollback.sh \
  --recover-pending-deploy \
  --target-release-sha "$FAILED_SHA" \
  --confirm-rollback "$FAILED_SHA" \
  --smoke-token-file /root/babagan-secrets/smoke-token
~~~

volume、marker 或 Compose ownership 不匹配时脚本会拒绝删除并保留 volume；成功结果是 no release remains。

在线 SQLite 备份：

~~~bash
sudo bash scripts/backup.sh \
  /var/lib/docker/volumes/babagan-meeting_api-data/_data/meetings.sqlite \
  "$APP_DIR/var/backups" 7
~~~

恢复脚本只创建新文件，不直接替换线上数据库：

~~~bash
sudo bash scripts/restore.sh "$APP_DIR/var/backups/meetings-<UTC>.sqlite" "$APP_DIR/var/restore"
~~~

先校验 sidecar checksum 和 PRAGMA integrity_check，再在停 API 的受控窗口由管理员执行文件替换；每月至少做一次空目录恢复演练。

## 7. 日常运维和安全

- Caddy 续期 turn 证书后，重复 3.4 节读取权限检查，重启 coturn 并验证 5349/TCP。
- P2P_TURN_SECRET 与 TURN_SHARED_SECRET 必须相同且至少 32 字符；P2P_TURN_TTL_SECONDS 固定 600。
- Cache-Control: no-store 是认证 ICE 响应的验收条件。
- 7880 不对公网开放；7881/TCP、UDP 443、50000–60000 由安全组和 UFW 同步允许。
- 旧 standalone babagan-coturn.service 不应与 Compose coturn 并存；确认使用容器版后执行 sudo systemctl disable --now babagan-coturn.service。
- 每周检查五服务健康、CPU/内存/磁盘/OOM、证书、TURN allocation、备份和 P2P 直连/中继/SFU 回退标签。
- 2 GiB 主机必须保留 1.1 GiB MemAvailable 门槛；日志不得记录 Token、密码、SDP 敏感标识或媒体内容，备份和发布记录不得放进 Web 目录。

