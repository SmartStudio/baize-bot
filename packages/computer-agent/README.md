# computer-agent

电脑代理以协议 3 完成握手。首次启动生成 UUID，完整落盘到 `<dataDir>/.agent/install-id` 后才发 hello；重连和进程重启复用它。hello 同时携带运行器导出的 Pi `CURRENT_SESSION_VERSION`。每条可靠上行先写入 `<dataDir>/.agent/outbox/` 并 fsync，再通过当前连接发送；welcome 的累计确认和后续 `uplink_ack` 会清理已确认帧。重连或进程重启会按原 stream 和序号补发未确认帧。

`.agent/computer.json` 记录传输状态所属的 `computerId`；换电脑、旧版无归属状态或状态文件损坏时，代理把旧 outbox、下行游标和归属信息移入 `.agent/transport-quarantine-<uuid>/`，并从新流和游标 0 开始。隔离不移动 `.agent/install-id`，安装标识属于这份 dataDir，不随换电脑重置。服务器 welcome 的确认序号低于本地记录时，也会隔离旧状态并主动重连新流。

prompt 的 `lane` 原样交给运行器。`cancel{runId}` 停单条运行；`cancel{lane, epoch}` 只停该道上本地代际小于目标代际的在跑和排队运行，不发送 `run_done`。

运行器的 `workAppend` 回调由 `src/work-append.ts` 提供：可靠帧 fsync 后，先登记上行 seq 再发送；收到累计 `uplink_ack` 时，按 `rejected[].seq` 取拒收结果，没有拒收就是 `ok`。`seq_mismatch` 原样返回 `nextSeq`。`stale_epoch` 和 `not_holder` 同时以该道 `epoch + 1` 调用运行器取消旧运行。连接关闭或代理停机立即把全部等待者结算成 `disconnected`，包括仍在等待 fsync 的探针，不使用计时器。

可靠下行按序持久化到 `<dataDir>/.agent/downlink.json` 后再交给运行器。重复序号只回累计确认，不重复执行。控制面关闭码 4002、4003、4004 会停止代理重连；4003 额外向 stdout 输出 `{"type":"upgrade_required"}`。

本机 MCP 的 `mcp_discover` 不经 Pi 会话或 Bot 串行队列，由运行器独立探测模块处理，`mcp_discovered` 只回固定枚举或操作表。两种报文都不落盘；探测断线或停机时取消，旧连接结果不回到新连接。
