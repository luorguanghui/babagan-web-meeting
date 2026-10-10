# WASM 编码输入转换性能调查

日期：2026-10-10。

## 真实会议检查

用户 Edge 正在共享 1920×1080 监视器，配置为 H.264、60fps、8Mbps。RTCRtpSender 的 maxFramerate 实际为 60。浏览器报告 NVIDIA MediaFoundation 硬件编码器、qualityLimitationReason=none，CPU 和 bandwidth 限制累计时间均为 0。

用户截图采集 57fps、编码 56fps、最近编码耗时 5.27ms；实际检查期间源输出约 32–33fps，编码输出也约 32–33fps。6 秒采样编码增加 194 帧，totalEncodeTime 增加 1.059 秒，平均约 5.46ms。该样本说明本段帧率下降在编码输入之前，不能由此认定 NVIDIA 编码性能不足。临时 requestAnimationFrame 动态图层在 6 秒仅运行 10 次，因此没有成功制造稳定 60fps 动态输入，不能作为硬件 60fps 负载验证；图层已移除。

## 已确认的软件路径开销

ProjectCaptureEncoder 读取的真实共享帧格式为 I420，colorSpace 全部为 null；直接复制约 0.5–1.7ms。旧 frameToI420 无条件先复制成 RGBA，再用 JavaScript 逐像素转回 I420。实际共享帧 30 个热身后样本中，RGBA 读取平均 4.38ms、JS 转换平均 8.83ms，共 13.21ms；同帧直接复制 I420 平均 2.39ms。该探针在主线程测量，不等同于 worker 单独编码结果。

页面中的软件“平均编码耗时”从 frameToI420 开始计时，包含像素读取和转换，并非仅 OpenH264 内部耗时。60fps 每帧预算为 16.67ms；单个编码 worker 顺序处理帧，平均 18ms 已超过该预算，多线程 OpenH264 也不会使这段串行 JS 转换并行执行。

## 修复

对于输出尺寸匹配、偶数裁剪原点、I420、limited-range 或未知 range、BT.601 或未知 matrix 的输入，使用 VideoFrame.copyTo 的 packed Y/U/V layout 直接读取。其他格式、显式 BT.709、full-range 或需缩放的输入继续走原转换路径，保持当前编码模块声明的 limited BT.601 色彩语义。没有改变码率预算、线程数、编码器或每位观看者独立编码方式。

[WebCodecs 规范](https://www.w3.org/TR/webcodecs/#dictdef-videoframecopytooptions)规定未提供 format 时复制原格式，未提供 rect 时使用 visibleRect；layout 控制目标平面 offset/stride。[当前 Chromium 颜色转换实现](https://raw.githubusercontent.com/chromium/chromium/main/media/gfx/paint_canvas_video_renderer.cc)对未知颜色信息采用 Rec601。此默认依据绑定当前 Edge 的实际验证，不推断未来浏览器默认值。

## 验证

- 6 个新增回归覆盖兼容矩阵及未知 range 直接复制、RGBA/BT.709/full-range 回退。其中 3 个直接复制测试先在旧实现失败、修复后通过。
- 全量 59 个文件、900 个测试通过；lint、生产构建通过；独立代码审查无 Critical/Important 项。
- 真实 Edge 对带源 padding 的偶数裁剪验证字节精确匹配；全 null 元数据彩色 I420 直接复制后重建与原帧的 RGBA 最大差异为 0；16×16→8×8 缩放正常。
- 独立 Edge worker 对 1920×1080 动态合成 I420 帧测试，OpenH264 四线程、60fps 编码配置、7,014,857bps 视频目标，150 帧去掉前 10 帧热身；测试和构建任务结束后顺序执行原实现与修复实现：

| 每帧平均耗时 | 原实现 | 修复后 |
| --- | ---: | ---: |
| 读取及像素转换 | 12.27ms | 0.67ms |
| 编码调用（含 WASM 输入/输出复制） | 9.00ms | 8.71ms |
| 合计 | 21.26ms | 9.37ms |

这是主动供帧的处理时间对比，不是实际屏幕捕获帧率，也不代表所有画面复杂度、设备或四位观看者都能稳定 60fps。

现有 canvas.captureStream 端到端 P2P 测试（1920×1080、请求 60fps、8Mbps、12 秒）编码 452、解码 449、显示 445 帧；接收端显示丢帧为 0。其采集约 48.80fps、编码 37.64fps、平均处理 24.99ms，仍不能达到稳定 60fps。该 RGB canvas 来源不能用于推断真实屏幕 I420 来源的改善幅度，保留这一不达标结果；实际共享必须部署后复测，不能仅用独立 worker 的 9.37ms 推断已达成端到端 60fps。
