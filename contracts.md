# 来源网关契约

GET /register 返回 logicalName、value、scaler、unit；GET /profiles/load 返回 captureVersion、captureObjects、entriesInUse。GET /profiles/load/entries?fromEntry=... 返回 entry、captureVersion、clock{local,deviation,status}、values。GET /captures/:version 返回该版本各列的 logicalName、attribute、scaler、unit。entry 在 meterEpoch 内唯一；值乘 10^scaler，clock.deviation 为来源分钟偏差。 GET /profiles/load/time?from=...&to=... 按带偏差的ISO时间半开区间筛选同一档案；样例只开放当天范围。

## 本地来源操作

默认场景 normal，其他场景为 clock-fold。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 历史负荷曲线接入

- 按行补读 collectProfileEntries(client,{fromEntry,maxPages,cursor})：按 entry 顺序读取，返回 rows、pages、cursor 与 uninterpretable。
- 按时间筛选 collectProfileTime(client,{from,to})：调用 /profiles/load/time，窗口为半开区间 [from,to)。
- 两种领取方式的行 id 都是 `meterEpoch:entry`，与表面时间无关；夏令时回拨产生的两个相同 clock.local 不会互相覆盖，clock.instant 由 `Date.parse(local + "Z") + deviation * 60000` 得到。
- 每行 raw 保留来源原值；columns 记录该行实际使用的捕获列 logicalName、attribute、scaler、unit 与换算结果，行内 provenance 记录所用 capture 版本及 clockRule/valueRule。
- 来源拒绝提供某段旧定义（如 /captures/:version 返回 404）时，该段行 interpretable=false 且 columns 为空，uninterpretable 按 captureVersion 折叠成 entry 区间；不以当前定义或相邻版本补值。
- reconcile(timeRows,entryRows) 按 id 逐条比对，报告 matched、missingInTime、missingInEntries、conflicts 与 duplicates。
- cursor 可跨进程续接：complete=false 时 cursor.nextEntry 指向下一段起点，complete=true 时 nextEntry 为 null，再次续接返回空批而非重抄整张表。
- dailyUsage(rows) 只汇总可解释的单一数值列，按表时钟日期与单位分别统计，不混合 kWh 与 Wh。
