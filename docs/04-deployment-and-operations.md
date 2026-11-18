# 部署与运维

本文件是 Babagan 的主部署指南，覆盖两条路径：

- **已有服务器更新**：服务器已有 Docker、Compose、生产环境文件和当前 release 记录。
- **从零部署**：全新的 Debian 12 或 Debian 13 服务器，没有 API 数据卷和当前发布记录。

默认域名是 meet.babagan.cloud、rtc.babagan.cloud、turn.babagan.cloud。命令中的 APP_DIR、TARGET_IP、TURN_RELAY_IP 和仓库地址必须替换成目标环境值。真实密码、Token、API secret 和公网 IP 只放在服务器受保护文件中，不进入 Git、命令历史或本文档。

## 1. 拓扑和固定约束

| 项目 | 当前约定 |
|---|---|
| 系统 | Debian 12 或 Debian 13，推荐 2 核、2 GiB、40 GiB |
| 网页/API | https://meet.babagan.cloud，DNS only，直连 Caddy |
| LiveKit 信令 | wss://rtc.babagan.cloud，DNS only |
| TURN | turn.babagan.cloud，DNS only |
| 应用目录示例 | /opt/babagan-web-meeting |
| 已有安装更新 | scripts/update.sh（独立候选、沿用现有配置） |
| 首次／完整部署 | scripts/deploy.sh（受保护 release 事务） |
| 数据 | Docker volume babagan-meeting_api-data 中的 SQLite |

Compose 服务：caddy（80/443、ACME、反代）、api（内部 3000）、livekit（7880、7881、UDP 443、50000–60000）、coturn（3478、5349、49160–49200）和 web（内部 8080）。

公网入站只允许 TCP 22、80、443、3478、5349、7881，以及 UDP 443、3478、49160–49200、50000–60000。LiveKit 7880 只允许 Docker bridge 内部 API/Caddy 访问，不加入公网安全组。禁止公开 API 3000、SQLite、7880、Docker 管理端口和监控端口。

## 2. 共同准备

~~~bash
export APP_DIR=/opt/babagan-web-meeting
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

deploy.sh 要求 Debian 12 或 Debian 13、至少约 1.1 GiB 可用内存和至少 10 GiB 可用磁盘。2 GiB 主机在构建时内存紧张时，可在停机窗口停止 Compose 并释放缓存：

~~~bash
sudo docker compose --env-file "$APP_DIR/infra/.env.production" -f "$APP_DIR/infra/docker-compose.yml" stop
sync
echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
awk '/MemAvailable:/ {print $2 " KiB available"}' /proc/meminfo
~~~

预检实际要求 `MemAvailable >= 1153434 KiB`。先确认没有需要保留的运行中会议，再停止服务或释放缓存；不要修改脚本门槛来跳过资源检查。

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

Cloudflare DNS 必须是：meet、rtc、turn 均为 DNS only，三者解析到目标源站，浏览器经 Caddy 的有效证书直连 HTTPS/WSS。部署脚本根据云防火墙和主机防火墙的匹配证据记录 SSH 策略；公开 SSH 时使用对应的 public SSH 证据字符串。

### 2.2 仓库同步（完整部署）

远端可达时：

~~~bash
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo git clone --branch '<发布分支>' "$REPO_URL" "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
cd "$APP_DIR"
git status --short
git rev-parse HEAD
~~~

远端不可达时，在本地从**包含完整目标提交和历史**的仓库生成经校验的 Git bundle。新服务器没有基线时，使用完整 bundle，并在空目录验证它没有缺失的 prerequisite；增量 bundle 只适用于目标机器已有完整且可信的基线提交。

~~~bash
git bundle create "babagan-release.bundle" '<发布分支>'
sha256sum "babagan-release.bundle"
mkdir -p /tmp/babagan-bundle-verify && git -C /tmp/babagan-bundle-verify init
git -C /tmp/babagan-bundle-verify bundle verify "$(pwd)/babagan-release.bundle"
~~~

将 bundle 传到目标服务器后，对照本地 SHA-256 核验，再从 bundle 克隆到空目录，检查目标提交和工作树。上传途径例如阿里云 Workbench 文件管理；如果浏览器扩展提示缺少文件 URL 权限，需要在扩展设置中启用后重试。不要上传生产 env 或秘密。

~~~bash
sha256sum /受保护上传目录/babagan-release.bundle
git clone /受保护上传目录/babagan-release.bundle "$APP_DIR"
git -C "$APP_DIR" checkout --detach "$RELEASE_SHA"
git -C "$APP_DIR" remote set-url origin "$REPO_URL"
test "$(git -C "$APP_DIR" rev-parse HEAD)" = "$RELEASE_SHA"
git -C "$APP_DIR" status --short
~~~

目标服务器已经具有可信基线时，也可生成增量 bundle：

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

本次迁移中 GitHub 的 Git 克隆超时，但固定提交的 GitHub codeload 压缩包可访问。实际操作以本地可信仓库的 Git tree 哈希核对解压内容，并恢复相同提交对象后导入含修复的增量 bundle；仅下载源码压缩包不会自动保留提交历史或版本来源，不能把它当作已验证的 Git checkout。无法核对 tree、提交对象与 bundle prerequisite 时，使用完整 bundle。

## 3. 从零部署 Debian 12 / Debian 13

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

本次 Debian 12 服务器访问 Docker 官方下载站时连接被重置，使用了阿里云 Docker CE 镜像。若需使用镜像，先从可信渠道独立核对下载的 Docker 签名密钥指纹，再将 apt 源指向 `https://mirrors.aliyun.com/docker-ce/linux/debian`，保留 `signed-by` 签名校验；不要因网络问题关闭 TLS 或包签名校验。Debian 默认源中的 `docker.io` 不一定提供所需的 Compose v2 插件，安装完成后以 `docker compose version` 验证。

容器镜像无法从 Docker Hub 拉取时，可在生产 env 的 `NODE_IMAGE`、`CADDY_IMAGE`、`LIVEKIT_IMAGE`、`COTURN_IMAGE` 中使用可用的镜像代理地址，但必须保留示例中各镜像原有的完整 digest。本次使用了 `m.daocloud.io/docker.io/` 前缀。阿里云主机还可将 `ALPINE_MIRROR` 设为 `http://mirrors.cloud.aliyuncs.com/alpine`，使用内网源下载 Alpine 软件包；软件包签名校验仍应保持启用。`NPM_REGISTRY` 保持可信、可用的注册表。

先检查旧 standalone coturn 服务是否存在；只有确认其与本项目容器服务冲突时才停用：

~~~bash
systemctl is-active babagan-coturn.service || true
systemctl is-enabled babagan-coturn.service || true
# 确认存在且可停用后：sudo systemctl disable --now babagan-coturn.service
~~~

### 3.2 生产环境和秘密

~~~bash
sudo install -d -m 700 /root/babagan-secrets /root/babagan-protected
cd "$APP_DIR"
sudo cp infra/.env.production.example infra/.env.production
sudo chmod 600 infra/.env.production
sudoedit infra/.env.production
~~~

至少替换：PUBLIC_BASE_URL、LIVEKIT_URL、LIVEKIT_INTERNAL_URL、LIVEKIT_NODE_IP、LIVEKIT_API_KEY、LIVEKIT_API_SECRET、ADMIN_PASSWORD_HASH、COOKIE_SECRET、P2P_STUN_URLS、P2P_TURN_URLS、P2P_TURN_SECRET、P2P_TURN_TTL_SECONDS=600、P2P_TURN_PROVIDER=coturn、TURN_SHARED_SECRET、TURN_EXTERNAL_IP、TURN_RELAY_IP。P2P TURN 只使用服务器 coturn；项目已移除 Cloudflare TURN 凭据生成、选项和探测功能。

`LIVEKIT_URL` 是浏览器客户端使用的 WSS 基地址，例如 `wss://meet.babagan.cloud` 或 `wss://rtc.babagan.cloud`。客户端会自行追加 `/rtc`，不要将同源基地址填成 `wss://meet.babagan.cloud/rtc`，否则真实入会会请求重复路径。部署冒烟使用的直接 WebSocket 探测地址 `wss://meet.babagan.cloud/rtc` 与这个客户端基地址用途不同。上线后还要在真实浏览器静音入会，确认列表至少包含本地参会者、麦克风按钮可用；单次 WebSocket 握手不能证明完整入会正常。

如需 Cloudflare SFU，可在受保护的生产 env 中成对配置 `CLOUDFLARE_SFU_APP_ID` 与 `CLOUDFLARE_SFU_APP_SECRET`，或按下文配置已有 Worker 网关。这里的秘密是 SFU 应用 App Secret，不是旧 Cloudflare TURN Key token，也不是 Cloudflare 用户 API token。App Secret 只由 API 后端读取，不发送到浏览器、Git 或日志。直连凭据和 Worker 网关均未配置时，Cloudflare SFU 入口显示未配置。

共享者在共享前选择 Cloudflare SFU 后，只发送一份屏幕视频与可选电脑声音；所有观看者从同一发布订阅，语音仍使用 LiveKit。P2P/服务器 TURN 与显式 LiveKit SFU 保留，Cloudflare TURN 不再可选。旧 `babagan.screen-turn-provider=cloudflare` 缓存会回退自动/coturn；升级时从当前 env 移除所有 `CLOUDFLARE_TURN_*`，设置 `P2P_TURN_PROVIDER=coturn`，先保留 mode-600 的 env 备份。不要删除 Cloudflare 账户中现有 TURN 应用。

Cloudflare SFU 默认由服务器直连 `https://rtc.live.cloudflare.com/v1` 发起控制请求，浏览器媒体直接连接 SFU；不使用 VPN 代理，不关闭 TLS 验证。更新后的 smoke 会验证当前配置路径的真实 SFU 会话分配及已认证项目 API 的 SFU 可用状态，配置存在但检查失败会回滚；旧的 Cloudflare TURN smoke 豁免不能用于 SFU。真实发布、订阅和媒体仍需会话验收。

若直连控制 API 不稳定，可复用现有 `babagan-p2p` Worker 的 `/api/sfu/` 路由：生产环境设置 `CLOUDFLARE_SFU_GATEWAY_URL=https://p2p.babagan.cloud/api/sfu`，并在受保护 env 中配置与 Worker `SFU_GATEWAY_TOKEN` 一致的 `CLOUDFLARE_SFU_GATEWAY_TOKEN`，移除服务器的 SFU App ID/Secret 配置。应用凭证继续由现有 Worker 配置管理，项目不会读取、替换或向 Worker 发送服务器密钥；服务器只转发已授权会议的 SDP 和会话操作。允许的入口只有该自定义域和 `https://babagan-p2p.1312479965.workers.dev/api/sfu`，不接受任意目标。浏览器媒体仍直连 SFU。控制请求不会在两种路径间自动重试，部署冒烟必须验证当前选中的入口成功。

服务器 coturn 是唯一 TURN 提供方，界面不再显示提供方选择框；观看者仍可选择 TURN 接收路径。停止共享后，客户端等待旧发布和共享权限释放完成才允许下一次捕获，期间显示“正在停止共享”。SFU 上游操作按成员串行，不同观看者可并发协商；失效发布立即撤出发现目录，失败的轨道关闭仍保留后台清理。客户端会话请求最多等待 45 秒，以覆盖两次各 10 秒的上游调用及失败清理，不能把超时自动当成未分配成功并盲重试。

清理已拥有的 SFU 会话时，明确的 HTTP `410` 且 `errorCode=session_error` 表示旧会话已关闭或过期，应退役本地清理记录以允许再次共享；不能因此重试旧会话。其他响应、未确认结果和网络失败继续保留清理状态，不把权限或鉴权错误当作关闭成功。

本次修复后，已进入 `closing` 的旧会话不再占用五个活动会话名额，后台仍会重试关闭；单个会议待清理会话达到 20 个时，新分配会返回清理进行中的 503，以限制上游资源堆积。同一成员同一角色的旧会话若尚未清理完成，替换连接仍需等待。`Cloudflare SFU: Meeting is full` 在此路径上由项目服务器的活动会话计数触发，不能仅凭提示认定是 Cloudflare 临时凭证过期时间造成。

LIVEKIT_NODE_IP/TURN_EXTERNAL_IP 必须等于 TARGET_IP；P2P_TURN_SECRET/TURN_SHARED_SECRET 必须相同且至少32字符；镜像保持示例中的批准 digest。Compose 的 edge 网段为 `172.30.0.0/16`、backend 网段为 `172.31.0.0/16`，现有内部服务和防火墙边界保持原配置。
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
NODE_IMAGE=$(sudo sed -n 's/^NODE_IMAGE=//p' infra/.env.production)
ALPINE_MIRROR=$(sudo sed -n 's/^ALPINE_MIRROR=//p' infra/.env.production)
NPM_REGISTRY=$(sudo sed -n 's/^NPM_REGISTRY=//p' infra/.env.production)
test -n "$NODE_IMAGE" && test -n "$ALPINE_MIRROR" && test -n "$NPM_REGISTRY"
sudo docker build --pull --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "ALPINE_MIRROR=$ALPINE_MIRROR" --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  -f apps/api/Dockerfile -t babagan-meeting-api:bootstrap .
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

将哈希填入 `ADMIN_PASSWORD_HASH`，在 Compose env 文件中用单引号包住完整 Argon2id 哈希，避免其中的 `$` 被插值；明文密码不得进入 env、shell 历史或文档。API Dockerfile 使用固定 Node 镜像内的 `/usr/local` 头文件编译原生模块，避免 `node-gyp` 在访问 Node 头文件下载站超时时失败。更换 Node 镜像时应先确认对应头文件与运行时版本匹配。

本次服务器还验证了另一种准备哈希的方法：安装 Debian 的 `python3-argon2`，由管理员在终端隐藏输入密码，使用 Argon2id、`memory_cost=65536`、`time_cost=3`、`parallelism=1` 生成并验证哈希，再写入 mode-600 生产 env，并移除临时明文文件。无论采用哪种方法，都不要把密码放进命令行参数、日志或聊天记录。

### 3.4 Caddy 证书和 coturn 权限

coturn 从 Caddy 数据卷读取 `turn.babagan.cloud` 证书。首次部署先只启动 Caddy；从旧服务器迁移时，须在约定的停机窗口把三条 DNS-only 记录切到新服务器，让 ACME 验证到达新 Caddy。确认解析后等待签发，再启动完整栈。原站可能在 DNS 缓存过期前继续收到请求；新站在完整栈启动前也可能返回 502。

~~~bash
cd "$APP_DIR"
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml up -d --no-deps caddy
# 此时完成 DNS 切换，并分别确认三个名称已解析到 TARGET_IP。
for host in "$PUBLIC_HOST" "$RTC_HOST" "$TURN_HOST"; do
  getent ahostsv4 "$host" | awk '{print $1}' | sort -u
done
CADDY_DATA=$(sudo docker volume inspect --format '{{.Mountpoint}}' babagan-meeting_caddy-data)
TURN_CERT_DIR="$CADDY_DATA/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud"
for attempt in $(seq 1 90); do
  if sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.crt" && sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.key"; then break; fi
  sleep 2
done
sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.crt"
sudo test -s "$TURN_CERT_DIR/turn.babagan.cloud.key"
~~~

对以非 root 用户运行的 coturn，按容器实际组 ID 限制证书权限。以下命令只给该组遍历所需目录和读取 TURN 证书的权限；其他站点私钥不应改为所有用户可读。`COTURN_IMAGE` 必须取自已核验的生产配置。

~~~bash
(
set -eu
COTURN_IMAGE=$(sudo sed -n 's/^COTURN_IMAGE=//p' infra/.env.production)
test -n "$COTURN_IMAGE"
COTURN_GROUP=$(sudo docker run --rm --network none --entrypoint id "$COTURN_IMAGE" -g)
for dir in "$CADDY_DATA" "$CADDY_DATA/caddy" "$CADDY_DATA/caddy/certificates" \
  "$CADDY_DATA/caddy/certificates/acme-v02.api.letsencrypt.org-directory" "$TURN_CERT_DIR"; do
  sudo chgrp "$COTURN_GROUP" "$dir"
  sudo chmod g+x "$dir"
done
sudo chgrp "$COTURN_GROUP" "$TURN_CERT_DIR/turn.babagan.cloud.crt" "$TURN_CERT_DIR/turn.babagan.cloud.key"
sudo chmod 640 "$TURN_CERT_DIR/turn.babagan.cloud.crt" "$TURN_CERT_DIR/turn.babagan.cloud.key"
sudo docker run --rm --network none -v babagan-meeting_caddy-data:/caddy-data:ro \
  --entrypoint sh "$COTURN_IMAGE" -c \
  'test -r /caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud/turn.babagan.cloud.crt && test -r /caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud/turn.babagan.cloud.key && echo TURN_CERT_READABLE'
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml stop caddy
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml rm -f caddy
)
~~~

预启动 Caddy 会创建 Compose network；某些 Compose 版本也会提前创建空的 `babagan-meeting_api-data` 卷，即使没有启动 API。`deploy.sh --bootstrap-empty` 要求此卷不存在。先确认没有其他部署、更新或进程操作该卷；只有在确认这是本次预启动创建、没有 release/pending 记录、卷归属项目、没有容器引用且目录完全为空时，才能移除这个空卷；任何条件不满足都应停止检查，不能删除已有数据库或 Caddy 证书卷。

~~~bash
sudo docker info >/dev/null || { echo 'Docker 不可用；停止并检查。' >&2; exit 1; }
if sudo docker volume inspect babagan-meeting_api-data >/dev/null 2>&1; then
  if (
    set -u
    test ! -e "$APP_DIR/var/releases/current-release.env" || exit 1
    test ! -L "$APP_DIR/var/releases/current-release.env" || exit 1
    test ! -e "$APP_DIR/var/releases/current-update.json" || exit 1
    test ! -L "$APP_DIR/var/releases/current-update.json" || exit 1
    test ! -e "$APP_DIR/var/releases/pending-release.env" || exit 1
    test ! -L "$APP_DIR/var/releases/pending-release.env" || exit 1
    test ! -e "$APP_DIR/var/releases/update-pending.json" || exit 1
    test ! -L "$APP_DIR/var/releases/update-pending.json" || exit 1
    API_DATA=$(sudo docker volume inspect --format '{{.Mountpoint}}' babagan-meeting_api-data) || exit 1
    API_PROJECT=$(sudo docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' babagan-meeting_api-data) || exit 1
    DOCKER_ROOT=$(sudo docker info --format '{{.DockerRootDir}}') || exit 1
    test "$API_PROJECT" = babagan-meeting || exit 1
    test ! -L "$API_DATA" || exit 1
    API_RESOLVED=$(sudo realpath -e "$API_DATA") || exit 1
    EXPECTED_DATA=$(sudo realpath -e "$DOCKER_ROOT/volumes/babagan-meeting_api-data/_data") || exit 1
    test "$API_RESOLVED" = "$EXPECTED_DATA" || exit 1
    API_ENTRY=$(sudo find "$API_DATA" -mindepth 1 -maxdepth 1 -print -quit) || exit 1
    API_USERS=$(sudo docker ps -aq --filter volume=babagan-meeting_api-data) || exit 1
    test -z "$API_ENTRY" && test -z "$API_USERS" || exit 1
  ); then
    sudo docker volume rm babagan-meeting_api-data
  else
    echo '空卷条件不成立；停止并检查，不能删除该卷。' >&2
    exit 1
  fi
fi
~~~

edge 网段固定为 `172.30.0.0/16`，`host.docker.internal` 使用 edge 网关 `172.30.0.1`；只允许 edge bridge 访问宿主机 7880。Docker 未显式设置 bridge 名称时，Linux 接口名通常是网络 ID 前 12 位加 `br-`，应实际核对：

~~~bash
EDGE_BRIDGE=$(sudo docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' babagan-meeting_edge)
EDGE_SUBNET=$(sudo docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' babagan-meeting_edge)
if [ -z "$EDGE_BRIDGE" ]; then
  EDGE_ID=$(sudo docker network inspect --format '{{.Id}}' babagan-meeting_edge)
  EDGE_BRIDGE="br-${EDGE_ID:0:12}"
fi
test "$EDGE_SUBNET" = 172.30.0.0/16
ip link show "$EDGE_BRIDGE"
sudo ufw allow in on "$EDGE_BRIDGE" from "$EDGE_SUBNET" to any port 7880 proto tcp comment 'babagan-livekit-internal'
~~~

网络被重建时重新核对接口名和 UFW 规则。证书续期后需重新设置 coturn 读取权限并重启 coturn，验证 5349/TCP；重启可能短暂影响正在使用 TURN 的连接。本次新服务器已安装 `/usr/local/sbin/babagan-coturn-tls.py` 和 `babagan-coturn-tls.timer`，每小时检查证书变化、修正组权限并在证书改变时重启 coturn。该维护脚本目前是服务器上的运维文件，不属于仓库中的通用安装器；在其他新服务器上不要假定定时器已经存在，需自行部署并验证等效机制。

~~~bash
sudo systemctl is-enabled babagan-coturn-tls.timer
sudo systemctl is-active babagan-coturn-tls.timer
sudo systemctl show babagan-coturn-tls.service -p Result --value
(set -o pipefail; echo | openssl s_client -connect turn.babagan.cloud:5349 \
  -servername turn.babagan.cloud -verify_hostname turn.babagan.cloud \
  -verify_return_error -CApath /etc/ssl/certs 2>/dev/null | openssl x509 -noout -subject -dates)
~~~

### 3.5 证据、Token 和首次发布

创建 deploy.sh 接受的 mode-600 证据文件（推荐限制 SSH）：

~~~bash
sudo tee /root/babagan-protected/network.txt >/dev/null <<'EOF'
Alibaba inbound: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted
Host firewall: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted; default deny inbound
EOF
sudo tee /root/babagan-protected/cloudflare.txt >/dev/null <<'EOF'
Cloudflare: meet DNS-only; rtc DNS-only; turn DNS-only
EOF
sudo chmod 600 /root/babagan-protected/network.txt /root/babagan-protected/cloudflare.txt
~~~

如果实际策略是公网 SSH，将 `network.txt` 的两行分别改为：

~~~text
Alibaba inbound: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH public by operator decision
Host firewall: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH public by operator decision; default deny inbound
~~~

证据应对应实际规则，两行的 SSH 策略必须一致。

deploy.sh 仍要求非空的 mode-600 smoke-token-file，主要兼容 rollback；正常 deployment smoke 会现场创建临时会议并签发新 Token，验证服务器coturn。配置了Cloudflare SFU时还会直连验证其App Secret及项目SFU能力接口。准备一个24小时Token：

~~~bash
sudo bash -c 'umask 077; docker run --rm --network none --env-file /opt/babagan-web-meeting/infra/.env.production --entrypoint node babagan-meeting-api:bootstrap --input-type=module -e '\''import {AccessToken} from "livekit-server-sdk"; const t=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:"deployment-rollback",ttl:86400}); t.addGrant({room:"deployment-smoke",roomJoin:true}); process.stdout.write(await t.toJwt());'\'' > /root/babagan-secrets/smoke-token; chmod 600 /root/babagan-secrets/smoke-token'
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

## 4. 已有服务器一键更新

已有安装采用 `scripts/update.sh`。它从当前安装的 Git `origin` 获取独立候选源码，默认分支 `main`；不会对 `/opt/babagan-web-meeting` 主工作树执行 reset、checkout 或 clean，因此兼容此前的热修复及多层 Compose override。首次安装或需要重建媒体配置时仍使用 `scripts/deploy.sh`，不能混用两套发布记录。

### 4.1 旧服务器首次获取更新器

旧安装还没有脚本时，先下载一个 Git 快照到独立目录。下列命令不会覆盖原安装源码：

~~~bash
sudo bash -c '
set -Eeuo pipefail
install -d -m 700 /opt/babagan-web-meeting/var/updater
candidate=$(mktemp -d /opt/babagan-web-meeting/var/updater/main-XXXXXX)
ref=main # 如需未合并版本，显式替换为已审查的发布分支
git clone --depth 1 --branch "$ref" https://github.com/luorguanghui/babagan-web-meeting.git "$candidate/source"
printf "Updater source: %s\n" "$candidate/source"
bash "$candidate/source/scripts/update.sh" --app-dir /opt/babagan-web-meeting --ref "$ref" --commit "$(git -C "$candidate/source" rev-parse HEAD)"
'
~~~

此快照的更新器可再次调用。记下终端打印的 `Updater source` 目录或用 `find var/updater -name update.sh` 定位。更新器不会覆盖原安装源码，因此应用更新成功不代表根目录的旧更新器也已升级；需要更新器新功能时重新获取已审查快照。未合并的功能分支必须显式选择，默认不会自动切换到它。

### 4.2 常规更新和选项

~~~bash
sudo bash scripts/update.sh --app-dir /opt/babagan-web-meeting
# 只更新静态网页，不重启 API 或媒体服务：
sudo bash scripts/update.sh --app-dir /opt/babagan-web-meeting --web-only
# 固定一个完整、已审查的 Git 提交：
sudo bash scripts/update.sh --app-dir /opt/babagan-web-meeting --commit '<40 位小写 SHA>'
# 显式选择未合并的已审查分支（默认仍是 main）：
sudo bash scripts/update.sh --app-dir /opt/babagan-web-meeting --ref '<发布分支>' --commit '<40 位小写 SHA>'
~~~

以 sudo 运行；需要 Python 3、Git、可用的 Docker daemon / Compose、SQLite、curl 和基础 Linux 工具，以及 mode-600 的 `infra/.env.production`、mode-700 的 `var/releases`。构建前要求至少 10 GiB 可用磁盘和 1100 MiB 可用内存；不自动安装依赖、清理旧镜像或删除备份。两种部署入口共享 `/run/lock/babagan-meeting-update.lock` 非阻塞事务锁，避免候选构建期间并发迁移或替换容器。更新前结束处于 created/active/grace 的会议。默认更新 API 和 web；Caddy、LiveKit、coturn 保留当前容器和配置。候选源码从 `origin` 获取，主工作树、生产 env 与历史发布均保留。构建、迁移和激活前会复核生产 env 的内容/权限、活动 Compose 链每个文件的内容及当前容器身份/健康。发生变化时停止并保留证据，不带着变化后的配置继续部署。锁由内核在进程退出时释放，残留的锁文件不表示仍在运行，不要删除锁文件绕过互斥。

更新过程：检查依赖/资源和现有配置 → 按实际运行镜像核对来源 → 获取完整 Git 历史并核对候选版本 → 固定版本 Dockerfile 构建 → 再检查会议/配置/容器并做 SQLite 在线备份 → API 更新时执行迁移 → 激活前再次核对 → 仅替换目标应用容器 → 等待五服务健康 → 公网 JavaScript 与容器文件 SHA-256 比对 → 新签发 Token 的鉴权 ICE/RTC 冒烟 → 最后复核配置与容器 → 原子写入发布记录。

版本检查按 API / web 分别进行，`--web-only` 不会把 API 冒认为网页的新版本。选中服务都已运行目标提交时打印 `ALREADY CURRENT`，不备份、不构建、不迁移、不重启。仍需读取运行状态及远端源码；这不是离线检查。其他更新要求目标为每个选中服务当前提交的 Git 后代，`--commit` 也不能绕过降级保护。已部署功能分支而 `main` 尚未包含它时，默认更新会拒绝，需显式选择包含现有版本的分支/提交；不要重置服务器工作树或强行回到旧 main。

默认检测已配置的Cloudflare SFU并要求鉴权检查通过。旧Cloudflare TURN的`--skip-cloudflare-smoke`参数已移除，不适用于SFU。API更新override向当前Compose链注入服务端SFU密钥引用并取消旧TURN配置，web-only不重配API。配置Cloudflare SFU或移除旧TURN时必须更新API和web。

### 4.3 发布记录与失败恢复

更新记录位于 `var/releases/update-<UTC>-<PID>/release.json`，最新记录为 `var/releases/current-update.json`。部署前的实际镜像 ID、完整 Compose 配置链、备份及 SHA-256、构建／迁移／激活／回滚／smoke 日志和 `rollback.sh` 均保存在该发布目录，权限为 600/700。没有成功日志时不能把候选镜像当作已验收。

激活或验证失败时，仅在配置仍与更新前一致的情况下尝试恢复之前的应用镜像；等待健康检查并核对旧镜像 ID、非目标容器未被替换，全部通过才记录 `applicationImagesRestored=true`。它只证明应用镜像和容器健康已恢复，不表示数据库已回到备份时刻；不自动替换数据库、不删除镜像和备份。配置变化时不使用变化后的 Compose 盲目回退。`var/releases/update-pending.json` 保留本次候选与备份位置，阻止再次更新。终端会提示失败阶段和证据目录，`failure.json` 同时保留初始错误与回退错误；记录写入失败也不会覆盖原始错误。迁移失败或激活前检测到变更时同样保留 pending，停止/中断后不能盲目重跑。先核对当前容器实际状态、`failure.json`、迁移日志及备份校验值，再依据该记录决定恢复数据库或向前修复；确认恢复完成后把 pending 归档到原发布目录。不要直接删除 pending 以绕过恢复。

来源校验优先使用受保护的 `current-update.json` / 历史 `update-*/release.json`，兼容完整部署生成的 `current-release.env`；只有其中记录的不可变镜像 ID 与实际运行一致时才认可提交。旧安装若缺少来源记录或有未记录热修复，会在构建和迁移前停止。先从原始部署备份恢复真实记录，并核对 API/web 镜像 ID 与记录的完整 SHA；无法取得可信来源时需人工查明该版本的构建/发布证据。不要用安装目录的 `git HEAD`、镜像 tag、手工编造记录或 `--commit` 绕过核验。

失败排查可先运行只读命令（发布目录使用失败输出的真实路径）：

~~~bash
sudo docker inspect --format '{{.Name}} {{.Image}} {{json .State.Health}}' babagan-meeting-api-1 babagan-meeting-web-1
sudo cat '/opt/babagan-web-meeting/var/releases/update-<UTC>-<PID>/failure.json'
~~~

日志和记录留在服务器受保护目录，不要把生产 env、Token 或原始日志上传到公开位置。

该流程的回滚使用记录目录里的 `rollback.sh`，它引用部署前真实镜像的不可变 ID。自动回退由更新器持锁并负责核验；单独执行该脚本只是镜像恢复命令，不包含数据库恢复或完整健康验收。人工执行前必须先确认无其他部署、配置未变、未发生更晚发布，执行后重新核对旧镜像及健康，不能把历史脚本作为任意降级入口。`scripts/rollback.sh` 只适用于下面完整部署流程生成的 `current-release.env`，不能用旧 `.env` 记录回滚新的一键更新。

## 4A. 已有服务器完整部署流程

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

若 pending-release.env 或 update-pending.json 存在，停止并诊断，不重复运行 deploy.sh。完整部署还要求实际运行镜像与受保护基线记录一致；旧记录与热修复现状不一致时使用 §4 的增量更新入口。保留 pending、容器日志、当前服务状态和备份，再决定归档后向前修复还是 guarded rollback。

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

非默认 env 文件追加 --env-file /受保护路径/infra.env.production。旧的 --allow-public-ssh 参数仍可接受，但不再需要。

deploy.sh 顺序固定为：只读预检 → SQLite在线备份和checksum → mode-600 pending → 固定镜像拉取/构建 → 一次性迁移 → 版本化镜像tag → 启动并等待五服务healthy → deployment-smoke。smoke创建临时会议并现场签发LiveKit Token，检查健康端点、coturn认证ICE、Cache-Control:no-store、P2P跨站403、RTC WebSocket和公网3000/7880阻断。配置了SFU App ID/Secret时，运行API容器内的直连SFU鉴权CLI以及已认证SFU能力请求；成功后写release record并保存completed pending。SFU诊断不输出App Secret、原始SDP或完整上游错误。

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

应看到五服务healthy、健康端点分别返回{"status":"ok"}和{"status":"ready"}、首页HTTP200、本次SHA、没有pending。若SFU已配置，smoke还应有`CLOUDFLARE_SFU_API_OK`，增量发布记录`cloudflareSfuApiVerified=true`；这只是鉴权／能力检查，媒体发布与订阅仍需真实会议验收。保留发布、健康与smoke输出到受保护记录。

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

- 检查 3.4 节的 TURN 证书续期同步任务；若当前服务器没有自动任务，续期后需按该节人工检查权限、重启 coturn 并验证 5349/TCP。
- P2P_TURN_SECRET与TURN_SHARED_SECRET必须相同且至少32字符，TTL固定600；P2P TURN只使用coturn。Cloudflare SFU App Secret不得进入Git、浏览器或日志。
- 共享传输方式在共享前选择，进行中不允许切换；Cloudflare SFU应明确显示为SFU，不能显示为Cloudflare TURN或在失败后暗中增加P2P编码。
- Cache-Control: no-store 是认证 ICE 响应的验收条件。
- 7880 不对公网开放；7881/TCP、UDP 443、50000–60000 由安全组和 UFW 同步允许。
- 旧 standalone babagan-coturn.service 不应与 Compose coturn 并存；确认使用容器版后执行 sudo systemctl disable --now babagan-coturn.service。
- 每周检查五服务健康、CPU/内存/磁盘/OOM、证书、TURN allocation、备份和 P2P 直连/中继/SFU 回退标签。
- 2 GiB 主机必须保留 1.1 GiB MemAvailable 门槛；日志不得记录 Token、密码、SDP 敏感标识或媒体内容，备份和发布记录不得放进 Web 目录。

### 屏幕共享掉帧日志

共享期间，发送端和观看端约每秒采样，积累 8 条样本后上传。停止共享或离开时会尝试上传尚未发送的样本，房间会话失效后停止接收。API 写入 `screen_share_quality` 结构化日志，随 API 容器日志按大小轮转（每文件 10 MiB，最多 3 个文件）。前后端应一起更新。

```bash
sudo docker logs --since 30m babagan-meeting-api-1 2>&1 | grep -F '"event":"screen_share_quality"'
```

用 `meetingKey` 和 `sourceKey` 找到同一房间的同一个共享者，再按样本 `at`（Unix 毫秒）对齐发送端和观看端。`traceId` 标识某一端的一次采集，`sequence` 是该端的批次序号，`link` 区分连接。浏览器缺失的指标或重建连接后的首个差分样本会省略。

- 查协商时，从 `links[].ice` 比较 `requestedPolicy`、`appliedPolicy`、`policyReason` 和两端选中的候选类型。用 `attemptReason`、`lastRetryReason` 和候选检查计数核对连接何时重建、程序当时检测到了什么。浏览器缺失的协商统计会省略。
- 先比较 `requestedFps`、`configuredFps` 和实测 `sourceFps`。静止画面可能自然降帧。Windows 原生采集还提供浏览器收到、提交、保活帧率和队列丢帧。
- Windows 采集组件 0.2.5 增加 `capture.native.pipeline`。按 `dxgiFps`（进入 FFmpeg 滤镜链）、`filteredFps`（筛帧后）、`helperFps`（组件从 FFmpeg 读取）、`loopbackSentFps`（本机写出完成）的顺序比较各段。用 `contentChangedFps` 看筛帧后实际变化的画面数，用 `loopbackDroppedFrames` 查本机传输丢帧。帧率和丢帧量对应 `intervalMs` 所示的采样时长。
- 再比较编码、发送、接收、解码和播放帧率。发送端的播放帧率来自本地预览。编码下降时可对照实际发送参数、目标码率、量化参数和单帧编码耗时。
- 发送正常时对照接收丢包、抖动、冻结时长及播放丢帧，并检查当时是否处于后台或线路恢复中。网络字段在浏览器提供对应计数时才出现。

### Cloudflare MoQ 屏幕共享

Cloudflare MoQ 是发起共享时可选的传输方式。发送端和观看端需要支持 MoQT draft‑18 的 WebTransport、WebCodecs 和 HTTPS。项目可复用网页或原生组件采集的视频和系统声音，麦克风语音仍经 LiveKit。

1. 在 Cloudflare 创建仅作用于该账户、具有 `Account > MoQ > Edit` 权限的 API Token。在服务器受保护的生产环境文件中配置 `CLOUDFLARE_MOQ_ACCOUNT_ID` 和 `CLOUDFLARE_MOQ_API_TOKEN`。管理凭据由 API 容器使用。
2. 按 API 和网页联合发布流程部署。每次 MoQ 共享由 API 自动分配一个隔离中继和短期连接令牌。中继随共享开始创建、随共享结束回收。
3. 在会议设置的「我发起共享时」选择「Cloudflare MoQ」，再发起共享。其他成员在同一会议里自动订阅。用两台客户端核对画面和系统声音，并确认停止共享后中继被回收。

观看者主动离开会议或被移除时，API 会回收旧中继以撤回该观看者的访问。连接会短暂中断，发送端会尝试用原采集内容重新发布，其余成员会自动重新订阅。浏览器无法建立 MoQ 连接时，共享者可选择 P2P 或 Cloudflare SFU 再发起。[Cloudflare MoQ 文档](https://developers.cloudflare.com/moq/)

## 8. DNS 切换与恢复

从旧源站迁移到新主机时，只改三条业务记录的目标 IP，代理状态保持不变：

- `meet.babagan.cloud`：改到新公网 IP，保持 DNS only。
- `rtc.babagan.cloud`：改到新公网 IP，保持 DNS only。
- `turn.babagan.cloud`：改到新公网 IP，保持 DNS only。

建议顺序：

1. 先在新主机准备并核验源码、镜像、生产配置与防火墙，记录原三条 A 记录及代理状态；确认当前会议已结束并选择停机窗口。
2. 按 3.4 节预启动 Caddy，然后将 `meet`、`rtc`、`turn` 三条 A 记录切到新公网 IP，保持 DNS only。确认三条记录均已更新，并分别通过 `getent ahostsv4` 等方式检查解析；DNS 缓存可能使不同客户端暂时看到不同目标。
3. 等待新 Caddy 取得证书，核对 TURN 证书权限；按 3.4 节处理预启动可能产生的空 API 卷，然后执行首次发布与健康检查。
4. 确认 HTTPS、coturn 和 RTC 冒烟；若配置 Cloudflare SFU，检查当前直连或 Worker 网关的鉴权与已认证能力接口。最后由用户在真实会议中验收语音、屏幕共享和多人反复进出。

若切换后发现 Caddy、TURN 或 LiveKit 不可用，只回退这三条业务 DNS 记录的原始 IP 与代理状态；不要删除现有 Cloudflare TURN 应用，也不要把长期凭据导出到 Git 或聊天。

### 8.1 2026-11-01 新服务器迁移记录

本次在 Debian 12、2 vCPU、2 GiB、40 GiB 的新服务器上采用空数据库首次部署；旧服务器会议数据和管理员密码没有迁移。生产目录为 `/opt/babagan-web-meeting`，发布提交为 `26ad7620f48bfa96dacf981f502bd5e73aed144f`。三个业务域名均保持 DNS only，`p2p` Worker 未迁移或修改；Cloudflare SFU 控制请求使用已有 Worker 网关。按用户要求保留原有公网 SSH 策略。

部署过程使用阿里云 Docker CE 和 Alpine 内网镜像、固定 digest 的容器镜像代理，以及 GitHub codeload 加经校验的增量 bundle。Caddy 预启动产生的 API 卷经确认为空且没有引用后移除；TURN 证书使用 coturn 容器组读取权限，并部署了本机证书同步定时器。

首次发布记录显示五服务健康、HTTPS 和 RTC WebSocket 冒烟通过，Cloudflare SFU 鉴权和已认证能力检查通过；这不等于已完成真实多人音视频或反复进出验收。管理员密码由用户在服务器终端隐藏输入、生成并验证 Argon2id 哈希，临时明文文件已移除。

当时发布的提交 `26ad762` 后续已合入 GitHub `main`。`scripts/update.sh` 仍会检查目标版本是否包含服务器当前运行的发布提交。

## 9. 项目 WASM 屏幕编码资源

屏幕共享默认使用浏览器编码，H.264 默认、VP8 可选；项目 WASM 软件编码保留为手动选项。每次进入会议默认选中浏览器编码，无需清除本地存储。浏览器 P2P 使用原生媒体轨道，软件 P2P 每位观看者独立编码、数据通道和码率控制，最多四路；SFU 使用浏览器编码，语音麦克风仍走 LiveKit。实际帧率取决于设备、场景和观看者数量，不保证 45／60 fps。

WASM 与逐帧 JS 适配层位于 `apps/web/public/screen-codecs`，SHA-256、源码版本及对应源代码清单位于各包 `manifest.json`。保持该目录原始字节，禁止格式化、压缩重写或换行转换；Git 属性已单独配置。完整对应源代码在各包 `sources` 下提供，运行时不从 CDN 加载编码器。

重新构建 OpenH264 时使用固定 emsdk 4.0.23 和 OpenH264 v2.6.0 提交，执行 `scripts/build-screen-codecs.py`；随后 `scripts/vendor-codec-sources.py` 包装来源及项目封装源码，再执行 `node scripts/publish-screen-codecs.mjs`。构建命令和版本详见设计文件及 `media/codecs.lock.json`。测试包括 `node --test scripts/test-codec-bitrate.mjs scripts/test-screen-codecs.mjs scripts/test-project-opus.mjs scripts/test-codec-artifacts.mjs`。

网页容器的 `infra/web/Caddyfile` 为页面和同源 Worker/WASM 提供 COOP `same-origin`、COEP `require-corp`。项目非隔离环境只能显式识别为单线程 WASM，不会暗中切换浏览器视频编码器。现有更新脚本替换 web 镜像即可更新这些头；如果修改的是外层 `infra/caddy/Caddyfile`，仍需按原流程更新 Caddy，不能声称 web-only 已应用外层变更。

一键更新器会额外验证公共隔离头、两个编码包的清单与当前容器一致、编码模块及对应源码的 HTTP 状态／大小／SHA-256、WASM MIME 为 `application/wasm`；缺失或陈旧资源触发原有不可变镜像回滚。发布前需做真实 P2P/TURN、共享声音同步及长期资源稳定验收。开发用 `codec-test.html`、`p2p-codec-test.html` 和 `av-codec-test.html` 位于 Vite 根目录，不包含在生产 dist 中。

更新后共享端和观看端都应刷新页面；进入会议后默认选中浏览器编码，软件编码需在共享前手动选择。成功切换后只运行本次发布镜像，旧镜像作为不可变回滚备份保留，不再另外启动旧web实例。资源测试结果见 `docs/acceptance/wasm-screen-implementation-2026-10-10.md`，软件编码帧率不能以目标值或静态画面结果代替实际测量。

