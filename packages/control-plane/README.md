# @baize/control-plane

控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js。四个对外的面在同一个 3001 端口上：`/api` 给 Web 客户端，`/api/ws` 往客户端推，`/agent` 给云电脑里的电脑代理，`/gateway/v1` 是模型网关。认身份、建电脑、发 config 那套写在仓库根 README.md 的「控制面」一节。

## 群与主题任务

每个群恰好一张主题任务卡。单 Bot 群在建 Bot 时自动建出来，多 Bot 群走 `POST /api/groups`，一次拉 2 到 6 个 Bot。编号是 `T-` 加四位，从 `user_counters.next_task_number` 取一个再把它加一，建 Bot 和建群共用这一个计数器，所以同一个用户的编号不会撞。`GET /api/groups` 只列成员数大于一的群，单 Bot 群在 `/api/bots` 里跟着它的 Bot 走。

### 路由规则

| 群 | 这条消息的目标 |
| --- | --- |
| 单 Bot 群 | 恒为它，@ 了谁、上一句谁经手都改变不了 |
| 多 Bot 群，正文 @ 了人 | 被 @ 的那些，按成员顺序去重 |
| 多 Bot 群，没 @ 人 | 当前经手 |
| 多 Bot 群，没 @ 人也没有当前经手 | 没人，群里留一句「@ 一个 Bot 派活」 |

规则本身是 `agent/routing.ts` 的两个纯函数，不碰数据库，成员由调用方查好传进去。「没人可派」这一句排在「电脑不在线」之前：谁都没 @ 的时候，让用户点个名比告诉他电脑睡了有用。

### `@名` 在写入前解析

`POST /api/groups/:id/messages` 在 `appendMessage` 之前按群成员名解析一遍正文，结果存进 `body.mentions`。派活只看它，不重新解析正文。名字长的先试，所以「@小销售」不会先命中成员「小销」；名字后面必须是空白或行尾。单 Bot 群不解析，`parseMentions` 在成员数小于二时直接返回空。

用户 @ 谁，谁就成为当前经手：`tasks.current_bot_id` 换人，`handled` 里上一位补上 `to`，新一位追加一条。@ 了好几个也只认第一个。这一段在事务里对那一行加行锁，不加的话两条并发消息会互相覆盖掉一条经手记录。Bot 之间 @ 不改经手，接力是 Bot 之间的事，不是用户交出去的。

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

触发那一刻就落一条 `running`，`run_done` / `agent_error` / `approval_request` 到了再改状态补 note，每次改都推一条 `routine_updated`（整条例行任务带 runs，客户端整条替换）。控制面中途重启的运行就停在 `running`，不补收尾。每条例行任务只留最近 20 条，插入后按 `started_at DESC, id DESC` 裁。

收尾要从 `run_id` 找回运行记录，两条路里选了**在 `runs` 上加 `routine_run_id` 可空列**，没用 `routine_runs.run_id`：run 行是 `startRun` 建的，派活时把 `routineRunId` 一路带进去，行一生下来就带着这条边。反过来先建 `routine_runs` 再回填 `run_id` 的话，派活到回填之间有个窗口，活跑得快的时候 `run_done` 进来会查不到边。

webhook 的 token 存在 triggers jsonb 里，`/api/hooks/:token` 用 `@>` 配 GIN 索引直接查，**没有单独的 `webhook_tokens` 表**：token 只由控制面的 `randomBytes(16)` 发，客户端在 `TriggerInput` 里只能带回这条例行任务已有的那个，别的都换新，所以撞号得赢 128 位随机数，一张表换来的唯一约束挡不住任何现实中的路，反倒多一条要同步的边。

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
