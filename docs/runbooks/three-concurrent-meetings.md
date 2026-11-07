# 三个同时开放的会议

容量定义为`created`、`active`、`grace`总计最多3个；每房人数仍为5、每房共享者仍为1。原生客户端仍是一个当前会议；此变更不承诺一个客户端同时加入或采集三个房间。

## 实现与兼容

- 新迁移`003_three_open_meetings.sql`不修改已执行的001/002，也不删除已有会议或会话；移除单会议索引，加入按创建顺序的查询索引和插入/状态更新容量触发器。
- 创建的计数与写入在IMMEDIATE事务内，数据库触发器阻止独立写连接绕过3房上限。容量错误为`MEETING_LIMIT_REACHED`，与每房人数已满区分。
- 新`GET /api/v1/meetings/open`返回所有开放会议和容量；旧`/current`严格保留单对象格式。不可用房间仍计数且标`unavailable:true`，前端不把未知人数解释成可加入。
- 主持人和参与者Cookie按slug哈希命名，保留签名并使用`__Host-`前缀及其安全属性，随会议TTL过期；所有HTTP、ICE、P2P握手、统计和CF控制路径使用同一房间范围读取规则。旧全局Cookie仅在新Cookie缺失时兼容读取，并继续验证数据库房间范围。
- 终态通知记录至下一轮清理，因此由公开查询触发的过期不会遗漏P2P/CF收尾；各房清理失败分别记录并继续处理其他房间。

## Cloudflare 与媒体服务

当前仓库的Worker只代理经过服务端认证的SFU session API；没有单会议计数。应用内Cloudflare服务按slug保存发布、按`[slug, identity]`串行化同一owner操作；每房5个活动SFU session和20个清理中session的边界均是按房间计数。P2P目录按slug，LiveKit房间及token按meetingId。无需为3房新建3个Worker或3个SFU App。

Cloudflare官方当前文档将应用房间准入与SFU资源限额分开，50次/秒限制针对单session；不同session的独立操作可并行。[SFU限制](https://developers.cloudflare.com/realtime/sfu/platform/limits/)、[协商并发规则](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/)

Workers的6个同时外连限制是每次请求，不能解释成整个Worker只支持6个人；Free账号每日请求额度仍需根据实际账号与使用量核对。[Workers限制](https://developers.cloudflare.com/workers/platform/limits/)

生产上线前核对当前Worker模块/绑定与上述仓库实现一致、当前套餐/请求量及服务器CPU和带宽。自托管coturn的端口池现为49160–49200（41个端口），尽管total-quota为120，多种TURN候选与集中重连仍可能先耗尽端口；应做三房满员强制TURN测试后决定是否扩池。任何扩池均须同步阿里云安全组和主机防火墙，不能只改quota。未以代码测试声称生产负载验证已通过。

## 发布与回滚

这是API、数据库和网页的联合更新，不能使用纯Web发布脚本。遵守现有`require_no_meeting`保护；准备具体制品、备份及发布窗口后，由用户结束已有会议，不自动结束用户房间。部署探针也在IMMEDIATE事务内显式拒绝任意开放会议，不再依赖旧唯一索引；脚本识别新旧Cookie，解析出合法probe slug后立即注册失败清理。

API激活后若用户已创建多个房间，不能自动退回只识别单房的旧API或重建旧唯一索引。标准updater对包含API的失败回退再次检查没有开放会议；纯Web回退不增加此限制。部署smoke会先清理自己的探针房再返回失败；若仍有用户会议，回退保护保留候选、原验证错误和阻止原因，待向前修复或安排窗口。镜像回滚不等同数据库恢复，不得自动覆盖运行数据库。本文不代表已经执行了生产部署或回滚。

## 回归重点

1. 旧数据库升级保留记录、迁移可重复调用；4个独立SQLite写线程只允许3个成功；终态重开也受限制。
2. 同浏览器三房主持人和参与者Cookie并存；Cookie改名、legacy跨房与损坏新Cookie均不能越权。
3. 三房可分别授权共享；结束A只关闭A的LiveKit房间、CF publication与P2P连接，B/C仍可刷新凭据并接收。
4. 单房媒体查询失败不隐藏其他房；硬TTL与查询触发的终态通知正确；失败清理不阻断其他房。
5. 网页三房列表、3/3禁止创建、不可用房占位、独立结束及迟到响应/刷新竞争正确；旧/current仍可使用。
