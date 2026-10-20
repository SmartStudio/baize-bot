# @baize/control-plane

控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js。同一个 3001 端口按路径分流：`/api` 给 Web 客户端，`/api/ws` 往客户端推，`/agent` 给电脑代理，`/gateway/v1` 是模型网关，`/mcp-proxy` 代执行工具，`/hub/v1` 提供附件和工作记录快照。认身份、建电脑、发 config 那套写在仓库根 README.md 的「控制面」一节。

## 电脑配对

一个用户本机和远程各至多一台。`POST /api/computers/local` 无请求体或空对象时按 `confirmDisplace: false` 处理；本机从未握手过就直接返回 `ComputerTokenResponse`。本机的 `lastSeenAt` 非空或此刻在线时，未确认回 409 和 `PairLocalConflictResponse`：`error` 是「这个账号已经在另一台 Mac 上用过，继续会让那台退出」，`computer` 是已有电脑的公开对象。409 不重置 token，也不关闭旧连接；已休眠的电脑同样需要确认。

用户确认后重新 POST `{ "confirmDisplace": true }`，电脑号沿用，token 轮换，在线的旧本机连接用 4004 和「这个账号已在另一台 Mac 上登录」关闭。顶号排在这台电脑的处理链上，先前正在握手的连接也会被关闭；排队中的 hello 入场前再次校验 token，旧 token 不能在重新配对后入表。远程电脑的 token 和连接不受本机配对影响。

## 电脑代理握手

hello 的协议号和下限都是 4，缺少 `protocol` 按 1 处理，以 `upgradeRequired`（4003）关闭。协议 4 起 hello 必须带 `controlOrigin`，是代理连 `/agent` 那个地址的源；缺了用 `badHello`（4001）关，格式不对（带路径、结尾斜杠、凭据，或不是 http(s)）在 parse 边界就不过，同样 4001。schema 上它可缺，是为了让不带它的旧代理先撞上协议号检查，拿到 4003 而不是 4001。config 里的 `modelGateway`、`hub`、`mcpProxy`、`accountsProxy` 四个 `baseUrl` 只由 `agent/data-plane.ts` 的 `dataPlaneUrls(controlOrigin)` 拼，按连接各用各的，不读 `PUBLIC_BASE_URL` 也不读 `Host` 头（nginx 默认会把 `Host` 改写成上游地址）。四个必须同源，运行器的 recall 拿网关地址的源去访问 `/hub/v1`。hello 带持久化的安装 UUID `installId` 和运行器的 `piSessionVersion`，握手事务写安装标识并续租；Pi 版本留在连接内存，追加时写入流元数据。协议满足下限、电脑号存在且 token 正确才回 `welcome` 和 `config`。电脑号存在但 token 不正确用 `AgentCloseCode.displaced`（4004）关闭；电脑号不存在、首条报文不合法、10 秒内没报 hello 用 `badHello`（4001）。同一 token 重连顶旧连接用 `superseded`（4000），删账号用 `accountDeleted`（4002）。序号缺口用 1011 关闭，1012 保留原行为。

电脑代理 stdout 每行一个 `AgentStatusLine` 状态 JSON，接纳时输出 `{"type":"online"}`。收到 4004 后输出一次 `{"type":"displaced"}`，收到 4003 后输出一次 `{"type":"upgrade_required"}`；4002、4003、4004 都停止重连并清理心跳、运行器和助理 Chrome。库函数不主动退出进程；桌面端保持 stdin 打开时代理进程可能以已停止状态驻留，stdin 结束或收到 SIGINT/SIGTERM 时现有入口正常退出。其他关闭码按退避重连。


## 可靠信封

shared 的 `UPLINK_DELIVERY`、`DOWNLINK_DELIVERY` 穷举报文送法。上行 reliable 用 `{ type: "uplink", conn, stream, seq, body }`，bare 用 `{ conn, body }`；流式 `bot_text` 只发 `done: false`，每块全文由 reliable 的 `bot_text_done` 定稿。控制面在同一事务里条件推进 `computers.up_acked` 和处理业务，重复帧只回确认，毒帧重试一次后回 `invalid` 并越过。已收尾的 run 允许 `run_done`、`bot_text_done`、`bot_tool_call`、`work_append`，其他动作回 `run_closed`。工作记录有独立的道、持有者和 run 校验，导入或空探针可不带 run。旧连接代际不处理、不确认。

电脑代理上行先写 `<dataDir>/.agent/outbox/<stream>/frames.jsonl`，同一 100ms 窗口共用 fsync，落盘后才发送。控制面以 20ms 合批累计 `uplink_ack`；代理持久化确认再清理旧帧，重启后沿用 stream、序号和未确认帧。

可靠下行在调用方事务里进入 `agent_outbox`，带 `{ type: "downlink", seq, body }` 按序发送；结束或放弃 run 的事务删除它绑定的行，4004 顶号清空该电脑发件箱，删电脑级联删除。在线或断线宽限内可以入队，宽限外沿用派发失败分支。hello 先更新连接代际和游标，再依次发 welcome、config、pause/resume、重放发件箱，随后补历史欠账。代理先持久化 `.agent/downlink.json` 再入运行器队列，重复帧只确认，崩溃窗口内丢失的 prompt 由 hello 的 activeRuns 对账收尾。对账发现已结束的 active run 时现场发 `cancel{runId}`，不入发件箱。

下行确认事务先用连接上的 owner id 拿归属人共享 advisory 锁，再条件更新电脑游标，最后删除已确认的发件箱行。删号拿同一把归属人排他锁，先删 runs 级联到发件箱，再删用户级联到电脑；确认若先锁电脑，两边会各持一行互等。共享锁让两条路径在碰行之前排队，每次确认多一条锁查询，不额外查归属人；更新非键游标本身拿电脑的 `FOR NO KEY UPDATE` 行锁。`test/privacy.test.ts` 用实际锁等待和查询闸门钉住这个交错。

无 `runId` 的 `agent_error` 不能按最近开始时间猜归属。运行器的会话关闭、配置对账和已进入 prompt 的失败路径仍会省略 `runId`：带群号时先校验群属于归属人，只在该群范围内查 open run；不带群号时电脑上恰好一条 open run 才落到它的群，零条或多条不落群，只打一行 `console.warn`（带 computerId、code 和截到 80 个字符的 detail），指定的群已删或不属于归属人时同样打一行。detail 是运行器原样带来的用户内容，没有长度上限，`agent_error` 的所有日志行（含 `config_rejected` 的 warn 和带无效或已结束 runId 的 error）都走同一个 `clipDetail`：按 Unicode 码点数，满 80 个才截，后面加「…」，不会把一个 emoji 的两半劈开。指定群号可以留群级错误提示，但只有该群恰好一条 open run 时才关联例行任务失败。其他带 runId 的上行仍按原有归属校验处理，报文形状和协议号不变。

已知限制：不带群号的错误仍按电脑归属，不按 Bot 或会话归属。同一台电脑上同时有两个以上开着的 run 时，这类错误宁可不落群也不猜；行为没改，要彻底解决得让运行器在这些路径上补带群号（`test/p3-cp-guards-uplink.test.ts` 钉着现在的取舍）。

启动清理和停机批量休眠也遵守删号的锁序：先读目标快照并按 owner 分组，owner id 升序切成批，每批 500 个 owner（`SLEEP_OWNERS_PER_BATCH`，函数参数可注入，测试里设成 2）一个事务，避免几千个 owner 的共享 advisory 锁撞 `max_locks_per_transaction`。每个事务里先按 owner id 升序拿本批归属人共享锁，随后按电脑 id 升序拿 `FOR NO KEY UPDATE`，最后只更新快照中仍符合条件的电脑。批与批之间不持锁，各批互相独立，中途失败已提交的批保留，没做的批下次启动或停机再扫。删号拿 owner 排他锁；批量写等它提交后目标已删除就跳过。每批先拿齐本批 owner 锁再碰任何电脑行，避免多实例滚动启停与删号各持一行互等。快照之后新增的电脑由它自己的连接维护，本次批量写不扩大目标范围。

用户消息插入复用群行 `KEY SHARE` 与插入同一事务的写法。查群之后若删号或删群已提交，插入入口返回 404「没有这个对象」，与群不存在的路由口径一致；若插入先锁住群行，删除等这条消息提交。删号会话级联失效，后续请求返回 401。

## 画面面

`/agent` 上的文本帧是报文，二进制帧是画面面。帧格式是 4 字节大端头长、UTF-8 JSON 头、可选负载，头的 schema 和 `encodeLive`、`decodeLive` 在 shared 的 `live.ts`。电脑上行 `LiveUp`：`session`（整份 upsert）、`frame`（负载是 JPEG）、`closed`。下行 `LiveDown`：`viewer`（attached、detached）、`input`、`end`、`reveal`。网页看画面连 `/api/live/<liveId>`，帧格式相同，收 `LiveToViewer`（`session`、`frame`），发 `LiveFromViewer`（`input`、`end`、`reveal`）。

画面帧和人的输入（含密码）不走可靠信封，不进库、不进发件箱、不进日志。理由有三条：

- 一台电脑的文本报文排在一条串行链上，可靠上行各开一个库事务。帧要是走这条链，就得排在库事务后面。
- 电脑代理 `computer-agent/src/agent.ts` 处理文本报文出错时会把 zod 的错误原文和 `String(error)` 写进日志。输入要是走文本报文，密码就可能进日志。
- 帧丢了，下一帧会补上。人的输入是看着当下画面做的，过时重放反而有害。可靠投递对它们没有意义。

所以 hub 在进链之前按 `isBinary` 分流，二进制帧同步交给 `live/relay.ts` 的 `LiveRelay`。中继的构造参数里没有 Db，结构上碰不到库。解不开的帧一律静默丢，不说原因，因为原因里可能夹着用户打的字。`test/live-relay.test.ts` 的最后一条用例跑完一整轮，再逐表比对 public 下的行数，并 spy console 确认输入不进日志。

会话按 `${ownerId}:${liveId}` 记，`computerId` 取自连接，不信帧里的。同一个号已经挂在这个人的另一台电脑上时，后报的忽略。`frame` 和 `closed` 只认报这个会话的那条连接。连接断了，这条连接上的会话全部结束。电脑重连后重报的会话换到新连接上，观看者留着，中继给新连接补发一条 attached。

hub 认连接用 `#onHello` 入表时登记的 WeakMap，再校验它还是 `#connections` 里的当前连接。不用 message 回调闭包里的 `conn`，因为它要等 `#onHello` 把 config、发件箱重放和对账全部做完才赋值。这期间电脑已经在报 session 和发帧，按 `conn` 判断会把它们丢掉。入表之前到的二进制帧直接丢。

一台电脑同一时刻最多一个观看者。新观看者进来时，不论看的是同一会话还是这台电脑的另一个会话，旧的都以 4101 关，电脑先收旧会话的 detached，再收新会话的 attached。所以电脑上每个会话的 attached 和 detached 严格交替。观看者的关闭码：

| 码 | 含义 |
| --- | --- |
| 4100（`LiveViewerClose.gone`） | 会话结束，电脑报了 closed 或连接断了 |
| 4101（`LiveViewerClose.replaced`） | 被新观看者顶掉 |
| 4104（`LiveViewerClose.notFound`） | 号不合法、会话不存在或不是你的，不区分 |
| 1012 | 控制面停机 |

升级时先查 Origin：带了 Origin 而它的 host 不等于 Host 头，回 403。之后用 cookie 认人，认不出回 401。这条 socket 能往用户登录着的网站里打字，被跨站劫持的后果比 `/api/ws` 大，所以多这一道。观看者 WebSocket 的 `maxPayload` 是 64KB，电脑来的单帧超过 2MB 丢。

人的输入每个观看者每秒最多转 120 条，用令牌桶，多的丢，`end` 和 `reveal` 不计数。`startServer` 的 `live.inputPerSecond`、`live.now` 可注入。发给观看者的帧走 `latestWins`：上一帧还没发完时只留最新的一帧。

`GET /api/live` 列当前用户的会话（`LiveSessionsResponse`），`/api/ws` 推 `live_session`（整份）和 `live_closed`。推送在断线期间会丢，所以网页启动和 `/api/ws` 重连时各拉一次列表。同一个号收到 `live_closed` 之后，电脑重连重报时还会再来一条 `live_session`。

中继的会话表和观看者表都在进程内存里，前提是看画面的人和这台电脑连在同一个控制面进程上。控制面跑多实例时，`/api/live/<liveId>` 必须按电脑粘性路由到持有这台电脑 `/agent` 连接的实例，否则观看者只会拿到 4104。

## 租约

`lane_leases` 用 `(bot_id, group_id)` 作主键，一条道只有一台持有电脑，并固定它的安装标识和正整数代际。`agent/place-run.ts` 的 `placeRun` 是唯一建 run 的入口，用户消息、Bot 之间的 @、例行、交接和牌桌隐藏 run 都走它。认领租约、必要时接管、建 run、可靠 prompt 入队在调用方的同一事务里提交；`test/place-run-guard.test.ts` 扫源码禁止其他入口直接建 run。

持有电脑的 `lease_until` 未过期且安装标识相等，道上又有未收尾的 run 时继续派给它。道闲着时按选机偏好迁回在线本机；持有者失效或闲道迁机时，代际加一，给旧持有者入队 `cancel{lane: {botId, groupId}, epoch: 新代际}`。同电脑、同道的取消只保留最大代际。选不到在线或宽限内的电脑时不建 run、不改租约，沿用群里的派发失败提示。删 Bot 时先给它各道的持有者发下一代取消，再删除；单聊群随 Bot 删除。

`placeRun` 依次拿归属人共享锁、Bot 共享锁、该归属人电脑行、道行和原有结账锁。电脑行按 id 升序锁齐，避免两个群从 A 到 B、从 B 到 A 同时接管时反序。prompt 的 `lane` 带 `{epoch, heads}`，`heads.chat`、`heads.table` 是已存在流的 `{seq: next_seq, head}`，未创建的流省略。

租约时钟和静默计时器共用续期点：默认 45 秒静默加 15 秒宽限，数据库续期同连接每 5 秒至多写一次。续期和断线缩租都在 SQL 中用 `clock_timestamp() + 时长` 写截止；关闭时按数据库返回的剩余毫秒启动宽限计时器，不依赖 Node 墙钟。旧连接的续期或关闭用连接代际条件写，没有更新到该代际就不启动宽限计时器，不能缩短新连接的租约。`startServer` 可注入 `silenceTimeoutMs`、`disconnectGraceMs`、`leaseRenewalIntervalMs`；短时长测试也要把合并窗口缩到租约寿命以内。持有者与派发时的期限判断用 `clock_timestamp()`，事务等锁后按当前时间核验。断线收尾继续走原来的 `abandonRun`。

网关、MCP 代执行和 Hub 都以网关 key Bearer 认电脑，再调用同一个 `validateLaneFence` 检查 `x-baize-lane: <botId>/<groupId>/<epoch>`。道必须属于该归属人，Bot 仍在群中，电脑、当前安装标识和代际须匹配，电脑租约须未过期。网关所有请求都要带头；MCP 请求体的 Bot 还须匹配头里的 Bot。key 不对回 401，租约失败回 409 和固定分类：

| 分类 | 正文的 `error` |
| --- | --- |
| `stale_epoch` | 代际过时 |
| `not_holder` | 不是持有者 |
| `expired` | 租约已过期 |
| `invalid` | 缺少或格式不对 |

## 工作记录

可靠上行 `work_append` 带 `{lane: {botId, groupId, stream, epoch}, runId, fromSeq, lines, head, cause}`。`stream` 是 `chat` 或 `table`，每帧至多 64 行。服务器先查持有者与代际，再逐行解析 Pi 条目的 `type`、`id`、`parentId`，拒绝 SessionHeader。保存的是留存过滤之后的原样 JSONL 字符串；服务器接受的行已经是过滤器的不动点，所以 `work_entries.retention` 为 `verbatim`，不能据此推断本机原文是否被过滤过。搜索文本只抽 user、assistant 和 toolResult 的文字，图片和 thinking 不入索引。

服务器从该归属人的 `tool_connections` 里取所有 `localOnly: true` 连接的操作名，包含目前未分配给这个 Bot 的操作；帧自报的名单不起作用。`@baize/shared/work-record` 的 `checkFrame` 逐帧复查图片块、超过 16 KiB 的文字、本机工具结果原文、重复 id、畸形已知条目，以及针对本机结果或未知目标的上下文编辑。有一行失败就整帧拒收，不保存合规前缀、不认领导入道。`work_streams.retain_snapshot` 保存 `RetainSnapshot`；读取 jsonb 时先按其 schema parse，成功追加时新快照和条目、信封游标在同一事务提交。旧流没有快照时从 `emptySnapshot` 开始重放已有行，避免遗失历史 id 和本机结果状态。

`work_streams` 还保存 `next_seq`、链头、末条 id 和连接报告的 Pi 版本。追加的条件 UPDATE 同时要求起始序号相等及租约的电脑、安装标识、代际匹配。序号从 0 开始，链头按 `sha256(上一个32字节摘要 || sha256(原样行))` 重算；空流的摘要是 32 个零字节。共享函数是 `@baize/shared` 的 `advanceWorkHead`。

工具连接新建、改本机范围、改名、补授权和删除时，在修改事务里立即按新名单复查归属人全部 Bot 的两条流。名单是归属人全局操作名集合，因此未分配的 Bot 也受影响。连接修改持归属人排它锁，与追加互斥；即使改名、删除、补授权没有改变操作名集合，也完成复查。从第一条不合规旧行起删除整个后缀（包括 `search_text`），重算合规前缀的链头，同时回退 `next_seq`、`tail_entry_id` 和快照；旧行全部合规就只更新快照。HTTP 返回前已提交撤回，不等新上传。后缀随后由运行器从本地原文按新名单重新过滤补传，本机 JSONL 不动。在途旧帧收到 `seq_mismatch`，按 Hub 的合规前缀对齐；下一轮 prompt 也按新 config 过滤本地前缀核对，保留本地会话。

结果经 `uplink_ack.rejected` 按可靠帧序号返回，无拒收项是 `ok`。运行器按下表处理：

| 结果 | 字段与原因 | 运行器动作 |
| --- | --- | --- |
| `ok` | 无拒收项 | 推进已确认游标 |
| `stale_epoch`、`not_holder` | `lane` | 停掉这条道；下一次 prompt 按服务器记录重建 |
| `seq_mismatch` | `nextSeq` | 对齐服务器游标；结合 Hub 快照核对链头，不盲目重发同帧 |
| `head_mismatch` | 链头不符 | 拉 Hub 快照重建镜像 |
| `invalid`，`reason: "tool_list_changed"` | `nextSeq`、`head`；截掉旧行时还有 `replayReason` 和 `lineIndex`（旧流中从 0 开始的行号） | 用最新 config 的本机工具名单从头过滤本地记录；核对服务器前缀后从 `nextSeq` 重传后缀，重新计算链头 |
| `invalid`，`reason: "unfiltered"` | `lineIndex`（当前帧从 0 开始的行号） | 先过滤这行和后缀，再组成新帧；原帧不再重传 |
| `invalid`，`reason: "duplicate_id"` 或 `"malformed_entry"` | `lineIndex` | 停止上传坏流，修复或按服务器快照重建 |
| 其他 `invalid` | 帧、Pi 条目或 run 不合法 | 修正结构或重建，不能当成成功 |

兼容旧流的非空追加仍会在快照缺失或名单指纹失效时复查。`replayReason` 为 `unfiltered`、`duplicate_id` 或 `malformed_entry`，对应第一条被截掉的旧行；只有名单失效但全部旧行合规时不带它和 `lineIndex`。电脑代理的 `WorkAppendChannel` 把 `invalid` 的 `reason`、`lineIndex`、`replayReason`、`nextSeq`、`head` 原样透传给运行器，服务器没给的字段不补。本期保留原拒收码集合，以 `invalid.reason` 表达 `tool_list_changed`，兼容其穷尽匹配。

`work_append` 的持有者校验不附加 HTTP 的时钟条件。空 `lines` 是 before_effect 等场景的探针，只看持有者与代际，忽略 run、序号和链头，不创建流或条目、不触发旧行复查。

非空普通追加须带属于此电脑、归属人、Bot、群的 run，已结束的 run 也可追加；可见范围复制 `runs.visible_to`。导入用 `cause: import` 和 `runId: null`。导入首帧 `fromSeq: 0` 在没有租约行时必须带代际 1，接受后以代际 1 认领；有租约时必须由当前电脑和安装持有，并带租约的当前代际，接受后保持代际不变。其他持有者或过时代际拒收。目标流已有条目时拒收重复首帧。后续导入帧继续使用 import/null run，按普通序号 CAS 追加，不再认领。导入牌桌群的条目只对该 Bot 可见，其他群为 null。

`GET /hub/v1/lanes/:botId/:groupId/:stream?after=<seq>&limit=<n>` 只接受网关 key Bearer，不接受登录 cookie；头中的道须匹配路径。Hub 认证中间件覆盖所有路由；快照路由在只读可重复读事务内按认证出的电脑号重读电脑行，租约栅栏和记录读取使用同一事务，返回 `{entries: [{seq, line}], nextSeq, head, piSessionVersion}`。默认 `after=-1`、`limit=64`，上限 200，下一页用本页末条 `seq`；名单和记录也在该快照内读取。流的快照指纹等于当前名单指纹时，写入侧不变式保证库里的行都合规，直接按 `seq > after ORDER BY seq LIMIT limit` 读本页，`nextSeq` 和 `head` 取流元数据，读一页只花一页的代价。指纹不等或没有快照（某个写入口漏了复查的流，或旧流）才从头复查，不合规的残留旧行及其后缀不会读出，`nextSeq` 和 `head` 对应可安全读取的完整前缀；这条路径逐页重读前缀，代价随流长增长，只在异常时走。正常流仍返回全流元数据。空流即使因失败留下 `nextSeq: 0` 的流元数据，也返回 `nextSeq: 0`、零链头和 null Pi 版本。

租约授权的原样读取和旧行重放只在 `repo/work-records.ts`，不带 viewer，理由登记在读守卫的 EXCEPTIONS。带 viewer 的读同样只在该文件，并须在同一查询链调用 `workEntryVisibleTo(viewer)`；守卫禁止其他文件直接读 `work_entries`，即使带 viewer 或借消息表白名单也不放行。`lane_leases`、`work_streams`、`work_entries`、`attachments` 按 Bot、群级联删除，条目和附件按归属人级联，run 删除只把条目的 `run_id` 置空。删 Bot 在删除事务里给单聊及多 Bot 群每条持有道入队 `cancel{lane, epoch + 1}`，提交后投递；群及队友数据保留，单 Bot 群随 Bot 删除。多 Bot 群没有删除入口，只能解散（软归档，见「群与主题任务」的「解散群」），解散也给这个群的每条道入队下一代取消。

删号按归属人、Bot、电脑、道、run 的顺序取锁，在同一事务里入队所有道取消、删除用户和相关记录，电脑与 `agent_outbox` 随外键清空。事务只返回已入队的道取消副本，未发出的 prompt、审批决定等报文随发件箱清空；提交成功后，仅向连接代际仍匹配的在线电脑按序投递，随后以 4002 关闭连接。副本不再落盘，断线电脑不会重放删号取消，旧 token 也不能重新握手。账号已删除时不存在可以持久保留的发件箱，这个最后投递窗口只服务于仍在线的电脑。

## recall

写入 `search_text` 和召回复核、摘录时直接删除文字中的 U+0000，跨 NUL 的关键词可连续命中，原始 JSONL 行及哈希链保持不变；Pi 条目的 `id`、`parentId`、`type` 若含 NUL，在解析时整帧回 `invalid`。

`POST /hub/v1/recall` 使用当前电脑网关 key 的 Bearer 和 `x-baize-lane` 租约头。鉴权后的电脑行、道栅栏和召回查询共用只读可重复读事务。Bot、归属人和当前群都从鉴权或租约头取得，请求只接受 `{query: string}`；关键词去掉首尾空白后须为 1 到 100 个字符且不能含 NUL，非法请求回 400「召回参数格式不对」。缺头、旧代际、非持有者和过期租约按租约节回 409，cookie 不能代替 Bearer。

`repo/work-records.ts` 的 `recallWorkRecords` 必填被查 Bot 的 viewer，只查它本人、同归属人、全群可见的 `chat` 流，排除当前群。`workEntryVisibleTo(viewer)` 之外还固定要求 `visible_to IS NULL`，对本人私密的记录也不召回；牌桌流、隐藏 run 和别的 Bot 的记录不进入结果。来源群必须仍属当前归属人且 Bot 仍是成员，群标题取该群主题任务的当前标题。工具名单查询与候选读取也在同一可重复读快照内；候选原行按当前名单再过滤，摘录只从过滤后的文字提取，陈旧 `search_text` 不会带回原文。排序键全部在 SQL 里：相似度降序、条目时间降序、群号（`COLLATE "C"`）升序、seq 降序，条目时间是 `work_entries.entry_at`，缺失时回退到 run 开始时间和群创建时间。候选按这个次序分批取（首批 32 条，之后每批翻倍），每批在 Node 里按当前名单再过滤，凑够 8 条或候选取完就停，不合规命中不会挤掉正常结果，也不把所有 `ILIKE` 命中整行拉进 Node。`entry_at` 在唯一写入口 `appendWorkRecords` 由 Node 从已通过 `JSON.parse` 和 `PiWorkEntry` 的 `chat` 流 `message` 条目计算：只认与共享 `ISO_TIME` 同形状的带时区 ISO 8601，按 `Date.parse` 取毫秒；缺失、非字符串、非法时间，以及 UTC 年份落在 1 到 9999 之外的值为 NULL。后一个范围保证 drizzle 序列化的 ISO 时间能被 PostgreSQL 接收，时区偏移跨年也按 UTC 判定。其他流和其他类型写 NULL。0037 删除 0036 的写入触发器并重算旧消息行：小数先在字符串上截到毫秒，再转时间；整行有真正的 JSON 转义 NUL、非法时间或 SQL 无法保证等价的形状时回填 NULL，不删 NUL 解析。回填函数随迁移删除，后续插入只依赖应用写入，直接 SQL 夹具须显式给出 `entry_at`。删群后同一查询回空；删 Bot 后原道的请求被栅栏拒绝，工作记录随外键级联删除。

查询用字面量 `ILIKE` 子串匹配，转义 `%`、`_` 和反斜线，再按 `similarity` 降序、记录时间降序排列，最多返回 8 条 `{groupId, groupTitle, at, kind, excerpt}`。`kind` 只接受 Pi `message` 的 `user`、`assistant`、`toolResult`。原行在 Node 用 JSON 解析，角色不依赖 `line::jsonb`；非检索字段里的 JSON 转义 NUL 照常保留、接收和召回。条目时间按上一段取 `entry_at` 及其回退，统一为 ISO。摘录围绕关键词截取，最多 400 个字符。`search_text` 使用 `pg_trgm` GIN 部分索引，条件为 `stream = 'chat' AND visible_to IS NULL`；候选仍由数据库的字面量查询筛选，可使用该索引；相似度和排序都由数据库计算，Node 只过滤、不重排。召回内容在运行器里只用于当前 run，历史和上传记录仅保留占位文字。

`test/recall-search.test.ts` 用 61 条中文语料比较 2 到 4 字关键词：默认相似度阈值漏掉全部命中，子串匹配保留全部命中。两字无边界子串没有内部三元组，实测仍需扫描候选；三字「小红书」在清理批量夹具的 GIN pending list 后，默认计划走 `work_entries_chat_search_idx`。索引存在不代表所有查询都由它执行，召回优先保留短词命中。

## 工具连接

创建 `localOnly: true` 连接、或按更新后的 `localOnly` 换凭据时，工具发现交给归属人在线的本机电脑；没有在线本机电脑返回 409，远程电脑不会代替它探测。代理独立执行 initialize 和 tools/list 分页，最多 10 秒，client 名为 `baize-bot-runner`；控制面等回报最多 15 秒，断线立即结束等待。非本机连接继续由控制面发现。

`mcp_discover` 和 `mcp_discovered` 在协议 3 登记为 bare。下行带明文凭据，不能进 `agent_outbox`、代理磁盘发件箱或 `.agent/downlink.json`；上行只供当前 HTTP 请求使用，丢失让请求超时、用户重试。待回记录只在内存，绑定用户、电脑和连接代际，未知请求或旧连接回报静默丢弃。控制面按固定枚举映射中文错误，重新校验操作表（最多 256 个操作，JSON UTF-8 最多 1 MiB）和凭据回显，成功后才保存；失败时旧凭据和操作表保持不变。地址仅支持 http 和 https。

工具连接是用户级对象。`tool_connections` 存 MCP 地址、发现的操作及其 `needsApproval` 标记，并把认证信息以 AES-256-GCM 密文存入 `authorization_enc`；`tool_connection_bots` 记录它分配给哪些 Bot，删 Bot 时对应分配由外键级联清除。API 列表和写入响应都不返回认证信息。默认 `localOnly: false`，凭据只留在服务器，`config.tools` 仅下发操作表和 Bot 分配，不含 `authorization`。运行器经 `/mcp-proxy/:connectionId/call` 代执行，本机和远程电脑都能使用。设成「只在本机用」后，本机电脑收到 `localOnly: true` 和解密后的凭据并直连 MCP；远程电脑不收到这条连接。

生产环境设置 `TOOL_SECRET_KEY` 为 64 位十六进制密钥。未设置时启动会警告一次，并使用固定开发密钥；已有密文依赖原密钥解密，换密钥前需迁移密文。MCP 发现时把认证信息作为 `Authorization` 请求头发送。操作默认按 MCP 的 `readOnlyHint` 定审批：明确为 `true` 的不需要，其余都需要；用户可通过 `PATCH /api/tools/:id` 覆盖标记。连接创建、修改、删除后，控制面都会向该用户在线电脑重发整份 `config`。

从分享链接导入的插件固定 `localOnly: false`，没有授权，操作表只有包里带的名字和 `needsApproval`，参数表是占位的空表：导入时控制面不去连包里的地址（D11）。所以导入的连接记成 `awaiting_authorization`，随 `config.tools[].status` 下发，运行器照样注册它的操作，但调用当场拒绝、不去连包里的地址。不能拿 `authorization` 为 null 来判：自己建的匿名 MCP 也是 null，那是 `ready`。导入后要先在 `PATCH /api/tools/:id` 带上 `authorization` 补授权，插件才能用；对端本来就不要认证的，传 `authorization: null`，控制面不带头重新探测，连上了清掉凭据、记成 `ready`。这一步对一种对端会误删凭据：`tools/list` 允许匿名、只有 `tools/call` 才要凭据。不带头的探测照样连得上，凭据一次就被清掉，之后每次调用都是 401，要所有者重新带凭据 PATCH。这不算越权，只有所有者能改自己的连接。Web 现在不发 null，以后接入这个入口时只对 `awaiting_authorization` 的连接开放，或者先二次确认。补授权时控制面当场重新 initialize 加 `tools/list`，连上了就按真实列表重建操作表并记成 `ready`，同名操作沿用原来的 `needsApproval`；连不上回 400，旧凭据和操作表都不动。探测要等对端，期间别的 PATCH 可能已经改了审批，所以写回在事务里先 `SELECT ... FOR UPDATE` 锁住这一行，按落库的最新操作表合并，普通的 operations 修改也走同一把锁。导入撞名时工具名和 Bot 名一样截掉尾巴给序号让位，不超过 40，再导出不会被分享包的上限挡住。对端能把收到的 Authorization 按任意编码写进报错，逐种编码去认认不完，所以探测失败只回固定的中文分类（`describeMcpFailure`，HTTP 状态码、MCP 错误码这一级），对端写的文字一个字都不回；运行器连不上、调用抛错也是同一套分类。探测成功时对端也可能把凭据写进操作的名字、说明或参数表，这些会落库、进回包、进分享包、进模型的工具定义，`discoverTools` 发现其中有凭据（原文、百分号编码、JSON 转义三种写法）就整份不收、回 400，不去改写操作名，改了名字就调不到对端的工具。工具调用的正文是对端的业务输出。默认由控制面在返回电脑之前脱敏，本机直连时由运行器脱敏；两条路径都换掉凭据的那三种写法，别的编码不保证。base64、小写的百分号编码、凭据的片段、Unicode 转义都认不出，成功和 `isError` 的正文一样原样进模型，模型可能转述进群消息，Pi 的 session 文件也会落盘。操作元数据的检查用的是同样三种写法，操作名里放凭据的 base64 能过检查，会落库，也会进再分享包的操作名。这个范围是有意的：对端本来就持有这把凭据，想外传不必借我们的通道，脱敏防的是它无意中原样回显。

运行器会话里的 MCP 工具在建会话时就定了，运行中换授权、操作表缩减时旧会话还挂着旧工具。所以运行器的闸门和执行都按最新下发的 config 判：连接没了、不再分给这个 Bot、操作不在最新表上，或者连接待授权，闸门在审批之前就拒，不出审批卡；本机连接凭据换了，下一次调用丢掉旧 MCP 连接、带新凭据重连。代理连接的凭据更新不下发到电脑，由控制面废弃缓存并重连。

代执行端点用当前 `modelGateway.apiKey` 的 Bearer 鉴权，按电脑找到归属人，依次检查连接归属、本机限定、ready 状态、Bot 归属和分配、操作名。越权及未知对象回 404，本机限定及待授权回 409。审批仍由运行器先过闸，再转发。SDK Client 按连接缓存，修改、删除、连接或协议错误会作废；每次调用还比较连接与凭据指纹，覆盖未显式作废缓存的写入路径。业务 `isError` 和单次调用取消或超时保留共享 Client。作废后新调用重连，旧 Client 等已有调用各自结束、在途计数归零才关闭。初始化使用连接自己的 60 秒超时信号，不受首个调用取消影响；每个 HTTP 调用从等待初始化开始共用 60 秒上限，超时回 504。调用方取消、超时和结果超限都会中止该调用自己的上游 POST，不关闭其他调用的连接。POST 的响应流断开或正常结束但没有对应 JSON-RPC 回包时，该调用立即回固定分类 502，共享 Client 和其他调用仍可使用。流拿到 SDK 的续传 token 后先交给 SDK 带 Last-Event-ID 续传；每次续传重置 token 标记，续传失败或再次 EOF 且没有新 token 时仍快速失败。POST 回 202、等待 GET 回包的调用，在 GET 断流时同样立即失败；仍通过健康 POST 等结果的调用继续收尾。GET 的读取错误按 SDK 的连接级错误作废缓存，正常 EOF 保留 SDK 的重连行为。控制面停机关闭该实例的全部连接（包括已作废仍在途的连接），之后拒绝新调用；HTTP 服务器关闭失败也执行 MCP 清理。

请求体上限 20 MiB，超限回中文 413。自定义 transport fetch 在 SDK 解析前按原始响应字节限长：POST 按单条响应累计，GET 长连接按每个 SSE 事件累计；超过 20 MiB 就取消读取，上游 POST 关闭，回固定中文 502「插件结果超过 20 MiB 上限」。GET 事件超限时因尚无可用的结果 id，会终止该 Client 的所有在途调用并作废缓存；等待该 GET 回包的调用收到超限文案，被连带取消的 POST 调用收到「插件调用失败：这个地址连不上」。GET 和 POST 的媒体类型比较都忽略大小写和参数。完整结果和脱敏后的响应仍各检查一次 20 MiB，不转发超限结果。连接/协议错误只回 `describeMcpFailure` 的固定中文分类，错误对象及凭据不进日志；成功和业务错误内容都经 `redactCredential` 后才回电脑。网关 key 每次 hello 会轮换，运行器在每次调用现取最新 key，轮换不重建工具。升级 SDK 后整文件跑 `mcp-proxy.test.ts`，断流判定依赖 `onmessage` 和 EOF 之间不跨宏任务。

## 命令行工具

用户登记的是一个第三方命令行工具，不是一组环境变量：命令名（如 `grok`）、可选的装包（`npm` 或 `pip` 加包名）、它要的几个键和值、在哪种电脑上（本机、云电脑）、给哪些 Bot（`bots: null` 是全部）。表是 `cli_tools`、`cli_tool_env`、`cli_tool_bots`，同一用户下命令名唯一，重复登记由唯一索引挡下、回 409；删 Bot 时分配由外键级联清掉。

### 密钥绑命令

键只属于登记它的那个命令。运行器只在整条 bash 就是这个工具（可以接只读过滤）时才把它的键并进进程环境，别的命令拿不到；`echo $GROK_API_KEY` 是空的。装包脚本也不带用户的键。

### 为什么不做全局环境变量

同一个沙箱里，拿到值的进程想读就能读，挡不住；真正的边界是「谁拿得到值」和「谁能联网」。全局环境变量让每条 bash 都拿到值，一句 `echo` 就把密钥打进模型上下文和工作记录。绑在命令上，拿到值的只有用户点名信任的那个工具，而且它要的联网也跟着这个登记走，用户心里想的本来就是「给 grok 配个 key」。

### 值只进不出

值进来就用 `TOOL_SECRET_KEY` 加密成 `value_enc`，和工具连接的 `authorization_enc` 同一把钥匙、同一种格式。HTTP 的任何响应都只给变量名和明文末四位 `last4`，值不足 8 位时 `last4` 是空串，免得四位就露出大半个值。改值走 `PATCH` 的 `set`，空着不发就是不改；`set` 和 `remove` 撞同一个名字回 400，一个工具最多 10 个变量，按合并后的结果算，超了整次改动回滚。解密只发生在拼 `config` 的时候：`config.cliTools` 恒带，空也带空数组，只含登记了这台电脑种类的工具，值是明文，运行器照 skills 整份对账。增删改之后都向该用户在线电脑重发整份 `config`。

## 群与主题任务

每个群恰好一张主题任务卡。单 Bot 群在建 Bot 时自动建出来，多 Bot 群走 `POST /api/groups`，一次拉 2 到 6 个 Bot。编号是 `T-` 加四位，从 `user_counters.next_task_number` 取一个再把它加一，建 Bot 和建群共用这一个计数器，所以同一个用户的编号不会撞。`GET /api/groups` 只列成员数大于一的群，单 Bot 群在 `/api/bots` 里跟着它的 Bot 走。每一项带 `poker`，说这个群有没有 `poker_tables` 行，Web 只对它为真的群去拉牌桌视图，普通项目页不再靠打一次牌桌接口吃 404 来认。`Group.kind` 是 `solo` 还是 `team` 只看 `groups.solo_bot_id` 是否非空，`repo/rows.ts` 的 `toGroup` 是唯一出处；团队群删到只剩一个成员仍是 `team`，Web 入列按这个字段，不按成员数和首席猜。

### 路由规则

| 群                                     | 这条消息的目标                         |
| -------------------------------------- | -------------------------------------- |
| 单 Bot 群                              | 恒为它，@ 了谁、上一句谁经手都改变不了 |
| 多 Bot 群，正文 @ 了人                 | 被 @ 的那些，按正文首次出现顺序去重    |
| 多 Bot 群，没 @ 人、有首席             | 只派首席                               |
| 多 Bot 群，没 @ 人、没首席、有当前经手 | 只派当前经手                           |
| 多 Bot 群，没 @ 人、没首席也没当前经手 | 全员按成员表顺序轮流说                 |

`@所有人` 派给全员，顺序按成员表。首席是群属性，可以由 Bot 调用 `set_chief` 设置或卸任；首席优先于当前经手。Bot 没有话要说时以 `(pass)` 或 `（pass）` 开头回复，控制面不落这条消息，也不推给 Web。运行器每个文字块报一条消息，`(pass)` 按块判断：一个 run 只要有一块可见的话就不算 pass，花费卡照留，后面那块 `(pass)` 本身仍不显示；整个 run 没有可见块才算 pass，花费并进这一轮。

例行任务写进群里的那条 user 消息不走这张表，只派给例行所属的 Bot，原因是 `prompt.reason` 记 `mentioned`，见「例行任务」。

同一条用户消息只让一个 Bot 运行。当前 Bot 的 `run_done` 到达后才派下一位；一轮里 Bot @ 了人，就按正文顺序进入下一轮。回合里「这一位」有三种状态：`idle` 空档，`sending` 已从队列里取出、派活报文还没回来，`running` 带 runId 在跑。带 runId 的上行报文只对 `running` 核，`sending` 这段里没有 runId 能对上。轮到的那位在这之前被删了（比如「@A @B @C」里 B 在 A 跑的时候被删），`sendSpeaker` 回 `skipped`，回合跳过它接着派 C，不关轮；选不到电脑或发不出去回 `stopped`，群里已经留了一句，后面的人同样派不出去，关轮。派活抛了错（比如建 run 的事务失败），回合收掉，群里留一句「派给 X 的活没发出去，@ 它再试一次」，`run_done` 照常确认；不靠代理补发 `run_done` 来重推，回合已经收掉，补发会继续结账并尝试推进，但不会重建已收掉的回合。`DELETE /api/bots/:id` 提交后调 `groupTurns.botDeleted`：正在说话的那位被删了，它的 `run_done` 过不了 `resolveRun`，当它说完，轮下一位，没人了就收轮；正在派活途中的只打标记，派活回来按跳过处理，不把已删的它设成这一位（它的 prompt 可能已经发出去，运行器那边随 config 换掉它）；排在后面的从队列里清掉，连同它交出去的交接，卡已随它级联删掉，派出去接手方也接不了。`start` 回 `nobody` 表示被 @ 的人全在派活途中被删、一个都没派出去，`dispatchUserMessage` 就用新鲜名单不认 @ 再路由一次，只退到首席或经手，不替用户扩到全员（刚建的群里 @ 的那位被删了，剩下的人不该平白接到活），仍没人就在群里留一句「@ 一个 Bot 派活」，POST 仍回 201。群本身没了是另一回事：单聊随 Bot 级联删掉后，`placeRun` 查不到成员，`sendSpeaker` 看群行还在不在，在就是 `skipped`，不在就是 `gone`，回合收掉、`start` 回 `gone`，`dispatchUserMessage` 不再往消失的群里写任何提示，POST 仍回 201；名单读出来是空的也按同一条分：多 Bot 群被删空、群行还在才留话。Bot 消息累计到 10 条时停止，并在群里留一句提示。运行器每个文字块报一条消息，一个 run 的正文不管分成几块只算一条；`mention` 工具每 @ 一次算一条，交接也算一条，回路守卫靠这两样。

### `@名` 在写入前解析

`POST /api/groups/:id/messages` 在 `appendMessage` 之前按群成员名解析一遍正文，结果存进 `body.mentions`。派活只看它，不重新解析正文。名字长的先试，所以「@小销售」不会先命中成员「小销」；名字后面必须是空白或行尾。单 Bot 群不解析，`parseMentions` 在成员数小于二时直接返回空。Bot 的正文在每块 `done` 时按同一套规则解析，运行器每个文字块报一条消息，所以工具之后那块里的 @ 也会派活；以前一个 run 的正文堆在第一条里，工具之后追加的 @ 不解析，Bot @ 了队友却派不到。

用户 @ 谁，谁就成为当前经手：`tasks.current_bot_id` 换人，`handled` 里上一位补上 `to`，新一位追加一条。多 @ 按正文顺序，第一个成为经手。这一段在事务里对那一行加行锁，不加的话两条并发消息会互相覆盖掉一条经手记录。Bot 之间 @ 不改经手，接力是 Bot 之间的事，不是用户交出去的。

### 多目标派活

每个目标各起一个 run、各发一条 prompt。多 Bot 群的 prompt 带完整任务卡和全体成员名单，Bot 靠名单知道能 @ 谁，名单在派每一位时重读，同一回合里前面有人被删，后面那位的名单里没有它；单 Bot 群 `task` 为 null。`messageId` 是触发这次 prompt 的那条群消息：用户发的、Bot @ 队友的那条、交接卡、例行写进群里的那条用户消息。上下文按收件人分别生成：收件人看自己只有名字，看别人是「名 · tag」，看已经删了的 Bot 是「别的 Bot」。任务卡不进上下文，它走 `task` 字段。

上下文里的卡写成一句结论，不是一个 id。审批、交接、草稿、内容计划的状态住在各自的行上，这批上下文涉及的每种卡各用一条查询查完，写成「小服要执行 `pay 100`，你批准了」「小服把活交给阿文，下一步是「…」，阿文接了」这样；草稿批了以后写「等着发」还是「留着没发」看账号现在的档位，有草稿卡时多查一次账号表。skill 卡和方案卡的状态就在正文里，照正文写。卡指的行查不到就不写这一条。卡的状态变了消息 id 不变，靠 `settled` 让运行器再拼一次，见下一段。

每行上下文带 `settled`，说的是这一行的字还会不会变。Bot 消息 `streaming` 为 true 时是 false。运行器每个文字块一条消息，`text_end` 之后那条不再长，所以 `streaming` 就是「这条还会长」。卡按状态定，每种一张表写在 `dispatch.ts`，加状态时编译器逼着表态：

| 卡       | 还会变（`settled: false`）                            | 不再变                          |
| -------- | ----------------------------------------------------- | ------------------------------- |
| 审批     | `pending`                                             | `approved` `rejected` `expired` |
| 交接     | `pending`                                             | `accepted`                      |
| 草稿     | `pending` `approved` `publishing` `returned` `failed` | `published`                     |
| 内容计划 | `pending`                                             | `approved` `returned`           |
| skill 卡 | `offered`                                             | `saved` `dismissed`             |
| 方案卡   | `offered`                                             | `started` `dismissed`           |

草稿发出去之前都算还会变：批了的会发，没开自动发的账号改了档字也跟着变；退回的和没发出去的 Bot 还能改了再交，改完回到待看。用户消息、system、工具行一律 true，工具行的状态会变但写出来的字不含状态。状态一变字就变，运行器的水位把这一行当半截记着，字变了再拼一次整句，所以批之前 Bot 看到「还在等你点头」，批了以后下一轮看到「你批准了」。拼法见 bot-runner README 的「prompt 拼法」。run 收尾时这个 Bot 在这个群里还停在 `streaming: true` 的文字一并收成 false，同一个 Bot 在这个群里还有别的 run 开着时这次不收，留给最后结束的那条（见「run 收尾」），收尾之后它就是定稿；早先断掉的旧半截要等这个 Bot 下次在这个群里收尾才收掉，在那之前 `settled` 一直是 false，运行器靠「字没变不重拼」挡住重复。没定稿的卡每轮都标 false 送过去，也是靠这一条只拼一次。报文里 `settled` 缺省为 true，控制面和电脑代理升级不分先后：旧控制面不发这个字段，新代理把行都当定稿，退回升级前的拼法，不会因为 parse 不过把整条 prompt 丢掉；新控制面配旧代理，多出来的字段被 zod 丢掉，照旧工作。

窗口是最近 20 条，前面再接上这个 Bot 上一次派活时没定稿、这次滑出窗口的行，最多 10 条（`CONTEXT_CATCHUP`），留最新的。不接的话，小采说到一半、用户连发 25 条，小采说完时那条已经不在窗口里，别的 Bot 永远看不到整句；卡滑出窗口以后才被批、被接，草稿滑出窗口以后才被批或退回，也一样看不到。派活建完 run 就把这次上下文里 `settled: false` 的行（窗口里的和接上的都算）的 id 记到这个 run 的 `unsettled_context` 列，但这份名单要等运行器在 `run_done` 里报这次触发进了 Pi 会话（`prompt: "entered"`）、`context_confirmed_at` 记上时刻才作数。派活时还把这次上下文里 `settled: true` 的行的 id 记到 `settled_context`，同样等确认才作数。下一次给同一个 Bot 在同一个群派活，候选是最近确认的 20 份名单（`CONFIRMED_RUNS_CONSIDERED`，按 `context_confirmed_at` 往回数，同一时刻的再按 `started_at`）的 `unsettled_context` 并起来、减掉这些 run 里任何一次 `settled_context` 里有的行、再去掉这次窗口里的，代码在 `repo/context-window.ts`。不挑「最新的一份」名单：各 run 读到的消息集合互不包含，按 `started_at`、按触发消息的 `seq`、按那次读到的最大 `seq` 挑，三种近似各错一种情形。`http/app.ts` 的消息路由里落库、加 skill 用量、派活没有串行化，相邻两条消息派活交错时，前一条的 run 可能建得更晚，按 `started_at` 取就拿到基于更旧消息的名单；多 Bot 群一回合里排在后面的 speaker（上一回合推迟过来的交接）触发消息更早、窗口取的却是最近 20 条，按触发消息的 `seq` 取就拿到被 @ 那次更旧的名单；三个 run 交错时（触发最早的那次靠接着送读到了卡，中间那次在窗口里读到了卡，触发最晚的那次窗口里全是闲聊、派活时又还没有名单可接），按读到的最大 `seq` 取就拿到最晚那份空名单。哪一种都把别的名单里没定稿的卡从此踢出候选，批了以后结论永远送不到（`test/context.test.ts` 用锁住 skill 行复现交错和三 run 组合，用先 @ 再交接复现延后的交接）。并集只看最近确认的 20 份名单不是为了挑名单，是为了收住增长。往回数按确认时刻，不按建 run 的时刻：一份名单的寿命从它被确认算起。派活建完 run、记完名单到 prompt 送出去之间可能隔一阵（主助理送之前还要读项目清单），这期间别的 run 已经建了又确认了，按 `started_at` 数，这份名单刚确认就落在 20 份之外，它记下的卡从此没人接，批了以后结论永远送不到（`test/context.test.ts` 扣住一次项目清单的读复现这个延后）。按确认时刻数，每份名单都能撑过后面 20 次确认；没定稿的行每次派活都接着送、接着记，所以它一直在最近几份名单里；超出 `CONTEXT_CATCHUP` 上限不再送的行，过 20 次确认以后就不再占候选。减法不看先后：定稿是终态，哪次读到过定稿的字，模型就看过结论了。「终态」靠两条约定成立，控制面自己不强制：各种卡的状态只从待定走到结论、不回头（审批、交接、skill、草稿、计划、方案卡的写入口都只改待定态的行）；现在的运行器每个文字块用新的 messageId，发过 `done` 的 id 不再接着流，而 `appendBotText` 本身不拦同一个 id 从 `streaming: false` 再改回 true。今后若允许正文修订或 id 复用，减法和运行器的水位要一起改，否则改过的整句既不再送、水位也认不出它变了。迁移前的 run `settled_context` 是 null，当空。prompt 没发出去（电脑不在线）、电脑报错带着 runId 被收尾（`abandonRun`）、运行器报 `prompt: "dropped"`、还在跑没回 `run_done` 的 run 都不确认：它们的名单里已经没有这一轮刚定稿的结论，可模型没读到，照它接就永远丢了这条结论，所以接着用更早那份确认过的名单，结论下一次再送。接上的行不看现在定没定稿，照现在的状态写一句、标现在的 `settled`。还没定稿的这一轮又被记下，一轮轮带下去：字没变，运行器的水位挡掉；字变了（比如草稿从「还在等你看」变成「你批准了，留着没发」），运行器就再拼一次。定稿那一轮整句再拼一次，之后它不在没定稿名单里，也就不再送。没定稿的行每轮都占名额，永远停在 `streaming: true` 的消息、一直没发出去的草稿会一直带着，所以要上限，超出的最老几条从此不再送。没在这个群派过活的 Bot 什么都不接。

比过三个做法。第一版重算上一次窗口：按这个 Bot 上一个 run 的 `started_at` 取那一刻最近的 21 条，补其中现在已定稿的。它不加表，但控制面不知道上一次哪条没定稿，只敢补定稿的，草稿从待看变成批了没发这种非终态之间的变化就补不上；它也只认最后一个窗口，待批卡滑出窗口后隔了一次派活才批，就再也补不上。复核实测出这两处漏送，换成了现在的做法。另一个做法是运行器把水位里没定稿的 id 报上来，同样准，但要在 `packages/shared` 加上行字段。现在的做法只在 `runs` 上加三列，不改报文。控制面记的是「这次派活算出的上下文里哪些行没定稿」，派活时就记，等这个 run 的 `run_done` 收下才拿来用；运行器水位记的是「这个会话看过哪些字」。前者决定下一次送哪些行，后者决定送到的行拼不拼。两边不是同一份事实，不用对齐。

确认权在运行器：`run_done` 的 `prompt` 字段说这次触发进没进 Pi 会话，`entered` 是运行器在这次 run 里见到了触发那条 user 消息的 `message_end`（Pi 的 Agent 先把它 push 进会话状态再通知订阅者），`dropped` 是没见到就收尾了（停机、Bot 被删、还没有能用的 config、建会话失败、Pi 的 `prompt()` 在消息进会话之前抛，比如没选模型、鉴权失败、正在压缩、已经在跑、Agent 被别的回合占住），只有 `entered` 才 `confirmContext`。运行器建会话时关掉了外来的 Pi 扩展（`noExtensions`），只留白泽注入的那个，所以没有扩展能在消息进会话之前另起回合或把输入拦下；依据和用例见 bot-runner README「群聊上下文」一段。进了会话不等于模型这次读到了（进了之后模型请求可以失败），但消息已经在会话历史里，下一次成功的回合会读到，不用再送。旧运行器不带这个字段，控制面按 `entered` 算，和它升级前一样「收下就确认」，等于保留它原来那个小漏洞，换成「不带就不确认」会让旧运行器每一次派活都不推进名单，常见路径反而退化；新运行器配旧控制面，多出来的字段被 zod 丢掉，照旧工作。运行器在调 `session.prompt` 之前就失败（建会话、`usePurpose`、拼 prompt）时报的 `runner_failed` 仍带这次的 runId，控制面照带 runId 的错走 `abandonRun` 把 run 立刻收尾、不确认，之后补来的零用量 `run_done` 撞上 `ended_at IS NULL` 落空；多 Bot 群这一回合也跟着关掉，不再轮到后面的 Bot，和其他带 runId 的错一样。

剩下的限制。上一次 run 还没回 `run_done` 时又派活，用的是更早那份确认过的名单，前一次已经送过的结论这一次会再送一遍，字没变的由运行器水位挡掉；两次派活交错时同一行也可能被当新行再拼一次，同样靠水位挡。取名单按确认时刻倒序取这个 Bot 在这个群确认过的 run 前 20 个，走部分索引 `runs_context_confirmed_idx`（群、Bot、`context_confirmed_at`、`started_at`，只含确认过的行），取够 20 条就停，不扫全群的 run；生产规模没量过。一次派活接着送了定稿的结论、它的 `run_done` 还没回来时又派活，这一次会再送一遍，字没变靠水位挡掉；只多不少。运行器那边触发没进会话就不记水位（`bot-runner/src/index.ts` 的 `runOne`），下一次这批行会再拼一遍，这一侧只会重复，不会漏。会话目录清空或者水位认不出时，运行器整批全拼，接上的这几条也跟着多拼一次。

### 派到哪台电脑

一个用户最多两台电脑，本机和远程。规则是 `agent/computer-selection.ts` 的纯函数 `selectComputer`，输入是这次要碰的账号和候选电脑，每台候选电脑可以带上挂在它上面的账号，在线看 `AgentHub` 此刻有没有这台的连接，而且这条连接 hello 的那份 `config` 已经发出。握手到 `config` 之间还要对账、查库，这段时间里派的 prompt 会比 `config` 先到，新起的代理还没有运行器，只能回 `prompt_before_config` 丢掉它，所以这段时间按不在线算。代理解析不了 config（多半是两边版本对不上）会回 `agent_error` `config_rejected`，detail 写校验不过的字段路径；控制面把这条连接记成被拒，按不在线算，推一条 stuck「电脑代理和控制面版本对不上，配置被拒」，被拒期间代理回的 `prompt_before_config` 也按这个原因收尾。代理每收下一条 config 回 `config_applied`，控制面收到才恢复派活。hello 那条 config 发出去就算在线不变，不回 `config_applied` 也照常能派。config 带每条连接单调递增的 `generation`：`AgentHub` 在开始读快照时就领号，并发的两次重发先领号的号小，但后领号的那条可能先发出去，代理丢掉比已应用代际小的 config，不回执；`config_applied` 和 `config_rejected` 都带同一个代际，控制面只认最后发出那一代的 `config_applied`，被拒之后又发过一代的话，早先那一代晚到的回执不能把它提前恢复成在线。拒收也只认最后发出那一代：带代际的拒收代际对不上就忽略；不带代际的拒收只在这条连接还没收到过带代际的回执时才认，收到过之后它不可能说的是当前这一代。被忽略的拒收没有任何副作用，不改连接状态，不记拒收警告，不推 stuck，所以也不会占掉这段在线期唯一那条 stuck，之后当前代际真被拒照样推（`test/config-generation.test.ts` 钉着）。不兼容旧代理的回执：基底那版代理回的 `config_applied` 不带代际，新协议 parse 不过，整条丢掉，被拒之后靠它恢复不了。控制面和电脑代理按同一个版本一起升，第一版只有自用，不写兼容分支。被拒期间用户再发消息，群里那句说的是「电脑上的白泽版本和控制面对不上，这条没派出去，把电脑上的白泽升级或重启后再说一次」，不是「电脑不在线」。代理的 `agent_error` 带了 `runId` 就是说那个 run 不会再有 `run_done`，控制面按断线收尾同一套替它收尾：run 结束、挂着的审批过期、还在跑的工具行记失败、还在流的文字收成定稿、群里一句、例行记失败。收尾找的是库里这台电脑还开着的 run，群按库里 run 的群，报文里的群号不作数；找不到（别的电脑的 run、已经收过尾的重报）不收尾，只打一行 `console.error`。它和新连接 hello 的对账排在同一台电脑的链上，先到的整个做完（事务提交）另一个才开始读 run，所以不会两边同时读到同一个还开着的 run：旧连接的报错收尾先做完，新 hello 对账时那个 run 已经结束，群里只有收尾那一句（`test/reconnect.test.ts` 扣住收尾的第一次读、排进新 hello 再放开，钉着这个先后）。`finishRun` 的 `WHERE ended_at IS NULL` 仍然在，挡的是 HTTP 路径和别的进程并发结束同一个 run。`dispatchUserMessage` 选一次，头一个 speaker 就派到这台，不再重选：重选的话两次之间掉线，头一个就不建 run 派空了，调用方却已经拿到 `sent`，例行会一直停在运行中。同一回合后面的 speaker 要等前一个跑完才派，那时各自再选。

| 这次要碰的账号 | 派到                                                   |
| -------------- | ------------------------------------------------------ |
| 不碰账号       | 本机在线派本机，否则远程在线派远程，都不在线就派不出去 |
| 碰账号         | 账号所在的那台；那台离线就派不出去，不改派到另一台     |

**群里选过电脑就只认那一台。** `group_members.computer_kind` 存每个 (Bot, 群) 选的电脑种类。它为 null 表示没选过，按上表派。选过的话，`selectAvailable` 只看那一种电脑：能派就派过去；派不过去报 `chosen_local_offline` 或 `chosen_remote_offline`，不落到另一台；那台连着但拒了 config，照旧报 `config_rejected`。选择跟着 (Bot, 群) 走，所以同一个 Bot 在别的群里照旧本机优先；牌桌换人时，换上来的牌友不继承前一个的选择。

「能派」只在 `agent/computer-availability.ts` 的 `computerAvailability` 一处定义：连着且 config 已收下，或者刚断开、还在宽限期里，并且库里的租约没过期。`GET /api/computers` 和 `computer_updated` 推送里的 `dispatchable` 也由它算。

选择只有一个写者，`agent/computer-choice.ts` 的 `chooseComputer`：

- 用户经 `PUT /api/groups/:groupId/bots/:botId/computer` 选的时候，目标可以不在线，因为出门前先把 Bot 放到云上是合理的。
- Bot 自己换的时候，目标必须当下能派。
- 同一个值再选一次，会被 `IS DISTINCT FROM` 条件挡成空 UPDATE，不推送，也不在群里留话。

`dispatchUserMessage` 那唯一一次选电脑放在路由之后，按头一个 speaker 在这个群里的选择来选。

**Bot 自己换电脑：这一轮到此为止，换好后在另一台接着做。** 运行器的 `switch_computer` 工具打 `POST /hub/v1/lane/computer`，网关 key 认电脑，道头认这条道，body 是 `SwitchComputerRequest`（这一轮的 runId 和目标 kind）。`agent/continuation.ts` 的 `requestSwitch` 在一个事务里核对 run 是这台电脑上、这条道上、还没结束的普通 run（牌桌 run、别人的 run、结束了的都回 `not_current_run`），再经 `chooseComputer` 改选择并把 `runs.continue_requested` 立起来；拒绝的六种原因和文案在 `SWITCH_REFUSED`，原样回给模型当工具错误；例行 run 的运行记录已经记成 `failed` 的回 `routine_failed`（理由见「例行任务」的「运行记录」），目标不在线回 `target_offline`，选择不改，这一轮继续在当前这台上做，绝不默默落回。道的栅栏不过回 409 `LANE_FENCE_ERRORS`。`runs.continue_requested` 只有这个文件写；`runs.continues_run_id` 只在接续落行时写，`agent/place-run.ts` 的 `placeRun` 在同一个事务里先用这个文件的 `takeContinuation` 认领标记，认领到了才带着它落新 run。

接续是一条新 run：旧 run 收尾（`run_done`、断线或报错收尾都算）之后，`dispatch.ts` 的 `resumeContinuation` 读 `pendingContinuation`，以 `reason: "continuation"` 的 speaker 进群回合。它的 prompt 只有一句「刚才你请求换电脑，现在已经换到<目标那台>上了……」（`continuationText`，目标是云电脑或主人的电脑），`context`、`members` 为空，`task` 为 null，`origin` 沿用旧 run 的，因为模型的会话会从工作记录重建，群历史和任务卡都已经在里面。`continue_requested` 立着的意思是「还欠一条没起的接续」：起接续的事务在落新 run 之前用 `UPDATE ... WHERE continue_requested` 把它认领成 false（`takeContinuation`），认领不到就不建，所以旧 run 收尾和 hello 补扫并发也只起一条；新 run 的 `continues_run_id` 指回旧 run，`runs_continues_run_idx` 唯一。已经换过一次的 run 再换回 `already_continued`。多 Bot 群里接续插在回合队首，不计入 `BOT_MESSAGE_LIMIT`。接续的用途、例行和边界只取自它自己的父链（speaker 上的 `continuation.routine`、落行时 `takeContinuation` 认领回来的 `routine_run_id`），排进别人的回合也不沿用那个回合的配置：父链没挂例行就是普通 run，不回退成回合发起者的例行记录。用户在这个群里又说了话、删 Bot 取消道、接续派不出去（目标在这期间掉线，群里那句 `selectionNotice` 改说「刚才换电脑后要接着做的活没派出去」）、执行它的 Bot 已经不在群里（牌桌换牌友）、落新 run 的事务失败，都清掉标记，不再自动接着做。例行任务派起的 run 换电脑，接续沿用旧 run 的 `routine_run_id`，算同一次触发，运行记录怎么收尾见「例行任务」的「运行记录」。推进接续的触发点（结账、放弃、回合排队）都在内存里，丢了一次库里就留下一条标记立着、已经结束、没有接续的 run：控制面在结账提交后没了，结账后读接续的查询出错，排进别人回合的接续随那个回合被放弃一起收掉，都是这样。所以 `resumePendingContinuations` 除了在控制面启动和目标那种电脑 hello 时跑，`server.ts` 还每 30 秒（`CONTINUATION_SWEEP_INTERVAL_MS`，和例行调度同一个节奏）补扫一轮，内存里的遗漏最多晚一个周期接着做。每轮先按 `runs_continue_requested_idx`（`WHERE continue_requested` 的部分索引，立着标记的行任何时候都只有几条）取出 id，再一条条读、一条条起，一条出错只记日志，不挡后面的。补扫和别的触发点同时捡到同一条，靠 `takeContinuation` 的条件认领和 `runs_continues_run_idx` 只落一条；`startContinuation` 在开回合前的最后一刻再排一次队，同一条接续不会开出第二个回合把前一个顶掉。上一轮没扫完，下一轮等它扫完再开始。停机之后新进入的自动断链不执行：`AgentHub.closing` 一立起，再走到 `endChain` 的直接返回，派不出去的接续也不在群里说「没派出去」，因为这时派不出去、读库出错多半只是停机关掉了连接；标记留着，重启后的补扫接着做。标记立起之前已经进了断链事务的照常提交，不在事务里撤回。`server.close` 在第一次等待之前就调 `agents.closeAll()`，停机标记同步立起，然后才等网页的关闭握手和在途的补扫。启动时的那次扫描在还没有任何电脑连上时什么也派不出去，不算失败；目标那台一直派不出去的，补扫每轮都跳过它，不收尾。执行它的 Bot 已经不在群里的（选择读出来是 null）不等电脑，补扫遇到就当场断链收尾。接续是一条独立的 run，用量页和项目页上各算各的。

**这一版派活不要求账号，候选电脑也不带账号。** `dispatch.ts` 的 `computerFor` 给 `selectComputer` 传的要求账号和每台电脑的账号都是空数组，实际走的是上表第一行。没有哪张表把群、例行或 Bot 绑到账号上，能从数据里算出来的只有群里草稿用过的账号。拿它来算不对：起草只要 `config.accounts` 里有这个账号，哪台电脑都能起，真发由发布循环按账号所在的电脑去发，不走派活。按草稿账号算的话，小红书项目的「排本周计划」会被钉在本机，合上 Mac 就不跑；主助理单聊里草稿跨了两台电脑的账号，就再也派不出去。例行任务也不加账号字段：例行只是归属人发的一句话，例行和 Bot 在派出去之前都不知道这一轮会碰哪个账号，填了也只能靠猜。眼下真正碰账号的动作只有发布草稿，它按 `accounts.computer_id` 下发，账号过期的隔离也落在发布上，见「账号」一节。

**要求账号的数据接上时，连同 HTTP 用例一起加。** 那时要做两件事：给候选电脑接上 `accounts.computer_id` 对应的账号，再把这次要碰的账号传进来。只接前一件的话，没有任何 HTTP 用例看得出它断没断；只接后一件而前一件是断的，每次碰账号都会返回 `required_account_not_found`，群里说「要用的账号已经不在账号页里」，账号其实还在。所以接线和一条走 HTTP 的「碰本机账号的活本机离线时不改派」用例同一单加。

派不出去时不建 run，群里落一句 `tone: "error"` 的 system，每种原因一句，写在 `SELECTION_FAILURE`。有两台电脑而都不在线时单说一句，让人看得出不是只有一台：

| 原因                             | 群里那句                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `no_computer_online`             | 电脑不在线，这条没派出去，电脑回来后再说一次                                         |
| `all_computers_offline`          | 你的电脑都不在线，这条没派出去，有一台回来后再说一次                                 |
| `required_account_not_found`     | 要用的账号已经不在账号页里，这条没派出去，把账号挂上后再说一次                       |
| `accounts_on_multiple_computers` | 要用的账号分在两台电脑上，这条没派出去，拆成两句，每句只碰一台电脑上的账号           |
| `required_computer_offline`      | 要用的账号所在的那台电脑不在线，这条没派出去，也不会改派到另一台，那台回来后再说一次 |
| `chosen_local_offline`           | 这个 Bot 在这个群里选了用你的电脑，你的电脑现在不在线，这条没派出去，也不会改派到云电脑，电脑回来后再说一次，或在群顶部改用云电脑 |
| `chosen_remote_offline`          | 这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，这条没派出去，也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑 |

### 上行 `task_checklist` 和 `mention`

`task_checklist` 整份替换清单，同一份重发两遍结果不变。库里每项多存一个 `doneAt`（勾选时刻），只供项目页数本周勾掉几项，`toTask` 不往外带，`ChecklistItem` 和协议都不变。它不收外面给的：运行器和 Web 的 `PATCH /api/tasks/:id` 都是整份替换，`stampedChecklist` 在写库那条语句里按文字从旧清单接，同一段文字原来就勾着的沿用原来的时刻，新勾上的记库时钟，没勾的清成 null。按文字不按下标，是因为整份替换时插一条、删一条下标就全错位。0018 给迁移前的清单项补上 `doneAt: null`，那些勾选不知道是哪天的，不算进任何一周。群里不另落一句「更新了清单」：进度在任务卡上，`task_updated` 已经推新了，Bot 一轮里每勾一项落一句会把它的回答切碎。清单里每条的 `ownerBotId` 控制面再校一次，必须是 null 或这个群的成员，有一条不是就整条丢掉不落库。运行器那边只能对着这次 prompt 带去的名单把名字解析成 id，比不出群的真实成员表，所以这一道不能省。

`mention` 的目标必须是这个群的成员且不是它自己。消息先落库再判限额：那句话 Bot 确实说了，用户该看见，停下的只是派活。两条用户消息之间，Bot 发起的 @ 最多派 10 次，越线的第一条在群里留一句「Bot 之间 @ 太多次，停下等你」，之后的只是不派。计数在内存里，进程重启归零，用户一说话就归零。

### 上行报文的 runId 归属

带 runId 的上行报文（`bot_text`、`bot_tool_call`、`run_done`、`approval_request`、`task_checklist`、`mention`）都过同一道校验：群要是这台电脑主人的，run 要是报文里那个 Bot 在那个群里的活。外键只保证 runId 存在，管不了它指到哪个群，不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。任一不成立整条丢掉，丢得安静：不抛异常，不给电脑回报文，只记一条日志。

### run 收尾

run 在三处结束：`run_done`、断线收尾（重连 hello 的 `activeRuns` 里没有它，或宽限到期）、带 runId 的 `agent_error`，后两处走同一个 `abandonRun`。结束的那个事务里一起做完：`finishRun` 写 `ended_at`；挂着的审批过期（只有 `abandonRun`，`run_done` 时运行器已经不在等）；还在 `running` 的工具行记 `failed`；还在流的 Bot 文字收成 `streaming: false`。收掉的文字沿用流式那条推送，推一条 `delta` 为空、`done: true` 的 `message_delta`，Web 照常把它收尾，不加新的推送种类。已经 `done` 的文字块不再推。

消息表没有 run 列，Bot 文字的正文里也没有 runId，收尾只能按「这个群里这个 Bot 还在流的文字」找。同一个群里另一个 Bot 的 run（插话派出去的）不受影响。同一个 Bot 却不一定只有这一条 run：本机掉线后下一条派到远程电脑，或另一台控制面上同 Bot 同群的 run 还开着，这时按 Bot 找会把那条 run 还在长的文字一起收掉。所以收文字的 UPDATE 带一个条件：这个 Bot 在这个群里除了正在收尾的这条，没有别的 `ended_at IS NULL` 的 run；有就整条跳过，一个字不收，也不推定稿。让最后一条结束的 run 收，它按 Bot 找时会把前面跳过留下的一并收掉。

这个条件要在提交前一直成立，靠一把按 (群, Bot) 算键的事务级 advisory 锁：`run_done` 和 `abandonRun` 的事务第一句先拿它（`lockSettlement`、`lockSettlementOfRun`，`pg_advisory_xact_lock` 的两参数形式，第一参数是这块自己的命名空间常量，和仓库里别处单参数的 advisory 锁不在一个键空间），再 `finishRun`；`startRun` 也在自己的事务里先拿同一把再插 run 行。于是同 Bot 同群的两条收尾排队，后来的那条等前一条提交，之后的语句拿新快照，看得见前一条已经结束，把两条的文字一起收掉；收尾进行中也不会冒出新 run。每个收尾事务只收一条 run，只拿一把键。锁序固定是 advisory → runs → messages，run 名下的写帧不拿 advisory。在这把锁之下，`NOT EXISTS` 看见的「别的 run 已经结束」是对的，「收它没错」还依赖一条文字只属于一个 run：正常运行器每个文字块生成新的 UUID 当 messageId，成立。剩下的代价：一条 run 挂在掉线电脑上没收尾时，同 Bot 同群的定稿要等它被对账或宽限收尾，只是晚收，不会收错。没往正文里塞 runId，是因为正文 jsonb 的形状别处直接读（e2e 用例按整条正文比对），shared 和迁移也都不动。早先没收尾就断掉的半截，在这个 Bot 下次在这个群里收尾时一并收掉。

**收尾、结账和上行游标共用信封事务。** `run_done` 沿用结束行和结账的两个函数，但都在 `acceptUplinkFrame` 的外层事务里；费用卡或例行记账失败时，结束行和游标一起回滚，重试一次仍失败就只推进游标并回 `rejected invalid`。结束行前先按 id 升序锁住当前 run 和可能合账的 held run，例行 run 还先取得共享 Bot 锁和例行行锁，避免与删除、裁剪反序。`charged_at` 仍区分待结账和已结账：`claimCharge` 用 `UPDATE ... WHERE ended_at IS NOT NULL AND charged_at IS NULL RETURNING *` 认领，认领、费用卡和例行记账共用事务，重复报文不会再加金额。先记着的 pass 留到后续汇总结账；例行派起的 run 回 pass 不先记着，单落一张卡、照常结运行记录，它是那一轮第一个说话的，后面多半没有费用卡来认领它，记着的话运行记录就一直 running（例行能建在多 Bot 的项目群里）。放弃的 run 在结束时直接写 `charged_at`。提交后才推送费用卡、例行任务、回合推进和通知；推送故障只记日志，不回滚已提交的业务结果或阻挡累计确认。例行列表的实时推送丢失后仍需刷新或重新进入，通过 HTTP 读取恢复。

费用卡单落、并进汇总还是先记着，看运行器此前的文字块（`(pass)`）和回合的内存状态，这两样只在第一次结账时读，读到的结论记在 `events.ts` 的 `costBookings` 里，结账失败后补发沿用，不再并第二次；控制面重启后这份记忆没了，补发按普通回话单落一张卡。先记着的 pass 不结账：认领在同一个事务里回滚，`charged_at` 留空就是它落库的样子，金额在它自己的 run 行上，确认照回。这个群下一张费用卡在自己的结账事务里逐个 `claimCharge` 这些 pass，认领到的才把步骤和金额加进卡里，所以卡上的数字只来自库里认领成功的行。要认领哪几条在事务外定下来（本进程记着的结论，或此刻这个群先记着的 pass），事务第一句 `lockRuns` 把当前这条和它们按 id 升序 `FOR UPDATE` 锁上，之后才逐条认领，锁序见下面删 Bot 一段。

**历史欠账在 hello 时补齐。** 可靠上行不再设三次或 64 条的内存补发上限，未确认帧留在磁盘发件箱。旧版本、历史故障和先记着的 pass 仍可能留下 `ended_at` 有值、`charged_at` 为空的行，所以 hello 在重放之后调用 `settleUnchargedRuns`，沿用 `settleCharge` 认领并补齐费用卡、例行账和回合推进。还属于当前内存回合的 pass 不动，等下一张费用卡；回合已消失或控制面重启后不再记得 pass 的，单落一张卡，合计金额仍与 run 账本一致。一条补结账失败不挡上线和后面的行，日志只记错误类别（`name`，pg 错误带 `code`）以及电脑、run 的 id，不打印可能含正文或凭据的异常原文。

**迁移 0023 和部署顺序。** 迁移把已有的结束行的 `charged_at` 回填成 `ended_at`，不然老 run 的 `run_done` 晚到会再出一张卡。回填只覆盖迁移执行时已经结束的行，旧版控制面不认这一列：迁移之后还在跑的旧实例结束 run 时不写 `charged_at`，补发落到新实例上会再结一次账，多一张卡、例行 note 多缀一次。所以部署顺序固定：先停完所有旧控制面实例，再跑 0023，再起新实例，不和旧实例混跑。没写兼容代码。迁移前旧实现里已结束、费用卡没写成的历史行也会被回填成已结账，迁移不识别也不补它们。

`test/run-done-sidefx.test.ts` 钉着费用卡写入抛错后补发补出费用卡、例行记账中途失败后补发补齐且只记一次、正常 `run_done` 重复送达不重复出费用卡也不重复推进回合、先记着的 pass 由下一张卡认领、已确认的 pass 在真重启子进程后自己成一张卡且合计一致、结账后例行推送抛错只记日志且确认照回、补发放手之后的欠账在故障排除后的下一次 hello 补齐、hello 里前一条推送抛错或结账失败都不挡后一条、补结账出错的日志不带异常原文。

收尾之后这个 run 名下晚到的帧作废：不落库、不推送、不回电脑。危险的是帧已经过了 `resolveRun`、正要写，收尾这时提交了。同一个进程里这台电脑的帧和收尾排在同一条链上，排不出这种交错；挡的是多个控制面共库（滚动重启）时另一个进程里的收尾。做法是每条 run 名下的写在自己的事务里先过 `lockOpenRun`（`SELECT id FROM runs WHERE id = ? AND bot_id = ? AND group_id = ? AND ended_at IS NULL FOR SHARE`，Bot 和群是 `resolveRun` 校验过的那两个，Bot 被删、外键把 `bot_id` 置空后在途的帧也查不到行），拿不到行整条不写，`whileRunOpen` 把「开事务、过这一道、再写」包成一步。只在写的 WHERE 里带 `EXISTS (... ended_at IS NULL)` 不够：READ COMMITTED 下子查询看不见收尾还没提交的结束，插进来的行又不在收尾那几条 UPDATE 开始时的快照里。共享锁和 `finishRun` 的 UPDATE 互斥：写先拿到锁，收尾等它提交，后面打 failed、收文字的语句看得见它；收尾先拿到，写等它提交后重查，查不到行。用 `FOR SHARE` 不用 `FOR KEY SHARE`，后者和 `finishRun` 的 `FOR NO KEY UPDATE` 不冲突。锁的顺序固定是先 run 行后消息行，收尾的事务在 advisory 锁之后第一句就是 `finishRun`，不会死锁。

删 Bot 也守这个锁序。外键级联会改 run 行（`runs.bot_id`、单 Bot 群被删时的 `runs.group_id` 置空），也会改任务卡（`tasks.current_bot_id` 置空）、群（`chief_bot_id` 置空，单 Bot 群整个删掉连带它的任务、消息、审批、交接）、交接和审批（级联删）。run 名下的写先拿 run 的共享锁再碰这些行，级联反过来先碰这些行、最后才改 runs，各拿一半就是死锁，删除回 500。所以 `deleteBot` 的事务开头、碰任何别的行之前先调 `lockRunsOfBot`：先拿这个 Bot 的排他 advisory 锁（同样是两参数形式，命名空间常量和收尾锁不同，键只有 Bot），再把它的和它单 Bot 群里的、`charged_at` 还为空的 run 按 id 升序 `FOR UPDATE` 锁上（`ORDER BY id` 在 `FOR UPDATE` 之前生效，行按排好的次序逐一上锁）。锁的不只是 open run：结束了还没结账的行，`run_done` 第二阶段的结账先认领它（`claimCharge`）再改运行记录，删除的转交先把运行记录收成失败再级联置空它的 `bot_id`，只锁 open run 的话这两边又各拿一半，删除或结账报 40P01；结过账的行没人再写。多行必须排序：一张费用卡会把这个群先记着的 pass 一并认领，几行在同一个事务里；早先结账先认领当前这条、再认领 pass，而删除按扫描顺序锁，同一个 Bot 名下有几条待结账的 run 时两边各持一行互等，删除回 500。现在结账事务第一句 `lockRuns` 把要认领的几条按同样的 id 升序锁上，和删除同序，后到的一边整体排队。不靠捕获 40P01 重试。`startRun` 在收尾锁之前拿同一把的共享锁，所以删除拿到排他锁时这个 Bot 已有的 run 都已提交、`FOR UPDATE` 看得见；之后它在任何群里都建不出新 run，包括删除开始后才建、才把它拉进去的群。早先按成员表逐群拿收尾锁做不到这一点：成员表是删除开始那一刻的快照，之后新建的群里照样能生出删除没锁住的 run，那条 run 的写帧和删除的级联又各拿一半。在 Bot 锁上等到删除提交的 `startRun`，接着查 `group_members`，这个 Bot 已不在这个群里就回 null，不建 run；`sendSpeaker` 回 `skipped`，回合只跳过它，同一回合排在后面的照常派，不留 system（单聊群已随 Bot 删掉，多 Bot 群里页面已收到 `bot_deleted`）。用户发消息和例行任务两条派活路都走这里，建 run 这一步不会再撞外键失败。在途的写要么先提交、删除等它，要么等删除提交后重查，查不到自己的 run 整条不写。锁完 run 再锁这个 Bot 交出和接手的交接卡（`FOR UPDATE`）。这一步防的是别的 Bot 的写：别的 Bot 确认它交出来的活，先改交接卡、再把任务卡的经手换成自己；级联的先后由外键触发器的名字排，新建的库里先置空经手、后删交接卡，两边各拿一半就是死锁。先锁交接卡，删除的顺序就和确认一致。派活换经手和建群也会和删除撞上，两处都先锁 Bot 行再写：`setCurrentBot` 先对新经手拿 `FOR KEY SHARE`，再锁任务卡，和删除「先删 Bot 行、再级联置空经手」同序，Bot 已删就不换经手，消息照常 201；建群把查归属挪进事务并 `FOR KEY SHARE` 锁住这几行，删除先提交就回 404，否则删除等建群提交，再把它从新群里级联删掉。电脑上行的帧撞外键（比如 `set_chief` 指向刚删的 Bot）整条事务回滚，只记一行日志，连接不断，后面的帧照常；这些帧单向、不等回包，不另做处理。别的 Bot 其余的写各只碰一行级联会改的行（清单改任务卡、设首席改群、建交接和审批只插新行），排不成环。

删账号（`DELETE /api/me`，`deleteAccount`）也守这个锁序，并在它前面多一层账号级的边界。事务第一句、碰任何行之前先拿这个人的排他 advisory 锁（`lockOwner`，命名空间常量和前两把都不同，键只有用户 id）；`createBot`、`createGroup`、开项目（`decideProjectOffer` 的 start）和 `startRun` 各自的事务第一句拿同一把的共享锁。这层解决两件事。一是快照：删号枚举 Bot 拿 Bot 锁是开始那一刻的快照，之后才建的 Bot 不在里头，它的 run 建出来就成了归属人置空的孤儿；有了账号锁，删号拿到排他时，经过这把锁的事务都已提交，到删号提交前，`createBot`、`createGroup`、开项目建不出 Bot 和群，`startRun` 建不出 run：`createBot` 醒来查不到 users 行回 null、路由回 401，`startRun` 醒来查不到成员回 null。这个保证只覆盖过锁的入口。登录和 hello 补建主助理的 `ensureAssistant` 不过账号锁，删号途中可能插出一个主助理：先插进去的，删 users 等它提交再把它级联掉；删号先提交的，插入撞外键失败，hello 照常被关掉。它不和删号成环（它先插 Bot 行、后占发号器，插入时已拿着 users 的 KEY SHARE，删号的 DELETE 在级联之前就等它），但它建出的 Bot 不在删号的枚举里，建不出 run 靠的是 `startRun` 自己也过账号锁，不靠建 Bot 那一侧。开项目建队员直接调 `insertMemberBot`，不经过 `createBot`，所以开项目的事务自己也第一句拿共享锁。锁序是硬约束：任何同时要账号锁和 Bot 锁的事务，账号锁都在第一句、Bot 锁在它之后，反过来拿和删号（账号排他在前、Bot 排他在后）各拿一半就是 40P01；用例「建 run 拿着账号锁、还没拿 Bot 锁时删号」钉着 `startRun` 这一处。等到锁之后，对象可能已随账号没了，各入口都要有消失的分支：开项目的方案卡已不在时 `decideProjectOffer` 回 `gone`，路由回 404，和预查没找到卡同一个口径；派活读完成员之后触发消息随群没了，`messageSeq` 回 null，`dispatchUserMessage` 不建 run、不写提示，直接回 `no_target`。二是反序：建群先 `FOR KEY SHARE` 锁 Bot 行再占发号器，删号先删 users 行再级联到 Bot 行和发号器，两边各拿一半是死锁、删号回 500；建群先过账号锁，就要么整个排在删号前面（删号等它提交再把新群级联掉），要么排在后面（查不到 Bot 回 404）。不用 users 行锁做这层边界：run 名下的写要插带归属人外键的行（草稿、项目卡），插入隐式拿 users 的 KEY SHARE，和删号的 DELETE 各拿一半又是一个环。账号锁之后级联删掉这个人的每个 Bot，所以接着按 Bot id 升序对每个 Bot 调 `lockRunsOfBot`，再锁这些 Bot 交出和接手的交接卡，然后删本人的 runs（runs 对用户的外键是置空，账要跟人一起走），最后删 users 让其余的表级联。多把排他锁按 id 升序拿，两次删号、删号和删 Bot 不会各拿一半。在 Bot 锁上等到删号提交的 `startRun` 和删 Bot 时一样，查 `group_members` 查不到就回 null，单聊群随 Bot 没了，`sendSpeaker` 回 `gone`；先一步建好 run 的派活，删号等它提交再把这条 run 一起删掉，之后删号断开代理，派活发不出 prompt，这时群已随账号没了，同样回 `gone`，不往群里写「电脑不在线」。派活失败时留给人看的 system 提示（没人接、选不到电脑、发不出 prompt）都走 `appendMessageIfGroupAlive`：同一个事务里先对群行拿 `FOR KEY SHARE` 再插消息，群刚随 Bot 或账号删掉就查不到行、一个字不写，不会先查后写两个事务之间被删掉再撞外键。两种派活请求都回 201，不留归属人置空的 run。代理连接由 `disconnectOwner` 关掉（4002），它先把这个用户记进「已删号」，`#onHello` 入表前看一眼：认完身份、还没入表时删号的 hello 不会握手成功；入表之后删号的，`disconnectOwner` 在表里找得到它。握手中途任何一步抛错，`#onHello` 都关掉这条 socket（1011），表里还挂着它就照断线处理（出表、记休眠、起宽限收尾）。这些交错各有一条用例钉着（`test/privacy.test.ts`）。

过这一道的写：`bot_text`（建空壳和接正文）、`bot_tool_call`（新建工具行，也包括改已有那行，收尾打成 `failed` 的不会被晚到的 `ok` 盖回去）、`approval_request`（`createApproval`）、`mention`、`skill_offer`、`project_offer`、`draft_create`、`plan_propose`、`draft_edit`，以及改任务卡和群状态的 `handoff`（建卡、排进下一轮派活、超限提示）、`handoff_accept`（接卡和换经手在同一个事务里）、`task_checklist`（清单）、`set_chief`、`set_cadence`。后五种不是这个 run 的产物，但晚到时会盖掉用户此后的选择：结束的 run 晚到的清单盖掉用户刚改的清单，晚到的确认把经手换回一个已经收尾的 Bot，晚到的交接建出一张错卡还真的派活，所以同样整条丢掉。只剩两种不过这一道：`run_done` 自己，它是收尾动作，`finishRun` 以 `ended_at IS NULL` 为条件做 UPDATE，拿的是更新锁，重复收尾返回 null；`approval_abandoned` 是单向的终态清理，只把 pending 改成 expired，重开不了审批，已有结论或重复到达都更新 0 行。`test/run-end.test.ts` 钉着三种收尾都收文字、多 Bot 群里只收收尾那个 Bot 的、同 Bot 在别的电脑上还有 run 开着时旧 run 收尾不收（`run_done` 和对账收尾两条路）、晚到的每种帧都不落，以及两台控制面共库时的两种交错：帧卡在锁之前、收尾先提交；收尾的事务结束了 run 还没提交，帧在锁上等它。还钉着排队的六件事：同 Bot 同群两条 run 在两台控制面上同时收尾，两条文字都收成定稿；收尾持锁时新消息的派活等它提交才建 run；清单帧拿着 run 的共享锁时删 Bot，删除等它、回 204 不死锁；帧已过 `resolveRun` 时它的 Bot 被删，放行后一行不写；删除锁好 run 之后才建群把这个 Bot 拉进去并派活，建 run 等删除提交、查不到成员就不建，删除回 204；别的 Bot 正在确认被删 Bot 交出来的活时删它，删除等确认提交、回 204，经手换成确认的那位。

限制：多台控制面时，收尾推的定稿只到本实例的 Web，另一实例上的 Web 要等重连或重拉才看到定稿。控制面不校验 `bot_text` 的 messageId 有没有被另一条 run 用过（`appendBotText` 只按 messageId、群、kind 接上），电脑代理若跨 run 复用 messageId，那条文字可能在另一条 run 收尾时被提前收成定稿。

### 解散群

`POST /api/groups/:id/archive` 是软归档：只立起 `groups.archived_at`，行和消息、审批、run 都留在库里，不删、不级联。单聊（包括主助理那个群）回 409，不想要就删 Bot；别人的和没有的回 404；解散过的再点一次回 204。归档之后这个群对所有入口都等于不存在：`findGroup`、`listGroups`、`findLiveGroupId`（`repo/live-groups.ts` 的 `groupIsLive` 同时要求有成员、没归档）、项目页、今天、目标记数、牌桌的 `loadTable` 和 `withTableLock` 都过滤 `archived_at IS NULL`，所以读写都回 404；`placeRun` 读成员时连上群并要求没归档，回 `not_member`；`appendMessageIfGroupAlive` 对群行拿 `FOR SHARE` 并要求没归档，派活失败的提示不会写进解散的群；上行帧的 `findGroupId` 认不出它，整条丢掉；例行调度的 `openRoutineRun` 目标群已归档就不开运行记录。

`repo/archive-group.ts` 的 `archiveGroup` 在一个事务里做完，锁序照删 Bot：账号共享锁，按 Bot id 升序拿每个成员的排他 Bot 锁（`lockRunsOfBot` 那一把，`startRun` 拿共享，解散持有期间这个群建不出新 run），再锁这些道所在的电脑行，牌桌拿桌锁，然后按 Bot 顺序锁 `lane_leases` 并给持有者入队 `cancel{lane, epoch + 1}`，收尾锁，最后按 id 升序 `FOR UPDATE` 这个群还没结账的 run。之后：清掉 `continue_requested`，开着的 run 收尾（`ended_at`、`charged_at` 置成现在，删掉它们还在发件箱里的下行），例行运行记录收成 `stopped`；pending 审批改成 `expired`；这个群的例行停掉；任务卡打成 `done`；最后才写 `archived_at`。提交后对取消涉及的电脑 `flushOutbox`，放掉内存里的回合，推每张过期审批的 `approval_updated`、每条停掉的例行的 `routine_updated`，再推 `group_archived`，页面从侧栏移掉这个群，开着它的页面回首页。

不做的事：pending 的交接卡不改，`HandoffStatus` 只有 pending 和 accepted 两态，接卡要求这个群里有开着的 run，解散后接不了，群又不可见，留着不影响任何人。被取消的 run 按零费用结账，已经花掉的那一截不进用量。流式中的文字和跑着的工具行不收成定稿，群已经看不到了。

## 主助理

每个用户恰好一个主助理，`bots.role = 'assistant'`，由部分唯一索引 `bots_owner_id_assistant_idx` 钉住。`ensureAssistant(tx, ownerId)` 不先查：直接插 bot 行撞这个索引，`onConflictDoNothing` 没返回行就停，不占编号、不建群。真插进去的那次才建单聊群、主题任务卡和 `group_members`，并在单聊里写主助理的第一句 `ASSISTANT_GREETING`。注册在同一个事务里调它；登录成功后再调一次，给 P1-13 之前注册的老用户补建，补建成功且电脑在线就重发一次 `config`；电脑 `hello` 校验通过后、查 Bot 发 `config` 之前也调一次，会话还有效、一直没重新登录的老用户靠这一处补上，补建成功时先给 Web 推 `bot_updated`（主助理）、`group_created`（单聊群和它的主题任务卡）和第一句的 `message`，已经开着的首页不用刷新就能用输入框，这个用户的其他连接也重发一次 `config`；`seed` 建完用户也调一次。主助理的色相固定 `sky`，不推进 `user_counters.next_hue`，所以用户自己建的 Bot 仍从色相轮转的第一格起。

`DELETE /api/bots/:id` 删不了主助理，回 409 和一句中文原因。删除和收审批用同一个 `role = 'member'` 条件，删不到时再分辨是主助理还是不存在。群没有删除和退群的接口，所以主助理的单聊群没有别的入口可以拆。

派给主助理的 `prompt` 恒带 `projects`，是这个用户所有项目群（`solo_bot_id IS NULL` 的群）的 `groupId`、`title`、`cadence`，没有项目也带空数组；派给队员不带。上行 `set_cadence` 先照常校验 run 归属，再在同一条 `UPDATE tasks` 里要求 `projectGroupId` 是这个用户的项目群、发报文的 Bot 是这个用户的主助理，改不到就静默丢弃。改成了只推 `task_updated`，不建审批、不写卡片消息。`findAssistant(db, ownerId)` 是取主助理和它单聊群的唯一入口，`GET /api/today` 用它，P1-9 建项目群时也用它。

## 项目

项目是主助理提议、用户点「开始」才建出来的多 Bot 群。

### 方案卡

上行 `project_offer` 先照常校验 run 归属，再要求发报文的 Bot 是这个用户的主助理、run 所在的群是主助理的单聊，不成立整条静默丢弃。成立就在单聊里落一条 `project_offer` 消息，`status: "offered"`、`groupId: null`，此外什么都不建。`platforms` 里的 `unsupported` 只随正文留着给 Web 显示，不建任何东西。

### 点开始

`POST /api/messages/:id/project-offer` 按归属人查这条消息，正文不是方案卡或不是自己的回 404。`start` 在一个事务里做完下面几件事，第一步就是抢卡：

1. `UPDATE messages ... WHERE body ->> 'status' = 'offered'`，同时写进 `status: "started"`、预先生成的项目群 id 和最终的项目名（请求给了 `name` 就是它）。卡的状态只住在这条正文里，改名不另存一份。并发的第二个请求在行锁上等，醒来 `WHERE` 已不成立，一行都改不到，事务回滚，什么都不建。
2. 按 `team` 建队员 Bot，每个都带自己的单聊群（`listBots` 按单聊 join，没有单聊的 Bot 进不了 `config`）。`tag` 对 `tag`，`description` 对 `description`。名字和这个用户已有的 Bot（包括这一批里先建的队员）撞了就自动避开：依次试「小内2」「小内3」……，太长时截掉原名尾巴给数字让位（上限 20 按 JS 码元算，和 zod 一致，emoji 不劈开）。不报错是因为点开始的人改不了队员名，报错只能让他回去叫主助理重提一张卡。避名在 `claimCounter` 抢到发号器行锁之后读这个用户全部 Bot 名，再交给 `naming.ts` 的 `untakenBotName` 挑：同一用户建 Bot 的事务都先抢这一行，锁到手时前一个已经提交，并发的两次挑不到同一个名字。序号一直往上试，同位数的候选互不相同，一定挑得出。Bot 名不加唯一索引：手动建 Bot、改名、`generateBotName` 随机起名都允许重名，加了它要动的是这几条路，不在这一件里。建完把正文 `team` 里的名字换成实际建出来的，和项目名一样，卡上显示的就是群里的人。
3. 建项目群和主题任务卡。群名取请求里的 `name`，没给用正文的；`summary` 取 `goal`，`cadence` 取正文，`firstStep` 是清单第一项。成员是主助理在前、队员在后，首席是主助理。
4. 建 `PROJECT_ROUTINES` 两条例行：「周一 09:00 排本周计划」让主助理调 `propose_plan`，「周五复盘」只复盘。例行的 Bot 是主助理，`groupId` 是项目群，`purpose` 是 `plan`。之后项目群换了首席，这两条照样派给主助理，见「例行任务」。

提交之后重推这条消息，给每个新队员推 `bot_created`（带这个 Bot 的单聊群 id，Web 不必再拉 Bot 列表），再推 `group_created` 和每条 `routine_updated`，最后重发 `config`，新队员这时才跑得起来。回包带这条消息、项目群和它的主题任务卡。`dismiss` 用同一个条件 `UPDATE` 改成 `dismissed` 并重推，回包的群和卡都是 null。抢不到卡时回 200 带当前消息，已开始的顺带项目群和卡，不再推送。

### 建队卡

主助理给已有的项目补人，走上行 `team_offer`：先照常校验 run 归属，再要求发报文的是主助理、run 在它的单聊里、`projectGroupId` 是这个用户还有成员的项目群（`findProjectGroupId`，成员删光的群和 `findGroup` 一样当作不存在，否则落下的卡永远确认不了）、`existing` 人选都是他的 Bot。任一不成立整条静默丢弃。后两道查在落卡的那个 `whileRunOpen` 事务里做，而且先锁后查（`repo/team-offers.ts` 的 `lockOfferTarget`）：先读目标群现在的成员，和卡上的既有候选并在一起，只取这个用户的，按 `bots.id` 升序 `FOR KEY SHARE`；锁到手之后重读成员，现在的成员里至少一个在锁里才往下走：读成员和上锁之间成员可能被整批换掉（确认别的卡把人加进来，再删掉原班人马），只锁旧那批就挡不住删新来的人。一个都不在就把前后两批并起来按 id 升序再锁一回、再读，还不在就当目标没了，整条丢弃。之后再用新语句查目标是他的项目群、候选都归他。删 Bot 要拿这些行的排他锁，`KEY SHARE` 把删除挡到卡提交之后；锁之前已提交的删除，锁之后的新语句看得见。只把查挪进事务而不锁是不够的：`READ COMMITTED` 下每条语句各取快照，查完到落卡之间成员被删空，卡照样落下。成立就在单聊里落一条 `team_offer` 消息，`status: "offered"`，谁都不加。卡落下之后目标群才删空的，确认只会回 404，首页待办用同一个 `hasMembers` 条件把它过滤掉（`repo/today.ts`），卡本身留在单聊里不改状态。

`POST /api/messages/:id/team-offer` 的 `defer` 只把 `offered` 改成 `deferred` 并重推；首页先按到达时间截好最新 50 条，再在这 50 条里把先放着的卡整组排到仍待处理的项之后；先挪再截会让一堆先放着的卡把更新的审批挤出首页。`confirm` 在一个事务里按下面的顺序取锁，顺序本身就是设计：

1. `UPDATE messages ... WHERE status IN ('offered', 'deferred')` 抢卡，改不到就是已经确认过了，回 409。
2. 勾选的已有 Bot 全部按 `bots.id` 升序 `FOR KEY SHARE`，已经在群里的也锁。锁不到的就是已经删了，回 409「卡上第 N 位已经不在了」，整个事务回滚、卡原样。`KEY SHARE` 和删 Bot 的 `DELETE` 冲突，所以删除排在确认提交之后：入群不撞外键，写进终态正文的人在提交那一刻也都还在群里，正文的 `members` 和回包的 `group.botIds` 一致。
3. 项目群行 `FOR UPDATE`，然后才读成员名单：前一次加人提交了才看得见。零成员回 404 回滚。已在群里的勾选项跳过，不重复加；加完超过 6 人回 400 回滚。
4. 新人走 `insertMemberBot(..., "untaken")`，在 `user_counters` 行上排队、避名，再接在群尾。改写卡正文为只剩勾选的人、新人换成实际建出的名字，最后在同一事务里读群回包。

提交之后推 `group_updated` 用的不是事务里的快照，而是重读的群：同一个群两次确认都成功时，两份提交回执可能逆序到达，先提交那份人少的快照会把后一份覆盖掉，Web 的群推送没有版本号，拦不住。只重读也不够，两次重读的结果一样可能逆序推出去，所以路由（`http/routes/team-offers.ts` 的 `publishGroup`）把同一个群的「重读加推送」在进程内排成一队：后进队的那次读一定在先进队那次的提交之后，最后一次推的就是库里最新的名单。回包仍用事务里的快照，跟卡上写下的人一致。这个队列只管建队确认这一条路径，并且假定控制面是单进程（推送本来就只发给连在本进程的连接）；set_chief、删 Bot 这些基底上已有的 `group_updated` 推送没有进队。

为什么是 Bot 在群前面：删 Bot 是先锁 Bot 行，再由外键级联到它当首席的群行（`chief_bot_id SET NULL`）。确认若先持群再等 Bot，两个项目互邀对方的首席、同时删这两个首席，就是「确认 A 持 A 等 y → 删 y 持 y 等 B → 确认 B 持 B 等 x → 删 x 持 x 等 A」的四方死锁，数据库报 40P01、一方 500。改成 Bot 在前，确认持群时手里已经有它要的所有 Bot，只剩发号器和自己新建的行要拿，没有谁持着群行等 Bot。各条路径的锁序：

| 路径 | 锁序 |
| --- | --- |
| 建队确认 | 卡消息行 → 勾选 Bot 按 id 升序 KEY SHARE → 项目群 FOR UPDATE → user_counters → 新 Bot、单聊、group_members |
| 建队卡落卡 | run 共享锁 → 目标群成员和既有候选 Bot 按 id 升序 KEY SHARE（成员被整批换掉时前后两批并起来再锁一回） → 单聊里的消息新行 |
| 删 Bot | Bot 的 advisory 锁 → open runs FOR UPDATE → 相关交接 FOR UPDATE → 审批 UPDATE → DELETE Bot → 级联到首席群行、成员行 |
| 开始项目 | 方案卡消息行 → user_counters → 新 Bot、单聊 → 新群、成员 |
| 交接接受 | run 共享锁 → 交接行 UPDATE → 新经手 Bot KEY SHARE → 任务行 FOR UPDATE |
| setCurrentBot | Bot KEY SHARE → 任务行 FOR UPDATE |
| createGroup | 输入的成员 Bot 按归属查出并 KEY SHARE → user_counters → 新群、成员 |
| set_chief | run 共享锁 → 群行 UPDATE → 新首席 Bot 的外键 KEY SHARE |

全局的序是：已有的 Bot 行 → 群行 → `user_counters` → 本事务自己新建的行。关键在发号器：拿着 `user_counters` 的事务不再等任何别人可能持有的锁。确认到发号器时勾选的 Bot 和群都已在手里；createGroup 在发号器之前就把输入的 Bot 锁好；开始项目在发号器之后只碰主助理和自己新建的行，而主助理不可删，没有谁对它拿排他锁；`insertMemberBot` 之后只插新行。这几条都对 Bot 只取 KEY SHARE，彼此不冲突，所以发号器上只有排队，没有环。删 Bot 和确认都是 Bot 在群前，同向；删 Bot 不碰发号器。落卡只对 Bot 取 KEY SHARE，之后只插自己单聊里的消息行，不碰群行和发号器，删 Bot 对它只有单向等待。交接接受、setCurrentBot 先对新经手 Bot 取 KEY SHARE 再锁任务行，Bot 在前，同向；它们碰的 run、交接、任务行确认一个都不碰，最多单向等确认的群锁。两个确认之间：同群在群行上串行，不同群对同一个 Bot 都是 KEY SHARE，不冲突。

createGroup 早先是先拿发号器、插成员时才靠外键锁 Bot，和这个序反着，三方就能成环：只勾新人的确认持着项目群 G、停在发号器前；删 G 的首席 x 持着 x 行，级联置空 G 的 `chief_bot_id` 时等 G；拉 x 建另一群的事务持着发号器，插成员撞到 x 的锁等删除；确认放行后等发号器，40P01、删除回 500。把归属查询挪进事务并 KEY SHARE 之后，建群在发号器之前就等删除，确认拿到发号器提交，删除再提交，建群醒来查不到 x 回 404。

set_chief 是群在 Bot 前，和删 Bot 反向，是这套序之外唯一一条边。它和一次删 Bot 排不成环：`is distinct from` 让重设同一个首席不改行、不取锁，级联也只碰现任首席是被删者的群。两个群同时互换首席、同时删这两位就凑成四方环，复核时用探针真的跑出了 40P01。这条路径基底就有，建队卡这一单不改它，登记为已知缺口一：要修就得让 set_chief 先对新首席取 KEY SHARE 再改群行。`test/team-offer.test.ts` 用测试自己持群行和发号器行、或 `gated-db` 停在某条 SQL 前当屏障，用 `pg_stat_activity` 数锁等待，把互邀首席四方交错、群内成员确认中被删、群锁未到手时删候选、只勾新人时建群与删首席三方交错、落卡前目标群被删空、落卡校验后删成员和删候选都要等卡落下、锁之前删空不落卡、读成员后成员被整批换掉时删新成员也要等卡落下九条交错都钉成确定的用例。

已知缺口二：卡落下之后候选全被删。确认回 409「卡上第 N 位已经不在了」，`defer` 照常 200，首页的过滤只看目标群还有没有成员，这张卡留在待办里清不掉。`test/team-offer.test.ts` 的「落下后候选没了」用例钉的是这个现状，改了它就要改 `repo/today.ts` 的过滤。

### 目标与手动记数

任务卡上的目标是三列 `goal_target`、`goal_unit`、`goal_due_at`，契约是 `ProjectGoal`（`shared/src/domain.ts:146-187`）：目标数是正整数，上限 2147483647；单位 1 到 8 个字；期限可空。PATCH 任务卡给 `goal` 就三列整体替换，给 `null` 三列一起清空（`repo/tasks.ts:69-74`），不单改一列。没有单位的数、没有数的期限在卡上都读不懂。方案卡也一样，`goalTarget` 和 `goalUnit` 两个都给了才写进任务卡（`repo/projects.ts:194-199`），只给一个就当没有目标（`test/goals.test.ts:164`）。

当前值不住在任务卡行上，住在 `metric_samples`，每记一次插一行。任务卡出边界前都过 `withMetric`（`repo/metrics.ts:66-70`），从样本算出 `current`、`weekDelta`、`sampledAt`；不过这一道，推出去的 `task_updated` 会把 Web 上的当前值冲成 null。存样本而不是覆盖一个数，是因为本周变化要拿得到周一之前的值。规则写在 `metricsOf`（第 21-64 行）：

- 本周从上海时区周一 00:00 起。
- 当前值减周一之前的最后一个样本。
- 周一之前一个样本都没有，就减本周第一个。
- 最新样本本身在周一之前，本周就是没动，记 0。

三个样本必须出自同一条语句，`metricsOf` 用三个 CTE 一次取齐（第 31-51 行）。分开查各拿各的快照，夹在中间的写入能拼出一个从没存在过的变化，`test/goals.test.ts:329` 的「读指标读到一半有人记数」钉着这一点。先后一律按 `sampled_at` 再按 id。

手动记数是 `POST /api/projects/:groupId/metric`（`http/routes/goals.ts:16-29`），样本的 source 记 `manual`。`recordSample`（`repo/metrics.ts:72-100`）用一句 `INSERT ... SELECT` 同时判定和插入，只认本人的、还有成员的多 Bot 群，插不进就回 404，不先查后写。采样时间取库里的 `clock_timestamp()`，微秒精度，同一毫秒里先后两次记数也分得出先后（`test/goals.test.ts:309`）。记成了推一条带新指标的 `task_updated`。

任务卡上还有一列可空的 `metric_source`，契约 `MetricSource`（`shared/src/domain.ts:155-165`）是 `kind` 区分的两种：`github_stars` 带账号和仓库，`reported` 带平台和名字。PATCH 能改它（`repo/tasks.ts:75`）。`metrics/poller.ts` 的 `MetricPoller` 每 10 分钟扫一遍 `github_stars` 来源的项目，按 UTC 对齐的六小时一格，库里这一格没有样本才去 GitHub 读星数，重启不会重取。同一群同一来源在一格里只落一条，`repo/metrics.ts` 的 `recordPolledSample` 先拿事务级 advisory 锁再做 NOT EXISTS 写入。运行器上报的 `metric_report` 进 `agent/events/metric-report.ts`，校验群和 run 的归属之后在 `whileRunOpen` 里落一条 `reported` 样本，run 收尾之后才到的报文作废，落了就推 `task_updated`。

首页 `GET /api/today` 的 running 项里 `goal` 和 `metric` 一律是 null（`repo/today.ts:225-226`），目标和进度只出现在任务卡、群列表和项目页上。

### 周复盘

开项目时建的「周五复盘」例行叫主助理写完调 `submit_review` 交上去（`repo/projects.ts:38-45`）。上行 `review_submit` 要过三道（`agent/events/review-submit.ts:17-41`），任一不成立整条丢掉，记一行日志：

- 群是本人的、不是单聊。单聊没有项目页。
- run 是这台电脑上这个 Bot 在这个群里的活（`runBelongsTo`）。
- run 是例行派的（`routineRunOfRun`）。用户当面叫它复盘那次是聊天，交上去会顶掉周五那份。

一周只留一份。`project_reviews` 有唯一索引 `(group_id, week_start)`（`db/schema.ts:258-270`），`saveReview`（`repo/project-page.ts:37-60`）用 upsert，冲突时只在旧的 `created_at` 早于这次 `receivedAt` 时覆盖。周界和先后都按 `receivedAt` 算，它是 hub 收到这一帧的时刻（`agent/hub.ts:159`），等链、等锁都不改它。不按写库先后，是因为两台电脑的链并行，先收到的那份可能被锁拖到后面才写，按写库先后它会顶掉后收到的新稿。同理，周日深夜收到、拖到周一才写库的复盘仍算上一周。`test/review.test.ts` 的「先收到但被拖住的旧稿不会顶掉后收到的新稿」和两条「周日深夜收到……仍算上一周」钉着这三种交错。

复盘在项目页的 `achievements` 里是一条 `kind: "review"` 的成果，标题「<weekStart> 那周的复盘」（`repo/project-page.ts:222-229`）。

## 审批

群消息是事实来源，审批是唯一一件「群消息本身说不全」的事：那张卡的正文只有一个 approvalId，批没批写在 approvals 行上。所以结论只随 `approval_updated` 推，重推那条 message 一个字都不会变。

### 哪些工具要点头

判定全在电脑那一侧的统一闸门里做，顺序是禁区、硬清单、授权、默认表，控制面不重算一遍，细节在 `packages/bot-runner/README.md`。闸门判成「问」时发上来的 `approval_request` 带着 `action` 和 `target`，控制面原样存在 approvals 行上，批准时的授权就从这两列来。

### 一条链

| 这一步                  | 谁做                      | 结果                                                                                               |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 拦下要点头的工具        | 运行器                    | 发一条 `approval_request` 上来，handler 挂起等结论                                                 |
| `approval_request` 到达 | `agent/events.ts`         | 一个事务里建群消息和 approvals 行，先推 `approval_updated` 再推那条 `message`                      |
| 归属人点批准或拒绝      | `POST /api/approvals/:id` | 定结论，选了长期范围就落授权并先重发 `config`，再向电脑发 `approval_result`、推 `approval_updated` |
| 结论到达                | 运行器                    | 批了就往下跑，拒了就 `block`，这个工具调用的终态是 `blocked`                                       |

控制面收到 `approval_request` 时先落卡，运行器挂着等 `approval_result`。下行用 `outcome` 区分 `approved`、`rejected`、`voided` 和 `timed_out`。

用户当面发起的审批 `deadlineAt` 为 null，不按时间过期；Bot 之间 @ 派活也按这个规则。例行 run 的 `routineRunId` 非空，或 run 的触发消息是交接卡时，审批截止为创建后 10 分钟。服务器每 15 秒扫描一次，`UPDATE ... WHERE status = 'pending' AND deadline_at <= now RETURNING` 把到期审批定为 `timed_out`、记录 `decidedAt`，向所属电脑发超时结论并推 `approval_updated`。测试通过 `scanApprovalTimeouts(now)` 指定扫描时刻，间隔可由 `approvalTimeoutIntervalMs` 注入。

按钮和群里答复的条件 UPDATE 同时要求 `deadline_at IS NULL OR deadline_at > now()`。截止已过、扫描器还没跑时，点按钮返回 409，并在原事务内用扫描器同样的条件 UPDATE 就地结算这一张卡，给电脑发 `timed_out`、推 `approval_updated`。重复点按钮或后续扫描不再发结论，也不落授权。

用户的新消息路由到目标 Bot 后、发 prompt 前，控制面把这个 Bot 在同一个群里的 pending 审批定为 `voided`。每张卡先向旧 run 所在电脑发作废结论，再派新 prompt；其他 Bot 和其他群的审批不受影响。例行消息不作废已有审批。群里回「批准、同意、拒绝、不行」先消费为审批决定，消费成功就不派活，也不触发作废。按钮、作废和到期都用 `WHERE status = 'pending'` 争同一行，作废后再点按钮返回 409。

审批的人工决定、文字答复、作废和超时都在调用方事务内把 `approval_result` 入可靠发件箱；新消息的作废与首个新 prompt 同事务提交，作废序号在前。提交之后才刷发件箱和向 Web 推 `approval_updated`，产生长期授权时先重发 config 再放行。锁序为归属人共享锁、Bot 共享锁、按 id 排的电脑行、run、审批行；自动结算只更新已经锁过投递范围的候选审批，仍由 `WHERE status = 'pending'` 决胜。

`expired` 保持原义：run 收尾或电脑断线后的审批失效。卡片把新消息作废显示为「已作废 · 你发了新消息，这一步不做了」，到期拒绝显示为「已拒绝 · 10 分钟没人批」。

两处幂等，都靠数据库自己，不靠先查后写：

- 电脑重发同一条 `approval_request` 时，唯一索引 `(run_id, call_id)` 拦下，整条事务回滚。群里不多一张卡，也不多推一次。消息必须先落地（`approvals.message_id` 是非空外键），所以输掉竞争时只能整条回滚，不能只删一半。
- 重复的决定靠 `WHERE status = 'pending'` 拦下，返回 0 行就是 409。电脑不会第二次收到 `approval_result`。
- 同一个用户对同一类动作、同一个目标、同一个群（`forever` 的群是空）只有一条授权，唯一约束 `grants_owner_action_target_group_uq` 带 `NULLS NOT DISTINCT`，空群也算重复。批第二次走 `ON CONFLICT` 拿回原来那一条，两条审批的 `grantId` 指向同一行。

### 批准的范围落成授权

`DecideApprovalRequest.scope` 是 `once`、`project`、`forever` 之一，省了是 `once`。

| 范围      | 落什么                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `once`    | 不落授权，只放行这一次                                                   |
| `project` | 一条绑在这个群上的授权，别的群同类动作照样问                             |
| `forever` | 一条对这个用户全局生效的授权。表里没有 Bot 列，同一个用户的所有 Bot 都认 |

越级的范围在边界回 400，不落授权，审批还在等：

- 超出 `GRANTABLE_SCOPES[action]` 的。`spend`、`account_security`、`delete` 只能 `once`，`write_outside` 最多 `project`。表里的 check 约束再兜一道。
- 审批行的 `target` 为空的。授权记的是「同类动作、同一个目标」，没有目标就没东西可记。Web 那边这种卡只给「这一次」，两边照同一条规则。

定结论、落授权、把 `grantId` 写回审批行在一个事务里。越级时 `UPDATE ... WHERE status = 'pending'` 已经跑过，只能整条回滚，所以不先查后写也不会把审批误定下来。

落了授权就**先重发 `config` 再发 `approval_result`**。运行器放行之后紧接着的同类调用要读到这条授权，顺序反过来它还会再问一次。群里回「批准」这类词没法选范围，一律按 `once`。

`GET /api/grants` 列这个用户的全部授权。`DELETE /api/grants/:id` 按归属人删，别人的和不存在一样是 404。删掉之后推 `grant_deleted`，再重发 `config`，下一次同类调用又会问。

### 暂停和继续

`POST /api/bots/:id/pause` 和 `resume` 只改 `bots.run_state`，给这个用户在线的每台电脑发 `pause` 或 `resume`，推 `bot_updated`，回 `BotResponse`。运行器那头怎么停在闸门上见 `packages/bot-runner/README.md`。

暂停状态住在控制面，电脑那头只是照着执行。发布循环不认领暂停 Bot 的到点已批草稿，保留已批状态，恢复后的下一轮照常认领发布；Bot 已删、草稿的 `bot_id` 为 null 时照旧认领。认领后才暂停的窄窗口由运行器兜底上报 `reason: "paused"`，草稿记成 `failed`、`failure: "paused"`，通知和草稿卡显示「Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿」。失败草稿不能直接重新批准，Bot 改稿后草稿回到 `pending` 才能再批；恢复本身不重发，也不改账号登录状态。

**hello 按状态补发。** 电脑 hello 成功后照发 `welcome` 加 `config`，紧跟着给 `config` 里的每个 Bot 各补一条：`run_state` 是 `paused` 的补 `pause`，其余的补 `resume`。新起的代理进程在收到 `config` 之前收到的 `pause`、`resume` 会被丢掉（那时还没有运行器），同一个进程重连时运行器还在，早到的会立刻生效；补发要对两种进程都成立，所以排在 `config` 后面。补发和 `config` 用的是同一次 `listBots` 的结果。

**断线期间点的「继续」不会丢。** 断线时点继续，库里照样写成 `running`，但这时没有连接，那条 `resume` 发不出去。代理重连有两种情况：

- 进程是新起的。运行器是按 `config` 新建的，本来就没停，补不补都一样。
- 同一个代理进程重连。运行器不重建，还记得断线前那个 Bot 停着。只补 `pause` 的话它会一直停着，之后的活全挂在闸门上，库和 Web 却显示在跑。

所以没停的也要补 `resume`。运行器对没停的 Bot 收到 `resume` 什么也不做，给新进程多发一条没有害处。

**还剩一个极窄的竞态。** `#sendConfig` 先查工具、skill 和授权，最后一个 await 才是 `listBots`，查完同步发出 `config` 和补发，中间不再让出事件循环。剩下的窗口是 `listBots` 这一次查询在途的那一段：

1. hello 的 `listBots` 读到快照，比如这个 Bot 停着。
2. 这次查询的结果还没回来，一个 `resume` 的 UPDATE 提交了，路由把 `resume` 发了出去。
3. hello 拿到结果，按旧快照补发 `pause`。

结果是运行器里停着，库里却是 `running`。反过来点暂停也一样，停不住。窗口是一次查询的往返，用户再点一次就能恢复，这一版不修。要彻底关掉，得把同一个用户的 hello 补发和 pause、resume 路由串到一条链上（做法同 `agent/hub.ts` 里按电脑一条链的 `#enqueue`，见下面「电脑断线」），让「读状态加下发」和「写状态加下发」不再交错。

### 删 Bot 时的审批

`DELETE /api/bots/:id` 在同一个事务里先把这个 Bot 挂着的审批 `UPDATE ... WHERE status = 'pending'` 成 `expired`，再删 Bot，然后逐条推 `approval_updated`，最后推 `bot_deleted`。运行器删 Bot 时不再报 `approval_abandoned`，收尾由控制面做。和同时点下的批准靠行锁排先后，谁先落谁算，输的一方拿到 409 或不在名单里。这条 UPDATE 自己带归属条件（`bot_id` 只取这个用户名下的 Bot），删别人的 Bot 回 404，连他的审批行锁都不碰。

同一个事务里它的例行转给主助理，见「例行任务」的「删 Bot 时的例行」。

approvals 行的 `bot_id` 外键是级联删除，事务提交后那一行随 Bot 一起没了。单 Bot 群连群带卡一起走，不留痕迹；多 Bot 群里那张卡还在，客户端手上已经有终态，重新加载后这张卡查不到审批。

### 群里回话等于按按钮

用户消息正文去掉首尾空白后恰好是「批准」「同意」「拒绝」「不行」之一时，落到该群最近一条待批审批上。词表在 `agent/dispatch.ts` 的 `REPLY_DECISIONS`。

这条消息照常存、照常推，但**不再派活**。运行器正挂着等这条审批的结论，再派一次会并发起第二个 run。群里没有待批审批时，「批准」就是一句普通话，照常派活。

### 超时只提醒

`repo/approvals.ts` 的 `remindStaleApprovals(db, push, now)` 给放了 24 小时还没有结论的审批各补一条 system 消息。**不升级，也不自动拒绝**，等的人始终是归属人。

先把 `reminded_at` 占住再补消息，所以再扫一遍不会重复提醒，进程重启也不会。`reminded_at` 就是为这个存在的。时钟是参数不是全局，`server.ts` 里一小时传一次 `new Date()`，测试直接传一个 25 小时后的时刻。

### 电脑断线

断线有两种：socket 真的关了，或者 45 秒收不到这条连接的任何报文。后一种是合盖的 Mac，进程冻住发不出 FIN，服务端手里的 socket 一直是 OPEN，只看 `readyState` 的话例行照样派给它。电脑代理每 15 秒发一次 `heartbeat`，45 秒是连丢两次还不判、第三次也没到才判。计时挂在每条 socket 上，收到任何一帧就重置，到点只 `terminate()`，之后标记休眠、推 `computer_updated`、宽限、收尾、推 `stuck` 全走下面这条普通断线的路，不另写一遍。用 `terminate()` 不用 `close()`：后者要等对端回关闭帧，冻住的对端不会回。没有用协议层 ping：心跳已经每 15 秒一帧，pong 能证明的它都能证明。被新连接顶掉的旧连接到点只关它自己，碰不到新连接。阈值是 `startServer` 的 `silenceTimeoutMs`，测试调短用。

**同一台电脑一条链。** 同一台电脑可能同时有两条连接在手里：代理重连时旧 socket 还没关，或者旧连接的某个任务停在一次查库上。`agent/hub.ts` 把同一台电脑的所有处理排成一条链（`#enqueue`，一个 `Map<ComputerId, Promise>`）：hello 认完身份之后的全部（轮换网关 key、登记连接、顶掉旧 socket、按 `activeRuns` 对账 run、上线写和推送、`welcome`、补建主助理、下发 `config`）是一个任务，已握手连接的每一帧、socket 的关闭、宽限到点的收尾各是一个任务。一个任务从开始到它的推送结束，这台电脑的另一条连接插不进来，所以「旧连接停在某个 await 上、新连接趁这时做完、旧连接醒来再写库或推送」这整类交错不存在，任务中间的 await 后面不用再判自己还是不是当前连接。每个任务只在开头看一次：帧和关闭看 `#connections` 里挂的还是不是这条连接，不是就整条丢掉，被顶掉的旧连接 inbox 里排着的帧是旧代理的旧话（`test/stale-connection.test.ts`）；宽限收尾看这台电脑有没有连接、有没有认完身份还在排队的 hello，有就停手，run 留给 hello 按 `activeRuns` 对账。认身份（`authenticateComputer`）在链外做，那时还不知道是哪台电脑。同一条 socket 的帧按到达顺序：上一帧在链上做完，下一帧才排进链，并发跑的话三段 `bot_text` 会乱序落库；两帧之间可能插进另一条连接的 hello，之后这条连接剩下的帧在开头丢掉。排队期间 socket 已经断了的 hello 也照做，它的关闭排在它自己后面把电脑写成休眠，电脑来过这件事才记得下来。不同电脑的链互相并行；同一用户两台电脑写同一个账号靠数据库的 advisory lock 和行锁。链上的任务不会等这台电脑后续的报文（`events.ts`、`dispatch.ts`、`group-turn.ts`、`account-expiry.ts` 里的 await 都是查库、事务、`notifications.publish` 和同步的 `agents.send`），所以链不会卡死；一个任务抛错由排它的那一方接住记日志，后面的任务照跑。复核过的五条交错序列各有一条用例钉着（`test/chain-order.test.ts`）。

**SQL 条件是数据库层的约束。** 上线和休眠这两条状态写（`markComputerOnline`、`markComputerSleeping`）带着这条连接的网关 key，UPDATE 的 WHERE 里要求行上的 `gateway_key_hash` 还是它；`markLoginValid` 和 `markLoginExpired` 带报它的那条连接（`ReportingConnection`），在锁里校验电脑行上的 key 还是这条连接的；心跳刷的 `last_seen_at` 走同一个函数。网关 key 每次 hello 都轮换，行上的 hash 就是最近一次握手的代次。这些条件挡的是 HTTP 路径上并发改电脑的写，以及以后多个控制面共库时另一个进程里的旧连接；同一个进程里两条连接的交错由链挡住，不靠它们。其余上行事件要么只写内存（`config_applied`、`config_rejected`），要么按 run 落在群里：run 绑的是电脑不是连接，同一个代理进程重连后继续报的那个 run 是正当的，该挡它们的是 run 的生命周期（`finishRun` 的 `ended_at IS NULL`、run 名下追加写开头的 `lockOpenRun`、`acceptHandoff` 和 `publish_result` 各自 WHERE 里的状态），不是连接代次。

**停机只进不出。** `closeAll` 先把 hub 记成停机，这一刻起不再有新的生产者：之后升级上来的 socket 当场关掉（close code 1012，代理按退避重连）；认身份在链外、停机期间才回来的 hello 也当场关掉不排链；已有 socket 再来的帧在 message 回调里同步丢掉，不进 inbox；socket 关闭只清它自己的计时器，不再排任务；没到点的宽限计时器在这一刻同步清掉，之后 `#onClose` 不再新建，所以没有计时器会在库关了之后才到点。剩下的只有停机前已经收下的那些帧：每条 socket 还没做完的 inbox 那一步记在一个 Set 里（做完就删，认身份那一步也在里面），`closeAll` 等一遍这些 inbox 尾，再等一遍各电脑的链，两个集合都是有限的，各等一次就够，不用循环。然后清空连接表、逐条关 socket、一条 UPDATE 把这几台写成休眠。先清表再写库：那条批量休眠之后没人再写这几台的状态，`closeAll` 返回时库里的休眠就是最终状态（`test/shutdown.test.ts` 钉着：认身份扣住再停机，放开后那条连接没有 welcome、库里不是在线、批量休眠扣住期间 `server.close` 不返回；停机前收下、还排在 inbox 里的第二帧做完才批量休眠；两台电脑停机后交替续帧，续的帧都丢掉，停机只做完停机前那两帧就返回）。

有效连接断开后等 15 秒；期间重连就用 `hello.activeRuns` 对账，缺席的 run 当即结束并在原群提示「电脑断过线，这次活没做完」，未重连则宽限到期后收尾全部未结束的 run。同一个 run 只收尾一次，收尾做的事见「run 收尾」。

**断线期间跑完的 run 走可靠发件箱补发。** `run_done` 和其他有后果的上行统一写入 `<dataDir>/.agent/outbox/<stream>/frames.jsonl`，追加并 fsync 后才发送。代理重连时把未确认帧中的 runId 并进 `hello.activeRuns`，welcome 带服务器的 `upAcked`；代理删除已累计确认的帧，按原序号补发后续帧。上行游标、run 收尾、费用和例行记账在同一事务中提交，重复帧只再回累计确认，处理器不重跑（`test/run-done-replay.test.ts` 和 e2e 同名用例）。提交后的通知和下一轮派活不属于确认的数据库效果。

无法处理的完整上行帧重试后以 `invalid` 拒收并推进游标，防止毒帧堵住后续报文。发件箱落盘后不按重连次数或内存条数丢帧；进程重启继续读原流。盘上状态记下 `computerId`，电脑身份改变、完整日志损坏或 welcome 的确认序号低于本地记录时，代理隔离旧传输状态、开新上行流并把下行游标归零，stderr 说明隔离目录。没有结尾换行的坏尾行只截断。

宽限到期时，控制面在同一事务里放弃该电脑未结束的 run，并清掉全部未确认下行，包括不绑 run 的 `publish_draft` 和 `browser_login`。草稿被标失败或回收时，同一事务删掉对应发布下行，避免用户已看到失败后晚重连又触发发布。提交前若已有 hello 排队，宽限收尾整批回滚，交给握手对账；用户推送在提交后执行。

pending 的审批随原有上行游标去重。每次握手仍按 welcome、config、每个 Bot 的 pause 或 resume、下行发件箱的顺序发送。电脑不在线时点结论，审批决定和 `approval_result` 在同一事务入箱；run 已结束时不入箱。作废审批的派活事务先按归属人、Bot、电脑、run、审批的顺序拿锁，锁住电脑之后再读待批范围，作废下行的序号在新 prompt 之前。

## 交接

一个 Bot 把手里的活交给群里另一个 Bot。审批等的是人点头，交接等的是另一个 Bot 接手，落库、推送、24 小时提醒是同一种形状。群里那张 `kind: handoff` 卡的正文只有一个 handoffId，做了什么、没做什么、下一步和清单指针都在 handoffs 行上，所以状态只随 `handoff_updated` 推，重推那条 message 一个字都不会变。

### 一条链

| 这一步         | 谁做                      | 结果                                                                                                                                                                               |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 决定交出去     | 运行器                    | 发一条 `handoff` 上来，带目标 Bot 和 done / notDone / next / checklistIndex                                                                                                        |
| `handoff` 到达 | `agent/events.ts`         | 一个事务里建群消息和 handoffs 行，先推 `handoff_updated` 再推那条 `message`，目标 prompt 排到当前 run 的 `run_done` 之后，带 `handoffId`，正文是 `agent/handoff.ts` 渲染出来的报文 |
| 目标确认接手   | 运行器发 `handoff_accept` | 状态改 accepted、`tasks.current_bot_id` 换人、经手记录补上一位的 `to` 再加新一位，推 `handoff_updated` 和 `task_updated`                                                           |

**确认之前当前经手不换人。** 交出去的那一个照旧收群里不 @ 人的消息，目标只是多收到一份报文。换人发生在 accept，不在发起，所以目标一直不确认时活不会悬在半空。

群回合里的 Bot 消息达到 10 条后，再来的交接不建卡，群里留一条「这一轮 Bot 已经说满 10 句，这份交接没有交出去」，同一轮里再来的静默丢掉。已经建了卡的交接不跟回合走：回合被用户插话取消，或这一张卡正好把发言数顶到上限时，目标排进这个群的下一个回合，排在用户新消息的目标后面。被取消的回合里后到的 mention 仍不派。

### 两道校验

`handoff` 要发起者正是这个群当前的经手，且目标是群里的另一个成员，不能交给自己。`handoff_accept` 要这个 handoffId 属于这个群，且它的目标正是报上来的这个 Bot。任一不成立整条丢掉，跟别的上行报文一样：不抛异常，不给电脑回报文，只记一条日志。

幂等靠数据库自己，不靠先查后写：`acceptHandoff` 的 `WHERE` 把 id、群、目标 Bot 和 `status = 'pending'` 一起写进去，重复确认、别的 Bot 替它确认、指错群，都返回 0 行，走同一条丢弃分支。消息必须先落地（`handoffs.message_id` 是非空外键），所以建卡和建行只能整条成或整条回滚。

和审批不同，这里**没有 `(run_id, call_id)` 那样的唯一键**：交接由 Bot 主动发起，同一个 Bot 交两次就是两份报文，不是重发。

### 超时只提醒

`repo/handoffs.ts` 的 `remindStaleHandoffs(db, push, now)` 给放了 24 小时还没确认的交接各补一条 system 消息。**不退回，也不升级**，活还挂在交出去的那一位身上。占住 `reminded_at` 再补消息、推送放在事务外，这套动作和审批共用 `repo/reminders.ts` 的 `appendReminders`，所以「再扫一遍不重复提醒、进程重启也不重复」对两者同时成立。时钟同样是参数不是全局，`server.ts` 里一小时一次，两条扫描共用同一个 `now`。

### 侧栏角标

`/api/bots` 和 `/api/groups` 的 `pendingHandoffs` 跟 `pendingApprovals` 一样按群算：该群还没确认的交接条数，Bot 那一行取它所在群的数。发起时加一，确认后归零。`/api/groups/:id/messages` 顺带把这一页消息里出现过的 handoffs 一起带下去，客户端不用为每张卡再问一次。

## 例行任务

例行任务属于一个 Bot。**一次运行就是归属人在群里发了一条消息**，`groupId` 为空时是这个 Bot 的单 Bot 群，不为空时是那个群（建项目时的两条例行发进项目群）：只落一条正文是 `instruction` 的 user 消息，正文另带 `routine: { name }`，Web 在气泡上方标「例行任务「X」」，不再另落一条 system：两条说的是同一件事，群里每次运行多一行噪音。然后走和手打消息同一个 `dispatchUserMessage`，派到哪台电脑也是同一条规则（见「派到哪台电脑」），本机合盖、远程在线时例行照常在远程跑。运行器和电脑代理因此不认识例行任务，没有新报文。派给谁不走路由表：`runRoutine` 带上例行的 `botId`，只派这一个 Bot，`reason` 记 `mentioned`，不改当前经手。按路由表走的话，项目群里换了首席，主助理的「周一 09:00 排本周计划」会派给新首席，那位手上没有项目清单，例行页面上却仍挂在主助理名下；首席卸任时没首席也没经手，就成了全员各排一份计划；队员自己在项目群里建的例行也会被首席截走。例行属于哪个 Bot 就由哪个 Bot 做，换首席不改例行，也不把例行改挂到新首席名下。到点触发、`POST /api/hooks/:token`、`POST /api/routines/:id/run` 三个入口走的都是 `routines/run.ts` 的 `runRoutine`。

`POST /api/bots/:id/routines` 带的 `groupId` 照存进 `routines.group_id`。群按归属人查，别人的群和不存在一样回 404；Bot 不在那个群里回 400。`GET /api/routines` 是这个用户全部 Bot 的例行，每条就是 `Routine`（带 `botId`、`groupId` 和最近 20 条运行记录），按建的先后排。

### 主助理在单聊里提议例行

上行 `routine_offer` 只认主助理在它自己单聊里发的（`agent/events/routine-offer.ts:15-52`）。群号不用报文自报的，直接取 `findAssistant` 查到的那个单聊（第 22-25 行）。主助理单聊里只有主助理的 run，run 对得上这个群就说明是主助理在单聊里发的，再信报文里的群号只多一个能伪造的口子。接着校验 cron 写法（`isValidCron`，第 29 行）、执行者是这个人的 Bot（第 30 行）、给了 `projectGroupId` 时那个群也是他的（第 31-32 行）。任一不成立整条丢掉，记一行日志。全部通过才在 `whileRunOpen` 里落一张 `status: "offered"`、`routineId: null` 的卡（第 35-50 行），不建例行。卡本身就是确认，和方案卡、建队卡同一套做法。

执行者在不在目标群里，落卡时不查，留到点加上那一刻查（`repo/routine-offers.ts` 的 `executorPlacement`，第 99-125 行）。卡落下到点加上之间，群成员和执行者都会变，落卡时查过的结论到点加上时已经不算数。点加上时执行者已删回 404，不在目标群里回 400（`http/routes/routine-offers.ts:27-28`）。点不要只用同一个带 `status = 'offered'` 的条件 UPDATE 改卡（`repo/routine-offers.ts:53-56`），不拿锁，也不建任何东西。`test/routine-offer.test.ts` 的「确认卡没点加上时不建例行」「不是主助理发的例行卡整条丢掉，冒充主助理的、主助理在项目群里发的也丢掉」「执行者不在目标项目群里回 400」钉着这几条。

### 确认卡点加上：锁序

主助理提的例行先落成单聊里一张 `routine_offer` 卡，`POST /api/messages/:id/routine-offer` 点加上才建例行。点加上的事务锁序固定为：执行者 Bot 的共享 advisory 锁（`shareBotRunsLock`，和 `startRun` 同一把 `BOT_RUNS_LOCK`）→ 卡所在 message 行的条件 UPDATE → 读执行者 Bot 和目标群成员 → INSERT routine。删 Bot 的事务开头拿同键排他锁（`lockRunsOfBot`），所以两边排队：加上先拿到锁，删除等它提交，之后的级联看得见这条例行；删除先拿到锁，加上等它提交，再读执行者已经没了，回 404「执行这条例行的 Bot 已经不在了」，卡留在 `offered`。只在读 Bot 时加 `FOR SHARE` 不够：删除可以在加上提交前先扫完例行，再等行锁、删 Bot，新例行就漏在扫描之外。锁也不能挪到校验之后：校验读到的 Bot 等删除提交后已经不在，INSERT 撞外键回 500。advisory 锁放在碰卡之前，删除不碰这张卡（卡在主助理单聊里，主助理删不掉），两边不会各拿一半。

**建例行的所有入口都要拿执行者的共享锁。** 删 Bot 在同一把排他锁里先把它的例行转给主助理再删，转交只扫得到已提交的例行；哪个入口建例行时不拿这把共享锁，它在转交扫描之后、删 Bot 之前提交的例行就被外键级联删掉，而调用方已经拿到成功。`test/routine-offer.test.ts` 钉着两种顺序：加上过完校验时删执行者，删除卡在锁上、放行后加上 200、删除 204，新例行转到主助理名下；删除先拿锁，加上等它提交后回 404。

方案卡点开始（`decideProjectOffer`）建的两条例行执行者是主助理，事务先拿归属人的共享锁（`lockOwner`，账号锁永远在 Bot 锁之前），再读出主助理、拿它的共享锁，再用新语句重查一次，然后才抢卡、建队员、建群（推 counter）、INSERT 两条例行。锁要在这些之前：既有 Bot 行在群行、成员和 counter 之前。主助理删不掉，所以这里防的是锁协议被绕开，不是已经能复现的丢例行；同一份测试里钉着「主助理被排他锁住时点开始连卡都不碰」。

已知缺口：成员资格只靠读一次 `group_members`，没有锁住。现在没有退群或移出成员的 HTTP 入口，碰不到；以后加成员写路径时，要和建例行共享同一套锁协议（移成员先提交，建例行重读时查不到回 400；建例行先拿锁，移成员等它）。

### 调度判定

`routines/scheduler.ts` 是单实例，在控制面进程里每 30 秒扫一遍带 cron 触发器的例行任务，`startServer` 起它、`close` 停它，时钟和扫描间隔都能注进来。

到点判定不是「离上次满 N 分钟了」，而是**「上次触发之后到现在之间存在一个 cron 时刻」**。游标 `lastFiredAt` 记在 triggers jsonb 里每个触发器上，触发时同一条 `UPDATE` 把它推到那个时刻并把旧值写进 `WHERE`：

```sql
UPDATE routines SET triggers = jsonb_set(triggers, '{0,lastFiredAt}', ...)
WHERE id = $1 AND triggers -> 0 ->> 'lastFiredAt' = $旧值
```

推不动就是别人已经推过了，这一刻不归我。两个进程同时扫也只发一次，扫得勤一点只让它准时一点，不会多跑。游标按触发器各推各的，一条例行挂两个同刻到期的 cron 时两个进程可以各认领一个，这一层挡不住；同一刻只落一条记录由 `openRoutineRun` 保证：到点触发锁住例行行之后查这条例行有没有 `started_at` 等于这一刻的运行记录，有就不落。先到的事务锁着例行行直到提交，后到的推游标那条 UPDATE 排在它后面，轮到它时看得见先到的记录。记录在库里，两个进程各自认领、控制面重启都挡得住。这条凭据不能被历史裁剪裁掉：第二个调度器推游标那条 UPDATE 可能排在第一个的事务后面，等它轮到时，中间已经有 20 次更晚的试跑把同刻那条记录挤出前 20 条，查不到就再跑一次。所以 `started_at` 正好等于这条例行某个 cron 游标的记录不裁（`cursorMoments`）：后到的调度器排到时游标已经是这一刻，它查的就是这一刻。只认相等，不留「游标之后的一切」：周更、月更的例行配上 webhook 或试跑，游标之后一整个周期的记录都留着就封不了顶。还没对齐的游标为空，它认领的时刻一定晚于现在，现在库里没有要为它留的记录。留不住的一种：一个调度器推完游标、还没锁到例行行查重，另一个调度器把这个触发器的游标又推过了一刻，中间 20 次更晚的试跑把同刻记录挤掉，先前那个轮到时就再落一条。这要同一个触发器被推两次、间隔一整个 cron 周期，先前那个事务停了一整个周期还没提交，不另设防。

### 停机不补跑

`routines/cron.ts` 的 `dueMoment` 取的是空窗里**最晚**的那个 cron 时刻，不是最早的。停机三小时再起来，每分钟跑的例行任务只跑这一刻，不把错过的 180 次排队跑一遍。`lastFiredAt` 为空的（新建的、刚迁移上来的）在调度器 `start` 时和每次扫到时都对齐到现在，对齐不算触发，所以新建一条不会立刻跑。

停用的例行任务**照推游标但不跑**。不这样的话停用一周再启用，攒下的那一刻会立刻补跑一次。调度器看的是扫到时的状态，`openRoutineRun` 拿到执行者的锁后再锁例行行（`lockRoutines`，和看过、自停、转交、暂停同一道边界）重读一次，自动触发（到点、webhook）读到不是 `on` 就不落记录：同一刻到期的两个 cron，第一个收尾时例行凑满三次没人看自己停了，第二个不能再跑第四次。光重读不锁行挡不住两个进程：一个进程派第三条还没收尾，另一个进程认领同刻的第二个 cron，读到的还是 `on`，就落了第四条，所以到点触发还查同一刻有没有记录（上一节）。webhook 打停用的回 409。「停用」是 `state` 不为 `on`，手动停的 `paused` 和自己停的 `auto_paused` 一样对待，试跑不看 `state`，也不锁例行行。

### 运行记录

触发那一刻就落一条 `running`。选不到电脑时当场记 `failed`，note 是原因加「没跑起来」，比如「电脑不在线，没跑起来」，同时推一条 `stuck` 通知，不补跑。群里没有能派的 Bot 时也记 `failed`，note 是「群里没有能派的 Bot，没跑起来」，不推 `stuck`；接口上走不到这种群，这一条是兜底。派出去的等 `run_done` / `agent_error` / `approval_request` 到了再改状态补 note，每次改都推一条 `routine_updated`（整条例行任务带 runs，客户端整条替换）。控制面中途重启的运行会在电脑重新 hello 时对账收尾；电脑一直不再连接时仍停在 `running`。电脑断线、run 被放弃时（`abandonRun`），运行记录在放弃 run 的同一个事务里收成 `failed`，不放到提交之后：提交后再记，记的那一下出错时 run 已经收完，下次 hello 不会再碰它，记录就永远停在 `running`；同一个事务里出错整个回滚，run 还开着，下次 hello 或断线宽限到点再收一次。接口上每条例行任务只给最近 20 条（`listRunsByRoutine` 截），库里按 `started_at DESC, id DESC` 留 20 条裁掉其余（`trimRoutineRuns`，一次运行派发收尾之后另开一个事务做，不在落记录的事务里），但两种记录不裁：还在 `running` 的（run 行经 `routine_run_id` 指着它，裁了 `run_done` 的记账就撞外键，结果丢掉），和 `started_at` 正好等于某个 cron 游标的（上一段）。所以库里会多于 20 条，接口上还是 20 条。

**换电脑的接续属于同一次触发。** 例行 run 请求换电脑后，接续落行时带上旧 run 的 `routine_run_id`（`runs_routine_run_id_idx` 不唯一，一条记录本来就能对多条 run），所以接续里的审批照样有十分钟截止、`stop_and_tell` 照样停在「1 条等你点头」，报上来的 skill 卡照样丢掉，接续也按例行的边界和用途跑。运行记录的结局只由这条链最后一个 run 定：旧 run 结账和放弃都在锁住它那一行的事务里读 `continuesAfter`（标记还立着，或者已经有 run 的 `continues_run_id` 指着它），后面还有接续的，结账只把花费缀进 note、状态不动，放弃不记失败、不推 `stuck`，不带 runId 的报错落到它身上、它的审批失效（`failRoutineRunOf`）也不记失败，同样锁住 run 行再读；反过来，这两种先落下、记录已经是 `failed` 的，同一个 run 再请求换电脑回 `routine_failed`，`requestSwitch` 锁的是同一行，两边谁先到谁算，「子段做成了、记录却停在 failed」不会出现。不带 runId 的 `runner_failed` 在运行器那边都只记日志、不终止运行（关 MCP、销毁会话、关浏览器、对账 skill、写 WorkMirror 等），run 的结局另由 `run_done` 或带 runId 的报错报，但控制面分不出它是哪一种，所以不改记失败的规则，只在换电脑这一侧挡住；等接续结账才记成 `ok`，note 是两段花费，比如「¥0.80 · ¥1.60」。记成 `ok` 是一条 `WHERE status = 'running'` 的条件 UPDATE，记录已经被别处收成 `failed`（比如接续里的审批先失效了）的，结账只缀花费，不改状态。认领标记要等这把行锁，所以结账读到的结论到提交前不会变。链在起接续之前断了，收尾在 `agent/continuation.ts` 的 `breakContinuation` 里和认领标记同一个事务，`ChainBreak` 定状态和 note：接续派不出去，`failed`，note 是群里那句的原因加「换电脑后没接着做」；从读群、读任务卡、读成员这些准备查询到落新 run 的事务提交，这一整段抛错都算没建出来（`dispatch.ts` 的 `breakChainOnError`），事务回滚了标记跟着回到立着，接住这次失败再认领一次，认领得到就说明接续确实没建出来，`failed`「派活出错，换电脑后没接着做」，提交之后的推送和发件出错不走这条；派起它的那条消息换电脑后读不到了（删了，或对执行它的 Bot 不可见了），`failed`「换电脑后读不到派起它的那条消息，没接着做」，`pendingContinuation` 不跳过这种标记，交给起接续的地方收尾；执行它的 Bot 已经不在群里，或者群里一个 Bot 都没了，`stopped`「换电脑后执行它的 Bot 不在这个群里了，没接着做」。收成 `failed` 的这一下给主人推一次 `stuck`「例行任务「名字」没跑完：原因」，他多半不在群里；`stopped` 的两种是主人自己动的手，不推。主人在群里插话时旧 run 已经结束的，`clearGroupContinuations` 收成 `stopped`，note「换电脑后你在群里插了话，没接着做」；旧 run 还没结束的不额外处理，它结账时标记已经清了，照常收尾。删 Bot 不用另管：转交例行时还在 `running` 的记录在同一个事务里记「执行者已删除，这次没跑完」。这些收尾都走 `settleRoutineRun` 的 `WHERE status = 'running'`，和别的收尾谁先到谁算。note 的格式是「状态短句 · 各段花费」，`settleRoutineRun`、`failRoutineRun`、`noteRoutineRun` 和删 Bot 的转交都只换开头那句状态短句，前几段已经缀上的花费留在后面，比如「换电脑后没接着做 · ¥0.80」；停在「1 条等你点头 · ¥0.80」的那条审批失效了是「审批已失效 · ¥0.80」，不是在前面再叠一句。状态短句不以 ¥ 开头、自己不带「 · 」，`withStatusNote` 靠这个把它和花费分开。

例行做完不推通知，只有没跑成、卡住的才找人：到点派不出去、跑到一半电脑断线推 `stuck`（见「系统通知」），中途报错、审批失效把记录收成 `failed` 的那一下（`failRoutineRunOf`）推一条 `failed`「例行任务「名字」没做成：原因」，已经是 `failed` 的不再推。早先每次做完都弹「做完了」，例行一天几条，通知就成了噪音，结果反正在群里。`routine_runs.has_result` 是那时候留下的列，已经没人读写，等下一次迁移删掉。例行不能建在牌桌群上：牌桌群只认出牌按钮。`repo/routines.ts` 的 `insertRoutine` 是手建（`POST /api/bots/:id/routines`）和点「加上」确认卡（主助理 `propose_routine` 的卡可以指向任何自己的群）共用的落库，在同一个事务里查到目标群是牌桌就不插，两条入口都回 400「牌桌群里不能建例行任务」，确认卡留在 offered。旧数据里已经绑在牌桌群上的，换电脑后牌友被换下就走上面「Bot 不在群里」那条。

收尾要从 `run_id` 找回运行记录，两条路里选了**在 `runs` 上加 `routine_run_id` 可空列**，没用 `routine_runs.run_id`：run 行是 `startRun` 建的，派活时把 `routineRunId` 一路带进去，行一生下来就带着这条边。反过来先建 `routine_runs` 再回填 `run_id` 的话，派活到回填之间有个窗口，活跑得快的时候 `run_done` 进来会查不到边。

webhook 的 token 存在 triggers jsonb 里，`/api/hooks/:token` 用 `@>` 配 GIN 索引直接查，**没有单独的 `webhook_tokens` 表**：token 只由控制面的 `randomBytes(16)` 发，客户端在 `TriggerInput` 里只能带回这条例行任务已有的那个，别的都换新，所以撞号得赢 128 位随机数，一张表换来的唯一约束挡不住任何现实中的路，反倒多一条要同步的边。

### 三态：自己停、看过、归档

`state` 有三个值：`on`、`paused`（用户停的、项目归档停的）、`auto_paused`（没人看自己停的）。恢复就是 `PATCH` 成 `on`，两种停都一样。

**连着三次没人看就自己停。** 每次运行收尾之后（`run_done` 结账提交后、`agent_error` 或断线收尾、审批停下、派不出去当场记失败、派发抛错收成失败、删执行者把还在跑的收成失败）调 `autoPauseIfUnseen`：取最近三条已结束（`status <> 'running'`）的运行，按 `started_at DESC, id DESC`，三条的 `seen_at` 都为空就 `UPDATE ... SET state = 'auto_paused' WHERE id = ? AND state = 'on'`。只认 `on`，手动停的不会被改成自己停的，重复收尾也只转一次。停下的那次和这次收尾合成一次 `routine_updated`。两条收尾并发时各推一次，快照相同，客户端按 id 覆盖，重复无害。

**看过。** `POST /api/groups/:id/seen` 把落进这个群的例行（`group_id` 指着它的，加上它是单聊时那个 Bot 不带群号的）里已结束、`seen_at` 为空的运行盖上 `now()`，回 204，对盖了章的每条例行推 `routine_updated`。别人的群和不存在的一样回 404。看过只重新起数，不把 `auto_paused` 改回 `on`。

**看过和自己停排成一队。** 自停改的是 `routines`，看过改的是 `routine_runs`，单条 UPDATE 互不相挡：自停那条语句在等例行行锁时，读 `routine_runs` 的子查询用的还是语句开头的快照，看不见刚提交的 `seen_at`，就会把用户刚看过的例行停掉。所以两边共用一个锁边界 `lockRoutines`：事务第一句 `SELECT ... FOR UPDATE` 锁住相关例行行（看过涉及多条时按 id 升序），锁到之后再用一条新语句读最近三条或盖章。READ COMMITTED 下新语句拿新快照，看得见先锁到的一边已经提交的结果。谁先锁到谁赢：看过先，自停就看见已读不停；自停先，就停下，看过随后只盖章。改写仍保留 `WHERE state = 'on'`。建运行记录的插入要对例行行拿 `FOR KEY SHARE`，和 `FOR UPDATE` 相斥，只是排队：触发的事务只插不裁，插入之前不持有任何运行记录的锁，排不成环。裁剪（`trimRoutineRuns`）和删整条例行（`deleteRoutine`）都要删运行记录，删记录经 `runs.routine_run_id ON DELETE SET NULL` 隐式改 run 行，结账是先按 id 升序锁 run 再改运行记录，直接删就是反序，两边各拿一半，试跑回 500、结账报 40P01。所以两者都先把要删的记录名下的 run 按 id 升序 `FOR UPDATE` 锁上再删，和结账同序，后到的排队。预锁和删之间不能再出生指着这些记录的 run，而能建这种 run 的不只执行者：项目群里执行者答完 @ 同群的另一位，那位的 run 带着同一条记录；`startRun` 查成员表，不是成员建不出。所以两者的事务第一步是 `lockRoutineWriters`：锁住执行者、例行所在群的全部成员和这个账号的主助理，按 Bot id 升序拿排他 advisory 锁（和删 Bot 同一把，`startRun` 拿的是它的共享版），锁完重读名单，没有新面孔才往下走。这份名单只在删 Bot 里变（成员被级联删掉、例行转给主助理、主助理补进项目群），删 Bot 持着被删那位的排他锁，和这里互斥；在本分支里能加进来的只有主助理，而它从第一轮就在名单里，所以重读只会少不会多，不会持着几把锁再去拿 id 更小的一把。已知项：合入 int 之后，建队确认会往已有的项目群里加成员，这条路径不拿 Bot 的 advisory 锁，新成员可能在重读之后、删除或裁剪落地之前带着这条记录建 run，名单这时就多了一位。最坏是一次 40P01 被回成 500，不丢数据，建队代码这一轮不改。触发的事务持着执行者的共享锁，升不成排他，裁剪因此不在它里面做，而是派发收尾之后另开一个事务。这个事务失败只记日志，不往外抛：活已经派出去了，回 500 会让 webhook 平台重试、重复派活，裁剪失败只是多留几条记录，下次裁剪收回。之后再锁例行行，再按 id 升序锁记录名下的 run，最后才删。全局锁序就是账号 advisory → Bot advisory（id 升序）→ 例行行 → run（id 升序）→ 运行记录。删 Bot 时级联删例行再删运行记录也是这个顺序，它开头 `lockRunsOfBot` 已经把这些 run 锁上。`test/routines.test.ts` 的两条竞态用例用一条 `FOR NO KEY UPDATE` 的连接扣住例行行，按 `pg_stat_activity` 看两边依次排上锁，再放开，钉着两种先后。

**项目归档停它的例行。** 任务卡改成 `done` 时，`updateTask` 在同一个事务里先把这个群里 `state <> 'paused'` 的例行改成 `paused`，再改任务卡，改了的逐条推 `routine_updated`。自己停的也一起改成 `paused`，归档是用户的决定。先例行后任务卡，和删 Bot 的顺序一致，反过来两边会各拿一半，报 40P01。

**改多条例行的都先按 id 升序锁行。** 归档（`pauseGroupRoutines`）和删 Bot 的转交（`transferRoutines`）改的都是一批例行，一条 `UPDATE ... WHERE group_id = ?` 按执行计划的顺序锁行，和看过按 id 升序锁的顺序不一定一致，两边各拿一半就是 40P01。所以这两处也走 `lockRoutines`：先 `SELECT ... ORDER BY id FOR UPDATE` 锁住要改的行，再用一条新语句 `UPDATE ... WHERE id IN (...)` 改，顺序和看过一样，只会排队不会成环。`test/routines.test.ts` 用一个 `BEFORE UPDATE` 触发器把归档和转交扣在 UPDATE 改到 id 大的那条行时，这时看过从 id 小的那条开始排队锁，钉着两边都不报 40P01；触发器在 `finally` 里删掉。

### 删 Bot 时的例行

执行者被删，它的例行不跟着删，在删除事务里转给主助理（`transferRoutines`），转走的逐条推 `routine_updated`。转交必须在删 Bot 行之前：`routines.bot_id` 是级联删除。挂在它单聊上的例行改成不带群号，以后发进主助理的单聊，否则单聊被级联删时例行也会被删掉。挂在项目群上的保留群号，照旧发进原群。主助理不在那个群就补成主助理成员（`joinGroups`），排在现有成员后面。已经在群里的靠 `group_members` 主键配 `ON CONFLICT DO NOTHING` 不动，同一个群挂几条例行也只加一次。被删的这位本来就是那个群的成员（建例行时校验过），它腾出的位置正好给主助理，群不会超过 6 个。补成员放在删 Bot 行之后：锁序是 Bot 行在前，群行和成员在后，多个群按群号升序插。没有用自动重试吞 40P01。不补的话派活只从群成员里找执行者，转交后的例行每次都记「群里没有能派的 Bot」，连着三次又会自己停。也不把项目群号一律置空，那样项目的例行就跑到主助理单聊里去了。

**建例行和触发都要拿执行者的共享锁。** 删 Bot 事务先查到要删的是自己的成员 Bot，碰任何别的行之前拿这个 Bot 的排他 advisory 锁（`lockRunsOfBot`），`startRun` 建 run 行拿的是同一把锁的共享版（`shareBotRunsLock`）。建例行（`createRoutine`）和触发（`openRoutineRun`，cron、webhook、试跑都走它）也拿共享锁，锁到之后再用一条新语句确认：建例行重查 Bot 还在并且归属这个用户，不在就回 404，不插；触发重读这条例行此刻的执行者和群，按读到的派发，执行者变了就对新执行者再锁一次再读，例行没了就不建运行记录。没有共享锁时两种顺序都坏：删除先转交再提交，期间来的建例行预检过了、插入时外键撞 23503 报 500，或者插进去又被级联删掉；触发读到旧执行者的单聊之后删除提交，消息插进已经不存在的群。有了锁，删除等建例行或触发提交后再扫，新例行一起转给主助理；反过来建例行和触发等删除提交后再读，看到的是转交后的样子。运行记录和两条消息在触发的同一个事务里落，记录落了之后派发抛错也要收成 `failed`（「派活出错，没跑起来」），不留 `running`，收完照样过三次没人看的判断、推一次 `routine_updated`，再把错往外抛。派活抛错有两种样子：派发前置的查询抛出来，`runRoutine` 的 catch 接住；建 run 的事务在回合里抛，`GroupTurns` 收轮、群里留一句之后把 `failed` 作为开轮结果传回，`dispatchUserMessage` 回 `failed`，`runRoutine` 按没派出去收尾。早先回合把它和别的收轮一样报成 `stopped`，派发把它当成 `sent`，记录就一直停在 `running`。

**删执行者时还在跑的运行记录当场收尾。** 转交时把这些例行里 `status = 'running'` 的运行记录改成 `failed`，note 是「执行者已删除，这次没跑完」，提交后对转走的每条例行先过三次没人看的判断再推 `routine_updated`：这次收尾也可能正好是第三条没人看的，和别的收尾一样自己停。锁序是例行行在前、运行记录在后，和看过、自停一致。迟到的 `run_done` 查不到属于这台电脑这个 Bot 的 run，照旧静默丢弃，不会把它改回去。

**删完推群快照。** 主助理补进去的项目群和被删的这位当首席的项目群（首席由外键置空）成员名单变了，删除事务提交后对每个群推一条现成的 `group_updated`（整份群快照），同账号的每条 `/api/ws` 连接都收到，在线的项目页才换得掉成员和首席，没有新的推送类型。

## skill

Bot 会做的一件活。**真相源是控制面的 `skills` 表，方向只有一条：随 `config` 下发，运行器落成 `<botDir>/skills/<skillId>/SKILL.md`，不往回同步。** 两个方向都能写的文件没有真相源：运行器改了一笔、Web 上同时改了一笔，谁覆盖谁只取决于哪条消息先到。`config.skills` 是该用户**全部** Bot 的 skill，运行器按 botId 分开落盘；这个字段恒带，一条都没有也带一个空数组，运行器靠整份名单和 skills 目录对账，省掉它它就分不清「这个用户没有 skill」和「这条 config 没说 skill 的事」，剩下的目录就删不干净。

**网页上只能看，不能配。** 加、改、删都由 Bot 在对话里出一张 `skill_offer` 卡，用户点了才动表；Bot 页头「它知道的」列出每条的步骤、来源和用过几次。`POST /api/bots/:id/skills`、`PATCH`、`DELETE`、`copy` 这几条 HTTP 路由还在，测试和验收脚本用它们造数据，Web 不再调。从公开仓库装的 skill 在 `skills.origin` 记下原链接（只收 http 和 https），界面上点得开；导出带它，分享模板不带。

### 同一 Bot 下名字不重复

唯一索引 `(bot_id, name)` 是这件事的唯一真相源。建一条、改名、复制给别的 Bot、点存、点改，几条路都靠**写入撞它**来判 409，不先查后写：先查后写挡不住并发的两个同名请求，两边都查到没有，两边都插进去。重名必须在库这一级挡死，因为 Pi 按 name 去重，同名的第二条根本不会进系统提示，库里留着它只会让用户看见一条永远跑不起来的活。

点存撞名时**卡留在 offered**，让用户先改名再点。所以那个事务只能整条回滚，不能只插一半：卡和 skill 行要么一起成，要么一个都不动。撞名和「已经点过了」都走 `tx.rollback()`，而它抛的是同一种错，所以是谁回滚的记在事务外的一个变量上，路由层照它翻 409 的文案。

### 那张卡的状态住在正文里

和审批、交接**相反**。审批和交接的卡正文里只有一个 id，状态在 `approvals` / `handoffs` 自己那一行上，所以重推那条 message 一个字都不会变。skill_offer 不是这样：卡上的 `change` 在用户点之前**不在任何表里**，只在正文里，状态没有别的地方可住。点完要**重推那条 message**，客户端按 id 覆盖那张卡。

`change` 是按 `op` 分的判别联合，一张卡只做一件事：`add` 带 `name`、`steps`、`origin`（有原链接就是装的，没有就是存刚才的做法）；`edit` 带 `targetId`、出卡时那条的名字 `fromName` 和改成什么（`name` 和 `steps`），卡上照正文写「旧」→「新」，那条改完、删掉之后历史卡也读得出改的是哪条；`remove` 带 `targetId` 和当时的名字。`status` 三种 op 共用（offered / saved / dismissed），saved 对 edit 是改了、对 remove 是删了，界面文案按 op 查表。`skillId` 对 add 指新插的那行，对 edit 指被改的那行，对 remove 恒为 null：删掉的行不在了，指着它的 id 没人能用。

`decideSkillOffer`（`repo/skills.ts`）按 op 穷尽分派，改 skills 表和收卡在同一个事务里：add 插行，撞名 409、卡留 offered；edit `UPDATE ... WHERE id = targetId AND bot_id = botId`，撞名 409，目标已经没了 409「这个技能已经不在了」，卡都留着；remove 直接 `DELETE`，目标已经没了照样收成 saved，用户要的就是它不在，终态一致。edit 不动 `use_count`、`source`、`origin`，改的是同一件活的做法。

旧卡正文只有 `{name, steps}`，迁移 `0046_skill_offer_change.sql` 把它们包成 `change: {op: "add", name, steps, origin: null}`。

幂等同样不靠先查后写，靠那条 UPDATE 自己：`WHERE id = ? AND group_id = ? AND body->>'status' = 'offered'`。两个并发的点存只有一个改得动，另一个看到 0 行就是 409。

### 哪些 `skill_offer` 不落卡

这几种整条丢掉，不报错：例行 run 报上来的，三种 op 都丢（例行本身就是重复做的活，没人在场点卡）；add 里这个 Bot 已经有同名 skill 的，或者这个群里还有一张同名、还没点的 add 卡的（不管是哪个 Bot 问的）；edit 和 remove 里 `targetId` 不是这个 Bot 的 skill 的（外部输入，可能指到别的 Bot 头上），或者这个群里同一个 `targetId` 已经有卡没点的。除例行外都在 `whileRunOpen` 的同一个事务里查（`repo/skills.ts` 的 `skillOfferUnwanted`），读卡带上被派 Bot 的 viewer。查和插不是原子的，并发的两张同名卡可能都落下，用户点了一张、另一张存时撞唯一索引回 409，不会多出一条 skill。什么时候该问由运行器的系统提示管：只在用户要过同一类活、或明说以后也这样做时问，见 `packages/bot-runner/README.md`。

### `skill_offer_source` 为什么在 `messages` 上

来源有五种。`template` 是从分享模板建 Bot 时带来的；`taught` 是 `POST /api/bots/:id/skills` 写死的，Web 上「教它一个」那条路拆掉以后只剩旧数据和测试造的数据；剩下三种只有**上行那一刻**判得出来：`change.origin` 不为空就是 `installed`，否则看这个 `runId` 能不能找到一条 `routine_runs`，找得到就是 `routine`，找不到就是 `chat`。现在例行 run 报上来的卡整条丢掉（见上一节），新卡只会是 `chat` 或 `installed`，`routine` 留给旧数据。这一列只对 add 卡有意义，edit 和 remove 不改来源。用户点存时手上只有那张卡，卡的正文里没有 runId，例行任务的运行记录又只留最近 20 条，早的那次连行都不在了。shared 的 `skill_offer` 正文里没有 source 字段，形状是冻的，塞不进去。所以单开 `messages.skill_offer_source` 一列存着它，点存时写进 skill 行。这一列只对 `kind = 'skill_offer'` 的行有意义，不出边界，`toMessage` 不读它。M10 之前落的卡读不到这一列，按对话算。

### `/名` 引用

`POST /api/groups/:id/messages` 落库推完那条消息之后解析一遍正文，命中的 skill `use_count` 加一。**控制面不改写正文**，运行器收到的和用户手打的一模一样，Pi 自己按名字找那份 SKILL.md。

解析规则和 `@` 完全一样，公共的那段就是 `agent/routing.ts` 的 `scanNames`：名字长的先试（「/小销售」不会先命中「小销」），名后必须跟空白或行尾，按索引扫不拼正则（skill 名里可能带正则元字符）。两处的差别只有两点：`@` 在单 Bot 群不解析，`/名` 在单 Bot 群照样算；`@` 认的是群成员，`/` 认的是群里全体成员 Bot 的 skill，按 `group_members.position, skills.created_at, skills.id` 排。

**每个 `/` 位置最多认一条。** 同名的 skill 跨 Bot 可以重名，但 Pi 按 name 去重，同名的第二条根本不会进系统提示，所以只给排在前面的那一条计数，和真正跑起来的那一条对得上。

### 哪个动作推什么

| 动作                        | 推送                         | 重发 config                                |
| --------------------------- | ---------------------------- | ------------------------------------------ |
| `POST /api/bots/:id/skills` | `skill_updated`              | 是                                         |
| `PATCH /api/skills/:id`     | `skill_updated`              | 是                                         |
| `DELETE /api/skills/:id`    | `skill_deleted`              | 是                                         |
| `POST /api/skills/:id/copy` | `skill_updated`（新那条）    | 是                                         |
| 上行 `skill_offer`          | `message`                    | 否，还没动 skill 行                        |
| add 卡点「存」              | `message`、`skill_updated`   | 是                                         |
| edit 卡点「改」             | `message`、`skill_updated`   | 是                                         |
| remove 卡点「删掉」         | `message`、`skill_deleted`   | 是                                         |
| 三种卡点不要                | `message`                    | 否，什么都没变                             |
| 正文里 `/名`                | 每条命中一条 `skill_updated` | 否，只有 `use_count` 变了，它不进 SKILL.md |

## 账号

`accounts` 一行是一个用户挂在某台电脑上的一个平台账号。`login` 有三个值：`none` 是还没登录的占位，`valid` 已登录，`expired` 登录过期。`login_changed_at` 跟着 `login` 一起写，取库时钟 `clock_timestamp()` 而不是控制面进程时钟，建占位时等于 `created_at`，今天页过期那行的时间取它，写的是「什么时候过期的」而不是「什么时候加的」。`login_generation` 是浏览器登录的会话代次，电脑每报一次登录成功（`markLoginValid`）加一，`valid` 重登到 `valid` 也加，它只用来对发布结果，不进 `Account`。今天页哪些账号出行见「用量、今天与通知」一节。

### 两种连法：接口授权和电脑浏览器登录

`accounts.via` 是这个号怎么连上的，`api` 是 OAuth 授权、控制面拿令牌调平台接口，`computer` 是在某台电脑的助理 Chrome 里登录、发布由那台电脑的浏览器做。小红书只有 `computer`，GitHub 只有 `api`，X 两种都有，同一个 X 号两种都连上就是两行，各自一个 accountId，表上的唯一索引和占位索引都带 `via`。库约束钉着：小红书必须是 `computer`，GitHub 必须是 `api`，`computer` 的号不能是 `direct_publish` 档。可直接发布等于不经人看就让 Bot 用这台电脑上的登录态往外发，浏览器发帖又可能被平台当成自动化操作，所以 `PATCH` 改档到 `direct_publish` 回 400，`setAccountTier` 按 `via` 判，不按平台。

建在哪由入口决定，不由平台决定：OAuth 回调和 `account-add` 建 `api`，`POST /api/accounts` 建 `computer`。按电脑登录（`POST /api/accounts/:id/login`）、`login_state`、今天页的登录过期行都只认 `computer` 的号；`api` 的号的 `login` 只跟着凭据代际走。

发布按 `(platform, via)` 查 `publish/platforms.ts` 的 `PUBLISHERS` 一张表，不再按平台散着判。`api` 一格是控制面里调平台接口的函数（GitHub、X），`computer` 一格是 `{ host, manageUrl, maxImages }`（小红书、X），发布循环认领到的草稿带着账号的 `via`，`computer` 的下发 `publish_draft` 给账号所在电脑，`api` 的在控制面直接发。一条最多带几张图也写在这张表上（`maxImages`）：`api` 的是 0，电脑上的 X 是 4，小红书是 9，超了起草和批准都拒，免得人批了一张到电脑上才发不出去的卡。电脑报回来的帖子链接只认 https、默认端口、主机是这一格的 `host` 或它的子域，别的换成 `manageUrl`。X 的 `host` 只写 `x.com`，不认 `twitter.com`：发布器读的是发完 X 自己弹的 toast，现在都是 `x.com` 链接，多认一个域就多一个能被页面塞进来的地方，读错了只是落成主页链接。

### 加浏览器登录的账号

`POST /api/accounts` 带 `{ platform, computerId }`，`platform` 是小红书或 X，建一行 `via='computer'`、`login='none'`、`handle` 为空的占位。电脑必须是本人的，别人的或不存在的回 404，本机和远程电脑都能挂：登录页经画面摆到网页上给人操作，远程电脑上的 Chromium 画在 Xvfb 里也一样能登。一个人每个平台每种连法最多一个占位，靠表上 `(owner_id, platform, via) WHERE login='none'` 的部分唯一索引收敛：重复加走 `ON CONFLICT DO UPDATE`，回已有那行（200，新建是 201），不先查后写。已有的占位可能挂在另一台电脑上（先在本机加了没登，又在远程电脑上加），冲突时把 `computer_id` 改成这次选的电脑：占位还没登录，哪台电脑上都没有它的登录态，用户再加一次就是要在那台上登。之后点登录发到新电脑；旧电脑上还在进行的那次登录报回来时账号已经不在它上面，按下面的规则整条丢掉。建完推 `account_updated`，再给这个用户重发 `config`。

### 打开登录窗口

`POST /api/accounts/:id/login` 带 `{ attempt }`。`attempt` 是页面为这一次点击取的号（`LoginAttemptId`，1 到 64 位安全字符），卡片一点就带着它，不等 202。依次判：账号不是本人的回 404，平台不走浏览器登录回 400，请求体不合 `{ attempt }` 回 400，账号所在电脑此刻没有连接回 409。放行时只给账号所在那台电脑发 `browser_login { accountId, platform, attempt }`，接口立刻回 202 和 `{ account, attempt }`，`account` 是账号当前的样子，`attempt` 原样带回。电脑在助理 Chrome 后台开平台的登录页，交给电脑上的屏，经上面「画面面」报一个 `purpose: login` 的会话，网页按 `attempt` 认领这个会话、打开画面，人在画面上扫码或输账号密码、验证码，本机和远程电脑一样。电脑自己每 250ms 查一次页面上出没出现已登录的标志，查到就撤回画面、关掉登录页，报 `login_state valid`。人在画面上点放弃、或者同一个账号又点了一次登录把这次顶掉，电脑不报，画面的 `closed` 就是结论。登录页没了或画面没展示出来报 `failed window_failed`；从收到 `browser_login` 起 15 分钟还没登上报 `failed timed_out`，等 Chrome 起来、人在画面上操作都算在这 15 分钟里。登上随 `account_updated` 推给页面，没成推 `login_failed` 带同一个 `attempt`。

`attempt` 只做页面上的关联，不是权限：控制面不存、不签发、不查重，只在边界校验格式，原样转给电脑、原样推回页面。页面按 `accountId` 和 `attempt` 一起结算那张卡，所以再点一次之后，上一次点击的失败晚到也不会把新的一次记成没成。账号归属在 HTTP 这边按会话用户查，在上行那边按电脑主人和账号所在电脑查，乱填别人的号进不来。

### `login_state` 三个分支

三个分支都先校验账号属于这台电脑的主人、登在这台电脑上，不成立整条丢掉，同一个用户的另一台电脑报也不认。账号还必须是在电脑浏览器里登录的（`via='computer'`）：接口授权的号（GitHub，和授权连上的 X）的 `login` 只跟着控制面的凭据代际走，电脑报上来的 `valid`、`expired`、`failed` 一律丢掉，账号状态和代际都不动。不然一台认证过的电脑就能把一个凭据已死的号报回 `valid`，或者在重新授权之后把新一代报成过期，绕过下面的不变式。

- `valid{handle}`：写 `login='valid'` 和 handle。同一台电脑、同一平台已经有这个 handle 的行（比如以前过期的那行），就在一个事务里把那行改成 `valid`，把占位上的草稿挪到那行，删掉占位，推 `account_deleted` 再推那行的 `account_updated`。表上 `(computer_id, platform, via, handle)` 的唯一索引保证不会多出第二行。收尾给用户重发 `config`，运行器按它放行可直接发布的账号。
- `expired`：`UPDATE ... WHERE login = 'valid'` 记成 `expired`，推 `account_updated` 和一条 `failed` 通知，重发 `config`。已经过期或还没登录的行不命中这条 UPDATE，重复报不再通知。
- `failed{reason, attempt}`：登录窗口没成，`accounts.login` 不动。原因和库时钟时刻写进 `login_failure`、`login_failed_at`（账号上的 `lastLoginFailure`，只留最近一次，表上 CHECK 保证两列成对），推 `account_updated`，页面刷新、换设备或当时没开着都还看得到；`valid` 落库时两列一起清空。这次写和上面两种一样在账号行锁里带连接代次，连接已经被顶掉就不落库也不推 `account_updated`。然后推 `login_failed { accountId, attempt, reason }`，`attempt` 原样带回 `browser_login` 里的那个，页面靠它结算对应那次点击的卡；再推 `failed` 通知给人看，见下面通知一节。这两条只说那一次尝试，不看连接代次。

### 过期隔离和重登收敛

发布循环 `claimDueDrafts` 只抢 `login='valid'` 账号的到点已批稿。账号一过期，它的稿子留在已批，不再下发，别的账号照发。重新登录成 `valid` 后（不管是更新原来那行还是新占位并进原来那行），这些稿子下一轮照常被抢，过了排期很久的也会补发。例外是控制面重启：`reopenMissedDrafts` 会把停机期间错过的定时稿打回待批，但跳过 `login` 不是 `valid` 的账号，过期账号的稿子不算停机错过，照样留在已批等重新登录。

发布路径自己发现过期也记账号：草稿因 `login_expired` 失败（电脑回的 `publish_result`、平台回 401/403、令牌缺失三处），`settleFailed` 在同一个事务里把草稿记失败、把账号按上面同一个 `markLoginExpired` 记成 `expired`。用户只收到一条通知，就是草稿那条「某平台上的「标题」没发出去：账号登录过期了，重新登录后让 Bot 再起一稿」，账号这边只推 `account_updated`、重发 `config`，不再加第二条。电脑自己报 `expired` 时没有草稿可挂，才用账号那条「小红书账号「handle」登录过期了，这个账号的稿子先不发，到账号页重新登录」。两条哪条先到就是那一条：`markLoginExpired` 只认 `login='valid'`，后到的那条发现账号已经是 `expired`，账号不改、不推 `account_updated`、不重发 `config`，也不再发通知；后到的是草稿失败时草稿照样结算成失败，只推 `draft_updated`。发布结果记过期还绑着认领时那一代登录。电脑发的草稿（小红书）没有控制面凭据，认领那条 UPDATE 把账号当时的 `login_generation` 抄进 `drafts.claimed_login_generation`（和 `login = 'valid'` 是同一行同一刻看到的），结算时同一条 UPDATE 另要求 `accounts.login_generation = 草稿的 claimed_login_generation`。用代次不用时刻：`valid` 重登到 `valid` 时 `login_changed_at` 不动（它是给今天页看的），代次每次登录成功都加一。这列加上之前认领的旧稿子 `claimed_login_generation` 是 null，结算时退回基底的 `login_generation = 1 AND login_changed_at <= claimed_at`（见「唯一锁序」）。这条规则有代价：新控制面已经把账号推进到第 2 代之后，滚动升级期间的旧控制面认领草稿时写不出 `claimed_login_generation`，这些草稿回来的真 `login_expired` 都因代次不是 1 退成已知，账号留在 `valid`、不推过期通知。旧实例每认领一次都可能这样漏报一次真实过期，直到旧实例排空；之后新实例认领带上当前代次，再遇到过期就照常记。选它是因为反过来更坏：把重登之后的新会话误标过期，会让一个能用的账号停发、让用户白跑一趟重新登录。走控制面凭据的草稿（GitHub、X）只按下一节的代际条件。认领之后账号已经重登成 `valid` 的，不管中间有没有经过 `expired`，旧那次回来的 `login_expired` 只把草稿记失败、推 `draft_updated`，账号保持 `valid`，不推过期通知、不重发 `config`。

过期推的是 `failed`，不是 `stuck`：`stuck` 每人一段离线期只推一次，是给电脑掉线的，混进来会和掉线那条互相吞。

### 授权：连 GitHub、连 X

`GET /api/oauth/:platform/start` 要登录。平台不是 github 或 x 回 404，这家没配应用回 503（「管理员还没配 GitHub 应用」）。放行时生成 state 和 PKCE verifier（S256，GitHub 也带），在 `oauth_states` 记一行 `(state, owner_id, platform, code_verifier, expires_at)`，十分钟有效，302 到平台授权页。这张表有上限：插入那个事务先按 `expires_at` 的索引删掉已过期的行，再把同一个人同一个平台超出最新 5 条的删掉（过滤和排序走 `(owner_id, platform, expires_at desc, state desc)` 复合索引，不随全站 state 行数扫全表）（`createOAuthState`，在 `pg_advisory_xact_lock('oauth-state:<ownerId>:<platform>')` 里做，并发点几次也越不过 5 条）。开五个标签页同时授权都能回来，第六个把最旧的挤掉。回调地址是 `<WEB_BASE_URL>/api/oauth/:platform/callback`，`WEB_BASE_URL` 不设就用 `PUBLIC_BASE_URL`，两个都没设就是实际监听的 localhost 端口，浏览器到不了，所以部署要设 `WEB_BASE_URL`。

回调也挂在 `/api` 下、要登录。session cookie 是 `SameSite=Lax`，平台跳回来是顶层 GET，cookie 照带。第一步是一条 `DELETE FROM oauth_states WHERE state=? AND owner_id=? AND platform=? AND expires_at>now() RETURNING code_verifier`：state 只认发起它的那个人，别人发起的授权链接落到这个人的会话上拿不到 verifier，平台号不会挂错人；同一个回调被打两次，只有第一次删得到。用户在授权页点了拒绝，这个 state 也跟着作废。之后拿 code 和 verifier 换令牌、调「我是谁」取 handle，在一个事务里挂账号、存令牌，推 `account_updated`、重发 `config`，302 回 Web 首页，带 `?oauth=<平台>&result=<connected|denied|invalid_state|failed>`。`failed` 只说换令牌、取 handle 或挂账号的事务没成；事务提交之后账号就是连上了，推送和重发 `config` 只是通知，出错只记日志，页面照样 `connected`。

令牌端点（换授权码和刷新共用）单独 10 秒超时，别的平台请求是 30 秒；刷新时有请求在等它，令牌端点只回一小段 JSON，10 秒还没回就当这次连不上。换授权码有自己的失败口径：令牌端点回 400、401，或者 200 带 `error`，都算这个授权码不认，回 `result=failed`，用户回账号页再点一次就是新的授权码，所以不细分错误码；5xx、超时也落 `failed`。它和刷新不共用判断，刷新的判断见下一节。

账号挂哪台电脑：有远程电脑挂远程电脑，没有就挂本机。读和发都走控制面，电脑只决定账号在账号页上归哪台，Bot 常驻在远程电脑那边。重连同一个 handle 不多出一行：同一人、同平台、同 handle 已有的行（优先挂在目标电脑上的那行，其次最早的那行）挪到目标电脑，旧令牌整行覆盖，`login` 由写凭据的 `saveGrant` 改回 `valid`（原本就是 `valid` 的不动，`login_changed_at` 也不动）。唯一索引按电脑建，拦不住同一个号在本机和远程各建一行，第一次授权时也没有现成的行可锁，所以挂账号的事务先拿 `pg_advisory_xact_lock(hashtextextended('oauth-account:<ownerId>:<platform>', 0))`（`lockOwnerPlatform`），同一人同一平台的回调排成一队，选电脑也在锁里。开发用的 `addAccountWithToken` 也先拿同一把锁再挂账号，所以同一个外部账号收敛到一行对这两条会新建 GitHub、X 账号行的路径都成立：account-add 在本机挂号还没提交时授权回调进来，回调排在锁后面，醒来看到那行，把它挪到远程电脑。反过来授权回调先在远程挂了号还没提交时 account-add 进来，account-add 排在锁后面，醒来先按人、平台、handle 找已有的行（`findOwnerAccount`），找到就在那一行上写凭据，电脑不动，找不到才在本机建行。电脑不挪回本机：account-add 选本机只是因为脚本没有别的可选，授权回调挂远程是有意的（Bot 常驻在那边），挪回去会让这一行随谁后到在两台电脑之间来回换。锁是事务级的，提交或回滚就放；会话级的锁会留在连接池的空闲连接上，下一条回调换一条连接就卡住。过期稿子因此跟着回来，走上面「重登收敛」同一条路。

令牌 AES-256-GCM 加密进 `account_credentials`，密钥是 `CREDENTIALS_KEY`。访问令牌、刷新令牌和两个过期时间各一列，另有一列 `generation`（代际），用法见下一节末尾。`account-add` 脚本还在，只给开发用：它只存访问令牌，没有刷新令牌，过期了控制面刷不了。挂账号和存令牌走 `addAccountWithToken`，一个事务，先拿 `oauth-account:<ownerId>:<platform>` 的 advisory lock、在锁里选行、再进 `withAccountLock`，顺序和授权回调一样；e2e 的测试栈也用它。

### 刷新：进程内合并、锁行、锁到后再查一次、成功先落库

发布循环和账号代理共用一个 `AccountTokens`，都从 `accessToken(accountId, rejected)` 拿令牌。`rejected` 是平台刚回 401 的那个令牌，平时为 null。访问令牌离过期还有一分钟以上、也不是 `rejected`，直接解密返回，不开事务。否则要刷新：

- 同一进程里同一个账号的刷新只跑一趟（single-flight）。进程里按账号记着正在跑的那一趟，后来的请求直接等它的结果，不开事务、不占数据库连接。那一趟不论成功、被拒还是抛异常，结束时都从表里删掉，下一次要刷新的请求会重新起一趟，一次 5xx 不会把后面的请求永远钉在同一个失败上。
- 不同账号的刷新各要一个事务，同时进事务的不超过连接池 `max` 的三分之一（至少 1 条，默认池 10 条时是 3 条），多出来的在进程内存里排队，排队时不开事务、不占连接。事务里要等令牌端点，最长 10 秒，不设上限的话发布循环一轮十几个账号一起刷新就能把连接池占满，登录、账号页这些普通请求全卡住。
- 跑的那一趟走 `withAccountLock` 锁账号行（见下面「唯一锁序」），锁到之后再判一次：还能用（排在前面的已经刷过，或者库里的已经不是 `rejected`），就用它；没有刷新令牌或刷新令牌也过期了，回 `login_expired`；否则拿刷新令牌去换。
- 换到了，新的访问令牌、刷新令牌、两个过期时间在同一个事务里写回，账号是 `expired` 的话同一条事务改回 `valid`，提交之后才把令牌交出去；改回了 `valid` 的，提交后推 `account_updated`、重发 `config`；这两步只是通知，重发 `config` 出错只记日志，这趟请求照常用新令牌走下去（`server.ts` 里交给 `AccountTokens` 的回调）。

刷新失败怎样分类。清掉刷新令牌是不可逆的，所以只有能证明刷新令牌本身失效的回应才算被拒，判断在 `oauth-providers.ts` 的 `DEAD_REFRESH_TOKEN`：

- 5xx 一律不算，不管错误体里写什么，GitHub 的 `bad_refresh_token` 也一样。5xx 是平台自己出了事。
- GitHub：`error` 是 `bad_refresh_token`。GitHub 不认时回 200，错误写在 `error` 里。
- X：HTTP 400，且 `error` 是 `invalid_grant`（RFC 6749 §5.2 定义它覆盖刷新令牌无效、过期、被撤销）。
- X：HTTP 400，`error` 是 `invalid_request`，且 `error_description` 等于或包含 `Value passed for the token was invalid`。X 对撤销或用过的刷新令牌实际就这么回，X 官方 TypeScript SDK 的 issue #54 存着完整回包。RFC 6749 §5.2 里 `invalid_request` 是通用的请求格式错误，所以光凭错误码不算，401、503 或别的描述都不算。

被拒时把 `refresh_enc` 清成 null，代际不变，回 `login_expired` 并带上被拒的那一代，调用方记过期。其余一律是运维错误：`invalid_client`、`unauthorized_client`、GitHub 的 `incorrect_client_credentials` 这类应用配置错误，描述对不上的 `invalid_request`，别的 400、401，错误体不是 JSON，5xx，超时，连不上。运维错误打一条 `console.error`，只写平台、状态码和错误码，不写令牌，然后抛异常，密文和账号状态都不动；管理员修好 client secret 或平台恢复之后，原来的刷新令牌照常能用。代理把异常回成 502，发布循环记这条草稿 `error`。

为什么要合并和锁行。两家的刷新令牌都是一次性的，换一次就轮换，旧的立刻作废。发布循环和代理、或者两个代理请求同时发现令牌过期，各自拿同一把刷新令牌去换，只有一个换得到，另一个被平台拒绝，然后把一个其实好好的账号记成过期。进程内合并挡住同一进程里的并发，也让十几个请求等一次刷新时只占一条数据库连接，不会把连接池占满；账号行锁和锁后再查一次留作跨进程的兜底，另一个进程排在锁后面，锁到时直接用前面换到的新令牌，不再打平台。锁里打 HTTP 会把这个账号锁到令牌端点回话为止，最长 10 秒，只挡同一个账号；这期间记过期、重新授权的事务排在它后面，醒来看到的是刷新提交之后的世界。连接池的占用由上面的并发上限管。没有把打令牌端点挪到事务外（先短事务读代际、事务外换令牌、再按「代际没变」提交），是因为刷新令牌一次性：两个进程在事务外拿同一把去换，后到的被平台拒掉，要么把刚被别人换好的账号清掉刷新令牌、记成过期，要么还得再加一层「被拒但代际可能马上会变」的等待；锁里换，后到的进程在行锁上等，醒来直接用前面换到的。代价是某家令牌端点挂住时，这个进程里别的账号的刷新排在后面，最多等上限那几条各自超时。成功先落库，是因为平台那边旧刷新令牌已经作废，新的没存下来就再也刷不了。

`login_expired` 到了发布循环就是草稿因 `login_expired` 失败，走上面同一条 `settleFailed`，只发草稿那条通知。到了代理就调 `expireLogin`：`markLoginExpired`、推 `account_updated`、发账号那条「…账号「handle」登录过期了，这个账号的稿子先不发，到账号页重新登录」、重发 `config`，和电脑报 `expired` 同一段代码。

代际。`account_credentials.generation` 每写一份新凭据加一：授权回调写凭据、刷新成功写回，都走 `saveGrant` 的 `generation = generation + 1`；刷新被拒只清 `refresh_enc`，代际不动，死的还是那一代。`accessToken` 交出的令牌和 `login_expired` 都带着代际，没有凭据行时是 null。控制面自己因为凭据被拒把账号记过期（代理取到 `login_expired`、代理重试后还是 401、发布同样两种情况、发布碰到 403），都把那一代交给 `markLoginExpired`，改账号的那条 UPDATE 里带 `EXISTS (SELECT 1 FROM account_credentials WHERE account_id = accounts.id AND generation = <被拒的那一代>)`，没有凭据行的那种换成 `NOT EXISTS`。代理和发布走同一个函数，电脑报上来的过期不经过控制面的凭据，不带这个条件（`ExpiryEvidence` 的 `reported` 和 `rejected` 两种）。

不变式。对有控制面凭据的账号，`login = 'expired'` 成立，当且仅当当前这一代凭据被判定为死了。过期是针对某一代凭据下的结论：记过期的 UPDATE 带着那一代，库里已经是下一代就什么都不改。凭据代际一推进（刷新成功、重新授权，都经 `saveGrant`），账号必须回到 `valid`，所以 `saveGrant` 写下新一代之后在同一个事务里把 `login <> 'valid'` 的账号改回 `valid`；代际不推进，账号就没有从 `expired` 回到 `valid` 的路（唯一例外是 `markLoginValid`，只给电脑报小红书登录用，这种账号没有控制面凭据）。刷新被拒只清 `refresh_enc`、不推进代际，因为死的还是这一代。选「刷新成功时在锁里写回 `valid`」而不是「发现已 `expired` 就不刷新」，是因为过期先提交、刷新随后成功这条交错里刷新已经拿到了平台发的新令牌，扔掉它就要用户再授权一次；写回 `valid` 让不变式直接成立，`account_updated` 和 `config` 在提交后补推。

唯一锁序。所有同时碰 `accounts` 和 `account_credentials` 的路径都先锁账号行，再碰凭据行，入口只有一个：`withAccountLock(db, accountId, run)`，它开事务、`SELECT ... FOR UPDATE` 锁账号行、把一个只有它造得出来的 `AccountLock` 交给 `run`。写凭据的 `saveGrant`、`saveAccessToken`，刷新的整趟（锁到后再查、打平台、被拒清 `refresh_enc`、成功写回），`markLoginExpired`，授权回调写凭据，`addAccountWithToken`，`markLoginValid` 都收这个 `AccountLock` 或从这里进，不收 `Db`，绕过锁的写法编译不过。凭据行不再单独加 `FOR UPDATE OF account_credentials` 或 `FOR SHARE`：账号行锁已经把这些路径排成一队，后到的在账号行上等，醒来跑的 UPDATE 看到的是前一个提交之后的世界，两边不会互等成死锁（`test/oauth.test.ts` 的「锁序」用例把回调停在「锁了账号、还没写凭据」的窗口，这时记过期，两边都能完成）。授权回调和 `addAccountWithToken` 的 advisory lock（`oauth-account:<ownerId>:<platform>`）在它外面，管的是「挂哪一行」，两条路径都先拿它、选定行之后才进 `withAccountLock`，顺序一致，不会互等。发布路径的会话代次条件（`login_generation = claimed_login_generation`）只留给电脑发的草稿：那些账号没有控制面凭据，只能靠它挡「认领之后重登」；走接口的草稿只看凭据代际。0016 之前认领的草稿 `claimed_login_generation` 是 NULL，滚动升级期间旧控制面重登也不推进 `login_generation`，所以这些行不用代次，改用基底那条 `login_generation = 1 AND login_changed_at <= claimed_at`：代次仍是 1 说明没经过新控制面重登，认领时刻挡旧控制面的重登。两边都是库时钟：`claimed_at` 是认领语句里的 `now()`，`login_changed_at` 由 `markLoginValid`、`markLoginExpired`、`saveGrant` 写成 `clock_timestamp()`，多个控制面进程时钟不齐也比不错。取语句时刻不取事务开始时刻，是因为登录事务开头在电脑和账号的锁上排过队，排队期间认领的草稿不能算在这次登录之后。`markLoginValid` 先在电脑上取 advisory lock（`login-valid:<computerId>`），再锁电脑报上来的那一行，合并到同名的 known 行时嵌套一层 `withAccountLock(known)` 才改它，和结算它的发布结果排成一队。要先排队，是因为两把行锁的顺序由报文决定：甲报成乙、乙报成甲同时到，一边先锁甲等乙，另一边先锁乙等甲，PostgreSQL 报 40P01，一次登录结果就丢了。控制面是单实例，同一台电脑的两条连接在 hub 里排成一条链，经连接报上来的两次合并本就先后进库；这把锁挡的是以后多个控制面共库，或者别的路径并发调 `markLoginValid`（`test/login-merge-lock.test.ts` 直接调仓库函数让两次合并并发进库钉着）。同一台电脑的登录结果一次只进一个，结算发布结果的那头只拿一把行锁，不会互等。

交错里那一次旧请求本身的结论不变：代理回 409，发布把那条草稿记 `login_expired`；账号不动，因为账号这边已经有了更新的结论，草稿失败时也不再发通知（同 `settleFailed` 的 `already_known`）。

### 代理：`/accounts-proxy/:accountId/*`

Bot 读 GitHub、X（查 issue、搜推文）不直接打平台，打控制面的 `/accounts-proxy`，地址随 `config.accountsProxy.baseUrl` 下发，和网关一样拼在代理自报的 `controlOrigin` 上。认身份用电脑的网关 key（`Authorization: Bearer`），浏览器 cookie 不算数。依次判：key 不对 401；不是 GET 405「代理只读，发东西走草稿」；账号不是这台电脑主人的、不存在、或不是 github/x 回 404；`login` 不是 `valid` 回 409；取令牌出错 502，取到 `login_expired` 记过期后回 409。放行时把 `*` 那段原样（不解码）拼到平台接口根地址后面，拼完核对 origin 和根路径前缀，跳出去回 400；解码后再拼的话 `..%2F` 会变回 `../`，GitHub 的账号能打到 X 上。请求头换成平台要的头和 `Bearer <平台令牌>`，客户端的 `accept` 保留，其他一律不带。回包只透 `content-type`、`etag`、`last-modified`、`link`、`cache-control` 和 `x-ratelimit-*`，平台的 `set-cookie` 不透。平台回 401 走下面那条共用规则，回 403 原样透给 Bot，不刷新、不记过期：403 多半是这个号没权限读那个资源，令牌本身没问题。平台可能把收到的 `Authorization` 回显在正文里，所以回包不是流式透传：正文读进内存，上限 1MB（`ACCOUNTS_PROXY_MAX_BYTES`），超过就截在上限处并带 `x-baize-truncated: true`；这次请求用过的每一把令牌（401 刷新重试时新旧两把）都换成 `[已隐藏]`，成功和出错的回包都换。匹配不按写法枚举，而是逐字符允许等价形态：原字符、`%XX`（十六进制不分大小写，非 ASCII 按 UTF-8 逐字节）、`\/` `\"` `\\`、`\uXXXX`，所以大小写混写、逐字符混用都认得出；双重编码和 HTML 实体不认。透出去的头命中令牌就整个丢掉，不替换，因为头值只能是单字节字符。截断落在令牌中间，或停在半个 `%2`、`\u00` 上时，结尾那一截一并去掉；上限之后已经读到的字节拿来接着看，接不成令牌的（比如 `%2` 后面是 `0`）原样留着，读到的不够判断时按接得成算。截断处在替换之前、按原始字节算：先替换的话，一把令牌是另一把的开头（刷新前后两把可能这样）时，短的那把会吞掉长的开头，长的余下那截就认不出来了。截点要是落在一把整个写在上限之前的令牌中间，就退到那把令牌的起点，整把去掉。读到上限后取消平台回包时 `cancel()` 抛错只记日志，上限前的正文已经读齐，照样回截断的 200。令牌端点发来的访问令牌（换令牌和刷新两处，都在 `requestToken`）含反斜杠、百分号、控制字符或非 ASCII 时不收，按被拒处理：授权回调跳回 `failed`；刷新时平台已经把旧刷新令牌用掉了（单次使用），再试也换不到，所以清掉刷新令牌、账号记过期、推 `account_updated` 和 `failed` 通知让用户重新登录，回 409，这把令牌不进库。原因有两个：一串连续的反斜杠或百分号会让上面的匹配正则灾难性回溯，1MB 正文能卡住控制面；Latin-1 字符在线路上是单字节，匹配器只认它的 UTF-8 写法。两家的令牌字符集本来就不含这些字符。`account-add` 脚本手工挂的令牌在入口过同一道校验（`unsafeAccessToken`），不收就退出码 1。

代理和发布共用一条「401 刷新后重试一次」的规则。平台回 401，就把这次用的令牌作为 `rejected` 交给 `accessToken`：库里的令牌已经不是它（别的路径刚刷过），直接拿库里的重试；还是它，就强制刷新一次再重试。重试还是 401，代理记过期回 409，发布循环把草稿记 `login_expired`、账号跟着记过期。对发布的 POST 重试一次是安全的：401 表示平台没有接受这次请求，什么都没发出去，重发不会发出两条。这条规则也挡住了一个交错：发布先拿到旧令牌 A、请求还在路上，代理这时 401、刷出新令牌 B；A 晚到的 401 交回去时库里已经是 B，发布直接用 B 重试，账号不会被记成过期。发布路径把平台的 403 也记成 `login_expired`，和代理的口径不同，这一版还没统一。

为什么令牌不出控制面。电脑上跑的是 Bot 写的命令，Bot 的上下文又会进模型。令牌一旦下发，就等于交给了模型和电脑上任何能读文件的进程，撤销只能去平台后台点。留在控制面，电脑只拿得到一把网关 key，它只能以这个用户的名义读、不能写，写一律走草稿和审批；要收回，删账号或换网关 key 就行。刷新也只有一处在做，锁行才管得住。

## 偏好

偏好属于一个 Bot，`bot_preferences` 一行一条，只有 Bot 自己在单聊里能提议，用户点了「记住」才记下。上行 `preference_offer` 要求群是本人的、恰好是这个 Bot 的单聊、run 是它在这里的活，任一不成立整条丢掉（`agent/events/preference-offer.ts`）。项目群里听到的话是对项目说的，不该变成这个 Bot 走到哪都套用的偏好，`test/preferences.test.ts` 的「项目群里的 preference_offer 静默丢弃」钉着它。

提议只落一张 `preference_offer` 卡，不写偏好、不重发 config，所以点之前这句话不影响 Bot。理由和 `skill_offer` 一样：点之前 text、private、sourceMessageId 不在任何表里，卡的状态（offered、saved、dismissed）随正文走，点了就改这条消息再重推。落卡写在 `whileRunOpen` 里，和别的 run 名下的写一样，run 收尾后晚到的帧不落。

点卡是 `POST /api/messages/:id/preference-offer`（`http/app.ts`，仿 skill-offer 那条）。点的时候 run 多半早就结束了，所以不靠 `whileRunOpen`，归属在 `findOwnedPreferenceOffer` 里重新认：消息是本人的、正文是这张卡、所在群此刻仍是卡上那个 Bot 的单聊，任一不成立 404。结论靠 `UPDATE messages ... WHERE body->>'status' = 'offered'` 抢，0 行回 409；记住时写偏好和改卡在同一个事务里（`repo/preferences.ts` 的 `decidePreferenceOffer`），抢输的整条回滚，并发点三次只会留下一行。来源消息 id 是电脑报上来的，外键只保证它存在，不在这个群里就记成 null（`addPreference`）。给模型的上下文里这张卡写成「提议记住「…」，你让记住了」或「你说不用记」（`agent/dispatch.ts` 的 `PREFERENCE_OFFER_*`）。

私人标记 `private` 只管分享时默认不勾（`shared/src/domain.ts:696`）。控制面只存它、切它，`config` 照样下发私人的偏好，Bot 写作时照样要套用（`repo/preferences.ts:35-47`）。`config.preferences` 是这个用户全部 Bot 的偏好，数组恒带，运行器靠整份对账，理由和 `config.skills` 一样，省掉就分不清「没有」和「没说」（`agent/hub.ts:519`）。

用户在 Bot 页能切私人（`PATCH /api/preferences/:id`）和删（`DELETE`），两条都按归属人过滤，别人的回 404（`repo/preferences.ts:81-102`）。三处写的推送顺序（切私人、删除在 `http/routes/preferences.ts:35-58`）：

- 切私人写库一返回就推 `preference_updated`，再 `sendConfig`。`sendConfig` 读库可能拖到别的请求删掉这条之后，那时再推更新会把已删的偏好推回页面。`test/preferences.test.ts` 的「切私人的 config 还没读回来时偏好被删，推送顺序仍是先更新后删除」钉着它。
- 删除先 `sendConfig`，再推 `preference_deleted`。
- 点「记住」写下的偏好，先重推那条卡，再推 `preference_updated`，最后 `sendConfig`；点「不用」只重推卡。

`GET /api/bots/:id/profile` 回 Bot 页头部的三个数：偏好数、skill 数、在几个项目里（`repo/bots.ts:320-337`）。项目只数多 Bot 群，单聊不算。三个数各查各的，不 join 在一起相乘。

## 品牌手册

一个用户一本，`brand_books` 一行。PUT 整本替换，带 `version` 表示「我基于哪一版改的」：库里已经不是这一版就回 409，什么都不写、不推、不建授权，草稿批准随时会往手册里追加改动，拿旧版整本覆盖会把它冲掉。`version` 上限 2147483646，写入时存的是加一后的值，列是 PostgreSQL integer，越界在请求边界回 400。

素材文件夹换成新值时给本机建一条永久读授权。路径和授权的 `prefix` 用同一个契约（`GrantPathPrefix`，绝对路径、最长 1024），超长在请求边界回 400，写授权前再按授权契约过一次：坏授权一旦落库，授权列表和下一份 config 都会解析失败，换短路径也删不掉旧的那条。

批准一条改过字的草稿，把这笔改动追加进手册的「改过的地方」，最多留 50 条，挤掉最旧的。去重键是 `(draftId, before, after)`，只看手册当前留着的那些：人删掉的、被上限挤掉的，同样的改动再批一次会重新记一笔。删一条等于说「这条不算」，再批是新的信号，所以不另建去重账本。

推送不按版本排队：两次写各自提交后各推一条 `brand_updated`，晚提交的可能先到。页面按 `version` 只收比手上新的那本，控制面不按 owner 串行广播。运行器那边靠 config 的代际，不受影响。

## 附件

`attachments` 把草稿配图的原始字节存为 Postgres `bytea`，记录归属人、Bot、群、sha256、MIME 和大小。`(owner_id, bot_id, group_id, sha256)` 唯一；重复上传用一条 `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING id` 返回同一个附件 id，不先查后写。

`PUT /hub/v1/attachments?botId=&groupId=` 接收原始图片字节和 `x-baize-sha256` 声明。先验证网关 key，无效回 401；读体前再检查 Bot 和群的归属及成员关系，不成立回 404；落库事务内再次复核，避免上传期间删除对象的竞态。只接受 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，其他类型回 415；读取请求流时累计大小，超过 20 MiB 立即取消读取并回 413。控制面和运行器共用 shared 的 `imageMime` 按魔数识别图片；空体回 400「附件图片不能为空」，无支持的魔数回 400「附件字节不是 PNG、JPEG、WebP 或 GIF 图片」，魔数与声明不符回 400「附件图片格式和 Content-Type 不一致」。服务器重算哈希，声明不符回 400。`GET /hub/v1/attachments/:id` 返回原始字节和上传时的 `Content-Type`；同一归属人的任何电脑可读，别人的附件和不存在的 id 都回 404。

`/hub/v1` 挂在 cookie 登录中间件之前，只接受当前电脑网关 key 的 Bearer。config 恒带 `hub.baseUrl`；hello 轮换 key 后旧 key 立即失效。`http/hub-auth.ts` 将归属人和电脑 id 写入请求上下文，P3-10 的租约头校验接在 `http/hub.ts` 的认证之后、附件路由之前；本单不校验租约头。

附件的归属人、Bot、群三个外键都设 `ON DELETE CASCADE`，删账号、删 Bot 或删群时连带删除。附件不引用草稿 id，删除草稿不会清理附件；上传成功后草稿创建失败也会留下附件，直到所属 Bot、群或账号删除。

## 数据导出与删号

`GET /api/export` 回一个 JSON 附件，文件名 `baize-export-YYYY-MM-DD.json`（`http/routes/privacy.ts:19-25`）。内容是账号、设置、品牌手册、每个 Bot 连同它的 skill 和偏好（私人的也在）、例行、项目任务卡、草稿，`format` 为 1（`repo/export.ts:36-46`）。每一段都按白名单从领域对象拼，工具连接、平台账号、电脑三类带凭据的对象整段不进（第 32-35 行）。不按表整行导出，是为了让以后往领域对象里加字段的人不会顺手把凭据带进来。webhook 的 token 本身就是触发凭据，导出只留 `{ kind: "webhook" }`（第 27-29、48-49 行）。`test/privacy.test.ts` 的「导出里有偏好和品牌手册，grep 不到 token 和 authorization」钉着它。各段查询并行跑，不在一个事务里（第 52-61 行），导出不保证是同一时刻的快照。

`DELETE /api/me` 要请求体里的邮箱等于当前账号，不对回 400（`http/routes/privacy.ts:27-31`）。删完关掉这个人连着的电脑代理（`disconnectOwner`）和浏览器推送连接（`PushHub.disconnectUser`，用 1008 关闭，并记下这个用户，握手到一半才入表的连接也会被关）、删 cookie、回 204。消息事务已提交、`hub.push` 还没跑时删号完成，那条推送找不到任何连接，旧页面收不到。`deleteAccount`（`repo/export.ts:80-107`）的锁序：

1. 账号排他 advisory 锁（`lockOwner`）。
2. 按 Bot id 升序对每个 Bot 调 `lockRunsOfBot`。
3. 这些 Bot 交出和接手的交接卡 `FOR UPDATE`。
4. 删本人的 runs。runs 对用户的外键是置空，账要跟人一起走。
5. 删 users，其余的表级联。

为什么账号锁在最前、多把 Bot 锁按 id 升序拿，以及删号和建 Bot、建群、开项目、建 run 的各种交错，见「run 收尾」一节删账号那一段。

## 牌桌

一张牌桌就是一个群。`poker_tables` 以 `group_id` 为主键，`(owner_id, request_id)` 唯一，重发建桌请求回同一张桌。桌上四个座位，用户固定坐 4 号，1 到 3 号是牌友 Bot，默认是 `leopard`、`old_k`、`jasmine`，盲注 10/20，起始筹码 2000。主持人老白（`laobai`）不入座，只在群里说话、回答问牌、写复盘。五位牌友和老白每个用户各建一次，靠 `bots` 上 `(owner_id, preset)` 的唯一索引。他们的 role 是 `player` 和 `host`（`TABLE_ROLES`），`/api/bots` 不列出，也不能 `PATCH`。代码在 `src/poker/`。

- `engine.ts` 是确定性的纯引擎，只有 `newHand`、`apply`、`replay`、`legalActions`、`settle`，不碰库和时钟。
- `view.ts`、`wire.ts`、`table-view.ts` 把引擎状态裁成某个座位看得到的样子。
- `converge-plan.ts` 是纯函数 `nextStep`，说下一步该做什么。`converge.ts` 执行它。`store.ts` 放桌锁和查询，`hint.ts`、`leave.ts` 管问牌和散场，`sweeper.ts` 是定时扫描。

### 一手牌怎么存

库里只存种子、`seats_start`、`button_seat`、盲注和 `poker_events` 日志，牌面本身不存，`replay` 把它们重放成当前状态。所以种子是整手牌的全部秘密，它不出控制面，响应、prompt 和日志都不带。路由里的错误处理也特意不把数据库的原异常交给公共日志，因为数据库的插入错误可能带整行。

几条唯一约束替代了先查后写。`poker_events` 主键是 `(hand_id, seq)`，同一个决策点只能落一条事件。`poker_hands` 有 `(group_id) WHERE status = 'playing'` 的部分唯一索引，一桌同时只有一手。`poker_sessions` 有 `(group_id) WHERE ended_at IS NULL` 的部分唯一索引，一桌同时只开一场。`poker_hints` 主键是 `(hand_id, seq)`。

`poker_tables.version` 每次桌面变化加一。`poker_table_updated` 带整张桌的视图只推给归属人，客户端只认更大的版本。`snapshot` 和 `currentHandOf` 在 `REPEATABLE READ` 只读事务里读，桌面和当前手出自同一个快照。

### 路由

都挂在 `/api` 下，归属不对一律 404。

| 路由                                  | 请求体           | 行为                                                                                                                                                |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /poker/tables`                  | `{ requestId }`  | 新建回 201，同一个 `requestId` 重发回 200。先补建缺的预设牌友，有新建的就向电脑代理重发一次 `config`，因为代理要认得这些 Bot                          |
| `GET /poker/tables`                   |                  | 当前用户所有牌桌的视图                                                                                                                              |
| `GET /poker/tables/:groupId`          |                  | 一张桌的视图，视角是 4 号                                                                                                                           |
| `POST /poker/tables/:groupId/seats/:seat` | `{ persona }` | 把 1 到 3 号座换成另一位牌友，不能换成老白。非牌友座位或已在桌上回 400，手进行中回 409。筹码留在座位上，不跟人走。群里不留话，谁下谁上由网页自己提示。推 `group_updated` 和 `poker_table_updated` |
| `POST /poker/tables/:groupId/hands`   | 空               | 开一手，201。桌上已有一手回 409                                                                                                                     |
| `POST /poker/hands/:id/act`           | `{ seq, action }` | 用户出牌。没轮到 4 号回 409「还没轮到你出牌」，`seq` 不等于已落事件数回 409「出牌序号已过期」，引擎不收回 400                                      |
| `POST /poker/hands/:id/hint`          | `{ seq }`        | 问老白，见「问老白为什么挂在决策点上」                                                                                                              |
| `POST /poker/tables/:groupId/leave`   | 空               | 散场，见「散场、复盘和战绩」                                                                                                                        |
| `POST /poker/tables/:groupId/review` | `{ sessionId }` | 给最近一场已散场的场次重派复盘。不是最近一场或没有电脑在线回 409，复盘已落或老白还在写回现状 |

牌桌群不收普通消息。`POST /api/groups/:id/messages` 对牌桌群回 409「牌桌里请用按钮出牌」，用户在这里只有按钮，没有自由文字。

### 桌锁

所有改动牌桌的动作都过 `withTableLock`，包括出牌、开手、`converge`、问牌、散场、牌友的 `poker_act` 和老白的 `poker_review`。它开一个事务，先拿账号共享锁，再拿 `pg_advisory_xact_lock`，最后 `SELECT ... FOR UPDATE` 锁住 `poker_tables` 那一行。顺序固定是账号锁、咨询锁、行锁。账号锁排在最前的理由见「run 收尾」一节删账号那一段。

因为同一张桌的所有写入排队，锁内每一步都重新从库里载入手牌。库中的日志是唯一事实来源，内存里没有牌局状态，重复推进不会再落同一个动作，也不会重复结算。要在锁外做的事（发 prompt、推送）等事务提交后再做，否则运行器收到 prompt 时 run 行还没落地，重连对账看不到它。

### 牌友看不到别人的底牌

这件事分三层守。

**视图只含这个座位的信息。** `viewFor(state, seat)` 给出公共信息加这个座位自己的底牌，不含种子和牌堆。别的座位的牌只有一手牌里出现了摊牌事件之后才以 `shown` 出现。`wire.ts` 里 `PokerSeatView` 是引擎 `SeatView` 的 zod 镜像，一条类型相等断言把两者钉在一起，字段对不上编译就失败。`buildTableView` 的出口再过一遍 `PokerTableView.parse`，多余字段被去掉。

**消息表带收件人。** `messages.visible_to` 是 `Viewer[]` 或 null。null 是全群可见，数组只给列出的人，空数组被 `messages_visible_to_check` 挡掉。`Viewer` 是 `{ kind: "user" }` 或 `{ kind: "bot", botId }`。读消息的查询把 `messageVisibleTo(viewer)` 拼进 `WHERE`，`listMessages`、`findOwnedMessage`、`messageSeq` 的 `viewer` 参数是必填，漏传编译不过。HTTP 一律以 `{ kind: "user" }` 读，派活拼上下文以被派的 Bot 读。推送也过滤，`ws/hub.ts` 对 `visibleTo` 里没有 user 的 `message` 和 `message_delta` 直接不推。

**牌桌 run 是隐藏 run。** `sendHiddenRun` 为牌友、问牌和复盘各起一条 run。`startTableRun` 在一个事务里写一条系统触发消息「牌桌回合」（带 `visibleTo`）和一条 `runs` 行（带 `visible_to` 和 `table_role`）。发出去的 `prompt` 的 `text` 是空串，`context` 是空数组，`task` 是 null，`members` 是空数组，座位视图、公开日志、问题、复盘材料都在 `table` 字段里。所以牌友拿到的只有自己座位的视图和公开日志，没有群历史，也没有任务卡。模型按角色选用途，牌友用 `fast`，老白问牌和复盘用 `plan`。发不出去（电脑刚好掉线）就把 run 收成 `abandoned`，不占着座位的唯一索引。

谁看得到什么：

| 内容                                         | 谁看得到       |
| -------------------------------------------- | -------------- |
| 牌友回合的触发消息                           | 只有这个牌友   |
| 问牌的触发消息                               | 老白和用户     |
| 老白回答问牌的文字                           | 只有用户       |
| 复盘的触发消息                               | 只有老白       |
| 老白的关键处播报（`narrate.ts` 的 `hostLines` 生成，不过模型）、牌友的台词 | 全群           |

隐藏 run 的上行也是默认拒绝。`table-run-policy.ts` 按角色列出放行的报文，牌友只能发 `poker_act` 和 `run_done`，老白问牌只能发 `bot_text`、`bot_text_done` 和 `run_done`，复盘只能发 `poker_review` 和 `run_done`。普通 run 全放行，run 行不存在不放行。判断在 `events.ts` 校验完 run 归属之后，不成立整条丢掉并记警告。所以牌友不能插卡、@ 人或派活，牌友的 `bot_text` 也不会上桌，公开台词只走 `poker_act.say`。老白的 `bot_text` 落库时由 `botTextVisibility` 写成只有用户可见，牌友以自己为 viewer 读群消息时读不到它。

牌桌这边只有一处读 `messages` 不带 viewer：`poker/hint.ts` 按 id 查老白答出来的那一条，读的是代码自己刚写下的行。出牌回执和重派计数都不在 `messages` 里，见下一节。列表类查询的 viewer 规则由 `test/p3-visible-read.test.ts` 钉着。

### converge 怎么推进

`converge(deps, handId)` 是推进一手牌的唯一入口，在桌锁里循环，每圈重新载入桌和手，调 `nextStep` 得到下一步。

| 下一步           | 做什么                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await_user`     | 轮到 4 号，用户不限时。如果手上还记着牌友的回合就清掉，然后返回                                                                                                                                |
| `wait_bot`       | 牌友的回合在路上且没超时，返回                                                                                                                                                                 |
| `dispatch_bot`   | 轮到牌友而手上没有这个座位的回合。发一条隐藏 player run，在 `poker_hands` 记下 `turn_seat`、`turn_run_id`、`turn_deadline`，截止时间是现在加 60 秒（`BOT_TURN_TIMEOUT_MS`），同座位重派沿用原来的截止时间 |
| `timeout_action` | 超时，或同一个决策点被引擎拒绝满三次（`MAX_REJECTED_ACTIONS`）。收掉那条 run，落兜底动作，然后接着循环。兜底不单独播，这次落下的事件里有新一街或结算，就并进那一句的开头，写成「阿豹（超时）过牌，翻牌：…」或「（三次无效）」，没有就不提                                      |
| `settle`         | 引擎已走完而手还没标完成。`UPDATE ... WHERE status = 'playing'` 标成 `complete`，把各座位最终筹码写回桌子，桌子回 `idle`                                                                        |
| `hand_over`      | 已经结算过，返回                                                                                                                                                                               |

**兜底动作。** `fallbackAction` 能过牌就过牌，否则弃牌，从不往里投筹码。超时的牌友因此最多输掉已经投进去的，不会因为掉线被迫跟注。

**牌友的 `poker_act`。** `events/poker-act.ts` 在桌锁里先校验 run 属于这台电脑、角色是 `player`、这个 Bot 在这手牌里有座位，然后才碰牌局。幂等靠专表 `poker_act_receipts`，主键 `(run_id, call_id)`，`ON CONFLICT DO NOTHING` 认领，结果和动作同事务写进 `result`，重复的帧读回已存的结果，不再碰牌局。回执以前是 `messages` 里 id 以 `poker-result:` 开头的隐藏行，迁移 0028 把它们搬进专表后删掉了原行。没有轮到它、`seq` 过期、手已结束都回 `ok: false` 和中文原因，不推进。引擎拒绝时 `turn_attempts` 加一，回 `ok: false` 让牌友在同一次 run 里改，同时重新 `converge`。成功就落事件，台词非空、这个 Bot 这一手在群里公开说过的话还不到两句（`BOT_LINES_PER_HAND`，从开手时刻算）时，以牌友的名义发一条全群可见的消息，排在这次老白播报之前，满了就只落动作不说话。台词只随被接受的动作上行，手结算之后的 `poker_act` 一律回 `ok: false`，所以结算后的台词不会进群。每次落动作都清掉手上的回合记录，下一个决策点重新派。

**派出去的 prompt 在提交后才发。** `converge` 把 prompt 收进列表，事务提交后再发。发送失败就把 run 收成 `abandoned`，下一轮扫描会重派。

**丢失的 run。** 手上记着回合，但 run 行没了，或 run 已结束而 prompt 没确认进会话（`context_confirmed_at` 为空），就当它丢了，沿用原截止时间重派。重派次数记在 `poker_hands` 的 `dispatch_seq` 和 `dispatch_count` 上：每发出一条牌友 run，`dispatch_seq` 等于当前事件数就加一，否则从 1 重新数。读的时候 `dispatch_seq` 对不上当前事件数就当 0，所以换决策点不用清。首派加三次重派，计数在库里，重启后还作数。如果 run 已结束且 prompt 确认进过会话却没出牌，就把截止时间设成现在，下一圈直接兜底。电脑代理重连时 `hello` 里的 `activeRuns` 没有的 run 由 `AgentHub` 收成 `abandoned`（`#finishMissingRuns`），所以掉线再连上的牌友会被这里重派。

**谁来触发。** 三处。用户出牌和牌友出牌的路由在提交后调用。`PokerSweeper` 每秒扫描所有 `playing` 的手并逐手 `converge`，`tick` 串行，一手出错不挡后面的手，`stop` 等当前一轮扫完。日志只记手 id、第几次和 `errorKind`，不记原异常。扫描器让超时兜底、掉线重派和重启后接着打都不靠内存里的定时器，控制面重启后第一次扫描就接上。它在 `server.ts` 启动，`close` 时停。测试用 `configurePoker(db, { now, turnTimeoutMs, afterCommitProbe })` 注入时钟、超时和提交后的故障，都随 `startServer` 的 `poker` 参数传进来，时钟同样是参数不是全局。`afterCommitProbe` 在开手和出牌提交后的每一步（推消息、`converge`、推视图、读视图）之前调用，抛错就当这一步失败，路由照样回已落库的视图，日志记手 id、步骤和 `errorKind`。生产不传它。

**一直推进不下去的手。** 同一手连续失败 30 次（`SWEEP_FAILURE_LIMIT`，约半分钟），扫描器调 `abandonHand` 把它作废：手标成 `abandoned`，不结算，在途的牌友 run 收成 `abandoned`，各座位筹码退回 `seats_start`，桌子回 `idle`，老白说一句这一手作废。选作废不选兜底散场，是因为散场在手进行中被拒，而且要读这一手的结果写复盘，推进失败时这些多半也读不出来；作废只碰手和桌两行，不重放日志，日志坏了也收得掉，用户之后能开下一手或散场。`abandoned` 的手不算进战绩和关键手，那两处只认 `complete`。计数在扫描器内存里，一成功就清零，重启也清零，坏手在新进程里要再失败满一轮才作废。偶发的库抖动撑不满半分钟，库整个断开时作废本身也写不进去，所以不会误伤正常的手。作废本身失败时计数不清，接着往上涨，每满一轮（第 60、90 次……）再试一次作废，库恢复后的下一次就能收掉。第一轮每次失败记一条日志，之后只在再试作废的那一次记，库断开时不会每秒刷一条。日志只有手 id、次数和 `errorKind`，不带原异常。

### 问老白为什么挂在决策点上

建议是针对某个视图给的。任何一个人再出一手牌，视图就变了，旧建议可能已经不对。所以建议的身份是 `(hand_id, seq)`，`seq` 是问的时候已落的事件数。

- 只能在轮到用户时问，否则 409「还没轮到你出牌，轮到你再问老白」。`seq` 不等于当前事件数回 409「问牌序号已过期」。
- 每个决策点一条，主键保证重复点返回同一条视图。`failed` 的可以再问，`onConflictDoUpdate` 换掉 run 重来。
- `hintOf` 只取当前手、`seq` 等于当前事件数的那一条，所以上一街的建议不会带到下一次行动上。
- 状态是推出来的。回答消息非空且不在流式中是 `done`。run 已结束而 prompt 没确认进会话，或没有回答，是 `failed`。其余是 `waiting`。对账收尾和报错收尾不确认 prompt，半截正文被通用收尾收成定稿也不算成功回答。
- 电脑离线时回 409「电脑不在线，这次没有问牌，电脑回来后再问一次」，不建 run 和问牌提示行；在线后用户可在同一决策点重试。
- 老白同时只答一个问题。`runs_table_role_open_idx` 是 `(group_id, table_role)` 上的部分唯一索引，每张桌未结束的 advisor run 和 reviewer run 各至多一个。`runs_table_bot_open_idx` 另外限制同一个 Bot 在同一张桌至多一个未结束的牌桌 run。上一条没答完再问回 409「老白还在回答上一条，等它说完再问」。

老白的 prompt 用 4 号座的视图，所以他只知道用户知道的。答案落库后 `refreshHintForRun` 在桌锁里更新，它在 `bot_text` 和收尾事务提交之后才调用，避免 run 锁和桌锁反序。它只认 `visibleTo` 恰好是 `[user]` 的消息，并且比对手和决策点，旧 run 的回调盖不掉重试后的行。

### 散场、复盘和战绩

**散场。** `leaveTable` 在手进行中回 409「这一手还没打完，打完再散场」，从没打过牌回 409「还没打过牌，没有要散的场」。否则用 `ended_at IS NULL` 的条件更新结束这一场。最近一场已散场而复盘还空时，再点一次会重派复盘，已经有复盘的再点什么都不做。重复点击撞 reviewer 的唯一索引回 busy，所以同一场只会有一份复盘在路上。

**解散。** 牌桌就是一个多 Bot 群，`POST /api/groups/:id/archive` 照样解散它（见「群与主题任务」的「解散群」）。在桌锁里把 `playing` 的那手改成 `abandoned`、清掉轮到谁和截止，桌回 `idle`、座位筹码回到这一场开场时的样子、版本加一，开着的那一场写上 `ended_at`。不派复盘、不写任何消息、不推牌桌视图，桌连同群一起读不到了。扫描器只扫 `playing` 的手，作废的手不会再被兜底推进。

**复盘状态。** 视图的 `reviewState` 只说最近一场已散场的那一场，全部从现有列推（`store.ts` 的 `reviewStateOf`）。`review` 非空是 `done`；这张桌有开着的 reviewer run 是 `generating`，一桌最多一条，只会是这一场的；其余都是 `failed`，包括散场时没有电脑在线、复盘根本没派出去。项目页的重试按钮打 `POST /poker/tables/:groupId/review`，带场次 id 是为了用户开了新一场之后还能给上一场补派，又不会误派到别的场。

**关键手。** `keyHandsOf` 从这一场已结算的手里挑用户（4 号）筹码变化绝对值最大的几手，最多 3 手（`KEY_HAND_LIMIT`），变化相同时先打的优先，按手序返回。挑手的是控制面，不是模型。老白只写话。

**复盘 prompt。** 每手带序号、标题（「你赢了 N」「你输了 N」「不输不赢」）、用户筹码变化和 4 号座的视图，没有种子，也没有别人没亮的牌。一手都没结算的场没有可复盘的，直接写一份空复盘，不派 run。散场和复盘都不在群里说话，复盘只落在项目页。

**交复盘。** `events/poker-review.ts` 要求 run 是这台电脑上还没结束的 reviewer run，session 是这张桌已散场的一场，提交的手和控制面自己挑的关键手一一对上（不重复、不遗漏、不多出，每手正文不超过 120 字，`REVIEW_TEXT_LIMIT`），任一不成立整条丢掉，没有回执，用户再点一次散场就重派。落库用 `UPDATE ... WHERE review IS NULL`，同一场重复交只有第一份生效。运行器那边有同一道长度检查，各自把关。

**战绩。** 没有单独的战绩表，每次读 `tableState` 现算。每手已结算的牌，用户净输赢是 4 号座最终筹码减 `seats_start` 里的起始筹码，按场累加。开着的那场给 `session.net` 和 `handCount`。`stats.sessions` 是已散场的场数，`sessionsWon` 是净值大于 0 的场数，`net` 是已散场各场之和。`lastReview` 是最近一场有复盘的已散场。

**群里怎么称呼用户。** 视图里 4 号位的名字是主人名。老白的播报、牌友和老白看的公开记录里，4 号位一律叫「你」，名字由 `narrate.ts` 的 `seatNamer` 统一换，`store.ts` 调 `hostLines`、`hint.ts` 和 `converge.ts` 调 `narrate` 都经过它。

**开下一手。** `startHand` 用 `UPDATE ... WHERE status = 'idle'` 认领桌子，抢不到回 409「桌上已有一手牌在进行」。没有开着的场就新建一场。庄位从上一手的庄位往后，按座位号找下一个有筹码的座位，第一手从 1 号找起。筹码不为正的座位按 `startingStack` 补码，补码不在群里说，桌面上的筹码自己会变。

**老白在群里说什么。** 群里只播关键处，单个动作不成消息，用户自己出牌也不成消息。一手最多五句：开手一句带庄位和盲注（「新一手，阿豹坐庄，老K小盲 10，茉莉大盲 20」），翻牌、转牌、河牌各一句带公共牌和此前的底池，结算一句写谁赢多少，摊牌时连同亮出的底牌和牌型。`store.ts` 每次落事件只拿这次新落的那段交给 `hostLines`，所以同一句不会说两遍。网页上座位状态、每一步动作和输赢都从视图的 `events` 画，不解析群消息。`narrate` 仍是逐条事件一句，只给牌友和老白 prompt 里的公开日志用。

## 用量、今天与通知

`GET /api/usage` 按用户返回本月合计、每个现存 Bot 的花费与 run 数（零花费也有一行）、本月有 run 的项目群（多 Bot 群，按金额降序），以及本月最近 20 次 run。月起点是 Asia/Shanghai 的 1 号 00:00，响应里的 `monthStartsAt` 是该时刻的 UTC ISO 时间。例如上海 2026-10-01 00:00 对应 `2026-09-30T16:00:00.000Z`。金额取 run 已保存的 `amount`，不重算历史价格。`runs.owner_id` 在 Bot 和群删除后仍保留，所以删掉的 Bot 的 run 计入 total，不再出现在 Bot 分列；迁移时只能回填仍能从 Bot 或群识别归属的旧 run。

预算住在 `settings.budget`（整数元每月，null 是不设），`PATCH /api/settings` 收，用量页随 `budget` 带回。本月合计 ≥ 预算就算超（D13）：例行的自动触发（到点和 webhook）不派活，记一条 `stopped`、note「本月超预算，没跑」的运行记录，不改例行状态，也不算进「三次没人看就自停」（`autoPauseIfUnseen` 按这个 note 排除，不给它盖 seenAt，免得打断真跑的连续计数），没有 run 行所以不进用量；试跑和用户当面说的照常。每次 run 结完账看一次本月合计，到了预算的 80%、开着通知、这个月还没提醒过，就推一条 `stuck` 通知。「一个月只一次」靠 `UPDATE settings SET budget_alerted_month = 本月 WHERE budget_alerted_month IS DISTINCT FROM 本月` 抢，不先查后写；关着通知时不占掉这个月，打开后下一次结账补上。

`GET /api/today` 只聚合当前用户的数据。计划只看 pending 和 approved 两种，稿子只看这些计划的稿子，加上不属于计划的 pending、approved 稿子，退回的计划和它的历史稿子不出现。`pending` 超过 50 条时保留最新 50 条，仍按到达时间正序排（先放着的建队卡在截好之后整组挪到末尾），待批计划里的稿子只嵌在计划项里；`done` 按时间倒序保留最新 20 条；`running` 每个群至多一行，取该群 `decidedAt` 最新的一份 approved 计划，这份计划的稿子全部发布（published 等于 planned）就不出行，没有计划的群这一期不出行，按批准时间倒序保留最新 20 条；`next` 按排期正序保留最近 20 条。`pending` 里的账号行（`kind: "account"`，带整个 `Account`）有两种：`login='expired'` 的账号恒出一行，`since` 是 `login_changed_at`，也就是什么时候过期的；`login='none'` 的浏览器登录类占位（`BrowserPlatform`，现在只有小红书）只在被当前 pending 稿子（不属于计划的，或挂在 approved 计划下的）或 pending 计划里的 pending 稿子引用时出一行，一个号只出一行，`since` 是引用它的待办里最早那件的 `since`：占位可能几天前就建了，要登录是从有稿子等着它那一刻开始的。GitHub、X 的 `none` 不出行，它们走授权页，不在电脑上登录。账号行和同一刻的待办并列时排在前面。这样待办数恒等于 `pending` 的条数：Web 首页的登录卡只替换这一行、挪到第一张要用它的稿子前面，服务端没列的号不凭空放卡；菜单栏不放卡，照原样列这一行，`none` 写「还没登录」，`expired` 写「登录过期」。`assistantGroupId` 是主助理的单聊群，只有 P1-13 之前注册、之后还没登录过的老用户才是 `null`。`assistantLatest` 是这个单聊里按 `seq` 最新的一条正文非空的 Bot 消息，正文按 UTF-16 码元截到 200、不劈开 emoji，加上它的 `createdAt`；用户的话、别的群的话都不算，没有主助理或它一句没说过时是 `null`。

`GET /api/projects/:groupId` 是项目页，同一套查询只看这一个群：群必须是本人的多 Bot 群，别人的群、单 Bot 群、不存在的群一律 404。`pending` 只有这个群的审批、计划和稿子，不带账号过期卡；`achievements` 读本人的 `publications` 和这个群的周复盘（见「周复盘」），合起来按时间倒序最新 20 条，小红书读不到笔记 id 时的管理页链接照样给，历史消息里长得像发布成功的话不算；`weekPublished` 是本周（周一 00:00，Asia/Shanghai）这个群发了几条，`weekChecked` 是任务卡清单里本周勾上、现在还勾着的项数；一句话连同它之后、下一句之前群里的其他消息算一轮，`latestTurn` 直接从 `messages` 取最近一轮，起点是按 `(createdAt, seq)` 最晚的那句用户消息，回应不含 cost、最多给最近 50 条，不受群历史分页窗口的限制，用户一句没说过时是 null，`olderTurns` 是更早的轮数。整页在一个 `REPEATABLE READ` 只读事务里查，起点、轮数和回应出自同一个快照：分开查的话，查完起点才落库的下一句不算起点，却会被当成回应带出来；`working` 是这个群还没结束的 run，标题规则和用量页一致；`plan` 是这个群最近批准的一份计划和它的稿子，`next` 是这个群最近一件排了时间的事，`routines` 是这个群的例行任务。

系统通知在这几种时候产生：

- `confirm`：新来一张审批卡。同一个群五分钟内（`CONFIRM_QUIET_MS`）只推第一张，一轮里 Bot 连着要批几样东西时只响一次，打开群就都看得到；记在内存里，重启清空。
- `result`：现在不产生。例行做完不推，见「例行任务」。
- `failed`：这件事没办成，要用户处理。有四种来源：例行任务中途报错或审批失效、记录收成失败，草稿发布失败，账号登录过期（见「账号」一节，和草稿失败同时发生时只推草稿那条），电脑代理报 `login_state` 的 `failed`。最后这种文案按原因写一句中文：`window_failed` 是登录窗口出错或被关掉了，`timed_out` 是开了很久还没登上、已经收起。两句都说账号状态没变、可以再点一次登录。登录没成不等于账号过期，`accounts.login` 不动。账号不属于哪个群，没有群消息可落，所以只走通知，`groupId` 为 null；用户关了通知就看不到这一句，免打扰期间它和别的通知一样只进汇总的件数。它不走 `stuck` 的去重和暂存，那两样是给电脑掉线的，登录接连失败几次每次都推。账号必须是这台电脑主人、登在这台电脑上的，同一个用户的另一台电脑报也不认，否则整条丢掉。
- `stuck`：例行任务到点时选不到电脑派不出去（原因和群里那句同源），或者跑到一半电脑断线被收尾。文案写明是哪条例行、为什么没跑。用户自己的消息派不出去时群里已经落了一条 system 消息，不再推。同一个用户一段离线期只推一次，他任一台电脑代理 hello 成功后清掉，下次再卡住再推。去重记在内存里。推 stuck 时用户没有推送连接，这条就留在内存里，连上推送时补发，`at` 仍是卡住的时刻。最常见的是本机 Mac 睡着，代理和 App 一起断开，醒来连上就收到。每段离线期至多留一条。代理 hello 只清去重，不清已经留下的。

用户关闭通知后不推。完整设置免打扰起止时间时，Asia/Shanghai 区间内只在内存累计数量，区间结束后由每 30 秒一次的扫描推一条汇总，所以汇总最多晚 30 秒。扫描每次按当前设置判断区间是否结束，缩短免打扰在下一次扫描就生效。跨午夜区间按次日结束计算。扫描时用户没有推送连接就留着计数，他下次连上推送时立刻汇总。留下的 stuck 和汇总一起补发时先推 stuck、后推汇总，连上时还在免打扰里就一起等到区间结束。设置改成不在免打扰里之后来的第一条通知，先推攒下的汇总再推它本身。单个用户汇总出错只清掉他的计数，不挡后面的用户。控制面重启会丢掉尚未汇总的内存计数、留着没发的 stuck 和 stuck 去重。

`users.last_seen_at` 列目前不再写入，留给后面的迁移删掉。

## 已知限制

**草稿、计划、例行、skill 四类没有服务端 revision。** 消息有：建出来是 0，正文每改一次加一，客户端只认更大的那份。这四类推送的是整个对象，几条路到客户端的先后没有保证，所以界面偶尔会停在旧状态，刷新或这一类的下一次推送就恢复。这是单人自用下的取舍（D38），没有为它给四张表各加一个 revision 列。写库一侧有条件守着：草稿和计划的状态流转靠 `WHERE status = 'pending'` 这类条件抢，旧界面上点出来的决定撞到已有结论就落不了库；改例行先锁行再合并；skill 的编辑是最后一次写赢，没有版本比较，一个人用不会撞。以后同一个账号要多人同时操作，再给这四类加 revision，做法照消息那一类。

## 迁移

```
pnpm --filter @baize/control-plane generate   # 改完 src/db/schema.ts 生成新迁移，只读 schema，不连库
pnpm --filter @baize/control-plane migrate    # 应用
```

已生成的迁移文件不改，只往后加。测试每个文件建一个随机库，从头跑全部迁移。

## 跑测试

```
docker compose up -d
pnpm --filter @baize/control-plane test
```

测试只通过 HTTP 和两条 WebSocket 碰控制面，不直接调路由函数。等异步效果时不靠超时：发一条确定会落地的报文，断言它先到，前面那步要是偷偷做了什么就会排在它前面。
