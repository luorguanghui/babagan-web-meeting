# Cloudflare SFU 与 detail60 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Independent backend/frontend domains may use superpowers:dispatching-parallel-agents after shared interfaces are fixed.

**Goal:** 移除Cloudflare TURN，增加一次发布的Cloudflare SFU屏幕共享及detail60档。

**Architecture:** 现有会议权限和语音保留；CF会话/媒体仅屏幕路径，由后端鉴权代理固定API、前端原生PC执行协商。共享者选择CF时统一所有观看者订阅一份发布。

**Tech Stack:** TypeScript/Fastify/TypeBox/React/native WebRTC/Cloudflare Connection API/coturn/LiveKit。

**Spec:** `docs/superpowers/specs/2026-10-10-cloudflare-sfu-detail60-design.md`。

## Global Constraints

- App Secret仅后端，SDP<=65536，不能任意代理URL或订阅其他meeting资源。
- 最多5人，CF单video sender，不启用simulcast；默认浏览器/H264/P2P保持。
- detail60明确60fps请求，兼容失败回退；不承诺硬件一定输出60fps。
- 活动会议检查/不可变镜像与env备份保留；SFU必须真实验收，不继承TURN豁免。

## Review Focus

- 跨用户/跨meeting/失效发布的资源操作必须拒绝。
- 共享撤回、踢出、过期后晚到云响应必须清理而非恢复共享。
- 同session协商与停止不能并发，未知分配结果不能盲重试。
- latejoin/reconnect与音轨latearrival有真实首帧和原生媒体验证。
- 4名观看者不会让发布端新增video编码；CF错误不能偷偷启动P2P副本。

### Task 1: 共享contracts与设计接口

- [x] 读取Spec和官方OpenAPI，确定schemas及HTTP/WS接口。
- [x] 在`packages/contracts/src/cloudflare-sfu.ts`定义publication/request/response schemas与类型，`index.ts`导出；TDD边界和额外字段拒绝。
- [x] 将任务责任拆分：后端拥有`apps/api/**`；前端拥有`apps/web/**`和既有contracts p2p/quality更新；主任务拥有新contracts、部署脚本/infra/docs和真实验收。

### Task 2: 后端SFU broker和Cloudflare TURN移除

- [x] 成对配置/直连验证RED→GREEN，移除旧TURN credential配置与服务、ice route只保留coturn；SFU不配置代理。
- [x] 固定CF client以及session/resource registry、认证路由、超时/partial错误/停止/prune闭环RED→GREEN。
- [x] P2P registry记录并广播screen-sfu、welcome快照，撤权/结束/离会清理，secret不出现在公共响应/日志。
- [x] 运行API相关测试和类型检查，报告接口与清理证据。

### Task 3: 前端SFU媒体及detail60

- [x] 原生publisher/viewer PC与同源API、协商、stats、epoch关闭回归RED→GREEN。
- [x] 新共享传输选项与CF强制原生编码、stage/name/audio/latejoin/reconnect；确保无P2P/LiveKit副本。
- [x] 清除前端Cloudflare TURN选项、cache迁移、probe/control、labels及不再有效的测试；保留coturn。
- [x] quality/detail60 schema/preset/UI，60约束和detail提示回归；运行Web/contracts测试与类型检查。

### Task 4: 集成、配置与真实验证

- [x] 集成两端接口，全量test/lint/build；独立审查及必要修复。
- [x] 更新infra例子、README、运维/updater/smoke；按用户最后选择复用现有Worker内凭证，服务器仅配置gateway，秘密不回显。
- [x] 已进行真实发布订阅、1/4viewer媒体、一路编码和音频验证；用户接手最终版本连续共享及稳定性复测，未通过项如实记录。
- [x] GitHub PR附加本聊天、合并main；结束助手测试会议后部署API/web，记录服务健康、publicSHA与Cloudflare媒体结果。
- [x] 清除助手诊断成员/测试会议，保留发布记录和受保护回滚备份；最终媒体复测由用户继续，不宣称全部通过。
