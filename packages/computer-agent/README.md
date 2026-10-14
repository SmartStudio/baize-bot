# computer-agent

电脑代理以协议 3 完成握手。每条可靠上行先写入 `<dataDir>/.agent/outbox/` 并 fsync，再通过当前连接发送；welcome 的累计确认和后续 `uplink_ack` 会清理已确认帧。重连或进程重启会按原 stream 和序号补发未确认帧。`.agent/computer.json` 记录传输状态所属的 `computerId`；换电脑、旧版无归属状态或状态文件损坏时，代理把旧 outbox、下行游标和归属信息移入 `.agent/transport-quarantine-<uuid>/`，并从新流和游标 0 开始。服务器 welcome 的确认序号低于本地记录时，也会隔离旧状态并主动重连新流。

可靠下行按序持久化到 `<dataDir>/.agent/downlink.json` 后再交给运行器。重复序号只回累计确认，不重复执行。控制面关闭码 4002、4003、4004 会停止代理重连；4003 额外向 stdout 输出 `{"type":"upgrade_required"}`。

本机 MCP 的 `mcp_discover` 不经 Pi 会话或 Bot 串行队列，由运行器独立探测模块处理，`mcp_discovered` 只回固定枚举或操作表。两种报文都不落盘；探测断线或停机时取消，旧连接结果不回到新连接。
