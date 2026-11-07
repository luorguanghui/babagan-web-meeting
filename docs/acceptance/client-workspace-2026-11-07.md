# 客户端工作台与 Android 60fps

Windows/Android 客户端此前直接显示包含安装宣传的公共首页。现在原生启动进入 `/client` 会议工作台，提供粘贴邀请/会议ID、创建会议、当前会议、设备能力与更新操作；客户端导航不再展示下载或安装入口。普通浏览器首页保留宣传与下载功能，已收到的会议深链仍进入对应会议。

Windows/Android 0.1.2原生入口也直接定位工作台，带版本查询参数；Windows保留本机采集连接片段。应用文档返回 `Cache-Control: no-cache`，签名更新清单仍是 `no-store`。两者不在会议中强制刷新或切换版本。

Android 0.1.2 / versionCode 3声明 `maxScreenFrameRate:60`，开放30/60帧配置。该值贯穿原生采集、视频源、sender、SDP、旋转事件与网页轨道设置；网页用户所选10Mbps发布上限不变，内部设备桥接预算仍为12Mbps。分辨率维持原1080p包络，旧0.1.1缺少新能力字段时仍按30帧运行。配置60帧不等于设备实测达到60个不同画面，用户真机验收仍待完成，暂无系统声音。

隔离界面夹具 `apps/web/qa/client.html` 仅在开发服务使用，模拟宿主与会议数据，不连接实际会议、不启动采集，且不进入生产dist。已验证错误站点链接被拒绝、有效ID进入既有昵称/静音加入大厅、Windows 1280与Android 390宽度无横向溢出。桌面工作台不再下载或显示主页的大幅角色宣传图。原会议网格和媒体传输结构保持不变。

网页73个测试文件/861项测试、类型检查和修改源码ESLint通过；Windows37项更新/入口/回滚检查通过；Android28项JVM测试、Debug构建和lintDebug通过。复查修正Android工作台更新文案，并将原生sender参数的严格验证放在answer生效后，避免协商前参数暂不可用阻断启动。

清洁提交 `fbbdd3969016a5c316c9cfa319ad44e25df994e7` 构建网页及两端0.1.2，Android Release构建/lint和v2/v3签名通过，证书与既有版本一致。第1步网页于2026-11-07发布到 https://meet.babagan.cloud/ ，记录位于 `/opt/babagan-web-meeting/var/releases/update-20261107T103955Z-client-workspace-prebuilt/`，同目录保留回滚脚本。该步骤只替换web，seq2下载与其他服务不变。

第2步独立发布0.1.2/序号3：从当前可信源码核对发布器及固定公钥后执行RSA校验、dry-run和正式发布，再从公网完整下载并复核所有清单及三个安装文件。所有容器、原运行时、旧客户端及0.2.2浏览器共享组件均保留。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Windows安装器 | 1140224 | a5180a31dce35e02938111438a864f8e8d7f26fcba2a6396bac0afe81ae2dfa2 |
| Windows更新ZIP | 826280 | c7670e217ec868e8f641b5891cd9ff8fae10866fa517697516be2d97365d1ce1 |
| Android APK | 49205271 | 7601e968778c2a57e3b70b2ffe5f34702e77390f9db7eb5f389875d2030d4d8d |

外网16项校验通过，包括HTML及新JS/CSS、应用入口缓存头、两个RSA签名清单、所有安装文件、原共享组件、运行时镜像、App Links与缺失下载404。证据见 `assets/client-workspace-public-2026-11-07.json`。

Windows实际0.1.1/seq2→0.1.2/seq3升级通过：忙碌时下载文件数为0，空闲后从公开地址下载826280字节更新包，验签/校验/真实新版本helper smoke均通过，版本指针切换且保留旧版。升级阶段原始证据见 `assets/client-workspace-upgrade-2026-11-07.json`，其中 `fullUiHealthPending` 属于该阶段状态；随后独立GUI验收完成后 `pendingHealth=false`。

实际Windows窗口已观察到 `/client?clientVersion=0.1.2`、会议工作台、加入/创建操作、本机采集能力及“已是最新版本0.1.2”，没有下载宣传入口。当前会议为空，截图不含真实会议内容。通过CUA正常关闭自有窗口后，测试client/helper/WebView2进程均为0；默认安装元数据与原profile未变。GUI证据和实窗截图分别为 `assets/client-workspace-gui-2026-11-07.json`、`assets/client-workspace-native-2026-11-07.png`。未创建或加入实际会议，未采集桌面。
