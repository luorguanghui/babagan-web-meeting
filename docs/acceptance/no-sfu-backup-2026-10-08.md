# 取消常驻 SFU 屏幕备份：2026-10-08

## 最终行为

- 默认屏幕共享只启动 P2P/TURN，不向 LiveKit 发布屏幕备份。
- 默认接收端不订阅 SFU 屏幕视频或共享音频，仍订阅会议麦克风。
- P2P/TURN 协商、断线、丢包或停帧时保持原方式并有节奏地重试，不自动切 SFU。
- SFU 仍可由观看者手动选择。鉴权信令 `screen-transport` 由服务器路由给当前共享者，不信任客户端指定共享者身份。
- 至少一名观看者明确选择 SFU 时才发布屏幕；最后一名 SFU 观看者离开或返回 P2P/TURN 后取消 publication，并停止克隆轨道。
- 多人混用时，SFU 只服务明确选择它的人，其余人不订阅屏幕备份。
- P2P/TURN 模式只显示其自身媒体源、读取其自身统计，缺失报告时不套用 SFU 屏幕数据。
- 取消 SFU 屏幕轨道不会释放仍在运行的 P2P 共享锁；显式结束共享、参与者离开和会议结束仍按原生命周期清理。
- 快速切换和离开期间的旧请求不能重建过期连接；预先选择 SFU 时会在等待期间重申明确需求，不依赖 P2P offer。
- 本次包含前一轮 1080p 自动恢复、协商参数重试、浏览器编码层重建及 Cloudflare 容量恢复修复。

## 验证与发布状态

本地全量回归已通过 45 个测试文件、834 项测试；相关 lint、两轮独立审查通过。2026-10-08 15:55:42（香港时间，07:55:42 UTC）完成核心线上验收，通过用户已登录的 Codex 内置浏览器服务器终端部署。

## GitHub 与部署执行结果

- 功能提交：`06dac592c3fa71df7897c8138f95b21c11fe2a0d`。实际部署源码：`4b6d2d071cfb69fe7c54012e15a7f23c69a359a8`，已推送到 `codex/no-sfu-backup`。
- 最终回归：45 个测试文件、834 项全部通过；审查发现的 Webhook、默认订阅、请求重申及旧请求竞态均补充回归并修复，复审没有重要问题。
- 首次生产构建发现两个新增测试文件的 4 处 TypeScript 类型错误；修正测试 fixture 返回类型及缺失的工厂参数后，相关 115 项测试和 lint 通过。重建的 API、contracts、web TypeScript 和 Vite 全部通过。
- API 镜像：`babagan-meeting-api:no-sfu-backup-20261008`，ID `sha256:feb78fd8045be4f47ccf877239643496b815c47b068fbd1bcc25643edce5167d`。
- web 镜像：`babagan-meeting-web:no-sfu-backup-20261008`，ID `sha256:48a5975c3a6ce70d52aa5369c3a70d213e5d6120a7d3b4d0c8944b17c269c0ad`。
- 公网资源：`/assets/index-BrhHhAUZ.js`，SHA256 `a549c0b565b58955d73c968bbb8b69d935ba8cf12a5aa92e67eb76a091f6eda7`，包含 `screen-transport` 新协议。
- SQLite 在线完整备份：`var/releases/no-sfu-backup-20261008/database-backup/meetings-20261008T074811Z.sqlite`，完整性与校验文件生成成功。
- 沿用现有四层 Compose 配置，追加 `var/releases/no-sfu-backup-20261008/override.yml`，仅使用 `up -d --no-deps --no-build --pull never api web` 更新 API/web；Caddy、LiveKit、coturn 保持原实例。
- API、web、Caddy、LiveKit、coturn 均健康，候选镜像 ID 与实际运行容器匹配，无 pending 事务。
- HTTPS 首页、新 JS、live/ready 健康接口及内置浏览器创建会议表单通过。
- 默认 ICE 的实际 coturn 回退、显式 coturn ICE、`Cache-Control: no-store`、跨站 P2P WebSocket 403、公网 TCP 3000/7880 不可达、认证 RTC WebSocket open 和首条响应检查通过；临时测试会议已清理。
- RTC 验证使用发布目录中的验证副本，等待首条响应后关闭连接，避免旧脚本在 open 时立即关闭产生误报；不声称原有完整脚本未经修改通过。显式 coturn 的首次 RTC 探测失败，其内置重试随后成功。
- Cloudflare 凭据接口在现有代理上报 `ECONNRESET`，旧 API 镜像的对照请求也超时。严格 Cloudflare 冒烟没有通过；用户明确允许暂时忽略。已单独确认请求会返回有效 coturn 回退，不推断 Cloudflare TURN 媒体通道本身不可达。
- 服务器受保护记录、构建/验收日志、overlay 和回退脚本保存在 `var/releases/no-sfu-backup-20261008/`；本地操作脚本在 `output/no-sfu-backup-release-20261008/`。
- 没有执行新的真实多设备长时屏幕共享验收，因此线上恢复效果仍需实际会话验证。

## 回退

保留旧 API 与 `bandwidth-recovery-20261007` web 镜像。服务器执行 `sudo bash var/releases/no-sfu-backup-20261008/rollback.sh` 会省略本次 overlay，恢复前一 API/web 组合；没有数据库迁移，不需要还原数据库。本次没有执行回退。

## 兼容性

前后端需一并更新以支持按需 SFU 请求。旧页面仍执行旧发布逻辑，因此所有参会页面须刷新，并重新开始共享以启用新行为。没有数据库结构迁移，不改变 LiveKit、coturn、Caddy、DNS 或生产凭据。
