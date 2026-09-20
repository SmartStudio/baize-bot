# @baize/control-plane

控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js。四个对外的面在同一个 3001 端口上：`/api` 给 Web 客户端，`/api/ws` 往客户端推，`/agent` 给云电脑里的电脑代理，`/gateway/v1` 是模型网关。认身份、建电脑、发 config 那套写在仓库根 README.md 的「控制面」一节。

## 工具连接

工具连接是用户级对象。`tool_connections` 存 MCP 地址、发现的操作及其 `needsApproval` 标记，并把认证信息以 AES-256-GCM 密文存入 `authorization_enc`；`tool_connection_bots` 记录它分配给哪些 Bot，删 Bot 时对应分配由外键级联清除。API 列表和写入响应都不返回认证信息，电脑代理的 `config.tools` 才带解密后的值和 Bot 分配。

生产环境设置 `TOOL_SECRET_KEY` 为 64 位十六进制密钥。未设置时启动会警告一次，并使用固定开发密钥；已有密文依赖原密钥解密，换密钥前需迁移密文。MCP 发现时把认证信息作为 `Authorization` 请求头发送。操作默认按 MCP 的 `readOnlyHint` 定审批：明确为 `true` 的不需要，其余都需要；用户可通过 `PATCH /api/tools/:id` 覆盖标记。连接创建、修改、删除后，控制面都会向该用户在线电脑重发整份 `config`。

## 群与主题任务

每个群恰好一张主题任务卡。单 Bot 群在建 Bot 时自动建出来，多 Bot 群走 `POST /api/groups`，一次拉 2 到 6 个 Bot。编号是 `T-` 加四位，从 `user_counters.next_task_number` 取一个再把它加一，建 Bot 和建群共用这一个计数器，所以同一个用户的编号不会撞。`GET /api/groups` 只列成员数大于一的群，单 Bot 群在 `/api/bots` 里跟着它的 Bot 走。

### 路由规则

| 群 | 这条消息的目标 |
| --- | --- |
| 单 Bot 群 | 恒为它，@ 了谁、上一句谁经手都改变不了 |
| 多 Bot 群，正文 @ 了人 | 被 @ 的那些，按正文首次出现顺序去重 |
| 多 Bot 群，没 @ 人 | 当前经手 |
| 多 Bot 群，没 @ 人也没有当前经手 | 没人，群里留一句「@ 一个 Bot 派活」 |

规则本身是 `agent/routing.ts` 的两个纯函数，不碰数据库，成员由调用方查好传进去。「没人可派」这一句排在「电脑不在线」之前：谁都没 @ 的时候，让用户点个名比告诉他电脑睡了有用。

### `@名` 在写入前解析

`POST /api/groups/:id/messages` 在 `appendMessage` 之前按群成员名解析一遍正文，结果存进 `body.mentions`。派活只看它，不重新解析正文。名字长的先试，所以「@小销售」不会先命中成员「小销」；名字后面必须是空白或行尾。单 Bot 群不解析，`parseMentions` 在成员数小于二时直接返回空。

用户 @ 谁，谁就成为当前经手：`tasks.current_bot_id` 换人，`handled` 里上一位补上 `to`，新一位追加一条。多 @ 按正文顺序，第一个成为经手。这一段在事务里对那一行加行锁，不加的话两条并发消息会互相覆盖掉一条经手记录。Bot 之间 @ 不改经手，接力是 Bot 之间的事，不是用户交出去的。

### 多目标派活

每个目标各起一个 run、各发一条 prompt。多 Bot 群的 prompt 带完整任务卡和全体成员名单，Bot 靠名单知道能 @ 谁；单 Bot 群 `task` 为 null。上下文按收件人分别生成：收件人看自己只有名字，看别人是「名 · tag」，看已经删了的 Bot 是「别的 Bot」。任务卡不进上下文，它走 `task` 字段。

### 上行 `task_checklist` 和 `mention`

`task_checklist` 整份替换清单，同一份重发两遍结果不变。清单里每条的 `ownerBotId` 控制面再校一次，必须是 null 或这个群的成员，有一条不是就整条丢掉不落库。运行器那边只能对着这次 prompt 带去的名单把名字解析成 id，比不出群的真实成员表，所以这一道不能省。

`mention` 的目标必须是这个群的成员且不是它自己。消息先落库再判限额：那句话 Bot 确实说了，用户该看见，停下的只是派活。两条用户消息之间，Bot 发起的 @ 最多派 10 次，越线的第一条在群里留一句「Bot 之间 @ 太多次，停下等你」，之后的只是不派。计数在内存里，进程重启归零，用户一说话就归零。

### 上行报文的 runId 归属

带 runId 的上行报文（`bot_text`、`bot_tool_call`、`run_done`、`approval_request`、`task_checklist`、`mention`）都过同一道校验：群要是这台电脑主人的，run 要是报文里那个 Bot 在那个群里的活。外键只保证 runId 存在，管不了它指到哪个群，不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。任一不成立整条丢掉，丢得安静：不抛异常，不给电脑回报文，只记一条日志。

## 审批

群消息是事实来源，审批是唯一一件「群消息本身说不全」的事：那张卡的正文只有一个 approvalId，批没批写在 approvals 行上。所以结论只随 `approval_updated` 推，重推那条 message 一个字都不会变。

### 哪些工具要点头

工具连接（`ToolConnection`）的 `operations` 里 `needsApproval` 为真的操作。判定在电脑那一侧做，控制面不重算一遍。工具名前缀到 `kind` 的映射表（`send_` 到 `send_external`、`pay_` 到 `pay`、其余到 `change_production_data`）在 `packages/bot-runner/README.md`。

### 一条链

| 这一步 | 谁做 | 结果 |
| --- | --- | --- |
| 拦下要点头的工具 | 运行器 | 发一条 `approval_request` 上来，handler 挂起等结论 |
| `approval_request` 到达 | `agent/events.ts` | 一个事务里建群消息和 approvals 行，先推 `approval_updated` 再推那条 `message` |
| 归属人点批准或拒绝 | `POST /api/approvals/:id` | 定结论、向电脑发 `approval_result`、推 `approval_updated` |
| 结论到达 | 运行器 | 批了就往下跑，拒了就 `block`，这个工具调用的终态是 `blocked` |

控制面收到 `approval_request` 时**不回任何东西**，运行器就一直挂着等。这是审批的本意：没人点头就不往下走。

两处幂等，都靠数据库自己，不靠先查后写：

- 电脑重发同一条 `approval_request` 时，唯一索引 `(run_id, call_id)` 拦下，整条事务回滚。群里不多一张卡，也不多推一次。消息必须先落地（`approvals.message_id` 是非空外键），所以输掉竞争时只能整条回滚，不能只删一半。
- 重复的决定靠 `WHERE status = 'pending'` 拦下，返回 0 行就是 409。电脑不会第二次收到 `approval_result`。

### 群里回话等于按按钮

用户消息正文去掉首尾空白后恰好是「批准」「同意」「拒绝」「不行」之一时，落到该群最近一条待批审批上。词表在 `agent/dispatch.ts` 的 `REPLY_DECISIONS`。

这条消息照常存、照常推，但**不再派活**。运行器正挂着等这条审批的结论，再派一次会并发起第二个 run。群里没有待批审批时，「批准」就是一句普通话，照常派活。

### 超时只提醒

`repo/approvals.ts` 的 `remindStaleApprovals(db, push, now)` 给放了 24 小时还没有结论的审批各补一条 system 消息。**不升级，也不自动拒绝**，等的人始终是归属人。

先把 `reminded_at` 占住再补消息，所以再扫一遍不会重复提醒，进程重启也不会。`reminded_at` 就是为这个存在的。时钟是参数不是全局，`server.ts` 里一小时传一次 `new Date()`，测试直接传一个 25 小时后的时刻。

### 电脑断线

有效连接断开后等 15 秒；期间重连就用 `hello.activeRuns` 对账，缺席的 run 当即结束并在原群提示「电脑断过线，这次活没做完」，未重连则宽限到期后收尾全部未结束的 run。同一个 run 只收尾一次。

pending 的审批留着。重连后照发 `welcome` 加 `config`，**不重发** `approval_request`：那是电脑发给控制面的方向，重连时控制面无从替它再问一遍。重连之后点的结论，`approval_result` 会发到重连后的那条连接上。

电脑不在线时点结论，`agents.send` 返回 false，这一版**决定照样落库**，群里不额外补一句话。运行器那一头本来就已经断了，等它回来是另一件事。

## 交接

一个 Bot 把手里的活交给群里另一个 Bot。审批等的是人点头，交接等的是另一个 Bot 接手，落库、推送、24 小时提醒是同一种形状。群里那张 `kind: handoff` 卡的正文只有一个 handoffId，做了什么、没做什么、下一步和清单指针都在 handoffs 行上，所以状态只随 `handoff_updated` 推，重推那条 message 一个字都不会变。

### 一条链

| 这一步 | 谁做 | 结果 |
| --- | --- | --- |
| 决定交出去 | 运行器 | 发一条 `handoff` 上来，带目标 Bot 和 done / notDone / next / checklistIndex |
| `handoff` 到达 | `agent/events.ts` | 一个事务里建群消息和 handoffs 行，先推 `handoff_updated` 再推那条 `message`，然后给目标派一条 prompt，带 `handoffId`，正文是 `agent/handoff.ts` 渲染出来的报文 |
| 目标确认接手 | 运行器发 `handoff_accept` | 状态改 accepted、`tasks.current_bot_id` 换人、经手记录补上一位的 `to` 再加新一位，推 `handoff_updated` 和 `task_updated` |

**确认之前当前经手不换人。** 交出去的那一个照旧收群里不 @ 人的消息，目标只是多收到一份报文。换人发生在 accept，不在发起，所以目标一直不确认时活不会悬在半空。

交接与 Bot @ 共用次数上限；越限时不落卡，也不写 handoffs 行。第一次越限留一条提示，后续静默。

### 两道校验

`handoff` 要发起者正是这个群当前的经手，且目标是群里的另一个成员，不能交给自己。`handoff_accept` 要这个 handoffId 属于这个群，且它的目标正是报上来的这个 Bot。任一不成立整条丢掉，跟别的上行报文一样：不抛异常，不给电脑回报文，只记一条日志。

幂等靠数据库自己，不靠先查后写：`acceptHandoff` 的 `WHERE` 把 id、群、目标 Bot 和 `status = 'pending'` 一起写进去，重复确认、别的 Bot 替它确认、指错群，都返回 0 行，走同一条丢弃分支。消息必须先落地（`handoffs.message_id` 是非空外键），所以建卡和建行只能整条成或整条回滚。

和审批不同，这里**没有 `(run_id, call_id)` 那样的唯一键**：交接由 Bot 主动发起，同一个 Bot 交两次就是两份报文，不是重发。

### 超时只提醒

`repo/handoffs.ts` 的 `remindStaleHandoffs(db, push, now)` 给放了 24 小时还没确认的交接各补一条 system 消息。**不退回，也不升级**，活还挂在交出去的那一位身上。占住 `reminded_at` 再补消息、推送放在事务外，这套动作和审批共用 `repo/reminders.ts` 的 `appendReminders`，所以「再扫一遍不重复提醒、进程重启也不重复」对两者同时成立。时钟同样是参数不是全局，`server.ts` 里一小时一次，两条扫描共用同一个 `now`。

### 侧栏角标

`/api/bots` 和 `/api/groups` 的 `pendingHandoffs` 跟 `pendingApprovals` 一样按群算：该群还没确认的交接条数，Bot 那一行取它所在群的数。发起时加一，确认后归零。`/api/groups/:id/messages` 顺带把这一页消息里出现过的 handoffs 一起带下去，客户端不用为每张卡再问一次。

## 例行任务

例行任务属于一个 Bot。**一次运行就是归属人在这个 Bot 的单 Bot 群里发了一条消息**：先落一条 system「例行任务「X」自动运行」，再落一条正文是 `instruction` 的 user 消息，然后走和手打消息同一个 `dispatchUserMessage`。运行器和电脑代理因此不认识例行任务，没有新报文。到点触发、`POST /api/hooks/:token`、`POST /api/routines/:id/run` 三个入口走的都是 `routines/run.ts` 的 `runRoutine`。

### 调度判定

`routines/scheduler.ts` 是单实例，在控制面进程里每 30 秒扫一遍带 cron 触发器的例行任务，`startServer` 起它、`close` 停它，时钟和扫描间隔都能注进来。

到点判定不是「离上次满 N 分钟了」，而是**「上次触发之后到现在之间存在一个 cron 时刻」**。游标 `lastFiredAt` 记在 triggers jsonb 里每个触发器上，触发时同一条 `UPDATE` 把它推到那个时刻并把旧值写进 `WHERE`：

```sql
UPDATE routines SET triggers = jsonb_set(triggers, '{0,lastFiredAt}', ...)
WHERE id = $1 AND triggers -> 0 ->> 'lastFiredAt' = $旧值
```

推不动就是别人已经推过了，这一刻不归我。两个进程同时扫也只发一次，扫得勤一点只让它准时一点，不会多跑。

### 停机不补跑

`routines/cron.ts` 的 `dueMoment` 取的是空窗里**最晚**的那个 cron 时刻，不是最早的。停机三小时再起来，每分钟跑的例行任务只跑这一刻，不把错过的 180 次排队跑一遍。`lastFiredAt` 为空的（新建的、刚迁移上来的）在调度器 `start` 时和每次扫到时都对齐到现在，对齐不算触发，所以新建一条不会立刻跑。

停用的例行任务**照推游标但不跑**。不这样的话停用一周再启用，攒下的那一刻会立刻补跑一次。webhook 打停用的回 409。

### 运行记录

触发那一刻就落一条 `running`，`run_done` / `agent_error` / `approval_request` 到了再改状态补 note，每次改都推一条 `routine_updated`（整条例行任务带 runs，客户端整条替换）。控制面中途重启的运行会在电脑重新 hello 时对账收尾；电脑一直不再连接时仍停在 `running`。每条例行任务只留最近 20 条，插入后按 `started_at DESC, id DESC` 裁。

收尾要从 `run_id` 找回运行记录，两条路里选了**在 `runs` 上加 `routine_run_id` 可空列**，没用 `routine_runs.run_id`：run 行是 `startRun` 建的，派活时把 `routineRunId` 一路带进去，行一生下来就带着这条边。反过来先建 `routine_runs` 再回填 `run_id` 的话，派活到回填之间有个窗口，活跑得快的时候 `run_done` 进来会查不到边。

webhook 的 token 存在 triggers jsonb 里，`/api/hooks/:token` 用 `@>` 配 GIN 索引直接查，**没有单独的 `webhook_tokens` 表**：token 只由控制面的 `randomBytes(16)` 发，客户端在 `TriggerInput` 里只能带回这条例行任务已有的那个，别的都换新，所以撞号得赢 128 位随机数，一张表换来的唯一约束挡不住任何现实中的路，反倒多一条要同步的边。

## skill

Bot 会做的一件活。**真相源是控制面的 `skills` 表，方向只有一条：随 `config` 下发，运行器落成 `<botDir>/skills/<skillId>/SKILL.md`，不往回同步。** 两个方向都能写的文件没有真相源：运行器改了一笔、Web 上同时改了一笔，谁覆盖谁只取决于哪条消息先到。`config.skills` 是该用户**全部** Bot 的 skill，运行器按 botId 分开落盘；这个字段恒带，一条都没有也带一个空数组，运行器靠整份名单和 skills 目录对账，省掉它它就分不清「这个用户没有 skill」和「这条 config 没说 skill 的事」，剩下的目录就删不干净。

### 同一 Bot 下名字不重复

唯一索引 `(bot_id, name)` 是这件事的唯一真相源。建一条、改名、复制给别的 Bot、点存，四条路都靠**插入撞它**来判 409，不先查后写：先查后写挡不住并发的两个同名请求，两边都查到没有，两边都插进去。重名必须在库这一级挡死，因为 Pi 按 name 去重，同名的第二条根本不会进系统提示，库里留着它只会让用户看见一条永远跑不起来的活。

点存撞名时**卡留在 offered**，让用户先改名再点。所以那个事务只能整条回滚，不能只插一半：卡和 skill 行要么一起成，要么一个都不动。撞名和「已经点过了」都走 `tx.rollback()`，而它抛的是同一种错，所以是谁回滚的记在事务外的一个变量上，路由层照它翻 409 的文案。

### 那张卡的状态住在正文里

和审批、交接**相反**。审批和交接的卡正文里只有一个 id，状态在 `approvals` / `handoffs` 自己那一行上，所以重推那条 message 一个字都不会变。skill_offer 不是这样：`name` 和 `steps` 在用户点存之前**不在任何表里**，只在正文里，状态没有别的地方可住。点完存或不存要**重推那条 message**，客户端按 id 覆盖那张卡。

幂等同样不靠先查后写，靠那条 UPDATE 自己：`WHERE id = ? AND group_id = ? AND body->>'status' = 'offered'`。两个并发的点存只有一个改得动，另一个看到 0 行就是 409。

### `skill_offer_source` 为什么在 `messages` 上

来源有三种。`taught` 是 Web 上「教它一个」那条路写死的，另外两种只有**上行那一刻**判得出来：这个 `runId` 能不能找到一条 `routine_runs`，找得到就是 `routine`，找不到就是 `chat`。用户点存时手上只有那张卡，卡的正文里没有 runId，例行任务的运行记录又只留最近 20 条，早的那次连行都不在了。shared 的 `skill_offer` 正文里没有 source 字段，形状是冻的，塞不进去。所以单开 `messages.skill_offer_source` 一列存着它，点存时写进 skill 行。这一列只对 `kind = 'skill_offer'` 的行有意义，不出边界，`toMessage` 不读它。M10 之前落的卡读不到这一列，按对话算。

### `/名` 引用

`POST /api/groups/:id/messages` 落库推完那条消息之后解析一遍正文，命中的 skill `use_count` 加一。**控制面不改写正文**，运行器收到的和用户手打的一模一样，Pi 自己按名字找那份 SKILL.md。

解析规则和 `@` 完全一样，公共的那段就是 `agent/routing.ts` 的 `scanNames`：名字长的先试（「/小销售」不会先命中「小销」），名后必须跟空白或行尾，按索引扫不拼正则（skill 名里可能带正则元字符）。两处的差别只有两点：`@` 在单 Bot 群不解析，`/名` 在单 Bot 群照样算；`@` 认的是群成员，`/` 认的是群里全体成员 Bot 的 skill，按 `group_members.position, skills.created_at, skills.id` 排。

**每个 `/` 位置最多认一条。** 同名的 skill 跨 Bot 可以重名，但 Pi 按 name 去重，同名的第二条根本不会进系统提示，所以只给排在前面的那一条计数，和真正跑起来的那一条对得上。

### 哪个动作推什么

| 动作 | 推送 | 重发 config |
| --- | --- | --- |
| `POST /api/bots/:id/skills` | `skill_updated` | 是 |
| `PATCH /api/skills/:id` | `skill_updated` | 是 |
| `DELETE /api/skills/:id` | `skill_deleted` | 是 |
| `POST /api/skills/:id/copy` | `skill_updated`（新那条） | 是 |
| 上行 `skill_offer` | `message` | 否，还没建 skill 行 |
| 点「存」 | `message`、`skill_updated` | 是 |
| 点「不存」 | `message` | 否，什么都没变 |
| 正文里 `/名` | 每条命中一条 `skill_updated` | 否，只有 `use_count` 变了，它不进 SKILL.md |

## 用量与昨夜进展

`GET /api/usage` 按用户返回本周合计、每个现存 Bot 的花费与 run 数（零花费也有一行），以及不限本周的最近 20 次 run。周起点是 Asia/Shanghai 的周一 00:00，响应里的 `weekStartsAt` 是该时刻的 UTC ISO 时间。例如上海 2026-09-21 00:00 对应 `2026-09-20T16:00:00.000Z`。金额取 run 已保存的 `amount`，不重算历史价格。`runs.owner_id` 在 Bot 和群删除后仍保留，所以删掉的 Bot 的 run 计入 total，不再出现在 Bot 分列；迁移时只能回填仍能从 Bot 或群识别归属的旧 run。

`GET /api/overnight` 的 `since` 是用户上一条推送 WebSocket 断开的时间，任一连接断开都会更新。没断开过，或离上次断开不到 30 分钟，`items` 为空。其余情况从断开之后每个 Bot 最新一条非空、已结束流式输出的 bot 消息取正文，按时间倒序至多 10 条。消息所在群里有该 Bot 发起的 pending 审批或 pending 交接时是 `waiting`；否则该 Bot 有未结束的 run 时是 `working`；其余是 `done`。审批/交接优先于运行状态。

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
