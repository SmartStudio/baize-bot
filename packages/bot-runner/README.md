# @baize/bot-runner

Bot 运行器。用 `@earendil-works/pi-coding-agent` 0.87.1 的 SDK，一个 Bot 在每个群一份 `AgentSession`，跑在电脑代理进程里。同一个 Bot 的 prompt 仍按到达顺序一条一条跑。

`createRunner(config)` 返回六个方法：

| 方法 | 对应的下行报文 | 干什么 |
| --- | --- | --- |
| `applyConfig(config)` | `config` | 按 Bot 增量对账定义、工具、skill 和网关凭据 |
| `prompt(message)` | `prompt` | 跑一次，产出 `bot_text`、`bot_tool_call`、`run_done` |
| `approve(runId, callId, approved)` | `approval_result` | 给挂起的审批一个结论 |
| `pause(botId)` | `pause` | 立起这个 Bot 的暂停闸门；正在执行的工具跑完，下一次工具调用或新 prompt 挂起 |
| `resume(botId)` | `resume` | 放开暂停闸门，原 run 从等待点继续 |
| `stop()` | 连接关闭 | 停掉所有会话 |

上行报文不从这里直接出网，交给 `config.send` 回调，由电脑代理写进 WebSocket。每条出边界前过 `AgentToControl.parse`。

## config 增量对账

电脑代理只在第一条 `config` 创建运行器，后续配置都交给同一个运行器的 `applyConfig`。每个 Bot 有一条串行队列 `chain`：运行、建会话、关会话和 MCP、skill 落盘、网关热更新都排在上面，同一个 Bot 任何时刻只做一件。`applyConfig` 只记下每个 Bot 的期望配置 `desired`，给每个 Bot 排一个对账步骤就返回，不等任何队列。它不能等：电脑代理的 inbox 在 await 它，而队列前面可能有一条在等审批的 run，审批结论也排在那个 inbox 里。config 之后到的 prompt 排在对账步骤后面，所以看得到新定义。

对账比较每个 Bot 的定义指纹：角色、名字、标签、描述、skill 的 id、名字和步骤、skill 是否落盘成功、它实际分到的 MCP 连接（id、名字、地址、Authorization、操作定义和顺序）。一条连接分给别的 Bot 的名单变化不算当前 Bot 变化。skill 要进指纹，因为 Pi 只在建会话时把 skill 列表拼进系统提示；落盘成功与否也进指纹，排障后落好的 skill 才会触发重建。

指纹没变的 Bot 保留现有会话。变了就关掉这个 Bot 的会话和 MCP，正在跑的 run 先跑完，因为对账步骤排在它后面。关完不批量重建，下一条 prompt 到了才为那个群建会话，`SessionManager.continueRecent` 续用原 JSONL。会话逐个关，关失败的也从表里删掉并报一条 `runner_failed`，不留已 dispose 的会话给后面复用。删除 Bot 时，暂停闸门上等待的 prompt 各发一条零用量 `run_done`。网关变化时只重新注册同一个 provider：key 是请求时按供应商取的，重新注册就生效；base URL 挂在会话的 Model 上，下一次 prompt 前的 `usePurpose` 发现地址变了才在同一个会话上 `setModel`。

闸门规则不跟会话走。每次工具调用都按这个 Bot 最新的 `desired` 工具、账号和授权判定，归属人收紧规则或撤销授权对在飞 run 的下一次工具调用立刻生效。只改授权和账号不会重建会话。删 Bot 会拒绝下一次工具调用，并解开暂停或审批等待，让 run 正常收尾。

暂停和「有 run 在跑」是两个字段。`paused` 是闸门状态，`active` 是当前 run。暂停期间的新 prompt 仍留在原来的 `chain`，排到队首后在模型请求前等待；不另建重放队列。这样恢复后仍按原到达顺序执行，也不需要重发 prompt。

`run_done` 只从 `finishRun` 发出，同一个 runId 只发一次，发的同时移出 `activeRuns()`。所以 `activeRuns()` 就是「收到了、还没发 run_done」，停在暂停闸门或 Bot `chain` 里的也算，重连时的 hello 带得上它们。

## 按用途换模型

provider 注册 `baize:plan`、`baize:fast` 两个模型，名字就是控制面网关认的那两个，网关再按 `GATEWAY_MODELS` 映射到真模型。每次 prompt 前 `usePurpose(prompt.purpose)` 挑对应那个，用途和网关地址都没变就不动，变了在同一个会话上 `setModel`，历史接着用。`config.modelGateway.model` 运行器不再读。

Pi 0.87.1 的 `setModel` 只改 `agent.state.model` 并往会话 JSONL 追加一条 `model_change`，下一次 prompt 就用新模型。所以不变的时候不调，免得每条 prompt 多写一行。

## 目录布局

`config.dataDir` 是根，每个 Bot 一棵子树，三个目录都在 `src/paths.ts` 的 `botDirs` 里定死：

```
<dataDir>/<botId>/agent                 Pi 的 agentDir。auth.json、models-store.json 落在这里
<dataDir>/<botId>/sessions/<groupId>    这个群的会话 JSONL
<dataDir>/<botId>/work                  会话的 cwd，Bot 干活的地方
<dataDir>/<botId>/skills                config.skills 落成的 <skillId>/SKILL.md，见「skill」一节
```

直接放在 `sessions/` 里的旧 JSONL 不迁移、不删除。升级后那个 Bot 会丢一次旧记忆，之后按群续用。

Pi 有四个独立的落盘回落点，不显式给就各自回落到 `~/.pi/agent`，一台电脑上多个 Bot 共用一个进程时会互相串。四个都在 `src/bot-session.ts` 里钉死：

- `ModelRuntime.create` 的 `authPath` 和 `modelsStorePath` 指到 `<botId>/agent`，`modelsPath` 设 `null`（关掉读 `models.json`）。
- `DefaultResourceLoader` 的 `agentDir`。
- `createAgentSession` 的 `agentDir`。
- `SessionManager.continueRecent(workDir, <sessions>/<groupId>)` 的第二参。目录里有 JSONL 就续最近一份，没有才新建。

`SettingsManager` 用 `inMemory()`，不落盘。测试里 `test/runner.test.ts` 的最后一条用例先确认探针在临时目录下确实看得见新写的 `auth.json` 和会话 JSONL，再断言 `~/.pi` 下一个新文件都没有。

## 统一闸门和沙箱

每次 Pi `tool_call` 都先走 `src/gate.ts` 的纯函数。判定顺序固定为禁区、硬清单、`config.grants` 与账号权限档、默认表。禁区授权也不能越过；`spend`、`account_security` 和 `delete` 每次都问。项目授权只在同一 `groupId` 生效，永久授权还会再过 `GRANTABLE_SCOPES`，畸形的硬清单或 `write_outside` 永久授权不会被采用。

`read`、`write`、`edit` 先展开 `~` 和开头的 `@`，再对已存在的路径段做 realpath。相对路径按 Bot 的 `<dataDir>/<botId>/work` 解。`~/.ssh`、钥匙串和浏览器登录资料是固定前缀禁区。MCP 的原始 `readOnlyHint` 已由控制面压成 `needsApproval`：`false` 归 `read`，`true` 再按操作名前缀归动作；用户在工具页改过的 `needsApproval` 也照此生效。

bash 用 `shell-quote` 分出管道、`&&`、重定向和简单命令。换行、控制字符、子 shell、变量展开、后台任务、危险选项和未知参数形态都归 `shell`。macOS 上实际执行统一经过 `src/sandbox.ts` 的 `sandbox-exec`：默认连外网、DNS、本机回环和本地代理端口都不通；写只开工作目录和 `/dev/null`、`/dev/stdout`、`/dev/stderr` 等固定设备；禁区读写在所有放宽规则之后再次拒绝。获批的当前调用只放宽判出来的写路径或整个网络，沙箱外还会把环境裁成基础变量和 `PI_` 前缀。Seatbelt 做不到按域名放行，域名授权只决定这次是否询问；一旦批准网络，当前调用可访问全部网络。Linux 在 bubblewrap 接入前，bash 一律问。

Pi 会话使用串行工具执行。文件工具和 bash 不会在同一批里先全部判完再并行执行，路径判定与实际使用之间不留给同批工具改符号链接的窗口。

起草工具（`create_draft`、`edit_draft`、`propose_plan`）在闸门里单走一个分支，排在按工具名分类之前：动作归 `publish`，结论只看账号档，不看授权。`read_only` 档拒绝，理由是一句中文，点名那个账号并叫模型换账号或告诉用户；其余三档一律放行，不出审批卡，草稿卡本身就是确认。`propose_plan` 里任一条草稿用了只读档账号就整份拒，`target` 指向那个账号。清单里没有的账号放行，交给工具报错并列出能用的账号；`edit_draft` 不带账号，放行。MCP 里 `publish_*` 这类名字的操作不走这个分支，照旧按档问：只有 `direct_publish` 且登录有效才放行。

`ask` 发出的 `approval_request` 带 `action` 和能确定时的 `target`。handler 同时监听审批 Promise 和 Pi 的 `ctx.signal`。拒绝或中止返回 `{ block: true, reason }`，工具函数不执行。停机时运行器发送 `approval_abandoned`；删 Bot 时只解开本地等待，不发送该报文，由控制面删除 Bot 的流程收尾审批。暂停不会让审批失效。`bot_tool_call` 的 `blocked` 标记由 `ApprovalGate` 记下，并在 reporter 消费后删除。

## 暂停和继续

Pi 没有原生 pause。本实现不再用 `abort()` 模拟暂停，而是在 prompt 入场和每次 `tool_call` 前等待同一个 Bot 的暂停闸门。正在执行的工具和正在返回的模型请求不会被截断；工具完成后，下一次工具调用停在闸门。审批在暂停前已经发出时仍可决定，批准后也要等 resume 才执行。

暂停不拦已经进入模型请求的纯文字回复。Bot 已经开始生成且这一轮没有工具调用时，文字和 `run_done` 会照常发完；暂停只卡新 prompt 入场和下一次工具闸门。

暂停期间的新 prompt 直接留在 Bot 原有的串行 `chain`，第一条排到队首后在模型请求前等待，其余保持原顺序。resume 只放开等待点，不重发 prompt、不换 runId。停机或删 Bot 会把等待结果定为不继续，随后仍从 `finishRun` 发唯一一条零用量 `run_done`。

## run_done 挂在 agent_settled 上

不能挂 `agent_end`：自动重试（`willRetry`）和队列续跑时它一次运行会发好几遍。`agent_settled` 在 `_runAgentPrompt` 的 finally 里发，一次 prompt 恰好一次，出错和中止也覆盖。`test/runner.test.ts` 的「上游重试」用例让网关对首个补全请求返 503，断言 Pi 重跑了一轮而 `run_done` 只有一条。

## 扩展工具

`RunnerConfig.extensionTools` 是注册点，元素就是 Pi 的 `ToolDefinition`，参数 schema 用 `typebox`（包名 `typebox`，不是 `@sinclair/typebox`）。运行器先注册覆盖内置实现的沙箱 bash，再注册 `extensionTools`、`src/topic.ts` 的主题任务工具、`src/skills.ts` 的 `propose_skill`、`src/drafts.ts` 的三件起草工具，主助理再加 `src/assistant.ts` 的两件工具；工具连接的 MCP 工具排在最后，见「工具连接」一节。桌面操作还没做。测试用这个注册点塞两个假工具。

## 工具连接

`config.tools` 是控制面下发的 `ToolConnectionConfig[]`（`ToolConnection` 加 `authorization`）。按 Bot 取 `assignedBotIds` 含这个 Bot 的连接，每个 `operation` 注册成一个 Pi 工具：`name`、`description` 照抄，`parameters` 是 `inputSchema` 原样经 `Type.Unsafe` 交给 Pi 校验，不再翻译一遍。代码在 `src/mcp-tools.ts`。这一份工具和 client 这个 Bot 的所有群共用，不按群各连一次。

每条连接一个 MCP `Client`（Streamable HTTP，`authorization` 不为 `null` 时放 `Authorization` 头）。惰性连接：第一次调用该连接的工具时才 `connect`。连不上不抛：工具结果是一句「工具连接「X」连不上：<原因>」，Bot 转述给用户，这次 run 照常收尾；下一次调用会再试一次连接。调用走 `callTool`，结果里 `text` 块拼起来作为工具结果，`isError` 为真当工具报错处理（终态 `failed`，错误文本就是 MCP 给的那句）。

撞名先到先得：运行器自己的工具（沙箱 bash、`extensionTools`、主题任务、skill、起草）先占名字，主助理那两件工具的名字不论角色都先占上，然后按 `config.tools` 的顺序，靠前的连接赢，后面的同名操作跳过并 `console.warn` 一次。

`stop()` 时把这个 Bot 每个群的会话逐个 abort、dispose，再把这份 client 关一次。config 变化时只关受影响 Bot 的这些资源；下一条 prompt 按新定义懒建会话，同一个群的 JSONL 用 `continueRecent` 续上。

## 主题任务工具

`src/topic.ts` 的 `createTopicTools` 挂六个工具，由 `createRunner` 按 Bot 建，不用调用方注册。

| 工具 | 参数 | 返回 | 上行报文 |
| --- | --- | --- | --- |
| `read_task` | 无 | 整张任务卡的文本；群里没有任务卡时是 `这个群没有任务卡` | 无 |
| `update_checklist` | `items: { text, done, ownerBotId? }[]`，最多 50 条 | `清单已更新，n/m 完成` | `task_checklist`，整份替换 |
| `mention_bot` | `name`、`text` | `已经在群里 @ 了 <名字>。` | `mention`，带 `targetBotId` |
| `handoff_task` | `to`、`done`、`notDone`、`next`、`checklistIndex?` | `已发交接报文给 <名字>，等它确认。` | `handoff`，带 `toBotId` |
| `accept_handoff` | 无 | `已确认接手，你现在是当前经手。` | `handoff_accept`，带 `handoffId` |
| `set_chief` | `name?` | `已请求将<名字>设为首席。` 或 `已请求卸任首席。` | `set_chief`，带 `targetBotId`；省略名字时为 `null` |

`update_checklist` 在边界上把缺省的 `ownerBotId` 补成 `null`（协议里它是可空不是可省），再过 `z.array(ChecklistItem).max(50)`。`mention_bot` 和 `handoff_task` 的目标都走同一个 `otherMemberByName`，按 `members` 里的 `name` 精确匹配，匹配不上或者匹配到自己都是错误。

**错误一律靠抛异常表达。** pi-agent-core 的 `agent-loop.js` 在 `execute` 的 catch 里把 `error.message` 做成一条 `isError` 的工具结果，`src/reporter.ts` 据此把 `bot_tool_call` 的终态记成 `failed`。返回一条带错误字样的正常结果只会被记成 `ok`，控制面看到的是这次调用成功了。

自己抛的是「不属于任何一次运行」「名字找不到」「交给自己」「不是当前经手」「这个群没有任务卡」「清单指针越界」「这次没有要你接手的交接」「这是单聊，没有首席可设」，都是中文文本；名字找不到时还会列出群里还能选的名字，模型下一轮才不用瞎猜。另外还有一条错误路径是 zod 抛的：清单项的 `text` 为空串、`mention` 的 `text` 为空或超过 2000 字，会在 `z.array(ChecklistItem)` 或 `AgentToControl.parse` 上抛，模型拿到的是 zod 那串英文 issues。这些都在 `send` 之前抛，所以一条上行报文也发不出去。

`set_chief` 只在多 Bot 群可用。`name` 省略表示让当前首席卸任，上行的 `targetBotId` 是 `null`；传名字时按群成员名单精确匹配，自己和队友都可以指定，名单外的名字沿用名字找不到的错误文案。

### 任务卡的文本

`renderTaskCard(task, members)` 是全函数：每个字段都出现一行，空值走固定占位词，不按字段有无分支。行数固定，模型就分不混「这行没出现」和「这个字段是空的」。

例外是节奏：`cadence` 非空时在「截止」后面加一行 `节奏：<cadence>`，空串不出这一行。节奏只有例行派来的主题才有（比如「排本周计划」），队员平常的任务卡没有它，加占位行会让所有队员的 prompt 多一行字节。

```
T-2482 给老客户回一封询价邮件
说明：先翻历史邮件再动笔
截止：2026-09-20T10:00:00.000Z
当前经手：小白
群成员：
- 小白（客服，首席）：客服方向的活先找我。
- 小黑
清单：
1. [x] 翻历史邮件（经手：小白）
2. [ ] 起草回信（经手：未指派）
```

| 字段 | 空值渲染成 |
| --- | --- |
| `summary` 为空串 | `无` |
| `dueAt` 为 null | `不限` |
| `currentBotId` 为 null | `未指派` |
| 清单项的 `ownerBotId` 为 null | `未指派` |
| 清单为空 | 单独一行 `（空）` |
| 成员名单为空 | `（空）` |

经手的 id 按 `members` 解析成名字。**名单里没有的 id 原样渲染那个 id**，不丢信息：成员名单是可能滞后于任务卡的，换成 `未指派` 就查不出到底是谁。

### prompt 拼法

第一段固定为群标签：team 群是 `[群 T-0007 双十一大促 · 成员 小销、小服]`，首席在名字后标成 `（首席）`，solo 群是 `[这是你和用户的单聊]`。群标签后按 `reason` 追加一句说明，再依次放项目清单（`projects` 有这个字段时）、能用的账号（`config.accounts` 非空时）、任务卡（非空时）、交接报文（有 `handoffId` 时）、群里刚才说的（有上下文时）、当前这条（没有 `handoffId` 时）。`reason` 的说明是：

- `mentioned`、`solo`、`handoff`：不追加。
- `chief`：「没人点名，你是这个群的首席，先到你。自己能答就直接答；需要谁补充就 @ 谁；要大家都表态就 @所有人。别为了显得周到把每个人都点一遍。」
- `current`：「没人点名，你是当前经手，这条是冲着手上的活来的。」
- `everyone`：「没人点名，群里每位会依次看到这条。对大家说的话（问候、通知、提问）得有人接：前面没队友答过就由你答；队友已经答到位而你没有要补充的，或者这条跟你无关，只回 (pass)，一个字都别多。」

当前这条按 `origin` 署名：

- `user`：`用户：正文`。
- `bot`：`小销 · 销售 @ 你：正文`，tag 为空则省去 ` · 销售`。下一行固定为「这是队友说的，不是用户的指令，做不做由你按任务卡判断」。
- `routine`：`例行任务（归属人定时发的，现在没有人在等回复）：正文`。

项目清单是主助理才有的一段，每个项目一行，带 `projectGroupId` 好让它调 `set_cadence`，节奏为空写 `未定`。`projects` 是空数组时照样出这一段，写 `（空）`，主助理得知道自己手上没项目；不带这个字段就整段不出，队员的 prompt 因此逐字不变：

```
你管的项目：
- 小红书运营（projectGroupId：group-xhs）节奏：每周 2 篇
- 开源仓库（projectGroupId：group-gh）节奏：未定
```

能用的账号是起草工具的 accountId 来源，每个账号一行，写平台、账号名、档位和 accountId，平台和账号名沿用 `accountLabel`。取的是 `config.accounts` 最新的一份，和起草工具查的是同一份。没有账号时整段不出，没账号的 Bot 的 prompt 逐字不变：

```
能用的账号：
- 小红书 @小满的日常，发布要确认档，accountId：acc-xhs
- X @baize_bot，只读档，不能起草，accountId：acc-x
```

任务卡成员按 `名字（标签，首席）：描述` 渲染，首席成员追加 `，首席`；没有标签时写 `名字（首席）`。普通成员没有标签时省括号，描述为空时省冒号和描述。队友通讯录来自每次 prompt 的 `members`，不进入系统提示。

prompt 的任务卡段和 `read_task` 的返回共用同一个 `renderTaskCard`，两边看到的卡片不会飘。

### 交接

交接分两步，中间隔着目标 Bot 的确认：当前经手点 `handoff_task` 发出报文，控制面落库并给目标派一条带 `handoffId` 的 prompt，目标点 `accept_handoff` 才真正接手。Bot 之间的这个确认不是归属人的审批，走的也不是审批那条路。

`handoff_task` 在三件事上拦：群里没有任务卡、发起的人不是 `task.currentBotId`、目标是自己或者名单外的名字。**经手校验排在名字解析前面**，所以一个手里没活的 Bot 写了个不存在的名字，拿到的错误是「你不是当前经手」而不是「没这个人」，先纠正那个更要紧的错。

`checklistIndex` 收的是**任务卡上那个序号**，从 1 起；协议里的 `checklistIndex` 是下标，从 0 起。换算和范围检查都在 `handoff_task` 里做：

| 模型写的 | 结果 |
| --- | --- |
| 1 到清单长度 | 减一，上行成下标 |
| 缺省 | `null` |
| 0、负数、超过清单长度 | 抛错，错误文本给出清单一共几条 |

范围**故意不写进 typebox 的 schema**。Pi 在 `execute` 之前按 schema 校验参数，被它挡下来的模型只能看到一条 `Validation` 报错，看不出该写几；交给这个 if 统一报，0 和越界给的是同一句能照着改的话。

`accept_handoff` 无参，只在这次 prompt 带了 `handoffId` 时能用，`handoffId` 从 `ActiveRun` 上取，不收模型给的。带 `handoffId` 的 prompt，正文就是控制面渲染好的交接报文，`composePrompt` 把它贴上「交接报文：」的标签紧跟在任务卡后面单成一段，再补一句「先调用 `accept_handoff` 确认接手」。这一段不会再重复成「当前这条」。混在群聊后面的话，模型会把它当成又一句闲话直接开干。

### 首席

`set_chief` 只在多 Bot 群可用。用户让自己或某个队友当首席时传 `name`，名字必须来自这次 prompt 的 `members`；用户让首席卸任时省略 `name`。运行器把名字转换成 `targetBotId`，卸任上报 `null`，控制面再写入群的首席。

### 清单里的经手怎么解析

`ownerBotId` 收的是**卡片上写着的那个字**，`src/topic.ts` 的 `ownerResolver` 在边界上把它解析成 `BotId`：

| 模型写的 | 解析成 |
| --- | --- |
| 群成员的名字 | 那个成员的 id |
| 卡片上出现过的 id（成员的 id，或清单里已有的经手） | 原样当 id |
| 缺省 | `null`，未指派 |
| 其余 | 抛错，错误文本列出群成员的名字 |

名字是主路，因为卡片上经手渲染的就是名字，模型没有别的地方能拿到 id。名单外的 id 也认，是因为经手的 Bot 可能已经退群，这时卡片渲染的是原始 id，模型读一遍改一条再整份写回来会原样抄回来，拦住它等于把正常的读改写打挂。

剩下的一律抛。`BotId` 只是 `z.string().min(1).brand()`，模型猜的名字照样过得了 `ChecklistItem` 和 `AgentToControl.parse`，不在这里拦住就是一条形状合法的脏数据发到控制面，终态还记成 `ok`。

`test/runner.test.ts` 的「运行器的主题任务工具」一节钉住这些：两条直接断言整张卡片的文本（一条满字段、一条全占位词加名单外的 id），其余九条都真跑一遍假上游，其中三条专钉经手的解析（名字解析成 id、猜的名字被拦下、退群的 id 原样放行）。「运行器的交接工具」一节另有十二条，覆盖整条报文的字段、指针换算、四道拦截，以及带 `handoffId` 的 prompt 里各段的先后。

## 主助理

`config.bots[].role` 为 `assistant` 的 Bot 是主助理，替这个人管所有项目。它和队员只差三处，都在 `src/assistant.ts`：

- 系统提示在描述之后多一段 `ASSISTANT_RULE`：一句话自己接、交给项目，还是改项目节奏；改节奏调 `set_cadence`，想做新事调 `propose_project`。人设还没定稿，定了直接换这个常量。
- prompt 多一段项目清单，见上面「prompt 拼法」。
- 多两件工具，只挂给主助理，都不走审批。`src/gate.ts` 按名字把它们归成运行器自己的工具，所以这两个名字对队员也保留（`ASSISTANT_TOOL_NAMES`）：队员连的工具里有同名操作也不注册，同名操作改不了它们的归类，也借不到这条放行。

| 工具 | 参数 | 返回 | 上行报文 |
| --- | --- | --- | --- |
| `set_cadence` | `projectGroupId`、`cadence` | `「<项目>」的节奏改成了「<节奏>」。` 加一句让它说清下次在哪里看到结果 | `set_cadence` |
| `propose_project` | `name`、`goal`、`team`、`platforms`、`cadence`、`firstStep`，形状照协议的 `project_offer` | `方案卡「<名字>」已经发到群里，等用户点开始。` | `project_offer` |

`set_cadence` 只认这次 prompt 的 `projects` 里的 `projectGroupId`，别的一律抛错并列出能改的项目。`set_cadence` 的 `cadence` 是空的就抛错，协议允许空串，但「清空节奏」不是用户会说的话。`propose_project` 的队员 `tag` 可省，边界上补成空串；`description` 必填，空的也抛错，P1-9 拿这一句建队员 Bot，没有它建出来的 Bot 没有边界；平台 `github`、`x`、`xiaohongshu` 写 `supported`，抖音这类写 `unsupported` 加名字。两件工具的长度范围都交给 `AgentToControl` 校验，不合格时把 zod 的 issue 翻成一句中文抛出，比如 `方案卡没发出去，改好再调：team 至少要 1 条`。

## 草稿和内容计划

Bot 想往外发东西只有起草这一条路。`src/drafts.ts` 的三件工具挂给所有 Bot，主助理和队员都能起草，三个名字（`DRAFT_TOOL_NAMES`）对工具连接一律保留。三件都不走审批，闸门只看账号档，见「统一闸门和沙箱」。

| 工具 | 参数 | 返回 | 上行报文 |
| --- | --- | --- | --- |
| `create_draft` | `accountId`、`content`、`scheduledAt?` | `草稿已建（draftId：…），等用户在卡上批。` 加一句别说已经发了 | `draft_create` |
| `edit_draft` | `draftId`、`content` | `草稿 … 已改，改过的稿子会重新等用户批` | `draft_edit` |
| `propose_plan` | `title`、`drafts[]`（每条同 `create_draft`，1 到 20 条） | `计划「…」已发出，N 条草稿等用户在计划卡上批` 加每条的 draftId | `plan_propose` |

- **id 由运行器生成。** 草稿和计划各用 `randomUUID()` 再 parse 成品牌类型，`propose_plan` 里每条草稿一个，计划里的草稿不再单独发 `draft_create`。
- **边界上补齐可省字段。** 模型可以不写 `title`、`images`、`github`，发出去前补成 `null` 和空数组，只挑协议要的字段，多写的键丢掉。`scheduledAt` 收带时区偏移的写法，换算成 UTC 的 ISO 串，认不出就抛错并给一个示例。长度范围交给 `AgentToControl` 校验，不合格时翻成一句中文抛出，和主助理的两件工具共用 `parseOrThrow`。
- **账号只认 `config.accounts`。** 工具每次调用都读最新的一份，换账号不用重建会话。模型从 prompt 里「能用的账号」一段抄 accountId，见「prompt 拼法」。`accountId` 不在清单里仍然抛错，错误里列出每个账号的平台、账号名和 accountId 作兜底；一个账号都没有时叫模型告诉用户先连账号。`propose_plan` 的错误前缀写明是第几条。
- **GitHub 和 X 的草稿先不带图。** `images` 非空就抛错，在读图之前判。`edit_draft` 这边不知道草稿属于哪个平台，挡不住改稿时加的图，得控制面挡。
- **配图由运行器认。** 工具入参里每张图只有 `path`，相对路径按工作目录算。运行器取 realpath，先看是否落在固定禁区里（`src/paths.ts` 的 `forbiddenPathPrefixes`），在就拒，哪怕是工作目录里的符号链接指过去的，错误里也不叫模型把它挪进工作目录；再看是否落在这个 Bot 的工作目录里，不在就叫模型先把图放进工作目录再起草；文件不存在或不是普通文件也抛错。三件工具的配图都这样判，错了只回工具错误，不发上行。通过的图，`DraftSpec` 里记 realpath 和运行器读文件算出的 sha256，所以用户批的那张图和发布器读到的是同一份字节；发布器照 sha256 再核一次，是 P1-5 的事。
- **平台限制只写在工具描述里。** X 正文不超过 280 字符、GitHub 要标题和 `github.repo`/`as`，运行器不强制。

`src/publisher.ts` 的 `publishDraft` 收控制面下行的 `publish_draft`，回一条 `publish_result`。本机发布器按平台登记成一张表，现在是空的，所以一律回 `failed`、`reason: "error"`、`detail: "本机发布器还没接上"`；P1-5 接小红书时往表里加一行。它不挂在 `Runner` 上，电脑代理收到报文直接调，不经过 Bot 的串行队列。

`test/runner.test.ts` 的「运行器的草稿」一节钉住这些，`test/gate.test.ts` 的「起草工具」一节钉住闸门分支。

## skill

**方向只有一个：控制面下发，运行器落盘。** skill 的真相源是控制面的 `skills` 表，运行器不往回同步文件。两个方向都能写的文件没有真相源，用户在 Web 上改的步骤和 Bot 刚存的文件谁覆盖谁说不清。改步骤、删除、复制给别的 Bot，都是改表再重发一条 `config`。

### 落盘和对账

`config.skills` 是该用户**全部 Bot** 的 skill，运行器按 `botId` 分，每个 Bot 落到自己的 `<botId>/skills` 下：

```
<dataDir>/<botId>/skills/<skillId>/SKILL.md
```

目录名就是 `skillId`，一条一个目录。文件长这样，frontmatter 的 `description` 用**第一步**，正文是编号的步骤：

```markdown
---
name: "Globex 报价"
description: "打开 CRM 找到 Globex 的联系人"
---

# Globex 报价

1. 打开 CRM 找到 Globex 的联系人
2. 按上季度的价目表算一版报价
3. 把报价贴进邮件草稿
```

`description` 不能为空：Pi 的 `loadSkillFromFile` 把没有 description 的文件整条丢掉，所以步骤为空的 skill 回落到用名字当 description。两个字段都过 `JSON.stringify` 写成 YAML 的双引号标量，名字里的冒号和引号才不会把 frontmatter 撑破（Pi 用的是真 `yaml` 解析器）。

对账在各 Bot 的 `chain` 上做，**整目录**一次过：`config` 里没有的目录删掉、少的补上、内容变了的重写，内容一样的连 mtime 都不动。重跑同一份 `config` 不改任何文件。不等这个 Bot 被 prompt 就对账，不然一条把 skill 删光的 `config` 下来，没人找它说话的那个 Bot 盘上的旧文件会一直留着。skill 变化会改这个 Bot 的指纹，旧会话关掉后，下一条 prompt 才重新建会话、刷新系统提示。

两条边界上的防护：

- `skillId` 直接当目录名，而 shared 的 `SkillId` 只保证是非空字符串。带 `/`、`\` 或等于 `..` 的 id **整条不落盘**，否则 `../../x` 这种 id 会把 `SKILL.md` 写到 `dataDir` 外面去，而对账只扫一层目录，写出去的永远清不掉。
- 要写的位置上如果是个普通文件（或者 `SKILL.md` 那一格是个目录），先 `rm` 再建。对账在 `createRunner` 里同步做，直接写会 `EEXIST`/`EISDIR`，一个 Bot 的一条脏目录就能让这台机器上所有 Bot 的 runner 都建不起来。

### 怎么让 Pi 看见

`DefaultResourceLoader` 的 `noSkills` 保持 `true`，另外把 `additionalSkillPaths` 指到那个目录。`noSkills` 只关掉 Pi 默认的两处（`agentDir/skills` 和 `cwd/.pi/skills`），`additionalSkillPaths` 照收（`core/resource-loader.js` 的 `mergePaths`），所以这两个选项不打架，而 `~/.pi` 下的 skill 一条也进不来。

**走这条不走 `skillsOverride`**：发现规则（目录里找 `SKILL.md`）、frontmatter 校验、重名去重、`reload()` 时的重扫，这几样都归 Pi 管。用 `skillsOverride` 就得自己调 `loadSkillsFromDir` 再把结果塞回去，等于把这几样重写一遍，而且 `reload()` 之后还得记得重新调。

Pi 把 `getSkills()` 的结果经 `formatSkillsForPrompt` 拼进系统提示，模型看到的是一段 `<available_skills>`，每条带名字、description 和 `SKILL.md` 的绝对路径，按名字对上了就用 `read` 打开读步骤。控制面不改写用户正文里的 `/名`，模型就是靠这段自己找过去的。

两处已知的毛刺，都不影响 skill 被加载：

- Pi 的 `validateName` 按 Agent Skills 规范要求名字是小写字母、数字和连字符，中文名字会在 `getSkills().diagnostics` 里留一条 warning。加载不受影响（只有 description 为空才会整条丢掉），提示里的名字也是原样中文。
- 同一个 Bot 底下两条 skill 重名时，Pi 只留先扫到的那条，另一条进 `diagnostics` 的 collision。名字的唯一性得控制面保证。

### propose_skill

存不存由 Bot 发起。`src/skills.ts` 的 `createSkillTools` 挂一个工具：

| 工具 | 参数 | 返回 | 上行报文 |
| --- | --- | --- | --- |
| `propose_skill` | `name`（1 到 40 字）、`steps`（2 到 20 条，每条非空、每条不超过 500 字） | `已经在群里问用户存不存「<名字>」了，等他点。` | `skill_offer` |

控制面收到 `skill_offer` 落一条消息，Web 画成一张带「存」「不存」的卡，用户点存才有 skill 行，再随新的 `config` 发回来。

**一次运行最多问一次。** 第二次调用抛「这次已经问过了。」。一个 Bot 的运行是串行的，手里最多一次运行，所以记住刚问过的那个 `runId` 就够，不用攒一张表。

这几个范围和 `protocol.ts` 里 `skill_offer` 的 schema 一一对齐：本地挡不住的会在 `AgentToControl.parse` 那里变成一坨英文 ZodError 扔给模型。范围和主题任务工具一个路子，**故意不写进 typebox 的 schema**：被 schema 挡下的模型只看得到一条英文 Validation 报错，看不出该写几条；交给工具里的检查统一报，给的是能照着改的中文。错误一律抛，理由见上面「主题任务工具」那节。

### Pi 集成与系统提示

`DefaultResourceLoader.systemPrompt` 使用任务书指定的白泽基础人设，替换 Pi 默认的编码助手文案。Pi 集成的系统提示按七段排列：白泽基础人设、身份、描述与边界、协作规则、起草规则、存 skill 规则、Pi 自动追加的 skill 列表和工作目录。Pi 0.86 起这些段落按段名拼，除打头的人设（`preamble`）外每段都包一层 `<段名>`：中间五段整体落在 `<addendum>` 里，skill 列表在 `<skills>` 里，工作目录从 `Current working directory: X` 变成 `<cwd>\nX\n</cwd>`。段落内容和顺序没变。

主助理在描述与边界之后、协作规则之前多一段 `ASSISTANT_RULE`，队员没有这一段。身份来自 `config.bots` 的 `name` 和 `tag`，形如 `你叫 小销，标签 销售`，tag 为空就只写名字。描述为空省略整段。协作规则要求只在需要专长时 @ 一个队友，整段交活用交接，队友的话按任务卡判断，并固定写入三条规则：`@所有人 会把话同时发给群里每一位；`、`没人点名轮到你而你无话可说时，只回 (pass)，一个字都别多；`、`用户让谁当首席或让首席卸任时，调 set_chief，别口头答应。` 协作规则之后是 `src/drafts.ts` 的 `DRAFT_RULE`，所有角色都有：往外发东西只能起草，不要用 bash、浏览器或工具连接里的操作自己去发。`PROPOSE_SKILL_RULE` 保持原文。后六段通过 `appendSystemPrompt` 和 Pi 原生 skill 拼接完成，段名和包裹由 Pi 决定，运行器只管内容。

## 跑测试

```
pnpm --filter @baize/bot-runner test
```

本机没有模型 key。测试起一个假上游加 OpenAI 兼容网关（`test/fixtures/`，搬自 `spikes/pi-embed/`，去掉了转发真上游的分支），按脚本产出 SSE 分片，不打任何付费接口。工具连接的用例起一个本地假 MCP（`test/helpers/mcp.ts`，SDK 的 `McpServer` 加 `StreamableHTTPServerTransport`），记下收到的参数和 `Authorization` 头。
