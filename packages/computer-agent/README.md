# computer-agent

电脑代理以协议 3 完成握手。首次启动生成 UUID，完整落盘到 `<dataDir>/.agent/install-id` 后才发 hello；重连和进程重启复用它。hello 同时携带运行器导出的 Pi `CURRENT_SESSION_VERSION`。每条可靠上行先写入 `<dataDir>/.agent/outbox/` 并 fsync，再通过当前连接发送；welcome 的累计确认和后续 `uplink_ack` 会清理已确认帧。重连或进程重启会按原 stream 和序号补发未确认帧。

可靠上行进发件箱之前按整帧序列化后的字节数对 `AGENT_FRAME_MAX_BYTES` 检查（`src/frame-limit.ts`），发件箱重开时对未确认帧也按同样规则原位改写，序号不变。控制面收到超限帧以 1009 关连接，代理重连重发同一帧又被关，整台电脑的发件箱就卡死了，所以超限只能在入队和重放前处理：`bot_text_done.text` 和 `agent_error.detail` 按 UTF-8 字节截尾并注明「内容过长」，不切开多字节字符；`bot_tool_call` 只是展示，`view.raw` 换成一句说明字节数的话，命令、路径、预览、参数各截到 4 KiB。`approval_request` 不一样，用户是看着卡决定批不批的，截掉的尾巴照样会执行，所以只换 `view.raw`、截写入预览，命令、说明、路径、工具连接、工具名和参数一个字不动。截完仍超限、带 runId 的帧原位换成同一 runId 的 `agent_error`（`runner_failed`），控制面替这个 run 收尾，代理本地 `cancel` 它，挂着的审批随之按过期结算，工具不执行；审批请求的说明写「审批请求过长，没法完整给你看，这一步没有执行」。`work_append` 由运行器先按字节切批，到这里还超限就回 `invalid` 让镜像停流。`mcp_discovered` 是 bare 报文，schema 已把结果限在 1 MiB，不经这道检查。

`.agent/computer.json` 记录传输状态所属的 `computerId`；换电脑、旧版无归属状态或状态文件损坏时，代理把旧 outbox、下行游标和归属信息移入 `.agent/transport-quarantine-<uuid>/`，并从新流和游标 0 开始。隔离不移动 `.agent/install-id`，安装标识属于这份 dataDir，不随换电脑重置。服务器 welcome 的确认序号低于本地记录时，也会隔离旧状态并主动重连新流。

prompt 的 `lane` 原样交给运行器。`cancel{runId}` 停单条运行；`cancel{lane, epoch}` 只停该道上本地代际小于目标代际的在跑和排队运行，不发送 `run_done`。

运行器的 `workAppend` 回调由 `src/work-append.ts` 提供：可靠帧 fsync 后，先登记上行 seq 再发送；收到累计 `uplink_ack` 时，按 `rejected[].seq` 取拒收结果，没有拒收就是 `ok`。`seq_mismatch` 原样返回 `nextSeq`。`stale_epoch` 和 `not_holder` 同时以该道 `epoch + 1` 调用运行器取消旧运行。连接关闭或代理停机立即把全部等待者结算成 `disconnected`，包括仍在等待 fsync 的探针，不使用计时器。

可靠下行按序持久化到 `<dataDir>/.agent/downlink.json` 后再交给运行器。重复序号只回累计确认，不重复执行。控制面关闭码 4002、4003、4004 会停止代理重连；4003 额外向 stdout 输出 `{"type":"upgrade_required"}`。

本机 MCP 的 `mcp_discover` 不经 Pi 会话或 Bot 串行队列，由运行器独立探测模块处理，`mcp_discovered` 只回固定枚举或操作表。两种报文都不落盘；探测断线或停机时取消，旧连接结果不回到新连接。

附件上传和发布下载在实际请求时读取最近 config 的 hub 和网关 key。config 尚未下发时收到附件发布，返回固定错误「发布出错：附件配置尚未下发」，不连接浏览器；这与实际下载失败的「发布出错：配图从白泽下载失败，请稍后重试」分开。
