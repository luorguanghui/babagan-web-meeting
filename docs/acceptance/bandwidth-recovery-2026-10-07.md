# Cloudflare 带宽与分辨率恢复修复发布：2026-10-07

2026-10-07 21:19:48（GMT+8；服务器验证时间 13:19:48 UTC）完成公网验收。

## 范围与发布方式

- 项目目录：`/opt/babagan-web-meeting`。
- 仅对 `cloudflare-adaptive-encoding.ts`、`cloudflare-turn-path-probe.ts` 和 `p2p-share-controller.ts` 应用本次运行时代码补丁。
- controller 补丁从线上匹配的基线生成，仅加入恢复状态变化检测及恢复期间的 sender policy；未包含本地其他未提交修改。
- 未修改生产环境、API、Caddy、LiveKit、coturn、代理、DNS 或数据库。
- 沿用 9 月 14 日的 web 专项发布方式，追加 Compose overlay，仅重建并替换 web 容器。未运行仍要求旧 DNS 代理证据的完整 `deploy.sh`；没有伪造代理证据或变更 DNS。
- 旧 web 镜像和三个文件的源码备份均保留。

## 校验与产物

补丁 SHA256：`65d311febbabee54e2e2945e42985c6b5d75db9b627eedf7f9cb47c8481725d2`。

| 源码 | 修改前 SHA256 | 修改后 SHA256 |
|---|---|---|
| cloudflare-adaptive-encoding.ts | e4bacfe4c3884e29f2878b47a6bbf0d3de0a7289c600dffdc4b92982a1f51239 | f339815d3d5a01045c6fa737582641fa61e14c1e26dd1b8ffe9d76e7e8a00e2f |
| cloudflare-turn-path-probe.ts | 711a825a6426d61fef658250f83864bc54ea4919106106b0a1c65dfdeaee7b94 | 6ed7b86be5b6226b362bd9648713aedfc1510ed32c2a7c954ae009b1a09294da |
| p2p-share-controller.ts | b7e3a88bcc3aca7efc61d4543aad40092aa8e9fe64ff2d8f3d6864fa15472a05 | 625c5e416d309e1588842e831d87bb7072638f0f230bbb80d4d3acba0fa657a8 |

三个修改前校验值均与服务器匹配；补丁上传后校验 SHA256，通过 `git apply --check` 才应用，修改后校验值也全部匹配。

- 新镜像：`babagan-meeting-web:bandwidth-recovery-20261007`。
- 构建后镜像标识：`sha256:ed57a1b3effd130fb4298e099612bfde60595f3e16745e90195f0ad3d66cedf0`。
- 前一镜像：`babagan-meeting-web:ice-session-retry-20260914`。
- 新网页资源：`/assets/index-tue_W5CV.js`，995122 字节。
- 公网 JS SHA256：`8225cbbdaaccff86489fca9855d40817d207b150142c4d147bc2e78935b5ad10`。
- 受保护服务器记录目录：`var/releases/bandwidth-recovery-20261007/`，包括源码备份、补丁、构建日志及退出码、新旧镜像信息、overlay、验收脚本、验收日志和 `release.json`。
- 本地补丁及校验清单：`output/bandwidth-recovery-release-20261007/`。

## 验证结果

- 本地工作区完整测试 782 项通过；修改文件 ESLint 通过，独立审查无问题。
- 对本次实际部署的三个候选源码单独运行新增回归用例，13 项全部通过。
- 服务器 Docker 生产构建退出码 0；contracts 编译、web TypeScript 编译和 Vite 打包均通过。只有既有大 JS chunk 提示。
- 切换前确认候选镜像包含分辨率恢复逻辑，再使用 `up -d --no-deps --no-build --pull never web` 切换。
- web、API、Caddy、LiveKit、coturn 均健康；其他服务仍保持原运行实例。
- 公网首页 HTTP 200；新 JS HTTP 200，且确认包含修复逻辑。
- `/health/live` 返回 `{"status":"ok"}`，`/health/ready` 返回 `{"status":"ready"}`。
- 无 `pending-release.env`。
- 内置浏览器成功加载 `https://meet.babagan.cloud/create` 的创建会议表单。

没有执行新的真实多设备长时屏幕共享验收或完整认证 ICE/RTC 冒烟；本次验证不能证明所有实际网络条件下的恢复效果。旧页面需要刷新，并重新开始屏幕共享以载入修复。

## 当前启动参数与回退

当前 Compose 顺序为基础配置、基线 release overlay、9 月 14 日 web overlay，以及本次新增 overlay。

仅回退 web 时，省略本次 overlay，保留 9 月 14 日 overlay，使用已保留旧镜像；无需恢复数据库：

```bash
cd /opt/babagan-web-meeting
sudo docker compose --env-file infra/.env.production \
  -f infra/docker-compose.yml \
  -f var/releases/releases/39de3d802f383a55fdebaf85a005d0de436340d6.compose.override.yml \
  -f var/releases/ice-session-retry-20260914.override.yml \
  up -d --no-deps --no-build --pull never web
```

本次没有执行回退。下一次完整发布或重新构建时应核对该专项补丁，避免将已修复源码替换回旧版本。
