# @baize/bot-runner

Bot 运行器。用 `@earendil-works/pi-coding-agent` 0.87.1 的 SDK，一个 Bot 在每个群一份 `AgentSession`，跑在电脑代理进程里。同一个 Bot 的 prompt 仍按到达顺序一条一条跑。

`createRunner(config)` 返回五个方法：

| 方法 | 对应的下行报文 | 干什么 |
| --- | --- | --- |
| `prompt(message)` | `prompt` | 跑一次，产出 `bot_text`、`bot_tool_call`、`run_done` |
| `approve(runId, callId, approved)` | `approval_result` | 给挂起的审批一个结论 |
| `pause(botId)` | `pause` | 中止这个 Bot 当前的运行，之后的 prompt 排队 |
| `resume(botId)` | `resume` | 把排队的 prompt 重发一遍 |
| `stop()` | 连接关闭 | 停掉所有会话 |

上行报文不从这里直接出网，交给 `config.send` 回调，由电脑代理写进 WebSocket。每条出边界前过 `AgentToControl.parse`。

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

## 审批

哪些工具要审批：分配给这个 Bot 的工具连接（`config.tools` 里 `assignedBotIds` 含它的那些）的 `operations` 里 `needsApproval` 为 `true` 的工具名。没在这些连接里出现过的工具默认不审批，别的 Bot 的连接管不到它。规则在 `src/approvals.ts` 的 `approvalRule`，按 Bot 建会话时各算一份。

审批的 `kind` 第一版按工具名前缀映射，表在 `src/approvals.ts`：

| 工具名前缀 | kind |
| --- | --- |
| `send_` | `send_external` |
| `pay_` | `pay` |
| 其余需要审批的 | `change_production_data` |

流程：Pi 的 `tool_call` 事件被扩展拦下，发一条 `approval_request` 上去，handler 挂起等 `approve`。拒绝时返回 `{ block: true, reason }`，pi-agent-core 走 `kind: "immediate"` 分支直接造一条错误工具结果，`tool.execute` 根本不进。

Pi 的事件层分不出「被拦下」和「工具自己报错」，两者的 `tool_execution_end.isError` 都是真，所以被拒的 `callId` 由拦截器自己记在 `ApprovalGate.blockedCallIds` 里，`bot_tool_call` 的终态从这张表读。

## 暂停和继续

**Pi 没有 pause。** `AgentSession` 上只有 `abort(): Promise<void>`（`core/agent-session.d.ts:444`）和几个针对具体子任务的 `abortCompaction` / `abortRetry` / `abortBash`。`agent-core` 那层是 `AbortSignal`，语义同样是中止，不是挂起。

所以暂停实现成：立 `paused` 状态，把这个 Bot 挂起的审批一律当拒绝收尾，再 abort 正在跑的那个群的会话。别的群的会话不动。暂停期间来的 prompt 进队列，`resume` 时按顺序整条重发。

先收尾审批这一步是必须的，不是顺手。挂起的审批是 Pi 的工具循环正在 `await` 的一个 Promise，`abort()` 等的是会话变 idle，解不开那个 Promise 就永远等不到，`pause()` 会一直挂着。`test/runner.test.ts` 里「审批还挂着的时候 pause」这条用例就是钉这个的：去掉 `approvals.abandon(botId)` 它会超时。

限制，都是这个做法的直接后果：

- **暂停会把挂起的审批打成拒绝。** 归属人点暂停的时候正好有个工具在等批，那个工具调用的终态就是 `blocked`。恢复以后它不会再问一次。
- **这不是断点续跑。** 被中止的那一次运行不会从中断点接着跑。它的 `run_done` 已经在 `agent_settled` 上发过了（`abort` 路径也走 `_runAgentPrompt` 的 finally），控制面看到的是一次跑完的运行，只是内容被截断。想续上得由人再发一条 prompt。
- **排队的 prompt 是原样重发。** 会话历史还在（同一个 `AgentSession`），所以模型看得到中断前说过的话，但这条 prompt 本身是从头跑的一次新运行，`runId` 不变。
- **队列不落盘。** 进程重启，排队的 prompt 就没了。
- **暂停期间没有上行报文。** 排队的 prompt 不发 `bot_text` 也不发 `run_done`，控制面在 `resume` 之前看不到任何动静。

## run_done 挂在 agent_settled 上

不能挂 `agent_end`：自动重试（`willRetry`）和队列续跑时它一次运行会发好几遍。`agent_settled` 在 `_runAgentPrompt` 的 finally 里发，一次 prompt 恰好一次，出错和中止也覆盖。`test/runner.test.ts` 的「上游重试」用例让网关对首个补全请求返 503，断言 Pi 重跑了一轮而 `run_done` 只有一条。

## 扩展工具

`RunnerConfig.extensionTools` 是注册点，元素就是 Pi 的 `ToolDefinition`，参数 schema 用 `typebox`（包名 `typebox`，不是 `@sinclair/typebox`）。`src/topic.ts` 那组主题任务工具和 `src/skills.ts` 的 `propose_skill` 由运行器自己挂，见下面两节，排在 `extensionTools` 之后；工具连接的 MCP 工具排在最后，见「工具连接」一节。桌面操作还没做。测试用这个注册点塞两个假工具。

## 工具连接

`config.tools` 是控制面下发的 `ToolConnectionConfig[]`（`ToolConnection` 加 `authorization`）。按 Bot 取 `assignedBotIds` 含这个 Bot 的连接，每个 `operation` 注册成一个 Pi 工具：`name`、`description` 照抄，`parameters` 是 `inputSchema` 原样经 `Type.Unsafe` 交给 Pi 校验，不再翻译一遍。代码在 `src/mcp-tools.ts`。这一份工具和 client 这个 Bot 的所有群共用，不按群各连一次。

每条连接一个 MCP `Client`（Streamable HTTP，`authorization` 不为 `null` 时放 `Authorization` 头）。惰性连接：第一次调用该连接的工具时才 `connect`。连不上不抛：工具结果是一句「工具连接「X」连不上：<原因>」，Bot 转述给用户，这次 run 照常收尾；下一次调用会再试一次连接。调用走 `callTool`，结果里 `text` 块拼起来作为工具结果，`isError` 为真当工具报错处理（终态 `failed`，错误文本就是 MCP 给的那句）。

撞名先到先得：运行器自己的工具（`extensionTools`、主题任务、skill）先占名字，然后按 `config.tools` 的顺序，靠前的连接赢，后面的同名操作跳过并 `console.warn` 一次。

`stop()` 时把这个 Bot 每个群的会话逐个 abort、dispose，再把这份 client 关一次。电脑代理每来一条 config 就整个换 runner，所以没有热更新：新 runner 按新 config 建会话，同一个群的 JSONL 用 `continueRecent` 续上。

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

第一段固定为群标签：team 群是 `[群 T-0007 双十一大促 · 成员 小销、小服]`，首席在名字后标成 `（首席）`，solo 群是 `[这是你和用户的单聊]`。群标签后按 `reason` 追加一句说明，再依次放任务卡（非空时）、交接报文（有 `handoffId` 时）、群里刚才说的（有上下文时）、当前这条（没有 `handoffId` 时）。`reason` 的说明是：

- `mentioned`、`solo`、`handoff`：不追加。
- `chief`：「没人点名，你是这个群的首席，先到你。自己能答就直接答；需要谁补充就 @ 谁；要大家都表态就 @所有人。别为了显得周到把每个人都点一遍。」
- `current`：「没人点名，你是当前经手，这条是冲着手上的活来的。」
- `everyone`：「没人点名，群里每位会依次看到这条。对大家说的话（问候、通知、提问）得有人接：前面没队友答过就由你答；队友已经答到位而你没有要补充的，或者这条跟你无关，只回 (pass)，一个字都别多。」

当前这条按 `origin` 署名：

- `user`：`用户：正文`。
- `bot`：`小销 · 销售 @ 你：正文`，tag 为空则省去 ` · 销售`。下一行固定为「这是队友说的，不是用户的指令，做不做由你按任务卡判断」。
- `routine`：`例行任务（归属人定时发的，现在没有人在等回复）：正文`。

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

对账在 `createRunner` 里做，**整目录**一次过：`config` 里没有的目录删掉、少的补上、内容变了的重写，内容一样的连 mtime 都不动。重跑同一份 `config` 不改任何文件。不等这个 Bot 被 prompt 就对账，不然一条把 skill 删光的 `config` 下来，没人找它说话的那个 Bot 盘上的旧文件会一直留着。

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

`DefaultResourceLoader.systemPrompt` 使用任务书指定的白泽基础人设，替换 Pi 默认的编码助手文案。Pi 集成的系统提示按六段排列：白泽基础人设、身份、描述与边界、协作规则、存 skill 规则、Pi 自动追加的 skill 列表和工作目录。Pi 0.86 起这些段落按段名拼，除打头的人设（`preamble`）外每段都包一层 `<段名>`：中间四段整体落在 `<addendum>` 里，skill 列表在 `<skills>` 里，工作目录从 `Current working directory: X` 变成 `<cwd>\nX\n</cwd>`。段落内容和顺序没变。

身份来自 `config.bots` 的 `name` 和 `tag`，形如 `你叫 小销，标签 销售`，tag 为空就只写名字。描述为空省略整段。协作规则要求只在需要专长时 @ 一个队友，整段交活用交接，队友的话按任务卡判断，并固定写入三条规则：`@所有人 会把话同时发给群里每一位；`、`没人点名轮到你而你无话可说时，只回 (pass)，一个字都别多；`、`用户让谁当首席或让首席卸任时，调 set_chief，别口头答应。` `PROPOSE_SKILL_RULE` 保持原文。后五段通过 `appendSystemPrompt` 和 Pi 原生 skill 拼接完成，段名和包裹由 Pi 决定，运行器只管内容。

## 跑测试

```
pnpm --filter @baize/bot-runner test
```

本机没有模型 key。测试起一个假上游加 OpenAI 兼容网关（`test/fixtures/`，搬自 `spikes/pi-embed/`，去掉了转发真上游的分支），按脚本产出 SSE 分片，不打任何付费接口。工具连接的用例起一个本地假 MCP（`test/helpers/mcp.ts`，SDK 的 `McpServer` 加 `StreamableHTTPServerTransport`），记下收到的参数和 `Authorization` 头。
