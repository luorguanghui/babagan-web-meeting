# P2P 屏幕共享混合模式实施计划

> **已废弃（2026-08-11）**：本计划保留为历史记录，不得用于部署或验收。LiveKit v1.11.0、STUN 配置、常驻 LiveKit 安全网、Origin、RTP 健康检查与隐私修复以 `2026-08-11-p2p-production-hardening.md` 及当前规范为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有会议系统中实现"屏幕共享 P2P 直连优先、LiveKit SFU 回退"的混合模式，使屏幕媒体不再依赖不稳定的云端带宽。

**Architecture:** 云端 Fastify 新增 P2P 信令 WebSocket（只做鉴权与 SDP/ICE 转发，零媒体可见性）与 ICE 凭据端点（经 LiveKit `/rtc/ice` 拉取）；共享者对每名观看者各建一条 `RTCPeerConnection`（同一连接发布屏幕视频 + 屏幕音频）；观看者级回退状态机（8 秒协商超时 / 5 秒失联 → 切 LiveKit 屏幕订阅），双源不并存。

**Tech Stack:** React + TypeScript（LiveKit Web SDK + 原生 RTCPeerConnection）、Node.js Fastify（@fastify/websocket）、LiveKit Server API、packages/contracts 共享类型。

**执行前提：** 本副本（`会议 - 副本`）仅含文档；代码在 `会议\.worktrees\meeting-implementation`（分支 `codex/web-meeting-implementation`）执行。任务内文件路径相对于该代码库根目录。前端与 API 同时发布；旧前端无 P2P 能力时自动走 LiveKit 回退路径，不影响会议。

## Global Constraints

- 屏幕音频轨道必须与屏幕视频轨道发布在同一条 `RTCPeerConnection`（音画同步硬约束，`07` 设计 §8）。
- 双源不并存：同一观看者在 P2P 与 LiveKit 之间切换，不并行接收。
- 只有共享锁持有者（`share_identity`）能发送 `offer`；观看者只能应答共享者；目标必须是同会议在线成员。
- SDP 全文、ICE 候选与凭据不写入任何日志；P2P 信令消息上限 64 KiB。
- 常量：`P2P_ICE_NEGOTIATION_TIMEOUT_MS = 8000`、`P2P_ICE_DISCONNECT_TIMEOUT_MS = 5000`、`P2P_ICE_CACHE_TTL_SECONDS = 3600`。
- P2P 码率档位 `[5_000_000, 8_000_000, 10_000_000]`（默认 8 Mbps）；SFU 档位 `[10_000_000, 13_000_000, 15_000_000]` 不变。
- 无新增云端端口；信令复用 `meet` 域 `/api/*` 反代（Caddy 需确认保留 WebSocket Upgrade 头）。
- 会议规模 ≤5 人、单一共享者；不实现 P2P 音频、多房间、移动端共享。

---

### Task 1: contracts 包 — P2P 信令消息类型与常量

**Files:**
- Create: `packages/contracts/src/p2p.ts`
- Create: `packages/contracts/src/p2p.test.ts`（或按现有测试惯例放置）
- Modify: `packages/contracts/src/index.ts`（导出新模块）

**Interfaces:**
- Produces:
  ```ts
  export type P2pClientMessage =
    | { type: 'hello'; participantIdentity: string }
    | { type: 'offer'; to: string; sdp: string }
    | { type: 'answer'; to: string; sdp: string }
    | { type: 'ice'; to: string; candidate: string | null } // null = end-of-candidates
    | { type: 'bye'; to: string; reason?: string }
    | { type: 'ping' };

  export type P2pServerMessage =
    | { type: 'welcome'; peers: Array<{ identity: string; nickname: string }> }
    | { type: 'peer-joined'; peer: { identity: string; nickname: string } }
    | { type: 'peer-left'; peer: { identity: string } }
    | { type: 'pong' }
    | { type: 'share-gone'; reason: string }
    | { type: 'error'; code: string; message: string };

  export const P2P_ICE_NEGOTIATION_TIMEOUT_MS = 8000;
  export const P2P_ICE_DISCONNECT_TIMEOUT_MS = 5000;
  export const P2P_MESSAGE_MAX_BYTES = 64 * 1024;
  export const P2P_SCREEN_BITRATES = [5_000_000, 8_000_000, 10_000_000] as const;
  export type P2pScreenBitrate = typeof P2P_SCREEN_BITRATES[number];
  ```
- 错误码扩展：`P2P_FORBIDDEN`（403）、`P2P_PEER_NOT_FOUND`（404），加入现有错误码联合类型。

- [ ] **Step 1: 写消息类型与常量测试**（类型级判别联合 + JSON Schema 或校验函数，覆盖非法消息拒绝：缺 `to`、超长 `sdp`、未知 `type`）
- [ ] **Step 2: 运行测试确认失败**（`pnpm --filter @meeting/contracts test`）
- [ ] **Step 3: 实现 `p2p.ts`**：判别联合类型、校验函数 `parseP2pClientMessage(raw): P2pClientMessage`（抛 `SchemaError`）、常量、错误码
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交**：`feat(contracts): p2p signaling message types`

### Task 2: API — ICE 凭据端点

**Files:**
- Create: `apps/api/src/http/routes/ice-servers.ts`
- Create: `apps/api/src/http/routes/ice-servers.test.ts`
- Modify: `apps/api/src/livekit/media-service.ts`（接口 + 方法签名）
- Modify: `apps/api/src/livekit/livekit-media-service.ts`（实现）
- Modify: `apps/api/src/http/routes/participants.ts` 或路由注册处（挂载端点）

**Interfaces:**
- Consumes: 现有参与者会话鉴权（`/api/v1/meetings/:slug/join` 后设置的 Cookie）
- Produces:
  ```ts
  interface MediaService {
    fetchIceServers(): Promise<Array<{ urls: string[]; username?: string; credential?: string }>>;
  }
  // GET /api/v1/meetings/:slug/ice-servers → 200 { iceServers: IceServer[] }
  ```
- LiveKit 实现：`new RoomServiceClient(...).listIceServers()`（LiveKit Server SDK 提供 `/rtc/ice` 封装，或直接 `fetch` 内部 HTTP `POST /rtc/ice`）。
- 内存缓存：`{ value: IceServer[], expiresAt: number }`，TTL `P2P_ICE_CACHE_TTL_SECONDS`；LiveKit 调用失败时返回 503 `MEDIA_SERVICE_UNAVAILABLE`。

- [ ] **Step 1: 写失败测试**：无 Cookie 拒绝；有 Cookie 返回 STUN+TURN 列表；第二次请求命中缓存（mock 的 LiveKit 只调用一次）；LiveKit 异常 → 503
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现端点与 `fetchIceServers`**（用 `MediaService` 注入，mock 复用现有测试替身）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**：`feat(api): ice servers endpoint with cache`

### Task 3: API — P2P 信令 WebSocket 端点

**Files:**
- Create: `apps/api/src/http/routes/p2p-signaling.ts`
- Create: `apps/api/src/http/routes/p2p-signaling.test.ts`
- Create: `apps/api/src/p2p/room-registry.ts`（在线表 + 广播，内存态）
- Modify: `apps/api/src/server.ts`（注册 @fastify/websocket）
- Modify: `apps/api/package.json`（依赖 @fastify/websocket）

**Interfaces:**
- Consumes: 参与者会话鉴权函数（现有 `auth.ts`）、`MeetingRepository.getMeetingBySlug`（共享锁读取）、`P2pClientMessage`/`P2pServerMessage`（Task 1）
- Produces:
  ```ts
  // WS /api/v1/meetings/:slug/p2p（Caddy 反代保留 Upgrade 头）
  class P2pRoomRegistry { // 单实例，按 meeting slug 分房间
    join(slug: string, identity: string, nickname: string, socket: WebSocket): void;
    leave(slug: string, identity: string): void;
    listPeers(slug: string): Array<{ identity: string; nickname: string }>;
    sendTo(slug: string, identity: string, msg: P2pServerMessage): boolean; // false = 目标不在线
    broadcast(slug: string, msg: P2pServerMessage, except?: string): void;
    broadcastShareGone(slug: string): void; // 共享锁释放时调用
  }
  ```
- 转发规则（在消息处理器内强制）：
  - `offer`：`from === share_identity` 才允许转发，否则回 `error {code:'P2P_FORBIDDEN'}`
  - `answer`/`ice`/`bye`：`to` 必须是当前 `share_identity`（观看者→共享者）或转发双方之一为共享者；`to` 在线
  - `hello` 的 `participantIdentity` 必须与 Cookie 会话身份一致
- 心跳：`ping` → `pong`；30 秒无任何消息视为失联断开；握手鉴权失败拒绝升级（HTTP 401）。
- 服务重启后在线表清空：客户端重连后以 `welcome` 全量恢复（Task 4 实现）。

- [ ] **Step 1: 写失败测试**（WS 集成，用 fastify inject + 原生 WebSocket 客户端或 mock socket）：
  - 无 Cookie 握手 → 401；越权 offer（非共享者）→ `P2P_FORBIDDEN` 且目标收不到；`to` 不在线 → `P2P_PEER_NOT_FOUND`；hello 身份不一致 → 断开；成员加入/离开广播 peer-joined/peer-left；共享锁释放 → 全员 `share-gone`；64 KiB 消息拒绝；限速后 429
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 `room-registry.ts` 与 `p2p-signaling.ts`**（共享锁状态经 MeetingRepository 读取；释放共享锁的既有路由调用 `broadcastShareGone`）
- [ ] **Step 4: 运行确认通过**（全量 `pnpm --filter @meeting/api test`）
- [ ] **Step 5: 提交**：`feat(api): p2p signaling websocket endpoint`

### Task 4: Web — P2P 信令客户端

**Files:**
- Create: `apps/web/src/meeting/p2p-signaling.ts`
- Create: `apps/web/src/meeting/p2p-signaling.test.ts`

**Interfaces:**
- Consumes: `P2pClientMessage`/`P2pServerMessage`（Task 1）、参与者 Cookie（浏览器自动携带，同源）
- Produces:
  ```ts
  export interface P2pSignalingEvents {
    onWelcome(peers: Peer[]): void;
    onPeerJoined(peer: Peer): void;
    onPeerLeft(peer: { identity: string }): void;
    onOffer(from: string, sdp: string): void;
    onAnswer(from: string, sdp: string): void;
    onIce(from: string, candidate: string | null): void;
    onBye(from: string, reason?: string): void;
    onShareGone(): void;
    onError(code: string): void;
  }
  export class P2pSignalingClient {
    constructor(slug: string, identity: string, events: P2pSignalingEvents);
    connect(): Promise<void>;          // 首次连接，成功回调 onWelcome
    sendOffer(to: string, sdp: string): void;
    sendAnswer(to: string, sdp: string): void;
    sendIce(to: string, candidate: string | null): void;
    sendBye(to: string, reason?: string): void;
    close(): void;
  }
  ```
- 行为：指数退避重连（1s/2s/4s/8s，上限 30s，会议结束时 `close()` 终止）；每 25 秒 `ping`；收到 `peer-left`/`share-gone` 驱动上层关闭对应 PC；服务端 `error` 转 `onError`。

- [ ] **Step 1: 写失败测试**（注入 fake WebSocket）：连接成功触发 onWelcome；重连恢复名单；ping 间隔；消息路由到对应回调；close 后不再重连
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过**（`pnpm --filter @meeting/web test`）
- [ ] **Step 5: 提交**：`feat(web): p2p signaling client`

### Task 5: Web — 共享者 P2P 会话控制器（星型 + 回退状态机）

**Files:**
- Create: `apps/web/src/meeting/p2p-share-controller.ts`
- Create: `apps/web/src/meeting/p2p-share-controller.test.ts`
- Modify: `apps/web/src/meeting/screen-share.ts`（`ScreenSharePublisher` 接口新增 P2P 变体，见 Task 7）

**Interfaces:**
- Consumes: `P2pSignalingClient`（Task 4）、ICE 凭据（Task 2 端点）、`MediaStream`（含屏幕视频 + 屏幕音频轨道）
- Produces:
  ```ts
  export type ViewerSessionState = 'negotiating' | 'p2p' | 'livekit-fallback' | 'closed';

  export interface P2pShareController {
    start(stream: MediaStream, bitrate: P2pScreenBitrate, viewers: Peer[]): Promise<void>;
    handleAnswer(from: string, sdp: string): Promise<void>;
    handleIce(from: string, candidate: string | null): Promise<void>;
    handleViewerLeft(identity: string): void;
    stop(): Promise<void>;   // 关闭全部 PC，广播 bye
    getViewerStates(): ReadonlyMap<string, ViewerSessionState>;
    subscribe(listener: (states: ReadonlyMap<string, ViewerSessionState>) => void): () => void;
  }
  ```
- 行为契约（每名观看者一条 `RTCPeerConnection`）：
  - `pc.addTrack(videoTrack)` + `pc.addTrack(audioTrack)`（同一连接，满足音画同步约束）；`pc.addTransceiver('video', {direction:'sendonly'})` 等价亦可
  - Trickle ICE：`onicecandidate` → `sendIce(to, candidate ?? null)`；收到 answer 后 `setRemoteDescription` + 应用远端候选
  - **协商超时**：从发送 offer 起 8 秒内该观看者 ICE 未 `connected` → 该观看者置 `livekit-fallback`，通知上层（回调 `onViewerFallback(identity)`）
  - **失联**：ICE `disconnected` 持续 5 秒或 `failed` → `livekit-fallback`
  - `stop()`：全部 PC `close()` + `sendBye`；已结束则幂等
  - 码率：`RTCRtpSender.setParameters({ encodings: [{ maxBitrate: bitrate }] })`（单编码；不开 simulcast，P2P 每路独立）
- 上层回退动作（Task 7 接入）：存在任一 `livekit-fallback` → 共享者发布 LiveKit 屏幕轨道；全部 `p2p` → 若已发布则取消。

- [ ] **Step 1: 写失败测试**（注入 fake RTCPeerConnection 工厂 + fake signaling）：对 4 名观看者各建 1 条 PC 且音视频轨同连接；answer/ice 流程；8 秒无连接 → fallback 事件；`disconnected` 5 秒 → fallback；stop 关闭全部并发 bye；幂等
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（PC 工厂注入以便测试；真实实现用 `window.RTCPeerConnection`）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**：`feat(web): p2p share controller with per-viewer fallback`

### Task 6: Web — 观看者 P2P 会话控制器与双源渲染

**Files:**
- Create: `apps/web/src/meeting/p2p-viewer-controller.ts`
- Create: `apps/web/src/meeting/p2p-viewer-controller.test.ts`
- Modify: `apps/web/src/components/screen-stage.tsx`（双源渲染）
- Modify: `apps/web/src/pages/meeting-room-page.tsx`（接线）

**Interfaces:**
- Consumes: `P2pSignalingClient`、ICE 凭据、LiveKit 房间（`Room`，回退源）
- Produces:
  ```ts
  export type ViewerP2pState = 'idle' | 'negotiating' | 'p2p' | 'livekit';
  export class P2pViewerController {
    constructor(signaling: P2pSignalingClient, iceServers: RTCIceServer[]);
    acceptOffer(from: string, sdp: string): Promise<void>; // 仅接受来自共享者的 offer
    handleIce(from: string, candidate: string | null): Promise<void>;
    getStream(): MediaStream | null;
    getState(): ViewerP2pState;
    subscribe(listener: (state: ViewerP2pState) => void): () => void;
    close(): void;
  }
  ```
- 行为契约：
  - 收到 offer → `setRemoteDescription` → 创建 answer 发回 → trickle ICE
  - `ontrack` 收集屏幕音视频轨道；`ontrack` 后 8 秒内未收到媒体（`track.kind === 'video'` 且收到 RTP）→ 发 `bye`（原因 `fallback`）并置 `livekit`，上层订阅 LiveKit 屏幕轨道
  - 渲染层 `screen-stage.tsx`：P2P 流（`video` 标签 `srcObject = p2pStream`）优先；`livekit` 时切 LiveKit 轨道；切换时保留上一源直到新源首帧，避免黑屏 >2 秒
- 观看者无需发 offer：非共享者发来的 offer 直接忽略（服务端已强制，客户端双保险）。

- [ ] **Step 1: 写失败测试**：acceptOffer 全流程（SDP→answer→ICE）；8 秒无媒体 → fallback 通知（fake ontrack 不触发）；收到非共享者 offer 忽略；close 清理；状态订阅
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现控制器与渲染切换**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**：`feat(web): p2p viewer controller and dual-source stage`

### Task 7: Web — 共享流程接入与码率档位联动

**Files:**
- Modify: `apps/web/src/meeting/screen-share.ts`（P2P 发布者变体 + 档位）
- Modify: `apps/web/src/pages/meeting-room-page.tsx`（启动流程、档位联动 UI 逻辑）
- Modify: `apps/web/src/components/meeting-controls.tsx`（档位选项）
- Modify: `apps/web/src/i18n/i18n.tsx`（文案：P2P 档位与提示）
- Modify: `apps/web/src/meeting/screen-share.test.tsx`

**Interfaces:**
- Consumes: `P2pShareController`（Task 5）、`P2pViewerController`（Task 6）、`room-controller.ts` 的 LiveKit 发布能力（既有 `publish` 接口，用于回退）
- Produces（行为契约，不新增公开接口）：
  - 共享启动：授权后获取屏幕流（含音频）→ `GET ice-servers` → 创建 signaling + `P2pShareController.start(stream, bitrate, peers)`
  - 回退联动：任一观看者 `livekit-fallback` 时调用既有 LiveKit 屏幕发布（`room-controller` 现有路径，档位沿用 10/13/15）；全部恢复 `p2p` 时取消 LiveKit 屏幕发布
  - 档位：P2P 模式选项 `[5, 8, 10]` Mbps 默认 8；按在线观看者数默认建议（1–2 人 8、3 人 8、4 人 5）；SFU 回退保持现有 `[10, 13, 15]` 默认 10
  - 停止/撤销：`P2pShareController.stop()` + 释放 LiveKit 屏幕轨道 + 关闭 signaling
  - 观众离开：`peer-left` → 关闭该观看者 PC；无观看者时停止全部 P2P
- 现有 `ScreenSharePublisher` 接口保留（LiveKit 回退实现不变），P2P 作为共享启动的首选路径，回退仍走既有实现。

- [ ] **Step 1: 写失败测试**：启动流程顺序（授权→流→ICE 凭据→P2P 协商）；档位联动默认值（4 人→5M）；回退触发 LiveKit 发布、全恢复后取消；停止幂等
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现接入与 UI**
- [ ] **Step 4: 运行确认通过**（含既有 `screen-share.test.tsx` 回归，LiveKit 路径不回归）
- [ ] **Step 5: 提交**：`feat(web): p2p-first screen share with bitrate guidance`

### Task 8: 匿名质量统计上报

**Files:**
- Create: `apps/web/src/meeting/p2p-stats.ts`
- Modify: `apps/api/src/http/routes/meetings.ts` 或新增 `POST /api/v1/meetings/:slug/p2p-stats`（匿名，会议结束后调用）
- Modify: `apps/web/src/pages/meeting-room-page.tsx`（离开/结束时上报）

**Interfaces:**
- Produces:
  ```ts
  interface P2pStatsReport {                       // 不包含媒体、SDP、IP、身份
    meetingIdHash: string;                         // SHA-256(meeting.id) 前缀
    sessionId: string;                             // 本次加入会话的匿名 ID
    attempts: number; p2pSucceeded: number; fallbacks: number;
    avgSetupMs: number; avgRttMs: number; maxLossPct: number;
  }
  // POST /api/v1/meetings/:slug/p2p-stats（参与者会话鉴权）→ 仅记录审计事件，不落库明细
  ```
- 上报失败静默忽略（不影响会议）；频率限制沿用现有速率限制。

- [ ] **Step 1: 写失败测试**：payload schema 校验；无 Cookie 拒绝；上报后审计事件存在
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现采集（webrtc-stats 面板已有数据源复用）与上报**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**：`feat: anonymous p2p quality stats`

### Task 9: 部署与配置变更

**Files:**
- Modify: `infra/caddy/Caddyfile`（确认 `/api/*` 反代保留 WebSocket Upgrade 与协议头；无此配置则补充）
- Modify: `apps/api/src/config.ts` + `config.test.ts`（`P2P_ICE_CACHE_TTL_SECONDS` 等新配置项，含默认值与校验）
- Modify: `infra/docker-compose.yml`（环境变量接入）
- Modify: `scripts/smoke-test.sh`（增加 ICE 凭据端点与 P2P 信令冒烟：401 无 Cookie / 200 有 Cookie）
- Modify: `docs/04-deployment-and-operations.md`（无新增端口确认，无需再改文档，核对即可）

- [ ] **Step 1: 更新配置与测试**（缺省值合法、非法值拒绝）
- [ ] **Step 2: 运行确认通过**
- [ ] **Step 3: 更新 Caddyfile 与冒烟脚本**
- [ ] **Step 4: 在目标服务器演练首次部署顺序 §6 新增步骤（`/rtc/ice` 可用性、P2P 信令鉴权冒烟）**
- [ ] **Step 5: 提交**：`chore(infra): p2p signaling deployment`

### Task 10: E2E 与真实网络验收

**Files:**
- Modify: `apps/web/e2e/*`（现有 Playwright 用例扩展）
- Create: `apps/web/e2e/p2p-signaling.spec.ts`（信令流程，mock 网络条件）

**验收（对应 `docs/05` AT-016 ~ AT-021 与 §4.3 NAT 矩阵）：**
- [ ] **Step 1: Playwright E2E**：创建会议 → 2 名参与者入会 → 主持人授权 → 共享者启动 P2P → 观看者收到 P2P 流；无 Cookie 信令被拒；非共享者 offer 被服务端拒绝
- [ ] **Step 2: 真实公网 NAT 矩阵**（至少覆盖）：公网×公网直连成功；CGNAT 观看者回退 ≤8 秒；同局域网 host 候选直连；TUN 代理启用/禁用对比（记录结果，TUN 未配置直连不计缺陷）
- [ ] **Step 3: 音画同步**：P2P 直连下屏幕画面与电脑声音同步（主观 ≤100ms）；回退模式同验
- [ ] **Step 4: 弱网**：共享者上行限制 6 Mbps → 仅该路降码率、语音持续；共享中 P2P 断线 → 该观看者切 LiveKit ≤2 秒
- [ ] **Step 5: 云端带宽验证**：P2P 直连共享期间服务器出口无 16–60 Mbps 屏幕流量（仅语音 ~1 Mbps）
- [ ] **Step 6: 回归**：`05` 文档既有用例 AT-001 ~ AT-015 全通过；两小时稳定性；双浏览器
- [ ] **Step 7: 提交**：`test(e2e): p2p acceptance matrix`

---

## 自审记录

- **规格覆盖**：`07` 设计 §4（信令）→ Task 1/3；§5（拓扑与会话状态机）→ Task 5/6；§6（ICE 与网络）→ Task 2/9；§7（码率联动）→ Task 7；§9（权限安全）→ Task 1/3/6；§10（监控）→ Task 8；测试与部署 → Task 9/10。PRD FR-015/FR-016 → Task 5/6/7 + Task 10 验收。
- **占位符检查**：全部步骤含具体内容；未使用 TBD/TODO。
- **类型一致性**：`P2pClientMessage`/`P2pServerMessage`、`P2P_*` 常量在 Task 1 定义并被 Task 3/4/5/6 引用，命名一致；`P2pShareController`/`P2pViewerController` 接口在 Task 5/6 定义，Task 7 按此接线。
- **风险**：真实浏览器 PC 行为与测试替身的差异由 Task 10 真实网络验收兜底；旧前端兼容由"P2P 失败即回退"保证。
