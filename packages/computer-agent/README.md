# computer-agent

电脑代理以协议 2 完成握手。每条可靠上行先写入 `<dataDir>/.agent/outbox/` 并 fsync，再通过当前连接发送；welcome 的累计确认和后续 `uplink_ack` 会清理已确认帧。重连或进程重启会按原 stream 和序号补发未确认帧。

可靠下行按序持久化到 `<dataDir>/.agent/downlink.json` 后再交给运行器。重复序号只回累计确认，不重复执行。控制面关闭码 4002、4003、4004 会停止代理重连；4003 额外向 stdout 输出 `{"type":"upgrade_required"}`。
