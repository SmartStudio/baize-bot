# @baize/control-plane

控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js。四个对外的面在同一个 3001 端口上：`/api` 给 Web 客户端，`/api/ws` 往客户端推，`/agent` 给电脑上的电脑代理，`/gateway/v1` 是模型网关。认身份、建电脑、发 config 那套写在仓库根 README.md 的「控制面」一节。

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
| 多 Bot 群，没 @ 人、有首席 | 只派首席 |
| 多 Bot 群，没 @ 人、没首席、有当前经手 | 只派当前经手 |
| 多 Bot 群，没 @ 人、没首席也没当前经手 | 全员按成员表顺序轮流说 |

`@所有人` 派给全员，顺序按成员表。首席是群属性，可以由 Bot 调用 `set_chief` 设置或卸任；首席优先于当前经手。Bot 没有话要说时以 `(pass)` 或 `（pass）` 开头回复，控制面不落这条消息，也不推给 Web。

同一条用户消息只让一个 Bot 运行。当前 Bot 的 `run_done` 到达后才派下一位；一轮里 Bot @ 了人，就按正文顺序进入下一轮。Bot 消息累计到 10 条时停止，并在群里留一句提示。

### `@名` 在写入前解析

`POST /api/groups/:id/messages` 在 `appendMessage` 之前按群成员名解析一遍正文，结果存进 `body.mentions`。派活只看它，不重新解析正文。名字长的先试，所以「@小销售」不会先命中成员「小销」；名字后面必须是空白或行尾。单 Bot 群不解析，`parseMentions` 在成员数小于二时直接返回空。

用户 @ 谁，谁就成为当前经手：`tasks.current_bot_id` 换人，`handled` 里上一位补上 `to`，新一位追加一条。多 @ 按正文顺序，第一个成为经手。这一段在事务里对那一行加行锁，不加的话两条并发消息会互相覆盖掉一条经手记录。Bot 之间 @ 不改经手，接力是 Bot 之间的事，不是用户交出去的。

### 多目标派活

每个目标各起一个 run、各发一条 prompt。多 Bot 群的 prompt 带完整任务卡和全体成员名单，Bot 靠名单知道能 @ 谁；单 Bot 群 `task` 为 null。`messageId` 是触发这次 prompt 的那条群消息：用户发的、Bot @ 队友的那条、交接卡、例行写进群里的那条用户消息。上下文按收件人分别生成：收件人看自己只有名字，看别人是「名 · tag」，看已经删了的 Bot 是「别的 Bot」。任务卡不进上下文，它走 `task` 字段。

上下文里的卡写成一句结论，不是一个 id。审批、交接、草稿、内容计划的状态住在各自的行上，这批上下文涉及的每种卡各用一条查询查完，写成「小服要执行 `pay 100`，你批准了」「小服把活交给阿文，下一步是「…」，阿文接了」这样；草稿批了以后写「等着发」还是「留着没发」看账号现在的档位，有草稿卡时多查一次账号表。skill 卡和方案卡的状态就在正文里，照正文写。卡指的行查不到就不写这一条。卡的状态变了消息 id 不变，已经在水位之前的卡不会因为状态变化再送一次。

### 派到哪台电脑

一个用户最多两台电脑，本机和远程。规则是 `agent/computer-selection.ts` 的纯函数 `selectComputer`，输入是这次要碰的账号和候选电脑，每台候选电脑可以带上挂在它上面的账号，在线看 `AgentHub` 此刻有没有这台的连接。`dispatchUserMessage` 选一次，头一个 speaker 就派到这台，不再重选：重选的话两次之间掉线，头一个就不建 run 派空了，调用方却已经拿到 `sent`，例行会一直停在运行中。同一回合后面的 speaker 要等前一个跑完才派，那时各自再选。

| 这次要碰的账号 | 派到 |
| --- | --- |
| 不碰账号 | 本机在线派本机，否则远程在线派远程，都不在线就派不出去 |
| 碰账号 | 账号所在的那台；那台离线就派不出去，不改派到另一台 |

**这一版派活不要求账号，候选电脑也不带账号。** `dispatch.ts` 的 `computerFor` 给 `selectComputer` 传的要求账号和每台电脑的账号都是空数组，实际走的是上表第一行。没有哪张表把群、例行或 Bot 绑到账号上，能从数据里算出来的只有群里草稿用过的账号。拿它来算不对：起草只要 `config.accounts` 里有这个账号，哪台电脑都能起，真发由发布循环按账号所在的电脑去发，不走派活。按草稿账号算的话，小红书项目的「排本周计划」会被钉在本机，合上 Mac 就不跑；主助理单聊里草稿跨了两台电脑的账号，就再也派不出去。

**要求账号的数据接上时，连同 HTTP 用例一起加。** 那时要做两件事：给候选电脑接上 `accounts.computer_id` 对应的账号，再把这次要碰的账号传进来。只接前一件的话，没有任何 HTTP 用例看得出它断没断；只接后一件而前一件是断的，每次碰账号都会返回 `required_account_not_found`，群里说「要用的账号已经不在账号页里」，账号其实还在。所以接线和一条走 HTTP 的「碰本机账号的活本机离线时不改派」用例同一单加。

派不出去时不建 run，群里落一句 `tone: "error"` 的 system，每种原因一句，写在 `SELECTION_FAILURE`。有两台电脑而都不在线时单说一句，让人看得出不是只有一台：

| 原因 | 群里那句 |
| --- | --- |
| `no_computer_online` | 电脑不在线，这条没派出去，电脑回来后再说一次 |
| `all_computers_offline` | 你的电脑都不在线，这条没派出去，有一台回来后再说一次 |
| `required_account_not_found` | 要用的账号已经不在账号页里，这条没派出去，把账号挂上后再说一次 |
| `accounts_on_multiple_computers` | 要用的账号分在两台电脑上，这条没派出去，拆成两句，每句只碰一台电脑上的账号 |
| `required_computer_offline` | 要用的账号所在的那台电脑不在线，这条没派出去，也不会改派到另一台，那台回来后再说一次 |

### 上行 `task_checklist` 和 `mention`

`task_checklist` 整份替换清单，同一份重发两遍结果不变。清单里每条的 `ownerBotId` 控制面再校一次，必须是 null 或这个群的成员，有一条不是就整条丢掉不落库。运行器那边只能对着这次 prompt 带去的名单把名字解析成 id，比不出群的真实成员表，所以这一道不能省。

`mention` 的目标必须是这个群的成员且不是它自己。消息先落库再判限额：那句话 Bot 确实说了，用户该看见，停下的只是派活。两条用户消息之间，Bot 发起的 @ 最多派 10 次，越线的第一条在群里留一句「Bot 之间 @ 太多次，停下等你」，之后的只是不派。计数在内存里，进程重启归零，用户一说话就归零。

### 上行报文的 runId 归属

带 runId 的上行报文（`bot_text`、`bot_tool_call`、`run_done`、`approval_request`、`task_checklist`、`mention`）都过同一道校验：群要是这台电脑主人的，run 要是报文里那个 Bot 在那个群里的活。外键只保证 runId 存在，管不了它指到哪个群，不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。任一不成立整条丢掉，丢得安静：不抛异常，不给电脑回报文，只记一条日志。

## 主助理

每个用户恰好一个主助理，`bots.role = 'assistant'`，由部分唯一索引 `bots_owner_id_assistant_idx` 钉住。`ensureAssistant(tx, ownerId)` 不先查：直接插 bot 行撞这个索引，`onConflictDoNothing` 没返回行就停，不占编号、不建群。真插进去的那次才建单聊群、主题任务卡和 `group_members`，并在单聊里写主助理的第一句 `ASSISTANT_GREETING`。注册在同一个事务里调它；登录成功后再调一次，给 P1-13 之前注册的老用户补建，补建成功且电脑在线就重发一次 `config`；电脑 `hello` 校验通过后、查 Bot 发 `config` 之前也调一次，会话还有效、一直没重新登录的老用户靠这一处补上，补建成功时这个用户的其他连接也重发一次 `config`；`seed` 建完用户也调一次。主助理的色相固定 `sky`，不推进 `user_counters.next_hue`，所以用户自己建的 Bot 仍从色相轮转的第一格起。

`DELETE /api/bots/:id` 删不了主助理，回 409 和一句中文原因。删除和收审批用同一个 `role = 'member'` 条件，删不到时再分辨是主助理还是不存在。群没有删除和退群的接口，所以主助理的单聊群没有别的入口可以拆。

派给主助理的 `prompt` 恒带 `projects`，是这个用户所有项目群（`solo_bot_id IS NULL` 的群）的 `groupId`、`title`、`cadence`，没有项目也带空数组；派给队员不带。上行 `set_cadence` 先照常校验 run 归属，再在同一条 `UPDATE tasks` 里要求 `projectGroupId` 是这个用户的项目群、发报文的 Bot 是这个用户的主助理，改不到就静默丢弃。改成了只推 `task_updated`，不建审批、不写卡片消息。`findAssistant(db, ownerId)` 是取主助理和它单聊群的唯一入口，`GET /api/today` 用它，P1-9 建项目群时也用它。

## 项目

项目是主助理提议、用户点「开始」才建出来的多 Bot 群。

### 方案卡

上行 `project_offer` 先照常校验 run 归属，再要求发报文的 Bot 是这个用户的主助理、run 所在的群是主助理的单聊，不成立整条静默丢弃。成立就在单聊里落一条 `project_offer` 消息，`status: "offered"`、`groupId: null`，此外什么都不建。`platforms` 里的 `unsupported` 只随正文留着给 Web 显示，不建任何东西。

### 点开始

`POST /api/messages/:id/project-offer` 按归属人查这条消息，正文不是方案卡或不是自己的回 404。`start` 在一个事务里做完下面几件事，第一步就是抢卡：

1. `UPDATE messages ... WHERE body ->> 'status' = 'offered'`，同时写进 `status: "started"` 和预先生成的项目群 id。并发的第二个请求在行锁上等，醒来 `WHERE` 已不成立，一行都改不到，事务回滚，什么都不建。
2. 按 `team` 建队员 Bot，每个都带自己的单聊群（`listBots` 按单聊 join，没有单聊的 Bot 进不了 `config`）。`tag` 对 `tag`，`description` 对 `description`。
3. 建项目群和主题任务卡。群名取请求里的 `name`，没给用正文的；`summary` 取 `goal`，`cadence` 取正文，`firstStep` 是清单第一项。成员是主助理在前、队员在后，首席是主助理。
4. 建 `PROJECT_ROUTINES` 两条例行：「周一 09:00 排本周计划」让主助理调 `propose_plan`，「周五复盘」只复盘。例行的 Bot 是主助理，`groupId` 是项目群，`purpose` 是 `plan`。

提交之后重推这条消息，推 `group_created` 和每条 `routine_updated`，再重发 `config`，新队员这时才跑得起来。`dismiss` 用同一个条件 `UPDATE` 改成 `dismissed` 并重推。抢不到卡时回 200 带当前消息，已开始的顺带项目群，不再推送。

## 审批

群消息是事实来源，审批是唯一一件「群消息本身说不全」的事：那张卡的正文只有一个 approvalId，批没批写在 approvals 行上。所以结论只随 `approval_updated` 推，重推那条 message 一个字都不会变。

### 哪些工具要点头

判定全在电脑那一侧的统一闸门里做，顺序是禁区、硬清单、授权、默认表，控制面不重算一遍，细节在 `packages/bot-runner/README.md`。闸门判成「问」时发上来的 `approval_request` 带着 `action` 和 `target`，控制面原样存在 approvals 行上，批准时的授权就从这两列来。

### 一条链

| 这一步 | 谁做 | 结果 |
| --- | --- | --- |
| 拦下要点头的工具 | 运行器 | 发一条 `approval_request` 上来，handler 挂起等结论 |
| `approval_request` 到达 | `agent/events.ts` | 一个事务里建群消息和 approvals 行，先推 `approval_updated` 再推那条 `message` |
| 归属人点批准或拒绝 | `POST /api/approvals/:id` | 定结论，选了长期范围就落授权并先重发 `config`，再向电脑发 `approval_result`、推 `approval_updated` |
| 结论到达 | 运行器 | 批了就往下跑，拒了就 `block`，这个工具调用的终态是 `blocked` |

控制面收到 `approval_request` 时**不回任何东西**，运行器就一直挂着等。这是审批的本意：没人点头就不往下走。

两处幂等，都靠数据库自己，不靠先查后写：

- 电脑重发同一条 `approval_request` 时，唯一索引 `(run_id, call_id)` 拦下，整条事务回滚。群里不多一张卡，也不多推一次。消息必须先落地（`approvals.message_id` 是非空外键），所以输掉竞争时只能整条回滚，不能只删一半。
- 重复的决定靠 `WHERE status = 'pending'` 拦下，返回 0 行就是 409。电脑不会第二次收到 `approval_result`。
- 同一个用户对同一类动作、同一个目标、同一个群（`forever` 的群是空）只有一条授权，唯一约束 `grants_owner_action_target_group_uq` 带 `NULLS NOT DISTINCT`，空群也算重复。批第二次走 `ON CONFLICT` 拿回原来那一条，两条审批的 `grantId` 指向同一行。

### 批准的范围落成授权

`DecideApprovalRequest.scope` 是 `once`、`project`、`forever` 之一，省了是 `once`。

| 范围 | 落什么 |
| --- | --- |
| `once` | 不落授权，只放行这一次 |
| `project` | 一条绑在这个群上的授权，别的群同类动作照样问 |
| `forever` | 一条对这个用户全局生效的授权。表里没有 Bot 列，同一个用户的所有 Bot 都认 |

越级的范围在边界回 400，不落授权，审批还在等：

- 超出 `GRANTABLE_SCOPES[action]` 的。`spend`、`account_security`、`delete` 只能 `once`，`write_outside` 最多 `project`。表里的 check 约束再兜一道。
- 审批行的 `target` 为空的。授权记的是「同类动作、同一个目标」，没有目标就没东西可记。Web 那边这种卡只给「这一次」，两边照同一条规则。

定结论、落授权、把 `grantId` 写回审批行在一个事务里。越级时 `UPDATE ... WHERE status = 'pending'` 已经跑过，只能整条回滚，所以不先查后写也不会把审批误定下来。

落了授权就**先重发 `config` 再发 `approval_result`**。运行器放行之后紧接着的同类调用要读到这条授权，顺序反过来它还会再问一次。群里回「批准」这类词没法选范围，一律按 `once`。

`GET /api/grants` 列这个用户的全部授权。`DELETE /api/grants/:id` 按归属人删，别人的和不存在一样是 404。删掉之后推 `grant_deleted`，再重发 `config`，下一次同类调用又会问。

### 暂停和继续

`POST /api/bots/:id/pause` 和 `resume` 只改 `bots.run_state`，给这个用户在线的每台电脑发 `pause` 或 `resume`，推 `bot_updated`，回 `BotResponse`。运行器那头怎么停在闸门上见 `packages/bot-runner/README.md`。

暂停状态住在控制面，电脑那头只是照着执行。

**hello 按状态补发。** 电脑 hello 成功后照发 `welcome` 加 `config`，紧跟着给 `config` 里的每个 Bot 各补一条：`run_state` 是 `paused` 的补 `pause`，其余的补 `resume`。代理在收到 `config` 之前收到的 `pause`、`resume` 会被丢掉（那时还没有运行器），所以只能排在 `config` 后面。补发和 `config` 用的是同一次 `listBots` 的结果。

**断线期间点的「继续」不会丢。** 断线时点继续，库里照样写成 `running`，但这时没有连接，那条 `resume` 发不出去。代理重连有两种情况：

- 进程是新起的。运行器是按 `config` 新建的，本来就没停，补不补都一样。
- 同一个代理进程重连。运行器不重建，还记得断线前那个 Bot 停着。只补 `pause` 的话它会一直停着，之后的活全挂在闸门上，库和 Web 却显示在跑。

所以没停的也要补 `resume`。运行器对没停的 Bot 收到 `resume` 什么也不做，给新进程多发一条没有害处。

**还剩一个极窄的竞态。** `#sendConfig` 先查工具、skill 和授权，最后一个 await 才是 `listBots`，查完同步发出 `config` 和补发，中间不再让出事件循环。剩下的窗口是 `listBots` 这一次查询在途的那一段：

1. hello 的 `listBots` 读到快照，比如这个 Bot 停着。
2. 这次查询的结果还没回来，一个 `resume` 的 UPDATE 提交了，路由把 `resume` 发了出去。
3. hello 拿到结果，按旧快照补发 `pause`。

结果是运行器里停着，库里却是 `running`。反过来点暂停也一样，停不住。窗口是一次查询的往返，用户再点一次就能恢复，这一版不修。要彻底关掉，得把同一个用户的 hello 补发和 pause、resume 路由串到一条链上（做法同 `agent/hub.ts` 里按电脑串行的 `#enqueueFinish`），让「读状态加下发」和「写状态加下发」不再交错。

### 删 Bot 时的审批

`DELETE /api/bots/:id` 在同一个事务里先把这个 Bot 挂着的审批 `UPDATE ... WHERE status = 'pending'` 成 `expired`，再删 Bot，然后逐条推 `approval_updated`，最后推 `bot_deleted`。运行器删 Bot 时不再报 `approval_abandoned`，收尾由控制面做。和同时点下的批准靠行锁排先后，谁先落谁算，输的一方拿到 409 或不在名单里。这条 UPDATE 自己带归属条件（`bot_id` 只取这个用户名下的 Bot），删别人的 Bot 回 404，连他的审批行锁都不碰。

approvals 行的 `bot_id` 外键是级联删除，事务提交后那一行随 Bot 一起没了。单 Bot 群连群带卡一起走，不留痕迹；多 Bot 群里那张卡还在，客户端手上已经有终态，重新加载后这张卡查不到审批。

### 群里回话等于按按钮

用户消息正文去掉首尾空白后恰好是「批准」「同意」「拒绝」「不行」之一时，落到该群最近一条待批审批上。词表在 `agent/dispatch.ts` 的 `REPLY_DECISIONS`。

这条消息照常存、照常推，但**不再派活**。运行器正挂着等这条审批的结论，再派一次会并发起第二个 run。群里没有待批审批时，「批准」就是一句普通话，照常派活。

### 超时只提醒

`repo/approvals.ts` 的 `remindStaleApprovals(db, push, now)` 给放了 24 小时还没有结论的审批各补一条 system 消息。**不升级，也不自动拒绝**，等的人始终是归属人。

先把 `reminded_at` 占住再补消息，所以再扫一遍不会重复提醒，进程重启也不会。`reminded_at` 就是为这个存在的。时钟是参数不是全局，`server.ts` 里一小时传一次 `new Date()`，测试直接传一个 25 小时后的时刻。

### 电脑断线

断线有两种：socket 真的关了，或者 45 秒收不到这条连接的任何报文。后一种是合盖的 Mac，进程冻住发不出 FIN，服务端手里的 socket 一直是 OPEN，只看 `readyState` 的话例行照样派给它。电脑代理每 15 秒发一次 `heartbeat`，45 秒是连丢两次还不判、第三次也没到才判。计时挂在每条 socket 上，收到任何一帧就重置，到点只 `terminate()`，之后标记休眠、推 `computer_updated`、宽限、收尾、推 `stuck` 全走下面这条普通断线的路，不另写一遍。用 `terminate()` 不用 `close()`：后者要等对端回关闭帧，冻住的对端不会回。没有用协议层 ping：心跳已经每 15 秒一帧，pong 能证明的它都能证明。被新连接顶掉的旧连接到点只关它自己，碰不到新连接。阈值是 `startServer` 的 `silenceTimeoutMs`，测试调短用。

有效连接断开后等 15 秒；期间重连就用 `hello.activeRuns` 对账，缺席的 run 当即结束并在原群提示「电脑断过线，这次活没做完」，未重连则宽限到期后收尾全部未结束的 run。同一个 run 只收尾一次。

pending 的审批留着。重连后照发 `welcome` 加 `config`（外加每个 Bot 的 `pause` 或 `resume`），**不重发** `approval_request`：那是电脑发给控制面的方向，重连时控制面无从替它再问一遍。重连之后点的结论，`approval_result` 会发到重连后的那条连接上。

电脑不在线时点结论，`agents.send` 返回 false，这一版**决定照样落库**，群里不额外补一句话。运行器那一头本来就已经断了，等它回来是另一件事。

## 交接

一个 Bot 把手里的活交给群里另一个 Bot。审批等的是人点头，交接等的是另一个 Bot 接手，落库、推送、24 小时提醒是同一种形状。群里那张 `kind: handoff` 卡的正文只有一个 handoffId，做了什么、没做什么、下一步和清单指针都在 handoffs 行上，所以状态只随 `handoff_updated` 推，重推那条 message 一个字都不会变。

### 一条链

| 这一步 | 谁做 | 结果 |
| --- | --- | --- |
| 决定交出去 | 运行器 | 发一条 `handoff` 上来，带目标 Bot 和 done / notDone / next / checklistIndex |
| `handoff` 到达 | `agent/events.ts` | 一个事务里建群消息和 handoffs 行，先推 `handoff_updated` 再推那条 `message`，目标 prompt 排到当前 run 的 `run_done` 之后，带 `handoffId`，正文是 `agent/handoff.ts` 渲染出来的报文 |
| 目标确认接手 | 运行器发 `handoff_accept` | 状态改 accepted、`tasks.current_bot_id` 换人、经手记录补上一位的 `to` 再加新一位，推 `handoff_updated` 和 `task_updated` |

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

例行任务属于一个 Bot。**一次运行就是归属人在群里发了一条消息**，`groupId` 为空时是这个 Bot 的单 Bot 群，不为空时是那个群（建项目时的两条例行发进项目群）：先落一条 system「例行任务「X」自动运行」，再落一条正文是 `instruction` 的 user 消息，然后走和手打消息同一个 `dispatchUserMessage`，派到哪台电脑也是同一条规则（见「派到哪台电脑」），本机合盖、远程在线时例行照常在远程跑。运行器和电脑代理因此不认识例行任务，没有新报文。到点触发、`POST /api/hooks/:token`、`POST /api/routines/:id/run` 三个入口走的都是 `routines/run.ts` 的 `runRoutine`。

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

触发那一刻就落一条 `running`。选不到电脑时当场记 `failed`，note 是原因加「没跑起来」，比如「电脑不在线，没跑起来」，同时推一条 `stuck` 通知，不补跑。群里没有能派的 Bot 时也记 `failed`，note 是「群里没有能派的 Bot，没跑起来」，不推 `stuck`；接口上走不到这种群，这一条是兜底。派出去的等 `run_done` / `agent_error` / `approval_request` 到了再改状态补 note，每次改都推一条 `routine_updated`（整条例行任务带 runs，客户端整条替换）。控制面中途重启的运行会在电脑重新 hello 时对账收尾；电脑一直不再连接时仍停在 `running`。每条例行任务只留最近 20 条，插入后按 `started_at DESC, id DESC` 裁。

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

## 用量、今天与通知

`GET /api/usage` 按用户返回本周合计、每个现存 Bot 的花费与 run 数（零花费也有一行），以及不限本周的最近 20 次 run。周起点是 Asia/Shanghai 的周一 00:00，响应里的 `weekStartsAt` 是该时刻的 UTC ISO 时间。例如上海 2026-09-21 00:00 对应 `2026-09-20T16:00:00.000Z`。金额取 run 已保存的 `amount`，不重算历史价格。`runs.owner_id` 在 Bot 和群删除后仍保留，所以删掉的 Bot 的 run 计入 total，不再出现在 Bot 分列；迁移时只能回填仍能从 Bot 或群识别归属的旧 run。

`GET /api/today` 只聚合当前用户的数据。计划只看 pending 和 approved 两种，稿子只看这些计划的稿子，加上不属于计划的 pending、approved 稿子，退回的计划和它的历史稿子不出现。`pending` 超过 50 条时保留最新 50 条，仍按到达时间正序排，待批计划里的稿子只嵌在计划项里；`done` 按时间倒序保留最新 20 条；`running` 每个群至多一行，取该群 `decidedAt` 最新的一份 approved 计划，这份计划的稿子全部发布（published 等于 planned）就不出行，没有计划的群这一期不出行，按批准时间倒序保留最新 20 条；`next` 按排期正序保留最近 20 条。`assistantGroupId` 是主助理的单聊群，只有 P1-13 之前注册、之后还没登录过的老用户才是 `null`。

系统通知在这几种时候产生：

- `confirm`：新来一张审批卡。
- `result`：例行任务派出的 run 收尾时留下了可见 Bot 回复。用户自己在群里发消息触发的 run 他当场就看得到，不推。
- `failed`：这件事没办成，要用户处理。眼下只有电脑代理报 `login_state` 的 `failed`，文案按原因写一句中文：`window_failed` 是登录窗口出错或到点没登上，`remote_refused` 是远程电脑不许登录、请到本机登录。登录没成不等于账号过期，`accounts.login` 不动。账号不属于哪个群，没有群消息可落，所以只走通知，`groupId` 为 null；用户关了通知就看不到这一句，免打扰期间它和别的通知一样只进汇总的件数。它不走 `stuck` 的去重和暂存，那两样是给电脑掉线的，登录接连失败几次每次都推。账号必须是这台电脑主人、登在这台电脑上的，同一个用户的另一台电脑报也不认，否则整条丢掉。`valid` 和 `expired` 这一期还不处理。
- `stuck`：例行任务到点时选不到电脑派不出去（原因和群里那句同源），或者跑到一半电脑断线被收尾。文案写明是哪条例行、为什么没跑。用户自己的消息派不出去时群里已经落了一条 system 消息，不再推。同一个用户一段离线期只推一次，他任一台电脑代理 hello 成功后清掉，下次再卡住再推。去重记在内存里。推 stuck 时用户没有推送连接，这条就留在内存里，连上推送时补发，`at` 仍是卡住的时刻。最常见的是本机 Mac 睡着，代理和 App 一起断开，醒来连上就收到。每段离线期至多留一条。代理 hello 只清去重，不清已经留下的。

用户关闭通知后不推。完整设置免打扰起止时间时，Asia/Shanghai 区间内只在内存累计数量，区间结束后由每 30 秒一次的扫描推一条汇总，所以汇总最多晚 30 秒。扫描每次按当前设置判断区间是否结束，缩短免打扰在下一次扫描就生效。跨午夜区间按次日结束计算。扫描时用户没有推送连接就留着计数，他下次连上推送时立刻汇总。留下的 stuck 和汇总一起补发时先推 stuck、后推汇总，连上时还在免打扰里就一起等到区间结束。设置改成不在免打扰里之后来的第一条通知，先推攒下的汇总再推它本身。单个用户汇总出错只清掉他的计数，不挡后面的用户。控制面重启会丢掉尚未汇总的内存计数、留着没发的 stuck 和 stuck 去重。

`users.last_seen_at` 列目前不再写入，留给后面的迁移删掉。

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
