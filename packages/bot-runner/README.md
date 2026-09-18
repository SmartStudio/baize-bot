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

`RunnerConfig.extensionTools` 是注册点，元素就是 Pi 的 `ToolDefinition`，参数 schema 用 `typebox`（包名 `typebox`，不是 `@sinclair/typebox`）。桌面操作、MCP 桥接、主题任务、存 skill 这四组这一版都没做，注册点先空着。测试用它塞两个假工具。

## 跑测试

```
pnpm --filter @baize/bot-runner test
```

本机没有模型 key。测试起一个假上游加 OpenAI 兼容网关（`test/fixtures/`，搬自 `spikes/pi-embed/`，去掉了转发真上游的分支），按脚本产出 SSE 分片，不打任何付费接口。
