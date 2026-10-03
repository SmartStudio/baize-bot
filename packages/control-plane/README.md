# @baize/control-plane

控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js。四个对外的面在同一个 3001 端口上：`/api` 给 Web 客户端，`/api/ws` 往客户端推，`/agent` 给电脑上的电脑代理，`/gateway/v1` 是模型网关。认身份、建电脑、发 config 那套写在仓库根 README.md 的「控制面」一节。

## 工具连接

工具连接是用户级对象。`tool_connections` 存 MCP 地址、发现的操作及其 `needsApproval` 标记，并把认证信息以 AES-256-GCM 密文存入 `authorization_enc`；`tool_connection_bots` 记录它分配给哪些 Bot，删 Bot 时对应分配由外键级联清除。API 列表和写入响应都不返回认证信息，电脑代理的 `config.tools` 才带解密后的值和 Bot 分配。

生产环境设置 `TOOL_SECRET_KEY` 为 64 位十六进制密钥。未设置时启动会警告一次，并使用固定开发密钥；已有密文依赖原密钥解密，换密钥前需迁移密文。MCP 发现时把认证信息作为 `Authorization` 请求头发送。操作默认按 MCP 的 `readOnlyHint` 定审批：明确为 `true` 的不需要，其余都需要；用户可通过 `PATCH /api/tools/:id` 覆盖标记。连接创建、修改、删除后，控制面都会向该用户在线电脑重发整份 `config`。

## 群与主题任务

每个群恰好一张主题任务卡。单 Bot 群在建 Bot 时自动建出来，多 Bot 群走 `POST /api/groups`，一次拉 2 到 6 个 Bot。编号是 `T-` 加四位，从 `user_counters.next_task_number` 取一个再把它加一，建 Bot 和建群共用这一个计数器，所以同一个用户的编号不会撞。`GET /api/groups` 只列成员数大于一的群，单 Bot 群在 `/api/bots` 里跟着它的 Bot 走。`Group.kind` 是 `solo` 还是 `team` 只看 `groups.solo_bot_id` 是否非空，`repo/rows.ts` 的 `toGroup` 是唯一出处；团队群删到只剩一个成员仍是 `team`，Web 入列按这个字段，不按成员数和首席猜。

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

同一条用户消息只让一个 Bot 运行。当前 Bot 的 `run_done` 到达后才派下一位；一轮里 Bot @ 了人，就按正文顺序进入下一轮。轮到的那位在这之前被删了（比如「@A @B @C」里 B 在 A 跑的时候被删），`sendSpeaker` 回 `skipped`，回合跳过它接着派 C，不关轮；选不到电脑或发不出去回 `stopped`，群里已经留了一句，后面的人同样派不出去，关轮。Bot 消息累计到 10 条时停止，并在群里留一句提示。运行器每个文字块报一条消息，一个 run 的正文不管分成几块只算一条；`mention` 工具每 @ 一次算一条，交接也算一条，回路守卫靠这两样。

### `@名` 在写入前解析

`POST /api/groups/:id/messages` 在 `appendMessage` 之前按群成员名解析一遍正文，结果存进 `body.mentions`。派活只看它，不重新解析正文。名字长的先试，所以「@小销售」不会先命中成员「小销」；名字后面必须是空白或行尾。单 Bot 群不解析，`parseMentions` 在成员数小于二时直接返回空。Bot 的正文在每块 `done` 时按同一套规则解析，运行器每个文字块报一条消息，所以工具之后那块里的 @ 也会派活；以前一个 run 的正文堆在第一条里，工具之后追加的 @ 不解析，Bot @ 了队友却派不到。

用户 @ 谁，谁就成为当前经手：`tasks.current_bot_id` 换人，`handled` 里上一位补上 `to`，新一位追加一条。多 @ 按正文顺序，第一个成为经手。这一段在事务里对那一行加行锁，不加的话两条并发消息会互相覆盖掉一条经手记录。Bot 之间 @ 不改经手，接力是 Bot 之间的事，不是用户交出去的。

### 多目标派活

每个目标各起一个 run、各发一条 prompt。多 Bot 群的 prompt 带完整任务卡和全体成员名单，Bot 靠名单知道能 @ 谁；单 Bot 群 `task` 为 null。`messageId` 是触发这次 prompt 的那条群消息：用户发的、Bot @ 队友的那条、交接卡、例行写进群里的那条用户消息。上下文按收件人分别生成：收件人看自己只有名字，看别人是「名 · tag」，看已经删了的 Bot 是「别的 Bot」。任务卡不进上下文，它走 `task` 字段。

上下文里的卡写成一句结论，不是一个 id。审批、交接、草稿、内容计划的状态住在各自的行上，这批上下文涉及的每种卡各用一条查询查完，写成「小服要执行 `pay 100`，你批准了」「小服把活交给阿文，下一步是「…」，阿文接了」这样；草稿批了以后写「等着发」还是「留着没发」看账号现在的档位，有草稿卡时多查一次账号表。skill 卡和方案卡的状态就在正文里，照正文写。卡指的行查不到就不写这一条。卡的状态变了消息 id 不变，靠 `settled` 让运行器再拼一次，见下一段。

每行上下文带 `settled`，说的是这一行的字还会不会变。Bot 消息 `streaming` 为 true 时是 false。运行器每个文字块一条消息，`text_end` 之后那条不再长，所以 `streaming` 就是「这条还会长」。卡按状态定，每种一张表写在 `dispatch.ts`，加状态时编译器逼着表态：

| 卡       | 还会变（`settled: false`）                                   | 不再变                         |
| -------- | ------------------------------------------------------------ | ------------------------------ |
| 审批     | `pending`                                                    | `approved` `rejected` `expired` |
| 交接     | `pending`                                                    | `accepted`                     |
| 草稿     | `pending` `approved` `publishing` `returned` `failed`        | `published`                    |
| 内容计划 | `pending`                                                    | `approved` `returned`          |
| skill 卡 | `offered`                                                    | `saved` `dismissed`            |
| 方案卡   | `offered`                                                    | `started` `dismissed`          |

草稿发出去之前都算还会变：批了的会发，没开自动发的账号改了档字也跟着变；退回的和没发出去的 Bot 还能改了再交，改完回到待看。用户消息、system、工具行一律 true，工具行的状态会变但写出来的字不含状态。状态一变字就变，运行器的水位把这一行当半截记着，字变了再拼一次整句，所以批之前 Bot 看到「还在等你点头」，批了以后下一轮看到「你批准了」。拼法见 bot-runner README 的「prompt 拼法」。run 收尾时这个 Bot 在这个群里还停在 `streaming: true` 的文字一并收成 false，同一个 Bot 在这个群里还有别的 run 开着时这次不收，留给最后结束的那条（见「run 收尾」），收尾之后它就是定稿；早先断掉的旧半截要等这个 Bot 下次在这个群里收尾才收掉，在那之前 `settled` 一直是 false，运行器靠「字没变不重拼」挡住重复。没定稿的卡每轮都标 false 送过去，也是靠这一条只拼一次。报文里 `settled` 缺省为 true，控制面和电脑代理升级不分先后：旧控制面不发这个字段，新代理把行都当定稿，退回升级前的拼法，不会因为 parse 不过把整条 prompt 丢掉；新控制面配旧代理，多出来的字段被 zod 丢掉，照旧工作。

窗口是最近 20 条，前面再接上这个 Bot 上一次派活时没定稿、这次滑出窗口的行，最多 10 条（`CONTEXT_CATCHUP`），留最新的。不接的话，小采说到一半、用户连发 25 条，小采说完时那条已经不在窗口里，别的 Bot 永远看不到整句；卡滑出窗口以后才被批、被接，草稿滑出窗口以后才被批或退回，也一样看不到。派活建完 run 就把这次上下文里 `settled: false` 的行（窗口里的和接上的都算）的 id 记到这个 run 的 `unsettled_context` 列，但这份名单要等这个 run 的 `run_done` 被正常收下、`context_confirmed_at` 记上时刻才作数。下一次给同一个 Bot 在同一个群派活，候选是最近一次（按 `started_at`）确认过的 run 记下的 id 里不在这次窗口的那些行，代码在 `repo/context-window.ts`。prompt 没发出去（电脑不在线）、电脑报错带着 runId 被收尾（`abandonRun`）、还在跑没回 `run_done` 的 run 都不确认：它们的名单里已经没有这一轮刚定稿的结论，可模型没读到，照它接就永远丢了这条结论，所以接着用更早那份确认过的名单，结论下一次再送。接上的行不看现在定没定稿，照现在的状态写一句、标现在的 `settled`。还没定稿的这一轮又被记下，一轮轮带下去：字没变，运行器的水位挡掉；字变了（比如草稿从「还在等你看」变成「你批准了，留着没发」），运行器就再拼一次。定稿那一轮整句再拼一次，之后它不在没定稿名单里，也就不再送。没定稿的行每轮都占名额，永远停在 `streaming: true` 的消息、一直没发出去的草稿会一直带着，所以要上限，超出的最老几条从此不再送。没在这个群派过活的 Bot 什么都不接。

比过三个做法。第一版重算上一次窗口：按这个 Bot 上一个 run 的 `started_at` 取那一刻最近的 21 条，补其中现在已定稿的。它不加表，但控制面不知道上一次哪条没定稿，只敢补定稿的，草稿从待看变成批了没发这种非终态之间的变化就补不上；它也只认最后一个窗口，待批卡滑出窗口后隔了一次派活才批，就再也补不上。复核实测出这两处漏送，换成了现在的做法。另一个做法是运行器把水位里没定稿的 id 报上来，同样准，但要在 `packages/shared` 加上行字段。现在的做法只在 `runs` 上加两列，不改报文。控制面记的是「这次派活算出的上下文里哪些行没定稿」，派活时就记，等这个 run 的 `run_done` 收下才拿来用；运行器水位记的是「这个会话看过哪些字」。前者决定下一次送哪些行，后者决定送到的行拼不拼。两边不是同一份事实，不用对齐。

这不是严格保证，最坏情况会永久漏掉一条该接的行。contextFor、建 run、记名单、发送这一串没有串行化，`http/app.ts` 的取消和 `agent/group-turn.ts` 的新回合不互斥，GroupTurns 在发送之后才看这一回合是不是已经被换掉。同一个 Bot 在同一个群两次派活挨得很近时，可能 A 先算出不含新卡 P 的上下文，卡在后面的查询上；P 落库后 B 算出带 P 的上下文、记名单、发出去；A 这才建 run，`started_at` 更晚，记下的名单里没有 P。两边都正常回了 `run_done` 以后，下一次取的是 A 的名单，P 这时已经滑出窗口的话，B 看到过的这张没定稿的卡从此不再是候选，之后批了、接了，这个 Bot 都看不到结论。两次读到同一个上一次 run、记名单的顺序和发送的顺序不一致，也会让同一行被当新行再拼一次。这一段是从调用链推出来的，没有做并发复现，也说不出多常见。上一次 run 还没回 `run_done` 时又派活，用的是更早那份确认过的名单，前一次已经送过的结论这一次会再送一遍，字没变的由运行器水位挡掉。确认只认 `run_done` 收没收下，不知道模型读没读到。运行器在调 `session.prompt` 之前就失败（建会话、`usePurpose`、拼 prompt）时报的 `runner_failed` 带这次的 runId，控制面照带 runId 的错走 `abandonRun` 把 run 收尾、不确认，之后补来的零用量 `run_done` 撞上 `ended_at IS NULL` 落空；多 Bot 群这一回合也跟着关掉，不再轮到后面的 Bot，和其他带 runId 的错一样。调过 `session.prompt` 以后才抛的仍不带 runId，照常补 `run_done`、照常确认，可 Pi 的 `prompt()` 自己也会在消息进会话之前抛（没选模型、鉴权失败、没有 API key、正在压缩、已经在跑），这几种结论模型没读到，名单却确认了；暂停中被停机、Bot 被删、还没有能用的 config 时运行器不报错直接补 `run_done`，也一样。这几种情况下这一轮刚定稿的结论滑出窗口后就不再送。运行器那边 prompt 抛错不记水位（`bot-runner/src/index.ts` 的 `runOne`），下一次这批行会再拼一遍，这一侧只会重复，不会漏。会话目录清空或者水位认不出时，运行器整批全拼，接上的这几条也跟着多拼一次。

### 派到哪台电脑

一个用户最多两台电脑，本机和远程。规则是 `agent/computer-selection.ts` 的纯函数 `selectComputer`，输入是这次要碰的账号和候选电脑，每台候选电脑可以带上挂在它上面的账号，在线看 `AgentHub` 此刻有没有这台的连接，而且这条连接 hello 的那份 `config` 已经发出。握手到 `config` 之间还要对账、查库，这段时间里派的 prompt 会比 `config` 先到，新起的代理还没有运行器，只能回 `prompt_before_config` 丢掉它，所以这段时间按不在线算。代理解析不了 config（多半是两边版本对不上）会回 `agent_error` `config_rejected`，detail 写校验不过的字段路径；控制面把这条连接记成被拒，按不在线算，推一条 stuck「电脑代理和控制面版本对不上，配置被拒」，被拒期间代理回的 `prompt_before_config` 也按这个原因收尾。代理每收下一条 config 回 `config_applied`，控制面收到才恢复派活。hello 那条 config 发出去就算在线不变，不回 `config_applied` 也照常能派。config 带每条连接单调递增的 `generation`：`AgentHub` 在开始读快照时就领号，并发的两次重发先领号的号小，但后领号的那条可能先发出去，代理丢掉比已应用代际小的 config，不回执；`config_applied` 和 `config_rejected` 都带同一个代际，控制面只认最后发出那一代的 `config_applied`，被拒之后又发过一代的话，早先那一代晚到的回执不能把它提前恢复成在线。拒收也只认最后发出那一代：带代际的拒收代际对不上就忽略；不带代际的拒收只在这条连接还没收到过带代际的回执时才认，收到过之后它不可能说的是当前这一代。被忽略的拒收没有任何副作用，不改连接状态，不记拒收警告，不推 stuck，所以也不会占掉这段在线期唯一那条 stuck，之后当前代际真被拒照样推（`test/config-generation.test.ts` 钉着）。不兼容旧代理的回执：基底那版代理回的 `config_applied` 不带代际，新协议 parse 不过，整条丢掉，被拒之后靠它恢复不了。控制面和电脑代理按同一个版本一起升，第一版只有自用，不写兼容分支。被拒期间用户再发消息，群里那句说的是「电脑上的白泽版本和控制面对不上，这条没派出去，把电脑上的白泽升级或重启后再说一次」，不是「电脑不在线」。代理的 `agent_error` 带了 `runId` 就是说那个 run 不会再有 `run_done`，控制面按断线收尾同一套替它收尾：run 结束、挂着的审批过期、还在跑的工具行记失败、还在流的文字收成定稿、群里一句、例行记失败。收尾找的是库里这台电脑还开着的 run，群按库里 run 的群，报文里的群号不作数；找不到（别的电脑的 run、已经收过尾的重报）不收尾，只打一行 `console.error`。它和新连接 hello 的对账排在同一台电脑的链上，先到的整个做完（事务提交）另一个才开始读 run，所以不会两边同时读到同一个还开着的 run：旧连接的报错收尾先做完，新 hello 对账时那个 run 已经结束，群里只有收尾那一句（`test/reconnect.test.ts` 扣住收尾的第一次读、排进新 hello 再放开，钉着这个先后）。`finishRun` 的 `WHERE ended_at IS NULL` 仍然在，挡的是 HTTP 路径和别的进程并发结束同一个 run。`dispatchUserMessage` 选一次，头一个 speaker 就派到这台，不再重选：重选的话两次之间掉线，头一个就不建 run 派空了，调用方却已经拿到 `sent`，例行会一直停在运行中。同一回合后面的 speaker 要等前一个跑完才派，那时各自再选。

| 这次要碰的账号 | 派到                                                   |
| -------------- | ------------------------------------------------------ |
| 不碰账号       | 本机在线派本机，否则远程在线派远程，都不在线就派不出去 |
| 碰账号         | 账号所在的那台；那台离线就派不出去，不改派到另一台     |

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

### 上行 `task_checklist` 和 `mention`

`task_checklist` 整份替换清单，同一份重发两遍结果不变。清单里每条的 `ownerBotId` 控制面再校一次，必须是 null 或这个群的成员，有一条不是就整条丢掉不落库。运行器那边只能对着这次 prompt 带去的名单把名字解析成 id，比不出群的真实成员表，所以这一道不能省。

`mention` 的目标必须是这个群的成员且不是它自己。消息先落库再判限额：那句话 Bot 确实说了，用户该看见，停下的只是派活。两条用户消息之间，Bot 发起的 @ 最多派 10 次，越线的第一条在群里留一句「Bot 之间 @ 太多次，停下等你」，之后的只是不派。计数在内存里，进程重启归零，用户一说话就归零。

### 上行报文的 runId 归属

带 runId 的上行报文（`bot_text`、`bot_tool_call`、`run_done`、`approval_request`、`task_checklist`、`mention`）都过同一道校验：群要是这台电脑主人的，run 要是报文里那个 Bot 在那个群里的活。外键只保证 runId 存在，管不了它指到哪个群，不校的话一个被入侵的电脑代理能拿自己的 runId 往自己另一个群插卡。任一不成立整条丢掉，丢得安静：不抛异常，不给电脑回报文，只记一条日志。

### run 收尾

run 在三处结束：`run_done`、断线收尾（重连 hello 的 `activeRuns` 里没有它，或宽限到期）、带 runId 的 `agent_error`，后两处走同一个 `abandonRun`。结束的那个事务里一起做完：`finishRun` 写 `ended_at`；挂着的审批过期（只有 `abandonRun`，`run_done` 时运行器已经不在等）；还在 `running` 的工具行记 `failed`；还在流的 Bot 文字收成 `streaming: false`。收掉的文字沿用流式那条推送，推一条 `delta` 为空、`done: true` 的 `message_delta`，Web 照常把它收尾，不加新的推送种类。已经 `done` 的文字块不再推。

消息表没有 run 列，Bot 文字的正文里也没有 runId，收尾只能按「这个群里这个 Bot 还在流的文字」找。同一个群里另一个 Bot 的 run（插话派出去的）不受影响。同一个 Bot 却不一定只有这一条 run：本机掉线后下一条派到远程电脑，或另一台控制面上同 Bot 同群的 run 还开着，这时按 Bot 找会把那条 run 还在长的文字一起收掉。所以收文字的 UPDATE 带一个条件：这个 Bot 在这个群里除了正在收尾的这条，没有别的 `ended_at IS NULL` 的 run；有就整条跳过，一个字不收，也不推定稿。让最后一条结束的 run 收，它按 Bot 找时会把前面跳过留下的一并收掉。

这个条件要在提交前一直成立，靠一把按 (群, Bot) 算键的事务级 advisory 锁：`run_done` 和 `abandonRun` 的事务第一句先拿它（`lockSettlement`、`lockSettlementOfRun`，`pg_advisory_xact_lock` 的两参数形式，第一参数是这块自己的命名空间常量，和仓库里别处单参数的 advisory 锁不在一个键空间），再 `finishRun`；`startRun` 也在自己的事务里先拿同一把再插 run 行。于是同 Bot 同群的两条收尾排队，后来的那条等前一条提交，之后的语句拿新快照，看得见前一条已经结束，把两条的文字一起收掉；收尾进行中也不会冒出新 run。每个收尾事务只收一条 run，只拿一把键。锁序固定是 advisory → runs → messages，run 名下的写帧不拿 advisory。在这把锁之下，`NOT EXISTS` 看见的「别的 run 已经结束」是对的，「收它没错」还依赖一条文字只属于一个 run：正常运行器每个文字块生成新的 UUID 当 messageId，成立。剩下的代价：一条 run 挂在掉线电脑上没收尾时，同 Bot 同群的定稿要等它被对账或宽限收尾，只是晚收，不会收错。没往正文里塞 runId，是因为正文 jsonb 的形状别处直接读（e2e 用例按整条正文比对），shared 和迁移也都不动。早先没收尾就断掉的半截，在这个 Bot 下次在这个群里收尾时一并收掉。

收尾之后这个 run 名下晚到的帧作废：不落库、不推送、不回电脑。危险的是帧已经过了 `resolveRun`、正要写，收尾这时提交了。同一个进程里这台电脑的帧和收尾排在同一条链上，排不出这种交错；挡的是多个控制面共库（滚动重启）时另一个进程里的收尾。做法是每条 run 名下的写在自己的事务里先过 `lockOpenRun`（`SELECT id FROM runs WHERE id = ? AND bot_id = ? AND group_id = ? AND ended_at IS NULL FOR SHARE`，Bot 和群是 `resolveRun` 校验过的那两个，Bot 被删、外键把 `bot_id` 置空后在途的帧也查不到行），拿不到行整条不写，`whileRunOpen` 把「开事务、过这一道、再写」包成一步。只在写的 WHERE 里带 `EXISTS (... ended_at IS NULL)` 不够：READ COMMITTED 下子查询看不见收尾还没提交的结束，插进来的行又不在收尾那几条 UPDATE 开始时的快照里。共享锁和 `finishRun` 的 UPDATE 互斥：写先拿到锁，收尾等它提交，后面打 failed、收文字的语句看得见它；收尾先拿到，写等它提交后重查，查不到行。用 `FOR SHARE` 不用 `FOR KEY SHARE`，后者和 `finishRun` 的 `FOR NO KEY UPDATE` 不冲突。锁的顺序固定是先 run 行后消息行，收尾的事务在 advisory 锁之后第一句就是 `finishRun`，不会死锁。

删 Bot 也守这个锁序。外键级联会改 run 行（`runs.bot_id`、单 Bot 群被删时的 `runs.group_id` 置空），也会改任务卡（`tasks.current_bot_id` 置空）、群（`chief_bot_id` 置空，单 Bot 群整个删掉连带它的任务、消息、审批、交接）、交接和审批（级联删）。run 名下的写先拿 run 的共享锁再碰这些行，级联反过来先碰这些行、最后才改 runs，各拿一半就是死锁，删除回 500。所以 `deleteBot` 的事务开头、碰任何别的行之前先调 `lockRunsOfBot`：先拿这个 Bot 的排他 advisory 锁（同样是两参数形式，命名空间常量和收尾锁不同，键只有 Bot），再把它的 open run 和它单 Bot 群里的 open run `FOR UPDATE` 锁上。`startRun` 在收尾锁之前拿同一把的共享锁，所以删除拿到排他锁时这个 Bot 已有的 run 都已提交、`FOR UPDATE` 看得见；之后它在任何群里都建不出新 run，包括删除开始后才建、才把它拉进去的群。早先按成员表逐群拿收尾锁做不到这一点：成员表是删除开始那一刻的快照，之后新建的群里照样能生出删除没锁住的 run，那条 run 的写帧和删除的级联又各拿一半。在 Bot 锁上等到删除提交的 `startRun`，接着查 `group_members`，这个 Bot 已不在这个群里就回 null，不建 run；`sendSpeaker` 回 `skipped`，回合只跳过它，同一回合排在后面的照常派，不留 system（单聊群已随 Bot 删掉，多 Bot 群里页面已收到 `bot_deleted`）。用户发消息和例行任务两条派活路都走这里，建 run 这一步不会再撞外键失败。在途的写要么先提交、删除等它，要么等删除提交后重查，查不到自己的 run 整条不写。锁完 run 再锁这个 Bot 交出和接手的交接卡（`FOR UPDATE`）。这一步防的是别的 Bot 的写：别的 Bot 确认它交出来的活，先改交接卡、再把任务卡的经手换成自己；级联的先后由外键触发器的名字排，新建的库里先置空经手、后删交接卡，两边各拿一半就是死锁。先锁交接卡，删除的顺序就和确认一致。别的 Bot 其余的写各只碰一行级联会改的行（清单改任务卡、设首席改群、建交接和审批只插新行），排不成环。

过这一道的写：`bot_text`（建空壳和接正文）、`bot_tool_call`（新建工具行，也包括改已有那行，收尾打成 `failed` 的不会被晚到的 `ok` 盖回去）、`approval_request`（`createApproval`）、`mention`、`skill_offer`、`project_offer`、`draft_create`、`plan_propose`、`draft_edit`，以及改任务卡和群状态的 `handoff`（建卡、排进下一轮派活、超限提示）、`handoff_accept`（接卡和换经手在同一个事务里）、`task_checklist`（清单和那条系统消息）、`set_chief`、`set_cadence`。后五种不是这个 run 的产物，但晚到时会盖掉用户此后的选择：结束的 run 晚到的清单盖掉用户刚改的清单，晚到的确认把经手换回一个已经收尾的 Bot，晚到的交接建出一张错卡还真的派活，所以同样整条丢掉。只剩两种不过这一道：`run_done` 自己，它是收尾动作，`finishRun` 以 `ended_at IS NULL` 为条件做 UPDATE，拿的是更新锁，重复收尾返回 null；`approval_abandoned` 是单向的终态清理，只把 pending 改成 expired，重开不了审批，已有结论或重复到达都更新 0 行。`test/run-end.test.ts` 钉着三种收尾都收文字、多 Bot 群里只收收尾那个 Bot 的、同 Bot 在别的电脑上还有 run 开着时旧 run 收尾不收（`run_done` 和对账收尾两条路）、晚到的每种帧都不落，以及两台控制面共库时的两种交错：帧卡在锁之前、收尾先提交；收尾的事务结束了 run 还没提交，帧在锁上等它。还钉着排队的六件事：同 Bot 同群两条 run 在两台控制面上同时收尾，两条文字都收成定稿；收尾持锁时新消息的派活等它提交才建 run；清单帧拿着 run 的共享锁时删 Bot，删除等它、回 204 不死锁；帧已过 `resolveRun` 时它的 Bot 被删，放行后一行不写；删除锁好 run 之后才建群把这个 Bot 拉进去并派活，建 run 等删除提交、查不到成员就不建，删除回 204；别的 Bot 正在确认被删 Bot 交出来的活时删它，删除等确认提交、回 204，经手换成确认的那位。

限制：多台控制面时，收尾推的定稿只到本实例的 Web，另一实例上的 Web 要等重连或重拉才看到定稿。控制面不校验 `bot_text` 的 messageId 有没有被另一条 run 用过（`appendBotText` 只按 messageId、群、kind 接上），电脑代理若跨 run 复用 messageId，那条文字可能在另一条 run 收尾时被提前收成定稿。

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
2. 按 `team` 建队员 Bot，每个都带自己的单聊群（`listBots` 按单聊 join，没有单聊的 Bot 进不了 `config`）。`tag` 对 `tag`，`description` 对 `description`。
3. 建项目群和主题任务卡。群名取请求里的 `name`，没给用正文的；`summary` 取 `goal`，`cadence` 取正文，`firstStep` 是清单第一项。成员是主助理在前、队员在后，首席是主助理。
4. 建 `PROJECT_ROUTINES` 两条例行：「周一 09:00 排本周计划」让主助理调 `propose_plan`，「周五复盘」只复盘。例行的 Bot 是主助理，`groupId` 是项目群，`purpose` 是 `plan`。之后项目群换了首席，这两条照样派给主助理，见「例行任务」。

提交之后重推这条消息，给每个新队员推 `bot_created`（带这个 Bot 的单聊群 id，Web 不必再拉 Bot 列表），再推 `group_created` 和每条 `routine_updated`，最后重发 `config`，新队员这时才跑得起来。回包带这条消息、项目群和它的主题任务卡。`dismiss` 用同一个条件 `UPDATE` 改成 `dismissed` 并重推，回包的群和卡都是 null。抢不到卡时回 200 带当前消息，已开始的顺带项目群和卡，不再推送。

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

控制面收到 `approval_request` 时**不回任何东西**，运行器就一直挂着等。这是审批的本意：没人点头就不往下走。

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

暂停状态住在控制面，电脑那头只是照着执行。

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

pending 的审批留着。重连后照发 `welcome` 加 `config`（外加每个 Bot 的 `pause` 或 `resume`），**不重发** `approval_request`：那是电脑发给控制面的方向，重连时控制面无从替它再问一遍。重连之后点的结论，`approval_result` 会发到重连后的那条连接上。

电脑不在线时点结论，`agents.send` 返回 false，这一版**决定照样落库**，群里不额外补一句话。运行器那一头本来就已经断了，等它回来是另一件事。

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

例行任务属于一个 Bot。**一次运行就是归属人在群里发了一条消息**，`groupId` 为空时是这个 Bot 的单 Bot 群，不为空时是那个群（建项目时的两条例行发进项目群）：先落一条 system「例行任务「X」自动运行」，再落一条正文是 `instruction` 的 user 消息，然后走和手打消息同一个 `dispatchUserMessage`，派到哪台电脑也是同一条规则（见「派到哪台电脑」），本机合盖、远程在线时例行照常在远程跑。运行器和电脑代理因此不认识例行任务，没有新报文。派给谁不走路由表：`runRoutine` 带上例行的 `botId`，只派这一个 Bot，`reason` 记 `mentioned`，不改当前经手。按路由表走的话，项目群里换了首席，主助理的「周一 09:00 排本周计划」会派给新首席，那位手上没有项目清单，例行页面上却仍挂在主助理名下；首席卸任时没首席也没经手，就成了全员各排一份计划；队员自己在项目群里建的例行也会被首席截走。例行属于哪个 Bot 就由哪个 Bot 做，换首席不改例行，也不把例行改挂到新首席名下。到点触发、`POST /api/hooks/:token`、`POST /api/routines/:id/run` 三个入口走的都是 `routines/run.ts` 的 `runRoutine`。

`POST /api/bots/:id/routines` 带的 `groupId` 照存进 `routines.group_id`。群按归属人查，别人的群和不存在一样回 404；Bot 不在那个群里回 400。`GET /api/routines` 是这个用户全部 Bot 的例行，每条就是 `Routine`（带 `botId`、`groupId` 和最近 20 条运行记录），按建的先后排。

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

| 动作                        | 推送                         | 重发 config                                |
| --------------------------- | ---------------------------- | ------------------------------------------ |
| `POST /api/bots/:id/skills` | `skill_updated`              | 是                                         |
| `PATCH /api/skills/:id`     | `skill_updated`              | 是                                         |
| `DELETE /api/skills/:id`    | `skill_deleted`              | 是                                         |
| `POST /api/skills/:id/copy` | `skill_updated`（新那条）    | 是                                         |
| 上行 `skill_offer`          | `message`                    | 否，还没建 skill 行                        |
| 点「存」                    | `message`、`skill_updated`   | 是                                         |
| 点「不存」                  | `message`                    | 否，什么都没变                             |
| 正文里 `/名`                | 每条命中一条 `skill_updated` | 否，只有 `use_count` 变了，它不进 SKILL.md |

## 账号

`accounts` 一行是一个用户挂在某台电脑上的一个平台账号。`login` 有三个值：`none` 是还没登录的占位，`valid` 已登录，`expired` 登录过期。`login_changed_at` 跟着 `login` 一起写，建占位时等于 `created_at`，今天页过期那行的时间取它，写的是「什么时候过期的」而不是「什么时候加的」。`login_generation` 是浏览器登录的会话代次，电脑每报一次登录成功（`markLoginValid`）加一，`valid` 重登到 `valid` 也加，它只用来对发布结果，不进 `Account`。今天页哪些账号出行见「用量、今天与通知」一节。

### 加小红书账号

`POST /api/accounts` 带 `{ platform, computerId }`，建一行 `login='none'`、`handle` 为空的占位。电脑必须是本人的，别人的或不存在的回 404。小红书要在助理浏览器里扫码，远程电脑没有助理浏览器，挂到 `kind='remote'` 的电脑回 400。一个人每个平台最多一个占位，靠表上 `(owner_id, platform) WHERE login='none'` 的部分唯一索引收敛：重复加走 `ON CONFLICT DO UPDATE`，不改任何列，只为回已有那行（200，新建是 201），不先查后写。每人每种电脑只有一台，占位只能挂本机，所以已有的占位就在这台电脑上。建完推 `account_updated`，再给这个用户重发 `config`。

### 打开登录窗口

`POST /api/accounts/:id/login` 带 `{ attempt }`。`attempt` 是页面为这一次点击取的号（`LoginAttemptId`，1 到 64 位安全字符），卡片一点就带着它，不等 202。依次判：账号不是本人的回 404，平台不走浏览器登录回 400，请求体不合 `{ attempt }` 回 400，账号所在电脑此刻没有连接回 409。放行时只给账号所在那台电脑发 `browser_login { accountId, platform, attempt }`，接口立刻回 202 和 `{ account, attempt }`，`account` 是账号当前的样子，`attempt` 原样带回。扫码结果由电脑代理的 `login_state` 报回来：登上随 `account_updated` 推给页面，没成推 `login_failed` 带同一个 `attempt`。

`attempt` 只做页面上的关联，不是权限：控制面不存、不签发、不查重，只在边界校验格式，原样转给电脑、原样推回页面。页面按 `accountId` 和 `attempt` 一起结算那张卡，所以再点一次之后，上一次点击的失败晚到也不会把新的一次记成没成。账号归属在 HTTP 这边按会话用户查，在上行那边按电脑主人和账号所在电脑查，乱填别人的号进不来。

### `login_state` 三个分支

三个分支都先校验账号属于这台电脑的主人、登在这台电脑上，不成立整条丢掉，同一个用户的另一台电脑报也不认。账号还必须是在电脑浏览器里登录的平台（`BrowserPlatform`，现在只有小红书）：GitHub、X 的 `login` 只跟着控制面的凭据代际走，电脑报上来的 `valid`、`expired`、`failed` 一律丢掉，账号状态和代际都不动。不然一台认证过的电脑就能把一个凭据已死的号报回 `valid`，或者在重新授权之后把新一代报成过期，绕过下面的不变式。

- `valid{handle}`：写 `login='valid'` 和 handle。同一台电脑、同一平台已经有这个 handle 的行（比如以前过期的那行），就在一个事务里把那行改成 `valid`，把占位上的草稿挪到那行，删掉占位，推 `account_deleted` 再推那行的 `account_updated`。表上 `(computer_id, platform, handle)` 的唯一索引保证不会多出第二行。收尾给用户重发 `config`，运行器按它放行可直接发布的账号。
- `expired`：`UPDATE ... WHERE login = 'valid'` 记成 `expired`，推 `account_updated` 和一条 `failed` 通知，重发 `config`。已经过期或还没登录的行不命中这条 UPDATE，重复报不再通知。
- `failed{reason, attempt}`：登录窗口没成，`accounts.login` 不动，所以没有 `account_updated`。先推 `login_failed { accountId, attempt, reason }`，`attempt` 原样带回 `browser_login` 里的那个，页面靠它结算对应那次点击的卡；再推 `failed` 通知给人看，见下面通知一节。

### 过期隔离和重登收敛

发布循环 `claimDueDrafts` 只抢 `login='valid'` 账号的到点已批稿。账号一过期，它的稿子留在已批，不再下发，别的账号照发。重新登录成 `valid` 后（不管是更新原来那行还是新占位并进原来那行），这些稿子下一轮照常被抢，过了排期很久的也会补发。例外是控制面重启：`reopenMissedDrafts` 会把停机期间错过的定时稿打回待批，但跳过 `login` 不是 `valid` 的账号，过期账号的稿子不算停机错过，照样留在已批等重新登录。

发布路径自己发现过期也记账号：草稿因 `login_expired` 失败（电脑回的 `publish_result`、平台回 401/403、令牌缺失三处），`settleFailed` 在同一个事务里把草稿记失败、把账号按上面同一个 `markLoginExpired` 记成 `expired`。用户只收到一条通知，就是草稿那条「某平台上的「标题」没发出去：账号登录过期了，重新登录后让 Bot 再起一稿」，账号这边只推 `account_updated`、重发 `config`，不再加第二条。电脑自己报 `expired` 时没有草稿可挂，才用账号那条「小红书账号「handle」登录过期了，这个账号的稿子先不发，到账号页重新登录」。两条哪条先到就是那一条：`markLoginExpired` 只认 `login='valid'`，后到的那条发现账号已经是 `expired`，账号不改、不推 `account_updated`、不重发 `config`，也不再发通知；后到的是草稿失败时草稿照样结算成失败，只推 `draft_updated`。发布结果记过期还绑着认领时那一代登录。电脑发的草稿（小红书）没有控制面凭据，认领那条 UPDATE 把账号当时的 `login_generation` 抄进 `drafts.claimed_login_generation`（和 `login = 'valid'` 是同一行同一刻看到的），结算时同一条 UPDATE 另要求 `accounts.login_generation = 草稿的 claimed_login_generation`。用代次不用时刻：`valid` 重登到 `valid` 时 `login_changed_at` 不动（它是给今天页看的），而且时刻来自控制面进程时钟，两个进程或一次校时就能让先后颠倒；代次每次登录成功都加一，和进程无关。这列加上之前认领的旧稿子 `claimed_login_generation` 是 null，结算时退回基底的 `login_generation = 1 AND login_changed_at <= claimed_at`（见「唯一锁序」）。这条规则有代价：新控制面已经把账号推进到第 2 代之后，滚动升级期间的旧控制面认领草稿时写不出 `claimed_login_generation`，这些草稿回来的真 `login_expired` 都因代次不是 1 退成已知，账号留在 `valid`、不推过期通知。旧实例每认领一次都可能这样漏报一次真实过期，直到旧实例排空；之后新实例认领带上当前代次，再遇到过期就照常记。选它是因为反过来更坏：把重登之后的新会话误标过期，会让一个能用的账号停发、让用户白跑一趟重新登录。走控制面凭据的草稿（GitHub、X）只按下一节的代际条件。认领之后账号已经重登成 `valid` 的，不管中间有没有经过 `expired`，旧那次回来的 `login_expired` 只把草稿记失败、推 `draft_updated`，账号保持 `valid`，不推过期通知、不重发 `config`。

过期推的是 `failed`，不是 `stuck`：`stuck` 每人一段离线期只推一次，是给电脑掉线的，混进来会和掉线那条互相吞。

### 授权：连 GitHub、连 X

`GET /api/oauth/:platform/start` 要登录。平台不是 github 或 x 回 404，这家没配应用回 503（「管理员还没配 GitHub 应用」）。放行时生成 state 和 PKCE verifier（S256，GitHub 也带），在 `oauth_states` 记一行 `(state, owner_id, platform, code_verifier, expires_at)`，十分钟有效，302 到平台授权页。这张表有上限：插入那个事务先按 `expires_at` 的索引删掉已过期的行，再把同一个人同一个平台超出最新 5 条的删掉（过滤和排序走 `(owner_id, platform, expires_at desc, state desc)` 复合索引，不随全站 state 行数扫全表）（`createOAuthState`，在 `pg_advisory_xact_lock('oauth-state:<ownerId>:<platform>')` 里做，并发点几次也越不过 5 条）。开五个标签页同时授权都能回来，第六个把最旧的挤掉。回调地址是 `<WEB_BASE_URL>/api/oauth/:platform/callback`，`WEB_BASE_URL` 不设就用 `PUBLIC_BASE_URL`。分开配是因为部署时 `PUBLIC_BASE_URL` 常是电脑在内网连控制面的地址，浏览器到不了。

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

唯一锁序。所有同时碰 `accounts` 和 `account_credentials` 的路径都先锁账号行，再碰凭据行，入口只有一个：`withAccountLock(db, accountId, run)`，它开事务、`SELECT ... FOR UPDATE` 锁账号行、把一个只有它造得出来的 `AccountLock` 交给 `run`。写凭据的 `saveGrant`、`saveAccessToken`，刷新的整趟（锁到后再查、打平台、被拒清 `refresh_enc`、成功写回），`markLoginExpired`，授权回调写凭据，`addAccountWithToken`，`markLoginValid` 都收这个 `AccountLock` 或从这里进，不收 `Db`，绕过锁的写法编译不过。凭据行不再单独加 `FOR UPDATE OF account_credentials` 或 `FOR SHARE`：账号行锁已经把这些路径排成一队，后到的在账号行上等，醒来跑的 UPDATE 看到的是前一个提交之后的世界，两边不会互等成死锁（`test/oauth.test.ts` 的「锁序」用例把回调停在「锁了账号、还没写凭据」的窗口，这时记过期，两边都能完成）。授权回调和 `addAccountWithToken` 的 advisory lock（`oauth-account:<ownerId>:<platform>`）在它外面，管的是「挂哪一行」，两条路径都先拿它、选定行之后才进 `withAccountLock`，顺序一致，不会互等。发布路径的会话代次条件（`login_generation = claimed_login_generation`）只留给电脑发的草稿：那些账号没有控制面凭据，只能靠它挡「认领之后重登」；走接口的草稿只看凭据代际。0016 之前认领的草稿 `claimed_login_generation` 是 NULL，滚动升级期间旧控制面重登也不推进 `login_generation`，所以这些行不用代次，改用基底那条 `login_generation = 1 AND login_changed_at <= claimed_at`：代次仍是 1 说明没经过新控制面重登，认领时刻挡旧控制面的重登。`markLoginValid` 先在电脑上取 advisory lock（`login-valid:<computerId>`），再锁电脑报上来的那一行，合并到同名的 known 行时嵌套一层 `withAccountLock(known)` 才改它，和结算它的发布结果排成一队。要先排队，是因为两把行锁的顺序由报文决定：甲报成乙、乙报成甲同时到，一边先锁甲等乙，另一边先锁乙等甲，PostgreSQL 报 40P01，一次登录结果就丢了。控制面是单实例，同一台电脑的两条连接在 hub 里排成一条链，经连接报上来的两次合并本就先后进库；这把锁挡的是以后多个控制面共库，或者别的路径并发调 `markLoginValid`（`test/login-merge-lock.test.ts` 直接调仓库函数让两次合并并发进库钉着）。同一台电脑的登录结果一次只进一个，结算发布结果的那头只拿一把行锁，不会互等。

交错里那一次旧请求本身的结论不变：代理回 409，发布把那条草稿记 `login_expired`；账号不动，因为账号这边已经有了更新的结论，草稿失败时也不再发通知（同 `settleFailed` 的 `already_known`）。

### 代理：`/accounts-proxy/:accountId/*`

Bot 读 GitHub、X（查 issue、搜推文）不直接打平台，打控制面的 `/accounts-proxy`，地址随 `config.accountsProxy.baseUrl` 下发，和网关一样拼在 `PUBLIC_BASE_URL` 上。认身份用电脑的网关 key（`Authorization: Bearer`），浏览器 cookie 不算数。依次判：key 不对 401；不是 GET 405「代理只读，发东西走草稿」；账号不是这台电脑主人的、不存在、或不是 github/x 回 404；`login` 不是 `valid` 回 409；取令牌出错 502，取到 `login_expired` 记过期后回 409。放行时把 `*` 那段原样（不解码）拼到平台接口根地址后面，拼完核对 origin 和根路径前缀，跳出去回 400；解码后再拼的话 `..%2F` 会变回 `../`，GitHub 的账号能打到 X 上。请求头换成平台要的头和 `Bearer <平台令牌>`，客户端的 `accept` 保留，其他一律不带。回包只透 `content-type`、`etag`、`last-modified`、`link`、`cache-control` 和 `x-ratelimit-*`，平台的 `set-cookie` 不透。平台回 401 走下面那条共用规则，回 403 原样透给 Bot，不刷新、不记过期：403 多半是这个号没权限读那个资源，令牌本身没问题。平台可能把收到的 `Authorization` 回显在正文里，所以回包不是流式透传：正文读进内存，上限 1MB（`ACCOUNTS_PROXY_MAX_BYTES`），超过就截在上限处并带 `x-baize-truncated: true`；这次请求用过的每一把令牌（401 刷新重试时新旧两把）都换成 `[已隐藏]`，成功和出错的回包都换。匹配不按写法枚举，而是逐字符允许等价形态：原字符、`%XX`（十六进制不分大小写，非 ASCII 按 UTF-8 逐字节）、`\/` `\"` `\\`、`\uXXXX`，所以大小写混写、逐字符混用都认得出；双重编码和 HTML 实体不认。透出去的头命中令牌就整个丢掉，不替换，因为头值只能是单字节字符。截断落在令牌中间，或停在半个 `%2`、`\u00` 上时，结尾那一截一并去掉；上限之后已经读到的字节拿来接着看，接不成令牌的（比如 `%2` 后面是 `0`）原样留着，读到的不够判断时按接得成算。截断处在替换之前、按原始字节算：先替换的话，一把令牌是另一把的开头（刷新前后两把可能这样）时，短的那把会吞掉长的开头，长的余下那截就认不出来了。截点要是落在一把整个写在上限之前的令牌中间，就退到那把令牌的起点，整把去掉。读到上限后取消平台回包时 `cancel()` 抛错只记日志，上限前的正文已经读齐，照样回截断的 200。令牌端点发来的访问令牌（换令牌和刷新两处，都在 `requestToken`）含反斜杠、百分号、控制字符或非 ASCII 时不收，按被拒处理：授权回调跳回 `failed`；刷新时平台已经把旧刷新令牌用掉了（单次使用），再试也换不到，所以清掉刷新令牌、账号记过期、推 `account_updated` 和 `failed` 通知让用户重新登录，回 409，这把令牌不进库。原因有两个：一串连续的反斜杠或百分号会让上面的匹配正则灾难性回溯，1MB 正文能卡住控制面；Latin-1 字符在线路上是单字节，匹配器只认它的 UTF-8 写法。两家的令牌字符集本来就不含这些字符。`account-add` 脚本手工挂的令牌在入口过同一道校验（`unsafeAccessToken`），不收就退出码 1。

代理和发布共用一条「401 刷新后重试一次」的规则。平台回 401，就把这次用的令牌作为 `rejected` 交给 `accessToken`：库里的令牌已经不是它（别的路径刚刷过），直接拿库里的重试；还是它，就强制刷新一次再重试。重试还是 401，代理记过期回 409，发布循环把草稿记 `login_expired`、账号跟着记过期。对发布的 POST 重试一次是安全的：401 表示平台没有接受这次请求，什么都没发出去，重发不会发出两条。这条规则也挡住了一个交错：发布先拿到旧令牌 A、请求还在路上，代理这时 401、刷出新令牌 B；A 晚到的 401 交回去时库里已经是 B，发布直接用 B 重试，账号不会被记成过期。发布路径把平台的 403 也记成 `login_expired`，和代理的口径不同，这一版还没统一。

为什么令牌不出控制面。电脑上跑的是 Bot 写的命令，Bot 的上下文又会进模型。令牌一旦下发，就等于交给了模型和电脑上任何能读文件的进程，撤销只能去平台后台点。留在控制面，电脑只拿得到一把网关 key，它只能以这个用户的名义读、不能写，写一律走草稿和审批；要收回，删账号或换网关 key 就行。刷新也只有一处在做，锁行才管得住。

## 用量、今天与通知

`GET /api/usage` 按用户返回本周合计、每个现存 Bot 的花费与 run 数（零花费也有一行），以及不限本周的最近 20 次 run。周起点是 Asia/Shanghai 的周一 00:00，响应里的 `weekStartsAt` 是该时刻的 UTC ISO 时间。例如上海 2026-09-21 00:00 对应 `2026-09-20T16:00:00.000Z`。金额取 run 已保存的 `amount`，不重算历史价格。`runs.owner_id` 在 Bot 和群删除后仍保留，所以删掉的 Bot 的 run 计入 total，不再出现在 Bot 分列；迁移时只能回填仍能从 Bot 或群识别归属的旧 run。

`GET /api/today` 只聚合当前用户的数据。计划只看 pending 和 approved 两种，稿子只看这些计划的稿子，加上不属于计划的 pending、approved 稿子，退回的计划和它的历史稿子不出现。`pending` 超过 50 条时保留最新 50 条，仍按到达时间正序排，待批计划里的稿子只嵌在计划项里；`done` 按时间倒序保留最新 20 条；`running` 每个群至多一行，取该群 `decidedAt` 最新的一份 approved 计划，这份计划的稿子全部发布（published 等于 planned）就不出行，没有计划的群这一期不出行，按批准时间倒序保留最新 20 条；`next` 按排期正序保留最近 20 条。`pending` 里的账号行（`kind: "account"`，带整个 `Account`）有两种：`login='expired'` 的账号恒出一行，`since` 是 `login_changed_at`，也就是什么时候过期的；`login='none'` 的浏览器登录类占位（`BrowserPlatform`，现在只有小红书）只在被当前 pending 稿子（不属于计划的，或挂在 approved 计划下的）或 pending 计划里的 pending 稿子引用时出一行，一个号只出一行，`since` 是引用它的待办里最早那件的 `since`：占位可能几天前就建了，要登录是从有稿子等着它那一刻开始的。GitHub、X 的 `none` 不出行，它们走授权页，不在电脑上登录。账号行和同一刻的待办并列时排在前面。这样待办数恒等于 `pending` 的条数：Web 首页的登录卡只替换这一行、挪到第一张要用它的稿子前面，服务端没列的号不凭空放卡；菜单栏不放卡，照原样列这一行，`none` 写「还没登录」，`expired` 写「登录过期」。`assistantGroupId` 是主助理的单聊群，只有 P1-13 之前注册、之后还没登录过的老用户才是 `null`。`assistantLatest` 是这个单聊里按 `seq` 最新的一条正文非空的 Bot 消息，正文按 UTF-16 码元截到 200、不劈开 emoji，加上它的 `createdAt`；用户的话、别的群的话都不算，没有主助理或它一句没说过时是 `null`。

`GET /api/projects/:groupId` 是项目页，同一套查询只看这一个群：群必须是本人的多 Bot 群，别人的群、单 Bot 群、不存在的群一律 404。`pending` 只有这个群的审批、计划和稿子，不带账号过期卡；`achievements` 只读本人的 `publications`，按发布时间倒序最新 20 条，小红书读不到笔记 id 时的管理页链接照样给，历史消息里长得像发布成功的话不算；`weekPublished` 是本周（周一 00:00，Asia/Shanghai）这个群发了几条；一句话连同它之后、下一句之前群里的其他消息算一轮，`latestTurn` 直接从 `messages` 取最近一轮，起点是按 `(createdAt, seq)` 最晚的那句用户消息，回应不含 cost、最多给最近 50 条，不受群历史分页窗口的限制，用户一句没说过时是 null，`olderTurns` 是更早的轮数。整页在一个 `REPEATABLE READ` 只读事务里查，起点、轮数和回应出自同一个快照：分开查的话，查完起点才落库的下一句不算起点，却会被当成回应带出来；`working` 是这个群还没结束的 run，标题规则和用量页一致；`plan` 是这个群最近批准的一份计划和它的稿子，`next` 是这个群最近一件排了时间的事，`routines` 是这个群的例行任务。

系统通知在这几种时候产生：

- `confirm`：新来一张审批卡。
- `result`：例行任务派出的 run 收尾时留下了可见 Bot 回复。用户自己在群里发消息触发的 run 他当场就看得到，不推。
- `failed`：这件事没办成，要用户处理。有三种来源：草稿发布失败，账号登录过期（见「账号」一节，和草稿失败同时发生时只推草稿那条），电脑代理报 `login_state` 的 `failed`。最后这种文案按原因写一句中文：`window_failed` 是登录窗口出错或到点没登上，`remote_refused` 是远程电脑不许登录、请到本机登录。登录没成不等于账号过期，`accounts.login` 不动。账号不属于哪个群，没有群消息可落，所以只走通知，`groupId` 为 null；用户关了通知就看不到这一句，免打扰期间它和别的通知一样只进汇总的件数。它不走 `stuck` 的去重和暂存，那两样是给电脑掉线的，登录接连失败几次每次都推。账号必须是这台电脑主人、登在这台电脑上的，同一个用户的另一台电脑报也不认，否则整条丢掉。
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
