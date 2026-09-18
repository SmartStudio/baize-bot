# pi-embed 技术验证

用真实的 `@earendil-works/pi-coding-agent` 0.85.1 在一个 Node 进程里嵌入 Pi，回答规格第三部分「Bot 运行器用 Pi」依赖的四个问题。跑 `pnpm --filter pi-embed test`。

四个答案都是能。下面每条给做法、用到的 SDK API、以及断言在哪。

SDK 的行号指 `spikes/pi-embed/node_modules/@earendil-works/pi-coding-agent/dist/`（0.85.1 的发布产物，本次以它为准；npm 包实际来自 `earendil-works/pi`，deepwiki 上的 `badlogic/pi-mono` 是旧名）。

## 一、一个进程能同时跑两个互不干扰的 AgentSession

能。每个 Bot 一次 `createAgentSession`，把三样东西按 Bot 分开：`cwd`、`sessionManager`、`modelRuntime`。

- `createAgentSession(options)` — `core/sdk.d.ts:107`，选项里 `cwd:12`、`agentDir:14`、`modelRuntime:16`、`resourceLoader:49`、`sessionManager:51`、`noTools:33`。
- `SessionManager.create(cwd, sessionDir)` — `core/session-manager.d.ts:319`。第二个参数就是会话 JSONL 的落盘目录，不给则按 cwd 推导。
- 调用点在 `src/bot-session.ts:123`，会话目录在 `:130`。

验证在 `test/pi-embed.test.ts:127`。两个会话的 `sessionManager.getCwd()` 不同，JSONL 落在各自的 `sessions/` 下，文件第一行的 header 里 `cwd` 分别是各自的工作目录，文件内容里分别只出现自己那个工具名。两个 `prompt()` 用 `Promise.all` 同时发（`:107`），网关日志里两个会话的请求是交错的，不是串行。

进程级共享状态只有一处要当心：不给 `ModelRuntime.create` 传 `modelsStorePath`，它默认写 `~/.pi/agent/models-store.json`（`core/models-store.js:30`），云电脑上会串到别的 Bot。`src/bot-session.ts:83` 显式钉死。

## 二、扩展注册自定义工具、拦截 tool_call、等外部 HTTP 批准、拒绝时 block

能，而且 block 是真的没执行工具函数体。

- 扩展不必落盘。`new DefaultResourceLoader({ extensionFactories: [fn] })` 直接吃一个 `(pi: ExtensionAPI) => void`（`core/resource-loader.d.ts:76`），调用点 `src/bot-session.ts:119`。
- `pi.registerTool(...)` — `core/extensions/types.d.ts:944`，`ToolDefinition` 在 `:344`，参数 schema 用 typebox 的 `Type.Object`。注册点 `src/bot-session.ts:44`（send_email）和 `:55`（list_files）。
- `pi.on("tool_call", handler)` — `core/extensions/types.d.ts:939`。事件是 `CustomToolCallEvent`（`:714`），字段只有 `type`、`toolCallId`、`toolName`、`input`。返回值 `ToolCallEventResult`（`:818`）就是 `{ block?: boolean; reason?: string; terminate?: boolean }`。拦截点 `src/bot-session.ts:66`。
- handler 是 async 的，可以一直挂着等外部结论。`src/approval.ts:37` 起一个 HTTP 服务，`GET /approvals` 列出挂起的，`POST /approvals/<callId>` 带 `{"approved":false,"reason":"..."}` 给结论。测试里的「审批人」在 `test/pi-embed.test.ts:44`。

block 的语义从 pi-agent-core 的源码确认（`@earendil-works/pi-agent-core/dist/agent-loop.js:412-433`）：`beforeToolCall` 返回 `block` 时走 `kind: "immediate"` 分支，直接造一条 `createErrorToolResult(reason)`，`tool.execute` 根本不进。模型看到的是一条 `isError: true` 的工具结果，正文就是 `reason`。

验证在 `test/pi-embed.test.ts:150`。A 的 `sideEffects` 是空数组（工具函数体往里 push，没执行就是空），B 的是 `["list_files:/work"]`；A 的消息里能找到 `toolCallId` 对得上的 toolResult，`isError` 为真，正文含拒绝理由。反向验证做过：把测试里的 `approved: false` 改成 `true`，b 和 d 两条立刻红，`sideEffects` 变成 `["send_email:kehu@example.com"]`。

注意 `tool_execution_start` 和 `tool_execution_end` 两个事件被 block 时照样发（`agent-loop.js:298` 和 `:534`），`tool_execution_end.isError` 为真。光看事件区分不出「被拒绝」和「工具自己报错」，所以 blocked 这个状态得由拦截器自己记（`src/approval.ts:39` 的 `blockedCallIds`，`src/reporter.ts:67` 消费）。

## 三、把自建的 OpenAI 兼容网关注册成 Pi 的模型供应商

能，而且不用碰 `~/.pi/agent/models.json`，全程序化。

- `ModelRuntime.create(options)` — `core/model-runtime.d.ts:53`。`modelsPath: null` 关掉读 models.json，`authPath` 和 `modelsStorePath` 指到自己的目录，`refreshOnCreate: false` 和 `allowModelNetwork: false` 关掉启动时的网络探测。调用点 `src/bot-session.ts:80`。
- `modelRuntime.registerProvider(providerId, config)` — `core/model-runtime.d.ts:98`，config 类型 `ProviderConfigInput` 在 `core/provider-composer.d.ts:16`。关键字段 `baseUrl:18`、`apiKey:19`、`api:20`、`models:25`。`api` 填 `"openai-completions"`，`apiKey` 可以直接给字面量（`core/resolve-config-value.d.ts` 的规则：`!` 开头当 shell 命令，含 `$VAR` 做环境变量插值，否则当字面量）。注册点 `src/bot-session.ts:89`。
- 拿模型用 `modelRuntime.getModel(providerId, modelId)`（`:65`），传给 `createAgentSession({ model })`。

一个 ModelRuntime 配一个 Bot，各自注册同一个 provider id 但不同的 apiKey，网关就靠 `Authorization: Bearer` 分账。网关在 `src/gateway.ts:70`，边转发 SSE 边从分片里挑 `usage` 记内存数组。上游选择在 `src/gateway.ts:64`：有 `OPENAI_API_KEY` 转 `https://api.openai.com/v1`，有 `ANTHROPIC_API_KEY` 转 `https://api.anthropic.com/v1`，都没有就用内置假上游（`src/openai-sse.ts`）。本次只跑过假上游，两条真上游分支没跑过。

验证在 `test/pi-embed.test.ts:167`。两个 key 各两条记录，`totalsFor` 分别是 2700/76 和 1700/48，和假上游脚本里写死的 usage 一致；还交叉比对了 `run_done` 上报的 token（来自 `session.getSessionStats().tokens`）和网关账本完全相等，说明 usage 确实是从流里一路传到 Pi 内部的。

## 四、会话事件转 AgentToControl 报文

能。映射在 `src/reporter.ts`，`session.subscribe(listener)`（`core/agent-session.d.ts:280`）拿到的是 `AgentSessionEvent`（`:40`），它是 pi-agent-core 的 `AgentEvent`（`@earendil-works/pi-agent-core/dist/types.d.ts:377`）加上会话层的分支。

| Pi 事件 | AgentToControl |
| --- | --- |
| `message_update` 且 `assistantMessageEvent.type === "text_delta"`（`src/reporter.ts:38`） | `bot_text`，`done: false` |
| `message_update` 且 `text_end`（`:42`） | `bot_text`，`delta: ""`、`done: true` |
| `tool_execution_start`（`:46`） | `bot_tool_call`，`status: "running"`、`durationMs: null` |
| `tool_execution_end`（`:59`） | `bot_tool_call`，`status` 取 blocked / failed / ok |
| `turn_end` | 累加 `run_done.steps` |
| `agent_settled`（`:79`） | `run_done`，token 取 `getSessionStats().tokens` |

每条出边界前过 `AgentToControl.parse`（`src/reporter.ts:34`），schema 不过就抛。验证在 `test/pi-embed.test.ts:183`，断的是完整序列而不是包含关系。A 的实际序列：

```
bot_text(delta:"小陈，", done:false)
bot_text(delta:"这就给客户发邮件。", done:false)
bot_text(delta:"", done:true)
bot_tool_call(send_email, running, durationMs:null)
bot_tool_call(send_email, blocked, durationMs:25)
run_done(steps:2, inputTokens:2700, outputTokens:76)
```

## 踩到的坑

**`~/.pi` 是默认目的地，而且不止一处。** `core/config.js:421` 的 `getAgentDir()` 读环境变量 `PI_CODING_AGENT_DIR`（名字由 `core/config.js:406` 拼出来，`APP_NAME` 来自包的 `piConfig`），没有就回落 `~/.pi/agent`。`createAgentSession` 的 `agentDir`、`SettingsManager.create` 的第二参、`ModelRuntime.create` 的 `authPath` / `modelsPath` / `modelsStorePath`、`DefaultResourceLoader` 的 `agentDir` 各有一个独立的回落点。测试里两道保险都上：环境变量指到临时目录（`test/pi-embed.test.ts:77`），每个入口再显式传。跑完 `find ~/.pi -newermt ...` 确认一个文件都没动。实测临时目录下确实会出现 `auth.json`，说明这些路径是活的，不是摆设。

**`registerProvider` 有两个重载，别看错文档。** `ExtensionAPI.registerProvider` 既能收一个完整的 `Provider` 对象（`core/extensions/types.d.ts:1066`），也能收 `(name, config)`（`:1067`）。deepwiki 给的答案是第一种（`createProvider` + `openAICompletionsApi` + `auth.apiKey.login/resolve` 的交互式登录流），对我们是绕远路。包里自带的例子 `examples/extensions/custom-provider-anthropic/index.ts` 用的是第二种，`ProviderConfigInput` 里直接给 `baseUrl` 和 `apiKey`，没有任何登录流程。源码和 deepwiki 不一致时以源码为准这条在这里生效了。

**`run_done` 不能挂 `agent_end`。** `agent_end` 一次 run 会发好几遍。自动重试默认开着（`core/settings-manager.js:582` 的 `enabled ?? true`，`maxRetries` 3），上游一次 503 就会让 Pi 重跑这一轮，`core/agent-session.js:386` 每次都带 `willRetry` 发一遍 `agent_end`；`core/agent-session.js:776` 的 `while (await this._handlePostAgentRun()) await this.agent.continue()` 还会因为 steering/后续队列再发几遍。一次 prompt 恰好一次的是 `agent_settled`，它在 `_runAgentPrompt` 的 `finally` 里发（`core/agent-session.js:347`、`:784`），错误和中断路径也覆盖得到。

这条有回归测试：`test/pi-embed.test.ts` 的「上游重试」用例让网关头一个请求返 503（`src/gateway.ts` 的 `failFirst`），断言 `agent_end` 发 2 次、`agent_settled` 发 1 次、`run_done` 只有 1 条。把 reporter 改回 `agent_end` 这条会红，其余四条依旧全绿——原来的四条测试盖不到这个路径。要让 503 冒到 Pi 的重试层，得把 `retry.provider.maxRetries` 设成 0（`core/settings-manager.js:610` 默认 undefined，会落到供应商 SDK 自己那层重试，把错误悄悄吞掉）。

**blocked 和 failed 在事件层是一回事。** 见上面第二节末尾。审批状态必须由拦截器自己记，指望从 `tool_execution_end` 读出来会把工具自身的报错也标成「被拒绝」。

**假上游的第二轮要空着。** 工具结果回去之后 Pi 会再请求一次模型。那一轮如果还吐文本，报文序列就变成 `bot_text… bot_tool_call… bot_text… run_done`，跟验收要的顺序对不上。脚本里第二轮 `textChunks: []` 且 `finish_reason: "stop"`，Pi 接受空 assistant 消息，序列才是干净的。另外第一个分片不要带 `content: ""`，否则会多出一对 `text_start`/`text_end`，凭空多一条 `done: true`。

**`AgentSession` 上没有 `getCwd()`。** cwd 在 `sessionManager.getCwd()`（`core/session-manager.d.ts:205`），会话文件路径在 `sessionManager.getSessionFile()`（`:209`）。

**typebox 要自己声明依赖。** 工具参数 schema 用的是 `typebox`（不是 `@sinclair/typebox`），pi-coding-agent 把它当自己的依赖，pnpm 下不会漏给使用方，得在 `spikes/pi-embed/package.json` 里显式写上。

## 没验证的

- 真上游那两条分支（`src/gateway.ts:64` 的 `realUpstream`）一行没跑过。Anthropic 的 OpenAI 兼容端点路径是按文档写的，没有实测。
- 只验了传输层错误（503）触发的重试。compaction 触发的 `willRetry`（`core/agent-session.js:1695` 的 overflow 路径）没跑到，不过 `run_done` 挂在 `agent_settled` 上对这两种都成立。
- 会话的续跑、分支、compaction 都没碰。
- 多于两个会话、以及长时间跑之后的资源占用没测。
- 接管暂停（`pause` / `resume`）对应到 Pi 的哪个 API 没找。
