# 电表负荷曲线的捕获对象接入

负荷档案收件器。使用 DLMS/COSEM 授权网关的 JSON 投影；不会访问真实电表。当前适配器读取寄存器。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

```sh
docker build --network=none -t meter-profile .
docker run --rm --network=none meter-profile npm test
docker run --rm --network=none meter-profile npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器，读取寄存器与负荷曲线；曲线每段只按自己的捕获版本（captureVersion）对应的定义解释，原始值、捕获列、倍率与表时钟状态随原件保留；不修改来源来迎合适配结果，也不拿当前定义补解释不了的旧段。
- src/cursor.mjs 保存曲线续读游标（meterEpoch 与 nextEntry）；主程序分段领取、逐段落盘游标，下次启动从未读完的区段续接，meterEpoch 变化时从头重读。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本（normal、clock-fold、capture-retired）。测试和演示自己创建空目录，不依赖上次执行遗留状态。

负荷曲线可按行（collectProfile）与按时间（collectProfileByTime）两条路径领取，reconcileProfile 对两者结果按 entry 对账；夏令时回拨产生的相同表面时间 entry 不同，不会互相覆盖。设备拒绝提供某段旧捕获定义时，对应段标记为不可解释并保留原始值。
