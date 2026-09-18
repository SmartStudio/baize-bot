# @baize/bot-runner

Bot 运行器。用 `@earendil-works/pi-coding-agent` 0.85.1 的 SDK，一个 Bot 一个 `AgentSession`，跑在电脑代理进程里。

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
<dataDir>/<botId>/agent      Pi 的 agentDir。auth.json、models-store.json 落在这里
<dataDir>/<botId>/sessions   会话 JSONL
<dataDir>/<botId>/work       会话的 cwd，Bot 干活的地方
```

Pi 有四个独立的落盘回落点，不显式给就各自回落到 `~/.pi/agent`，一台云电脑上多个 Bot 共用一个进程时会互相串。四个都在 `src/bot-session.ts` 里钉死：

- `ModelRuntime.create` 的 `authPath` 和 `modelsStorePath` 指到 `<botId>/agent`，`modelsPath` 设 `null`（关掉读 `models.json`）。
- `DefaultResourceLoader` 的 `agentDir`。
- `createAgentSession` 的 `agentDir`。
- `SessionManager.create(workDir, sessionDir)` 的第二参。

`SettingsManager` 用 `inMemory()`，不落盘。测试里 `test/runner.test.ts` 的最后一条用例先确认探针在临时目录下确实看得见新写的 `auth.json` 和会话 JSONL，再断言 `~/.pi` 下一个新文件都没有。

## 审批

哪些工具要审批：工具连接（`ToolConnection`）的 `operations` 里 `needsApproval` 为 `true` 的工具名。没在任何工具连接里出现过的自定义工具默认不审批。规则在 `src/approvals.ts` 的 `approvalRule`。

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

所以暂停实现成：立 `paused` 状态，把这个 Bot 挂起的审批一律当拒绝收尾，再 `session.abort()` 中止当前运行。暂停期间来的 prompt 进队列，`resume` 时按顺序整条重发。

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

`RunnerConfig.extensionTools` 是注册点，元素就是 Pi 的 `ToolDefinition`，参数 schema 用 `typebox`（包名 `typebox`，不是 `@sinclair/typebox`）。`src/topic.ts` 那组主题任务工具由运行器自己挂，见下一节，排在 `extensionTools` 之后。桌面操作、MCP 桥接、存 skill 这三组还没做。测试用这个注册点塞两个假工具。

## 主题任务工具

`src/topic.ts` 的 `createTopicTools` 挂五个工具，由 `createRunner` 按 Bot 建，不用调用方注册。

| 工具 | 参数 | 返回 | 上行报文 |
| --- | --- | --- | --- |
| `read_task` | 无 | 整张任务卡的文本；群里没有任务卡时是 `这个群没有任务卡` | 无 |
| `update_checklist` | `items: { text, done, ownerBotId? }[]`，最多 50 条 | `清单已更新，n/m 完成` | `task_checklist`，整份替换 |
| `mention_bot` | `name`、`text` | `已经在群里 @ 了 <名字>。` | `mention`，带 `targetBotId` |
| `handoff_task` | `to`、`done`、`notDone`、`next`、`checklistIndex?` | `已发交接报文给 <名字>，等它确认。` | `handoff`，带 `toBotId` |
| `accept_handoff` | 无 | `已确认接手，你现在是当前经手。` | `handoff_accept`，带 `handoffId` |

`update_checklist` 在边界上把缺省的 `ownerBotId` 补成 `null`（协议里它是可空不是可省），再过 `z.array(ChecklistItem).max(50)`。`mention_bot` 和 `handoff_task` 的目标都走同一个 `otherMemberByName`，按 `members` 里的 `name` 精确匹配，匹配不上或者匹配到自己都是错误。

**错误一律靠抛异常表达。** pi-agent-core 的 `agent-loop.js` 在 `execute` 的 catch 里把 `error.message` 做成一条 `isError` 的工具结果，`src/reporter.ts` 据此把 `bot_tool_call` 的终态记成 `failed`。返回一条带错误字样的正常结果只会被记成 `ok`，控制面看到的是这次调用成功了。

自己抛的是「不属于任何一次运行」「名字找不到」「交给自己」「不是当前经手」「这个群没有任务卡」「清单指针越界」「这次没有要你接手的交接」，都是中文文本；名字找不到时还会列出群里还能选的名字（排除自己），模型下一轮才不用瞎猜。另外还有一条错误路径是 zod 抛的：清单项的 `text` 为空串、`mention` 的 `text` 为空或超过 2000 字，会在 `z.array(ChecklistItem)` 或 `AgentToControl.parse` 上抛，模型拿到的是 zod 那串英文 issues。这些都在 `send` 之前抛，所以一条上行报文也发不出去。

### 任务卡的文本

`renderTaskCard(task, members)` 是全函数：每个字段都出现一行，空值走固定占位词，不按字段有无分支。行数固定，模型就分不混「这行没出现」和「这个字段是空的」。

```
T-2482 给老客户回一封询价邮件
说明：先翻历史邮件再动笔
截止：2026-09-20T10:00:00.000Z
当前经手：小白
群成员：小白、小黑
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

`task` 不为 null 时任务卡还会作为 **prompt 的第一段**送给模型，形如 `任务卡：\n<卡片>\n\n`，后面才接「交接报文」（只在这条 prompt 带了 `handoffId` 时有，见下）、「群里刚才说的」和「当前这条」。放第一段是因为它是这一轮的目标，群里的闲聊放在后面不会把它挤远。`task` 为 null 时 `composePrompt` 的行为和没有任务卡这套东西时完全一样。

prompt 的这一段和 `read_task` 的返回共用同一个 `renderTaskCard`，两边看到的卡片不会飘。

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

## 跑测试

```
pnpm --filter @baize/bot-runner test
```

本机没有模型 key。测试起一个假上游加 OpenAI 兼容网关（`test/fixtures/`，搬自 `spikes/pi-embed/`，去掉了转发真上游的分支），按脚本产出 SSE 分片，不打任何付费接口。
