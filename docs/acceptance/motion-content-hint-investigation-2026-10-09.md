# 高动态共享掉帧：内容提示对照与候选修复

## 问题与事实

用户报告 Chrome/Edge 网页、单人观看、H.264、1080p、P2P 直连，在短时间大幅画面变化时下降到约 17 帧。随后提供的发送端截图显示编码 19 fps、实际发送约 20 fps、码率 3.35 Mbps、编码器目标 3.42 Mbps、设置上限 8 Mbps、限制原因为 `none`、会话平均编码耗时 5.02 ms。因此不能把该截图解释为“发送 60 fps、接收 17 fps”。

源码所有画质模式原先统一设置轨道 `contentHint='detail'`，包括声明帧率优先的标准与动态模式。直接 P2P 强制保护空间分辨率，因此没有通过分辨率变化释放高动态编码压力。

## 本机实验

实验使用独立 Edge 浏览器、真实 H.264 编码／解码和本机 host-to-host P2P，输入为固定种子生成的 1920×1080 canvas 纹理平移。每次运行新建连接、先静态 6 秒，再动态 20 秒；结果每秒采样，下面为末段 12 次样本平均值。没有人工注入编码帧率或改写 WebRTC 统计。

| 测试 | 实际源帧率 | 编码帧率 | 解码帧率 | 分辨率 |
|---|---:|---:|---:|---|
| 旧 detail 设置，60 fps 输入 | 57.17 | 10.20 | 9.20 | 1920×1080 |
| motion 提示，其他设置相同 | 57.17 | 53.58 | 53.33 | 1920×1080 |
| 修复后的实际采集控制器 + P2P 自动监测，60 fps 模式 | 53.92 | 49.00 | 48.92 | 1920×1080 |
| 修复后的实际采集控制器 + P2P 自动监测，30 fps 模式 | 29.58 | 29.08 | 29.00 | 1920×1080 |

detail 受压实验的末段平均编码耗时约 3.88 ms，限制原因仍为 `none`，与“低编码帧率但平均编码耗时不高”的报告形态相符。motion 对照约 3.57 ms。此实验确认输入与编码输出之间会丢帧，内容提示可以显著影响这条链路；不能把 `none` 当成“不可能编码前丢帧”。

原始样本位于：

- `docs/acceptance/assets/motion-detail-resolution-16.json`
- `docs/acceptance/assets/motion-motion-resolution-16.json`
- `docs/acceptance/assets/motion-production-resolution-16.json`
- `docs/acceptance/assets/motion-production-resolution-16-r30.json`

夹具与运行器保留在本地 `output/playwright/motion-debug.html` 和 `output/playwright/run-motion-comparison.mjs`，不作为随仓库发布的自动化浏览器测试。早期两次互相重叠、样本数不足的运行已用后续有效运行覆盖；最终运行器要求至少 12 个动态样本，避免把无效运行算作通过。

## 候选修复

- 标准／动态模式在发布前设置 `contentHint='motion'`，让编码器从初始化开始采用运动内容策略。
- 流畅／分辨率优先模式保留 `detail`。
- 保留现有 P2P 分辨率保护、码率上限、连接恢复与 TURN/SFU 行为；未引入降低分辨率的自适应策略。
- 统计面板新增关联 `mediaSourceId` 的实际采集帧率、最近采样的编码平均耗时、实际编码器与浏览器节能编码标记，以区分源帧率不足和编码输出减少。

## 验证与边界

- 修改内容提示断言后先观察到两项回归测试失败，再实现修复。
- 新增采集／编码耗时测试先失败，再实现统计。
- 网页回归：25 个测试文件、593 项测试通过；最终相关文件 123 项测试再次通过。
- 网页生产构建、类型检查和定向 ESLint 通过。
- 修复后真实 P2P 回放断言：平均编码与解码至少达到目标的 75%，且所有末段样本保持 1920×1080，现有 `maintain-resolution` 策略不变，30／60 模式均通过。

这是可复现的代码策略缺陷及其最小修复，不是对用户原会话全部原因的唯一性证明。输入是合成 canvas，真实桌面采集的操作系统／GPU 路径没有在该实验中复现；复杂内容、设备负载和可用码率仍可能造成低于 60 fps。用户实际会话需要上线后的对照验收。

## 发布状态

本轮后续重试已恢复内置浏览器连接，并通过用户打开的阿里云 Workbench 终端完成部署。此前连接失败阶段没有执行服务器部署；恢复后沿用用户已授权的上线范围。

已准备 `output/motion-content-hint-release-20261009/`：六文件补丁、校验清单、可恢复的 Python 发布脚本和 `deploy-command.txt` 单次传输启动命令。基线为 `3b83d6fe8fba1f43e59eea40176cfddef0e68674`，补丁 SHA-256 为 `a7353986bc22c41766ce8f7790394820e6d6966e6679ca8d28feca1e7c66aecd`。

发布脚本只更新 web：复制当前干净发布基线、校验补丁、在线备份 SQLite、生产构建、激活前确认没有开放会议、沿用当前 Compose 配置链、保留旧镜像回滚脚本、验证五个服务健康且其他四个容器 ID 不变、比对公网脚本与容器文件 SHA-256。只有这些检查通过才写入 `deployed-and-verified`。

### 2026-10-09 上线结果

- 部署前 SQLite 会议状态汇总仅有 `ended`，无活动会议；无待处理发布。
- 服务器源码基线与六文件补丁校验通过；在线数据库备份完成。
- 服务器生产构建完成，已运行 `babagan-meeting-web:motion-content-hint-20261009`。
- 公网脚本 `/assets/index-CRjsRjMv.js` 包含新增诊断字段；其 SHA-256 与容器 `/srv` 文件一致。
- 五个服务健康，API、Caddy、LiveKit、coturn 容器及镜像 ID 与部署前相同。
- 终端返回 `DEPLOY_SUCCEEDED=motion-content-hint-20261009`。
- 服务器发布记录：`/opt/babagan-web-meeting/var/releases/motion-content-hint-20261009/release.json`；回滚脚本：同目录 `rollback.sh`，保留旧网页镜像。
- 本地证据：[脱敏部署记录](assets/motion-content-hint-deployment-2026-10-09.json) ；终端截图和完整原始清单保留在本地受控 `output/` 目录。

上线验证证明新版本已实际提供服务；不等同于原用户设备已验收稳定 60 fps。两端刷新网页并重新开始共享后，还需按相同高动态画面对照实际采集、编码与接收帧率。
