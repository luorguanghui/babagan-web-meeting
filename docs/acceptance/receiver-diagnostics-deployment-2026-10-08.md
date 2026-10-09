# 接收端掉帧诊断统计部署

2026-10-08（香港时间），用户明确要求通过内置浏览器中已打开的阿里云服务器终端更新部署。

## 发布内容与来源

- 基线：`3b83d6fe8fba1f43e59eea40176cfddef0e68674`，与线上当前发布的干净源码一致。
- 补丁 SHA-256：`641f35a8d47ecb79735c51cbfc5a25aa2c88adae262b3fca4a226405a6907d24`。
- 补丁只包含统计汇总、统计面板、中英文文案及两份相关测试，共五个文件；未包含工作区其他未提交修改。
- 新增实际发送帧率、完整帧接收速率、最近采样的解码／帧组装平均耗时、实际解码器与浏览器节能解码标记。区分编码帧率与解码帧率；缺少浏览器支持或采样基线时不伪造数值。
- 本地验证：129 项相关测试通过，网页类型检查、定向 ESLint 和生产构建通过。

## 服务器执行与结果

- 应用目录：`/opt/babagan-web-meeting`。
- 发布目录：`/opt/babagan-web-meeting/var/releases/receiver-diagnostics-20261008`。
- 发布镜像：`babagan-meeting-web:receiver-diagnostics-20261008`。
- 部署前会议状态汇总只有 `ended`，没有活动会议；五个服务健康，无待处理发布记录。
- 从当前发布源码复制独立候选目录，验证补丁校验和、应用范围并在服务器完成生产构建。
- 使用 SQLite 在线备份保存数据库，备份位于发布目录下的 `database-backup/`。
- 沿用当前 Compose 配置链，仅追加 web 镜像覆盖并替换 web 容器。API、Caddy、LiveKit、coturn 的容器 ID 和镜像保持一致。
- 五个服务健康；公网 HTTPS 首页、`/health/live`、`/health/ready` 均通过。
- 公网新脚本为 `/assets/index-DcELtEa7.js`，新增诊断字段和英文标签均存在；公网脚本与新容器内文件 SHA-256 一致。
- 终端明确返回 `DEPLOY_SUCCEEDED=receiver-diagnostics-20261008`。

服务器发布证据保存在发布目录的 `release.json`、`deploy.log`、`web-build.log`、`source-manifest.json`、`before-containers.json`、健康检查结果与数据库备份中。回滚入口为该目录的 `rollback.sh`，仅恢复先前的 web 镜像配置。

[脱敏部署记录](assets/receiver-diagnostics-deployment-2026-10-08.json)。终端截图保留在本地受控 output 目录。

## 验证边界

这是诊断统计更新，没有改变采集、编码、P2P 传输或播放策略。尚未复现并修复用户报告的高动态画面约 17 帧问题。需要两端刷新网页加载新版后，在掉帧瞬间对比实际发送、完整帧接收、解码帧率及耗时。
