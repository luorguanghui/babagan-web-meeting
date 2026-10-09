# WASM 编码可行性：1080p60 门槛未通过

2026-10-10，设计第一阶段。**仅完成编码器原型与基准，未接入会议，未更改生产默认，未部署。**

测试机器 AMD Ryzen 7 5800X（8 核 / 16 线程），32 GiB 内存，Windows。浏览器为 Playwright 启动的 Edge 154 headless，版本信息包含在原始 JSON。此机器结果不能代表每位用户，也不能用来判断之前那次浏览器编码下降的唯一原因。

## 结论与证据

默认 H.264 和可选 VP8 均实现逐帧输入/输出。OpenH264 明确关闭 `bEnableFrameSkip`；libvpx 设置 `dropframe-threshold=0`、`lag-in-frames=0`、`deadline=realtime`、`cpu-used=8`。两者均未调用浏览器 VideoEncoder / MediaRecorder。H.264 构建开启 `-O3 -flto -msimd128`，比较了屏幕与运动视频预设，最终矩阵使用较快的运动视频预设。

最终矩阵在编译结束后连续运行，没有同时进行编译或测试。各场景输入 180 帧，实际输出、浏览器实际解码均为 180 帧，SDK skip 为 0。实际 SPS 得到 `avc1.42c02a`，初始和中途请求的关键帧均成功。

| Codec / 4 个编码线程 | 静态纹理：纯编码 fps | 平移纹理：纯编码 fps | 复杂动态：纯编码 fps |
| --- | ---: | ---: | ---: |
| OpenH264 WASM | 190.36 | 42.16 | 40.84 |
| libvpx WASM | 70.72 | 34.12 | 34.71 |

这些是吞吐探针，帧从预先生成的 I420 数据产生，按尽快处理的方式提交。包含不同的纹理运动，16 帧序列循环；不是实际屏幕捕获、不是 180 秒实时 60 fps 验收、不是完整 P2P 性能。

复杂动态 H.264 的平均编码耗时约 24.5 ms，超过 60 fps 每帧 16.7 ms 的时间预算。它在不跳帧时完成全部输入，只是花了更久。接入实时系统后，不能同时保持 60 fps 输入、零丢帧及有界低延迟：落后的输入必须积压或被明确丢弃。

原始结果也记录实际码流长度；关闭内部跳帧后，复杂纹理下输出码率可以明显超出 8 Mbps 目标。目标码率不是硬性容量保证，不能以目标值代替实际网络预算。

**因此不能把当前原型默认上线为“稳定 1080p60”。** 编码端的吞吐上限已低于设计门槛 57 fps，尚未包含采集、RGBA→I420、数据通道传输、播放和声音同步。第二至第五阶段尚未实施，180 秒 / 10 分钟 AV / 30 分钟 / TURN 与多人验收未执行，不宣称通过。

完整数据：[2026-10-10-wasm-codecs.json](2026-10-10-wasm-codecs.json)。解码耗时字段来自与编码器共用 Worker 的回调时间，受编码阻塞影响，**不能作为端到端播放延迟或接收端性能结论**。

## 已处理的构建问题

- Emscripten 4.0.23 不默认导出 `HEAPU8`；显式导出以支持受控 I420 输入和码流复制。
- OpenH264 四个编码工作线程另需一个线程池协调线程，pthread 预创建池设置为 5，编码线程仍为 4。
- libav.js 6.10.9 pthread postamble 在 WASM 导出准备好之前缓存了未定义的数值函数。基准构建补丁将 cwrap 解析延迟至调用，四线程编码/解码实际运行通过；原始 npm 模块没有修改。补丁源码在 prepare 脚本中。
- OpenH264 动态提高目标码率前必须先提高空间层最大码率，降低目标时顺序相反。ABI 测试覆盖上下调整及停止后不能编码。

## 复现

应用依赖：`pnpm install --frozen-lockfile`。工具链固定在 `media/codecs.lock.json`：OpenH264 v2.6.0 / 提交 `652bdb7719f30b52b08e506645a7322ff1b2cc6f`，官方 emsdk 4.0.23 / 提交 `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`。

下载并激活官方工具链和 OpenH264 源码，然后运行：

```sh
python scripts/build-screen-codecs.py --source /path/to/openh264 --emsdk /path/to/emsdk --jobs 4
node scripts/prepare-libav-codecs.mjs
node --test scripts/test-screen-codecs.mjs
node scripts/benchmark-screen-codecs.mjs
```

打开 `http://127.0.0.1:5190/fixtures/screen-codecs.html?codec=h264&threads=4&frames=180&preset=video&scene=high-motion`。修改 `codec=vp8`、`scene=static/texture` 或 `threads=1/2/3` 比较。页面展示实际输出、解码、耗时与码流长度。基准服务只监听本机，设置隔离头；关闭终端即可停止服务。

二进制生成在 git-ignored `artifacts/screen-codecs`，带 SHA-256 清单，不进入网页的 public/dist。OpenH264 许可证随构建复制；libav 对应源代码发行包还未收集完成，manifest 明确标记 `releaseReady=false`，**不得将此基准二进制直接当成生产资源发布**。

## 后续边界

继续纯网页方案需要进一步移植并测量编码器热点 SIMD 等优化；此次 `-msimd128` 是编译器支持与自动向量化，不等于完成 OpenH264 原生 x86 汇编的 WASM 移植。不能保证这些优化会达到门槛。若要求更接近 OBS 的硬件编码性能，需要改变“不安装本机组件”的约束，让本机组件调用 GPU 编码器；不能用一个 WASM 名称宣称已经调用 NVENC / QSV / AMF。
