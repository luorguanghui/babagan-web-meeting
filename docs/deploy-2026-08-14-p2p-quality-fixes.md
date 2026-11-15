# Babagan 会议系统部署指南 —— P2P 质量修复版(2026-08-14)

> 这是 2026-08-14 指定版本的部署记录。当前部署和回滚请以[部署与运维指南](04-deployment-and-operations.md)为准。
>
> 目标:把包含 P2P 质量修复与会议控制修复的提交部署到 babagan.cloud 生产服务器(阿里云·武汉,Debian 12)。
> 本文档自包含,可以直接交给另一个 AI 或运维人员在服务器终端逐步执行。
> 涉及服务器时,所有命令都在**服务器上的 SSH 终端**中执行;每执行一步把输出记下来,失败时先停,不要继续。

## 0. 快速摘要(三步)

1. 定位部署目录:`APP_DIR=$(dirname "$(dirname "$(find / -maxdepth 6 -path '*/scripts/deploy.sh' 2>/dev/null | head -n1)")")`
2. 检出发布提交:`cd "$APP_DIR" && git fetch origin && git checkout c7c29b9871628ce3080c5172614323b9ea2a4e97`
3. 受控部署:`bash scripts/deploy.sh --confirm-deploy c7c29b9871628ce3080c5172614323b9ea2a4e97 --target-ip "$(sed -n 's/^TURN_EXTERNAL_IP=//p' infra/.env.production)" --smoke-token-file /protected/smoke-token --network-evidence /protected/network.txt --cloudflare-evidence /protected/cloudflare.txt`

详细步骤、前置检查、验证与回滚见下文各节。

## 1. 本次发布内容

- Git 远程:`https://github.com/luorguanghui/babagan-web-meeting.git`
- 分支:`feature/p2p-screen-share-hybrid`
- 部署提交(完整 40 位 SHA):**`c7c29b9871628ce3080c5172614323b9ea2a4e97`**
- 提交信息:`fix(meeting): reliable participant mic state and fail-fast host meeting end`
- **版本链**:本分支上 `8861595`(前四个 P2P 质量修复)→ `c7c29b9`(追加开麦/闭麦状态与结束会议两个修复)。**`c7c29b9` 已包含 `8861595` 的全部内容**,直接部署 `c7c29b9` 即可;若服务器此前已部署过 `8861595`,本次同样按本指南执行,属于增量重建(仅 `api` 与 `web` 两个服务),流程不变。

六个修复:

1. **锥形 NAT 下 A→B 可 P2P、B→A 不可**:观看者在收 offer 前检查 TURN 凭据过期并刷新;协商超时改为进度感知(ICE 有进展顺延,单次上限 30 秒),超时后自动用全新凭据重试一次再回退;观看者媒体定时器在 ICE 仍 checking 时顺延一次。
2. **P2P 直连 1080p 大变动掉到 ~10fps**:码率语义从"总预算平分"改为"档位=每名观看者上限",总额受 20 Mbps 上行预算封顶;3 人会议每人拿到满 8 Mbps。
3. **TURN 中转大变动模糊/色块**:relay 会话同样拿满档位;发送端每秒采样 `qualityLimitationReason`,连续 3 个样本带宽受限且帧率塌陷时自动切 `balanced`(先降分辨率避免色块),恢复后还原。
4. **共享音频间歇过响**:观看端共享音频经 WebAudio 处理(-6 dB 衰减 + 压缩限幅,threshold −20 dB、ratio 10:1)。
5. **开麦/闭麦状态显示不正确**:补齐 track 发布/取消发布与订阅状态事件的刷新,并每 5 秒对参会者状态做一次快照刷新,漏掉的静音事件也能在 5 秒内收敛。
6. **结束会议按钮有时没反应、会议仍在继续**:结束请求先落库(会议状态立即终止、参会者会话吊销),LiveKit 房间删除改为尽力而为——失败不再导致结束请求报错,由 30 秒清理循环自动重试;前端结束请求加 15 秒超时、按钮显示"正在结束会议…"忙态,重复点击或服务器已结束时不再报错。

仅重建 `api` 与 `web` 镜像;LiveKit、coturn、Caddy 配置与端口不变;无数据库迁移(本次提交无迁移文件)。

## 2. 部署前准备(服务器上执行)

### 2.1 定位部署目录与关键文件

```bash
# 找到部署检出目录(特征: 含 scripts/deploy.sh)
APP_DIR=$(dirname "$(dirname "$(find / -maxdepth 6 -path '*/scripts/deploy.sh' 2>/dev/null | head -n1)")")
echo "APP_DIR=$APP_DIR"
test -n "$APP_DIR" && test -f "$APP_DIR/scripts/deploy.sh" || { echo '找不到部署目录,请先确认服务器上的代码检出路径'; exit 1; }
cd "$APP_DIR"
```

记录输出中的 `APP_DIR`(例如 `/opt/babagan-web-meeting`),后续都用它。

### 2.2 确认证据文件(上次部署遗留)

```bash
ls -l /protected/smoke-token /protected/network.txt /protected/cloudflare.txt 2>/dev/null || ls -l /root/protected/* 2>/dev/null || echo '未找到 /protected 下的证据文件'
```

部署脚本要求:

- `--smoke-token-file`:LiveKit 冒烟 token 文件,权限必须 `600`;
- `--network-evidence`:防火墙取证文件;
- `--cloudflare-evidence`:内容必须**恰好一行** `Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)`。

若三个文件都在(上次部署使用过),直接复用。若缺失,先联系有服务器控制台权限的管理员按 `docs/runbooks/deployment-record.md` 的取证要求重新生成,**不要**自行编造。

### 2.3 确认生产环境文件与当前发布记录

```bash
stat -c '%a %n' infra/.env.production          # 必须 600
grep -c '^P2P_TURN_TTL_SECONDS=600$' infra/.env.production   # 必须输出 1
TARGET_IP=$(sed -n 's/^TURN_EXTERNAL_IP=//p' infra/.env.production); echo "TARGET_IP=$TARGET_IP"
grep '^RELEASE_SHA=' var/releases/current-release.env       # 当前线上版本,记下来作为回滚参照
test ! -e var/releases/pending-release.env && echo '无遗留 pending 记录' || { echo '存在 pending 记录,先按第 7 节恢复,不要继续'; exit 1; }
```

### 2.4 确认当前没有会议进行(建议在无会议窗口部署)

```bash
docker compose ps
# 最稳妥:请主持人确认当前无人在开会;如必须确认,可查看 LiveKit 最近连接日志:
docker compose logs --since 30m livekit 2>/dev/null | tail -n 20
```

有活动会议时**不要**执行第 4 节的受控部署,等会议结束。

### 2.5 基础资源自检(部署脚本也会再查一遍)

```bash
free -m | awk '/MemAvailable:/{print "MemAvailable(MB)=" $2}'   # 需 ≥ 1153
df -Pk . | awk 'NR==2{print "FreeDisk(KB)=" $4}'                # 需 ≥ 10485760
getent ahostsv4 rtc.babagan.cloud turn.babagan.cloud             # 两项都必须解析到 TARGET_IP
```

## 3. 更新服务器代码到新提交

```bash
cd "$APP_DIR"
git fetch origin
# 本地若有未提交改动先备份(正常应为干净状态):
git status --short
git stash push -m "pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
git checkout c7c29b9871628ce3080c5172614323b9ea2a4e97
git rev-parse HEAD
```

最后一条命令的输出必须**精确等于** `c7c29b9871628ce3080c5172614323b9ea2a4e97`(部署脚本会用这一条做硬校验,不匹配会拒绝部署)。

## 4. 受控部署(一条命令,自带全部预检、备份与冒烟)

```bash
cd "$APP_DIR"
bash scripts/deploy.sh \
  --confirm-deploy c7c29b9871628ce3080c5172614323b9ea2a4e97 \
  --target-ip "$TARGET_IP" \
  --smoke-token-file /protected/smoke-token \
  --network-evidence /protected/network.txt \
  --cloudflare-evidence /protected/cloudflare.txt
```

(证据文件路径以第 2.2 节实际找到的为准;若 SSH 防火墙取证使用了"允许公网 SSH"策略,需追加 `--allow-public-ssh`。)

脚本执行顺序与预期输出:

1. 只读预检(环境文件、镜像摘要、DNS、端口占用、数据库卷、release 记录);
2. 数据库一致性备份(输出 `Backup created: ...` 与 sha256 文件路径);
3. 写入 `var/releases/pending-release.env` 事务记录;
4. `compose pull --policy missing caddy livekit coturn` + `compose build --pull api web`(服务器 2C2G,**构建较慢,预计 5–15 分钟**,期间保持终端连接稳定);
5. 一次性数据库迁移;
6. 固定镜像 tag `babagan-meeting-<svc>:release-c7c29b98...` 并 `compose up -d`;
7. 等待全部服务 healthy(上限 180 秒);
8. 自动冒烟测试;
9. 输出 **`DEPLOY SUCCEEDED: c7c29b98...`** 并生成 release 记录。

**任何一步报错(`DEPLOY PREFLIGHT FAILED:` / `fail` / 非零退出)都立即停止**,把完整输出保存下来分析;若错误发生在 pending 事务写入之后,按第 7 节用 `--recover-pending-deploy` 走受控恢复,**不要**重复执行 deploy。

## 5. 部署后验证

### 5.1 服务与健康检查

```bash
docker compose ps                                  # 五个服务(caddy/api/livekit/web/coturn)全部 healthy/running
curl -fsS https://meet.babagan.cloud/health/live && echo    # {"status":"ok"}
curl -fsS https://meet.babagan.cloud/health/ready && echo   # {"status":"ready"}
curl -sS -D - -o /dev/null https://meet.babagan.cloud/ | head -n 5   # 200
```

### 5.2 本次六个修复的功能验证(真实双端)

用两台不同网络(最好一方为锥形 NAT/家庭宽带)的 Windows Chrome/Edge 打开 `https://meet.babagan.cloud` 开会,关注界面右下角 **WebRTC 统计面板**:

| 验证项 | 操作 | 预期 |
|---|---|---|
| ① 双向 P2P | A 共享 → B 显示 `P2P 直连`;停止后 B 共享 → A 也显示 `P2P 直连` | 双向都能直连;若直连失败,面板先显示 `正在建立连接`,数秒内应经历一次自动重试(可观察共享端 F12 网络里 `/ice-servers` 被再次请求),仍失败才落到 `TURN 中继`/`SFU 中转` |
| ② 直连帧率 | 3 人会议,1 人共享 1080p30,播放全屏视频/快速滚动 | 大变动时统计面板 `帧率` 应明显高于 10 fps(20+),`码率` 接近 8 Mbps |
| ③ TURN 画质 | 强制走 TURN(如双方开移动热点或 CGNAT),大变动画面 | 不再出现大面积色块;`质量受限原因` 显示 `bandwidth` 期间分辨率可能暂时降到 720p,恢复后回 1080p 且无块状伪影 |
| ④ 共享音频 | 共享方把系统音量调到很小,播放一段音乐 | 接收方音量稳定在语音电平附近,不会间歇性爆响;共享方本机预览仍静音 |
| ⑤ 开麦/闭麦状态 | 双方反复开麦/闭麦,观察对方参会者列表 | 每次切换后 5 秒内双方列表状态正确(已静音/麦克风已开启);本地按钮文案同步切换 |
| ⑥ 结束会议 | 主持人点"结束会议"确认;再试一次在服务器忙碌时段(如共享进行中)点结束 | 按钮立即变为"正在结束会议…"并禁用;请求 15 秒内要么成功离开、要么显示明确错误;会议状态在数据库中立即终止,其余成员 30 秒内被清出 LiveKit 房间 |

另验证:会议持续 >10 分钟后再让 B 开始共享(验证 TURN 凭据过期刷新路径仍能 P2P)。

> **部署后前端刷新提示**:`web` 静态资源带内容哈希,但 `index.html` 会更新。部署完成后,已打开的会议页面需要**刷新一次(F5)**才会加载新前端;正在开会的人不受影响(旧前端与新 API 兼容,语音/共享由 LiveKit 承载),建议会后再刷新。

## 6. 部署记录归档

```bash
cat var/releases/current-release.env    # 确认 RELEASE_SHA=c7c29b98...
ls -l var/backups/                      # 确认本次备份文件与 .sha256 都在
```

把 `DEPLOY SUCCEEDED` 输出、备份路径、`docker compose ps` 截图保存到服务器之外(按 `docs/runbooks/deployment-record.md` 模板补全证据)。

## 7. 回滚(仅在新版本出现问题时执行)

```bash
cd "$APP_DIR"
# 回滚目标 = 新 release 记录里保存的直接前身版本
PREV=$(grep '^PREVIOUS_RELEASE_SHA=' var/releases/current-release.env | cut -d= -f2)
echo "回滚目标: $PREV"
bash scripts/rollback.sh \
  --target-release-sha "$PREV" \
  --confirm-rollback "$PREV" \
  --smoke-token-file /protected/smoke-token
```

注意 `--target-release-sha` 与 `--confirm-rollback` 必须**完全相同**(脚本要求)。回滚同样自带备份校验与冒烟,完成后 `docker compose ps` 确认服务恢复。

若第 4 节部署在 pending 事务之后失败,回滚命令改用:

```bash
bash scripts/rollback.sh \
  --target-release-sha c7c29b9871628ce3080c5172614323b9ea2a4e97 \
  --confirm-rollback c7c29b9871628ce3080c5172614323b9ea2a4e97 \
  --smoke-token-file /protected/smoke-token \
  --recover-pending-deploy
```

(此时 `target` 是**失败候选**的 SHA,而不是前身版本。)

## 8. 注意事项

- 全程不要复制粘贴或记录任何 secret(token、密码、`infra/.env.production` 内容);证据文件保持 `600`。
- 服务器代码检出目录中的 `var/`(release 记录、备份)不要提交进 git。
- 部署期间如构建失败,常见原因:服务器磁盘不足(需 ≥10 GiB)、npm/镜像源网络抖动——修好后**先走第 7 节的 pending 恢复**,再考虑重新部署。
- 本次发布不改防火墙、DNS、LiveKit/coturn 配置;如部署后发现 3478/5349 或 relay 端口问题,与本发布无关,勿在排查时改容器端口映射。

## 9. 部署执行记录(部署完成后填写)

| 项目 | 记录 |
|---|---|
| 部署 SHA | `c7c29b9871628ce3080c5172614323b9ea2a4e97` |
| 执行时间(UTC) | |
| 操作人 | |
| `DEPLOY SUCCEEDED` 输出 | |
| 数据库备份路径 | |
| 冒烟测试结果 | |
| 第 5.2 节验证项 ①–⑥ 结果 | |
| 遗留问题 | |
