# Edge 会议专用入口

原生采集请使用 `scripts/start-native-meeting.cmd`，操作见[本机原生共享使用说明](native-capture-user-guide.md)。`scripts/launch-meeting-edge.cmd` 是仅启动专用浏览器的兼容入口，不会启动原生采集组件，也不能单独保证整屏真实 60fps。

双击脚本后，在新窗口里创建或加入会议。它使用独立的 `%LOCALAPPDATA%\Babagan\MeetingEdge` 配置目录，首次可能需要重新登录；日常 Edge 的账户、扩展、配置和默认浏览器保持原样。已有会议链接可复制到这个窗口中打开。共享者使用该入口即可，接收者无需为此更改浏览器。

关闭这个独立配置的所有会议窗口后再从脚本启动，才能确保新的启动参数生效。脚本不会强行结束其他窗口，也不会自动接受屏幕或声音权限。需要恢复普通行为时，关闭专用窗口，使用原来的 Edge 入口即可。

两个入口的浏览器性能参数保持一致：禁用 `MediaFoundationUseSWBRCForH264Camera` 和 `MediaFoundationUseSWBRCForH264Desktop`，启用 `WebRtcAV1HWEncode` 并避免后台计时器／渲染进程降频。原生编码器和 WebRTC 网络拥塞控制继续运行；脚本不关闭浏览器安全保护，不设置最低码率，不开放调试端口，不安装扩展或常驻服务。

可先运行 `scripts\launch-meeting-edge.cmd --print-command` 检查程序路径、独立配置路径和特性参数；该模式不会启动浏览器或创建配置目录。浏览器升级后需要复测，因为内部特性可能变化或被移除。

对照实验确认：相同的生成式 1080p60 输入，在禁用这两个特性后编码器内部丢帧归零，并能输出约 60fps。真实整屏的有效新画面供给仍受 WGC 原生路径影响，不能把面板 60fps 或重复内容当作采集问题已修复。本入口是可选的编码侧绕开方式，尚未安装或设为默认。
