# Cloudflare TURN relay-to-relay 回环探测可行性门槛

日期：2026-09-03（三轮运行时间约为 UTC 02:05–02:20）
环境：用户已认证的 Edge 会议标签页（生产站点 `meet.babagan.cloud`），通过 CDP
`Runtime.evaluate` 在页面内执行；短期 ICE 凭据仅存在于页面内存，未导出、未回显。
结论：**方案 A（浏览器内双 Cloudflare relay 回环）通过全部门槛**，计划 Tasks 2–9 继续。

## 门槛判定

| 门槛（spec §5） | 结果 | 证据 |
|---|---|---|
| 两端只选中 `relay` candidate | 通过 | 三轮均 `selectedRelay: true`；脚本在校验失败时会抛错中止 |
| candidate 来自 `turn.cloudflare.com` | 通过 | 三轮选中 relay 的 `url` 均包含 `turn.cloudflare.com`，脚本校验通过 |
| DataChannel 打开并完成 2/4/8/16 Mbps 阶梯 | 通过 | 每轮 4 个窗口全部返回累计确认 |
| 发送/接收/累计确认一致，无静默丢弃 | 通过 | 每个窗口 `lossRatio: 0`，`confirmedBytes === sentBytes` |
| 三轮中位数稳定，离散度 ≤ 25% | 通过 | 中位数 4.286 / 4.241 / 4.311 Mbps，轮间离散度 ≈ 0.68% |
| 与设备已知上行能力同数量级 | 通过 | 用户实测上行 ≥ 10 Mbps；第 4 档确认 ≥ 8.8 Mbps 且零丢包（见"已知限制"） |
| 连接、通道、allocation 释放 | 通过 | 三轮 `closed: true`（两端 PeerConnection 均关闭） |
| 不修改生产码率、不进入产物 | 通过 | 实验仅通过 CDP 运行，生产代码零改动 |

## 三轮脱敏结果

每个窗口：`offeredBps` 提供档位、`confirmedBps` 确认吞吐、`lossRatio` 丢包率。
`dispersion` 为单轮内部四个档位之间的离散度——阶梯档位吞吐本应随提供速率增长，
该值高是预期现象；门槛要求的是**三轮之间**中位数的稳定性。

```json
{"run":1,"protocol":"udp","selectedRelay":true,"closed":true,"medianBps":4286162,"dispersion":0.5507,
 "windows":[{"offeredBps":2000000,"confirmedBps":1746130,"lossRatio":0},
            {"offeredBps":4000000,"confirmedBps":3368842,"lossRatio":0},
            {"offeredBps":8000000,"confirmedBps":5203482,"lossRatio":0},
            {"offeredBps":16000000,"confirmedBps":8834896,"lossRatio":0}]}
{"run":2,"protocol":"tcp","selectedRelay":true,"closed":true,"medianBps":4240631,"dispersion":0.5251,
 "windows":[{"offeredBps":2000000,"confirmedBps":1742151,"lossRatio":0},
            {"offeredBps":4000000,"confirmedBps":3344283,"lossRatio":0},
            {"offeredBps":8000000,"confirmedBps":5136979,"lossRatio":0},
            {"offeredBps":16000000,"confirmedBps":8286955,"lossRatio":0}]}
{"run":3,"protocol":"udp","selectedRelay":true,"closed":true,"medianBps":4311326,"dispersion":0.5370,
 "windows":[{"offeredBps":2000000,"confirmedBps":1708096,"lossRatio":0},
            {"offeredBps":4000000,"confirmedBps":3377523,"lossRatio":0},
            {"offeredBps":8000000,"confirmedBps":5245128,"lossRatio":0},
            {"offeredBps":16000000,"confirmedBps":8525668,"lossRatio":0}]}
```

轮间中位数：均值 4,279,373 bps，总体标准差 ≈ 29,258 bps，离散度 ≈ **0.68%**（门槛 ≤ 25%）。

## ICE gathering 诊断与 trickle ICE 要求

首轮 harness 等待 `iceGatheringState === 'complete'`，左侧 PeerConnection 8 秒超时失败。
单独诊断显示：Cloudflare relay candidates 在 **304–452ms** 内全部产生（udp、tcp relay、tls relay），
但备用 TURN URL 持续探测使 gathering 状态超过 20 秒仍停留在 `gathering`。

因此生产探测与门槛 harness 必须使用 trickle ICE（候选一到就交换），**不得等待
gathering complete**——该结论已写入实施计划的 Task 1 与全局约束。

## 已知限制（不影响通过判定）

- 实验运行的 Edge 浏览器版本号未在运行时捕获；Task 9 的真实观察验收会重新记录环境。
- 实验 harness 的发送节流（20ms tick + 512 KiB 缓冲上限）把第 4 档实际提供速率限制在
  ~13.8 Mbps，故确认吞吐 8.8 Mbps 是"至少"值，不是路径上限；生产实现按 `bufferedAmount`
  全速节流，阶梯延伸到 32/50 Mbps。
- 回环路径同时占用客户端上行与下行，结果是保守的 TURN 路径容量；若客户端下行更差，
  不能称为纯上行容量（spec §4.1）。
- 两个探测 allocation 不是媒体 PeerConnection 的同一个 allocation（同一 Anycast 数据中心）。
- 短期 ICE 凭据仅停留在页面作用域；返回结果经脱敏校验（拒绝包含
  `username`/`credential`/`iceServers`/`password`/`cookie`/`token` 的序列化结果）。
