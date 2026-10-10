# 浏览器 60fps 档采集约束调查

日期：2026-10-10，测试浏览器 Edge 154 / Windows。

用户在高负载下看到1920×1080采集32fps、编码33fps，NVIDIA硬件编码约6.31ms。实际会话配置为60fps、8Mbps、motion内容提示，发送器maxFramerate=60、qualityLimitationReason=none，累计CPU/带宽限制时间为0。源显示器能力上限为2560×1440/60fps，输出约束为1920×1080。

## 定位与测量

对当前屏幕轨道克隆使用MediaStreamTrackProcessor直接读取编码前VideoFrame，6秒194帧，实际32.13fps，时间戳中位间隔31.01ms、95分位33.985ms。确认帧率不足发生在编码之前，不能将这段情况归因于NVIDIA编码吞吐不足。

对同一真实采集源顺序交替测试，每阶段约3秒，结束后关闭克隆轨道：

| 约束 | 原始读取帧率 | 原轨道media-source帧率 | 编码帧率 |
| --- | ---: | ---: | ---: |
| 原有理想60fps | 32.45 | 32.66 | 32.33 |
| min/ideal/max=60 | 51.73 | 50.90 | 46.58 |
| 原有理想60fps | 32.35 | 32.57 | 32.24 |
| min/ideal/max=60 | 52.05 | 51.56 | 50.23 |

在原共享轨道上另外测试6秒min/ideal/max=60，浏览器报告采集51–53fps、编码50–51fps，qualityLimitationReason仍为none；最后恢复原约束。恢复后的3秒采样仍约51fps，存在状态延续或场景变化，不能将这次单独试验描述为完全可逆对照；主要对照证据为上表交替克隆测试。

[Chromium桌面采集源码](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/lkgr/content/browser/media/capture/desktop_capture_device.cc)有独立的CPU使用预算与基于采集耗时的调度策略，默认单核预算50%；这不是视频编码器的CPU限制。它说明高负载时采集可能低于请求帧率，但没有对本会话内部采集耗时进行直接剖析，不能断言具体是某个Windows采集后端或该预算触发。

## 变更与验证

初始getDisplayMedia仍只使用ideal帧率，让用户正常选择共享源。选定源后，60fps档通过applyConstraints请求min/ideal/max=60，同时保留现有按源宽高比计算的分辨率上限。请求被拒绝时重新尝试原ideal约束，避免不支持60fps的共享源导致共享失败。30fps档、默认浏览器编码、H264及码率预算均保持原行为。没有在项目中补重复帧提高计数。

[W3C Screen Capture规范](https://www.w3.org/TR/screen-capture/#constraints)区分了选择器与选定轨道的约束：min/exact不能放入getDisplayMedia，但可在后续applyConstraints中接受或返回OverconstrainedError。

控制器高动态采集与拒绝回退回归先在原实现失败、修复后通过；111项屏幕共享测试通过，全量60文件909测试、lint、生产构建通过，独立审查无新增阻塞问题。实测改善为约32→51–53fps，不承诺所有负载下稳定60fps；接收端实际效果仍需部署后会话复测。
