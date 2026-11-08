# Windows 原生共享故障诊断：本地变更审阅

状态：本地实现与测试，未推送、未创建 PR、未发布安装器、未部署。基于 main `3709546e8c0b005fd28b56491b7f663c7bb573e8`；本地分支 `codex/native-fault-timeline`。真实游戏启动引发的原始故障仍未捕获，本次没有宣称修复其根因。

## 拟提交的变更

拟议 PR 标题：**为 Windows 原生共享增加可导出的脱敏故障时间线**。

| 范围 | 改动及目的 |
| --- | --- |
| contracts/native-diagnostics | 固定事件/字段白名单，256 条环形时间线，严格导出校验；剔除任意字符串和未知字段 |
| native-capture/capture、capture-recovery | 记录显示布局检查、子进程启动/首帧/退出码/信号、DXGI特征类别、恢复及终止顺序；诊断回调异常不影响采集 |
| native-capture/server、diagnostics、http-stream | 同源、同 bearer、loopback 的 POST `/diagnostics`；1 KiB 请求限制；最多四次尝试；活动记录保留，结束后30分钟访问时淘汰 |
| web/native-capture、native-diagnostics | 授权请求/拒绝/轨道结束、mute/unmute、显示参数观察、HTTP/协议/帧交付错误；最多750ms能力确认，首帧前即可关联新版组件；旧版原请求格式不变 |
| web/screen-share、p2p-share-controller、cloudflare-sfu、meeting-room-page | 分开记录网页停止、离开、页面清理、轨道结束、P2P ICE/connection、Cloudflare connection及LiveKit会议状态；连接用尝试内序号，不用成员标识 |
| 共享设置及中英文文案 | “导出上一次原生共享诊断”，停止后仍可点击；仅本地 JSON 下载，组件不可用时导出浏览器部分 |

恢复仍只针对已有 `capture_access_lost` 类，最多8次、恢复窗口20秒；不扩大重试范围，不改变授权约束，不改变编码或码率策略。原始 stderr 只用于已有分类和帧时间戳解析，不加入时间线。

## 审查结论与故障分类

原有四条路径会汇聚为网页轨道 ended：FFmpeg退出、恢复失败、HTTP流中断和浏览器授权哨兵结束。原有 `failed → stopped` 中的 stopped 是清理，不等于用户操作。FFmpeg多个DXGI特征共用一个恢复码；现在另外保留固定 evidence 分类。P2P失败触发回退、Cloudflare失败触发重连，不能反推本地采集失败。进程退出码0且输出过帧原先视作完成，本次保留行为并记录 `capture_eof`。

详细分类表、导出步骤、缺失状态解释见 [用户指南](../runbooks/native-capture-user-guide.md)。导出单位是一次共享尝试，可包含连续故障；两条时间线按编号关联，各自保存起点和单调偏移，不假装存在精确的跨进程事件全序。

独立审查发现首帧前超时/取消时响应头尚未送出，无法关联本机日志。本轮用有界能力确认解决，新增真实 HTTP 超时/取消后取回对应诊断的回归。另将页面会议状态改为绑定实际共享轨道，避免下一次申请授权等待期间污染上一次时间线，并补充不支持来源的终止事件。

## 验证记录

环境：隔离 Linux，Node 24.22.1，项目锁定 pnpm 10.34.5，Vitest 4.1.10；合成 FFmpeg 使用系统 7.1.5。此环境不代表 Windows 发行安装器使用的 FFmpeg 9.0.2/DXGI 驱动路径。

- `corepack pnpm typecheck`：全工作区通过。
- `corepack pnpm build`：全工作区通过。Vite 有大于500kB的chunk提示，未在本次扩大范围拆包。
- 对全部改动及新增 TS/TSX 执行 ESLint：通过；`git diff --check` 通过。
- `BABAGAN_TEST_FFMPEG=/usr/bin/ffmpeg corepack pnpm test`：最终为 **1,327通过、1失败、8跳过**，116个文件中114通过、1失败、1跳过；失败项及其未处理环境异常见下条。FFmpeg 合成滤镜16项实际运行；Windows专属启动器检查8项跳过。
- API 中 `apps/api/src/server.test.ts` 的本地生产组合启动测试因执行环境网卡枚举失败，出现 `uv_interface_addresses … Unknown system error 1` 并超时。独立执行 `node -e 'require("node:os").networkInterfaces()'` 在不加载项目代码时复现同一错误。没有修改此测试、mock网卡结果或隐去失败，因此不能声称全仓全绿。
- 审查修复相关5个文件59项通过；导出下载用例所在文件6项通过。最终类型检查覆盖新增下载测试。

回归覆盖：真实子进程非零/信号/零退出、正常停止的 expectedStop、启动卡住、恢复超时、连续DXGI失败/次数耗尽、布局变更拒绝、恢复期间取消；HTTP授权/CORS、关联ID、首帧前超时/取消后导出；浏览器授权结束（启动中及共享中）、正常stop、旧组件兼容、能力确认期间撤销；P2P/Cloudflare失败记录及不误判采集终止；截断、过期、导出期间新尝试、错误ID、恶意字段、超大响应、不可达组件、下载对象URL释放。

## 隐私与边界

时间线不含画面、音频、原始错误文本、路径、窗口/设备名称、会议/成员标识、令牌、URL/IP、SDP或ICE。导出请求只发到已有授权的本机辅助进程，最多等待2秒，响应最大128KiB；没有遥测上传或消息发送。日志不以帧频率写入。

浏览器仅保留最近一次尝试至刷新/再次原生共享；组件退出会丢失其内存记录。运行中完全无帧但进程未退出、整页崩溃，以及浏览器授权结束的系统根因仍不能仅靠本功能定论。Windows桌面切换/独占全屏、HDR/刷新率、缩放、多屏插拔、UAC/锁屏和驱动重置须由用户实际场景验证。本轮未运行真实游戏、未共享用户桌面、未操作生产服务，也未重测1080p60性能。

## 后续审批范围

如用户批准，后续才将本地分支推送并创建面向 main 的 PR，附上述验证限制；不自动合并、不部署、不构建或发布新的安装器。线上发布需另行提供具体发布方案并取得批准。
