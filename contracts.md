# 来源网关契约

GET /register 返回 logicalName、value、scaler、unit；GET /profiles/load 返回 captureVersion、captureObjects、entriesInUse。GET /profiles/load/entries?fromEntry=... 返回 entry、captureVersion、clock{local,deviation,status}、values。GET /captures/:version 返回该版本各列的 logicalName、attribute、scaler、unit。entry 在 meterEpoch 内唯一；值乘 10^scaler，clock.deviation 为来源分钟偏差。 GET /profiles/load/time?from=...&to=... 按带偏差的ISO时间半开区间筛选同一档案；样例只开放当天范围。

## 本地来源操作

默认场景 normal，其他场景为 clock-fold（夏令时回拨，两个相同表面时间）与 capture-retired（旧捕获版本 c0 的定义已被来源移除，/captures/c0 返回 404）。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

负荷曲线原件以 meterEpoch 与 entry 标识，每段只按自己的 captureVersion 对应定义解释，原始值、捕获列、倍率与表时钟状态随原件保留。设备拒绝提供某版本定义时，对应段标记为不可解释并保留原始值，不拿当前定义补空。按行与按时间两条领取路径的结果按 entry 对账；相同表面时间的不同 entry 不互相覆盖。续读游标记录 meterEpoch 与 nextEntry，由领取方各自维护，meterEpoch 变化后旧游标作废。
