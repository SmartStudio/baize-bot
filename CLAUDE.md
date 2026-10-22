# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

白泽 Bot：企业内部的多 Bot 协作产品。pnpm monorepo，TypeScript strict，ESM，Node 22+。仓库内文档全是中文，回复和注释也用中文。

## 常用命令

```
pnpm install
docker compose up -d                                   # PostgreSQL 16，端口 5434，库/用户/密码都是 baize
pnpm --filter @baize/control-plane migrate             # 应用迁移
pnpm --filter @baize/control-plane seed                # 建开发账号 chen@baize.dev / baize-dev，打印 COMPUTER_ID 和 AGENT_TOKEN
pnpm dev                                               # 起控制面 3001 和 Web 5173，会先 docker compose up -d
pnpm dev --agent                                       # 再起电脑代理，要求 .env 或 shell 里有 COMPUTER_ID 和 AGENT_TOKEN；启动 JSON 走 stdin，不进代理环境
pnpm check                                             # typecheck + oxlint + 全部测试
pnpm typecheck / pnpm lint / pnpm format
```

测试按包跑，每个包都是 `vitest run`：

```
pnpm --filter @baize/control-plane test                # 需要 docker 里的 Postgres，每个测试文件建一个随机库跑全部迁移
pnpm --filter @baize/bot-runner test                   # 起假上游，不打付费接口
pnpm --filter @baize/e2e test                          # 真控制面 + 真代理 + 真运行器，只有模型上游是假的，端口和库都临时
pnpm --filter @baize/web test                          # vitest 之后接着跑 Playwright
pnpm --filter @baize/web test:e2e                      # 只跑 Playwright，自动起 mock 控制面 3317 和 Web 5377
pnpm --filter @baize/e2e acceptance                    # 真栈截图验收，截图落 packages/e2e/acceptance/screenshots
```

跑单个测试：

```
pnpm --filter @baize/control-plane exec vitest run test/handoff.test.ts -t "用例名"
pnpm --filter @baize/web exec playwright test e2e/app.spec.ts -g "用例名"
```

`bot-runner/test/runner.test.ts` 最后的「落盘位置」用例检查的是前面用例写下的文件，单独用 `-t` 挑它会失败，要整个文件跑。

其他：

```
pnpm --filter @baize/web mock                          # 单跑前端用的假控制面
pnpm --filter @baize/control-plane generate            # 改完 src/db/schema.ts 生成迁移，已生成的迁移文件不改只往后加
pnpm --filter @baize/control-plane computer-token      # 重置并打印电脑 token
```

环境变量在 `.env.example`，dev 脚本只认 `KEY=value` 一种写法。`UPSTREAM_API_KEY` 必须是 ASCII，否则每次上游请求都变 502。

## 架构

七个包，五个在下面这条链路上，另外 `desktop` 是起本机代理的 Electron 壳，`e2e` 是真栈测试和验收剧本。`packages/shared` 是唯一的类型来源，对象模型、控制面与电脑代理之间的报文、HTTP API 契约全是 zod schema，其他包只从这里引类型，外部输入在边界 parse，内部函数信任类型。

```
Web (Vite/React, /api 代理到 3001)
  │ HTTP /api，WebSocket /api/ws 推送
  ▼
control-plane (Hono + drizzle/postgres.js，3001)
  │ WebSocket /agent：hello → welcome → config（该用户全部 Bot、skill、工具连接、网关 key）
  ▼
computer-agent（电脑上的常驻进程，出站连接，第一条 config 建 runner，之后按 Bot 增量对账）
  └─ bot-runner：每个 Bot 每个群一份 Pi 会话（@earendil-works/pi-coding-agent）
       │ 模型请求走控制面的 /gateway/v1，Bearer 换成 UPSTREAM_API_KEY，baize:plan/baize:fast 按用途映射到 GATEWAY_MODELS
       ▼
     UPSTREAM_BASE_URL
```

控制面四个面在同一个 3001 端口上按路径分流：`/api`、`/api/ws`、`/agent`、`/gateway/v1`。

### 几个要先建立的模型

- 群是唯一的会话容器。单 Bot 群建 Bot 时自动建出来，多 Bot 群拉 2 到 6 个 Bot。每个群恰好一张主题任务卡（`T-xxxx`），卡上有清单、截止、当前经手。
- 路由规则在 `control-plane/src/agent/routing.ts`，纯函数：单 Bot 群恒为它；多 Bot 群被 @ 的说，没 @ 就是当前经手，都没有就留一句「@ 一个 Bot 派活」。`@名` 在写入前解析进 `body.mentions`，派活只看它。
- 派活在 `agent/dispatch.ts`：每个目标各起一条 `runs` 行、各发一条 `prompt`，带触发消息之前 20 条历史（每条截 200 字）、任务卡（单 Bot 群为 null）和成员名单。运行器 `composePrompt` 按「任务卡 → 交接报文 → 群里刚才说的 → 当前这条」拼。
- 上行报文（`bot_text`、`bot_tool_call`、`run_done`、`approval_request`、`handoff`、`mention`、`skill_offer` 等）都进 `agent/events.ts`，带 runId 的先校验 run 属于这台电脑、这个 Bot、这个群，不成立整条静默丢弃。`run_done` 挂在 Pi 的 `agent_settled` 上，一次 prompt 恰好一次。
- 群消息是事实来源，但三种卡的状态住的地方不同：审批和交接的卡正文只有一个 id，状态在 `approvals` / `handoffs` 行上，只随 `approval_updated` / `handoff_updated` 推；`skill_offer` 的 name 和 steps 在点存之前只在正文里，点完要重推那条 message。
- 交接分两步：`handoff_task` 发报文，目标 `accept_handoff` 之后 `tasks.current_bot_id` 才换人。确认之前活不悬空。
- 多 Bot 群一次回合的调度在 `agent/group-turn.ts`，Bot 之间 @ 的回路守卫也在这里，一个回合里 Bot 最多说 10 条（`BOT_MESSAGE_LIMIT`），计数在内存。
- skill 单向：真相源是控制面 `skills` 表，随 `config` 下发，运行器落成 `<dataDir>/<botId>/skills/<skillId>/SKILL.md`，不回传。`config.skills` 恒带，空也带空数组，运行器靠它整目录对账。
- 电脑代理的启动配置是一行 JSON `{ url, computerId, token, dataDir }`，由调用方写入 stdin；`COMPUTER_ID`、`AGENT_TOKEN`、`CONTROL_PLANE_AGENT_URL`、`BAIZE_DATA_DIR` 不得出现在代理环境中。
- 例行任务就是归属人在单 Bot 群里发了一条消息，运行器和电脑代理不认识它。调度游标用 `UPDATE ... WHERE lastFiredAt = 旧值` 抢，停机不补跑。
- 牌桌就是一个群，用户固定坐 4 号，1 到 3 号是牌友 Bot，老白不入座。`control-plane/src/poker/` 放它的引擎和推进逻辑。`engine.ts` 是不碰库和时钟的纯引擎，一手牌只存种子、起始座位和事件日志，靠 `replay` 还原。`converge.ts` 在桌锁（`store.ts` 的 `withTableLock`）里推进，牌友 60 秒不出牌就兜底，`sweeper.ts` 每秒扫一遍 `playing` 的手。`hint.ts` 管问老白，`leave.ts` 管散场和复盘。牌友和老白的 run 是隐藏 run，触发消息只写给 `visibleTo` 里的人，prompt 不带群历史。设计理由读 `packages/control-plane/README.md` 的「牌桌」一节，运行器一侧读 `packages/bot-runner/README.md` 的「牌桌」。
- 幂等一律靠数据库自己的唯一索引或 `WHERE status = 'pending'`，不先查后写。
- Pi 的四个落盘点（authPath、modelsStorePath、两个 agentDir、sessionDir）都在 `bot-runner/src/bot-session.ts` 钉到 `<dataDir>/<botId>/` 下，`~/.pi` 不能出现任何新文件，`bot-runner/test/runner.test.ts` 最后一条用例钉着这件事。
- Pi 没有 pause。暂停状态住在控制面的 `bots.run_state`，运行器收到 `pause` 只立起这个 Bot 的暂停闸门，在 prompt 入场和每次 `tool_call` 前等它，不 `abort()`。正在跑的工具和模型请求不截断，挂起的审批不失效，期间的新 prompt 留在原来的串行队列里，`resume` 只放开闸门、不重发。
- 画面接管。远程和本机电脑上的登录、Bot 请人接手，都靠把助理 Chrome 的一页实时画面送到网页上给人操作。电脑上的屏是 `computer-agent/src/live-screen.ts`，`present` 只 resolve，结局是 `user`、`caller`、`page_gone`、`broken` 四种。画面帧和人的按键走 `/agent` 与 `/api/live/<liveId>` 上的二进制帧，在串行链之前分流，不进库、发件箱和日志，会话只在电脑内存和控制面中继的内存里。一台电脑同一时刻一个观看者，新的进来旧的以 4101 关。登录在 `computer-agent/src/login.ts`，250ms 查一次、15 分钟收起；接手在 `bot-runner/src/takeover.ts`，借出那一页而不持浏览器锁，同群来了新的用户消息就作废，30 分钟收起。`Page.bringToFront` 只许出现在 `live-screen.ts`，`computer-agent/test/bring-to-front-guard.test.ts` 钉着。设计理由读 `packages/control-plane/README.md` 的「画面面」。
- 云电脑换机与接续。每个 (Bot, 群) 选哪台电脑存在 `group_members.computer_kind`，只有 `agent/computer-choice.ts` 的 `chooseComputer` 写，选过就只认那一台，不在线也不改派。Bot 自己换走运行器的 `switch_computer`，打 `/hub/v1/lane/computer`，控制面 `agent/continuation.ts` 的 `requestSwitch` 在一个事务里改选择并立起 `runs.continue_requested`，拒绝有六种（`SWITCH_REFUSED`），工具回 `terminate: true` 结束这一轮，且必须单独成批。旧 run 收尾后 `dispatch.ts` 起一条 `reason: "continuation"` 的新 run，`placeRun` 在同一事务里用 `takeContinuation` 的条件 UPDATE 认领标记，认领不到就不建，`runs_continues_run_idx` 只兜底。用途、例行和边界只取父链，不回退成别人回合的配置。插话、删 Bot、派不出去、Bot 已不在群里都清掉标记，结局由链尾定。推进点在内存，丢了靠 `server.ts` 每 30 秒的补扫和 hello 补扫；`AgentHub.closing` 立起后不再断链，标记留给重启。云电脑上（`remote` 加 `bwrap`）的 bash 只有要联网、写工作区外，看得出是删、移的，或者 `python -c`、`sh -c` 这类内联代码才问（`relaxIfContained`），系统包管理器直接拒；Mac 只收紧。设计理由读 `packages/control-plane/README.md` 的「派到哪台电脑」和 `packages/bot-runner/README.md` 的「统一闸门和沙箱」「换电脑」。

### 文档在哪

- `README.md`（英文）、`README.zh-CN.md`（中文）对外介绍。`docs/开发.md` 跑起来、环境变量、控制面握手。
- `packages/control-plane/README.md` 路由、审批、交接、例行、skill、牌桌、用量的设计理由，改这些前先读对应一节。
- `packages/bot-runner/README.md` Pi 集成、目录布局、审批拦截、主题任务工具、prompt 拼法、牌桌工具。
- `spec/规格.md` 产品规格 v0.2，方向已转成个人助理，每个对象写了目标和「现在」的差距。`spec/用户故事.md` 按天讲用户怎么用，每期的验收就是走通对应的故事。`spec/原型/个人助理-v4.html` 是可点的交互原型，一次性的，不照着抄代码，prettier 忽略它。
- `plan/开发计划.md` 分期和单元，第四节列了 v0.1 的 M 和 N 单元去哪了。
- `plan/交付补强架构.md` 第 3 期交付补强的目标架构，信封、中枢、租约、MCP 代执行、审批规则、隔离各自怎么做、为什么这么做。改 P3-4 起的单元前先读。
- `research/` 竞品对照，Grok Bot 和个人助理几家。
- `bot-application-prototype/` v0.1 的静态原型，Web 的样式只用它 `_ds/.../tokens` 里的变量。oxlint 和 prettier 都忽略它。

## 与 codex 协作

控制面、运行器、Web 三条线的实现可以派给 Herdr 里的 codex 面板，流程在 `.claude/agents/codex-panel.md`：任务书写 `.audit/briefs/<slug>.md`，报告回 `.audit/reports/<slug>.md`，提交由协调者做。codex 一律用 **GPT-5.6 Solo，推理强度 xhigh**，起面板时显式带参数，不靠本机 `~/.codex/config.toml` 的默认值：

```
herdr agent start <名> --kind codex --pane <pane_id> -- --yolo -m gpt-5.6-sol -c model_reasoning_effort=xhigh
```

面板启动横幅里 `model: gpt-5.6-sol xhigh`、`permissions: YOLO mode` 两行都在才算对。`--yolo` 让 codex 不再为沙箱外命令逐条弹审批。

## 约定

- 根 `tsconfig.base.json` 是唯一编译选项来源，`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 都开着，可省属性和 `undefined` 不是一回事。
- 状态用字面量联合，不用布尔组合。错误在工具里靠抛异常表达，中文文案，Pi 会把它做成 `isError` 工具结果。
- 读消息必须带收件人。`messages.visible_to` 为 null 是全群可见，否则只给数组里的 `Viewer`（用户或某个 Bot），空数组被数据库拒绝。`repo/messages.ts` 的 `listMessages`、`findOwnedMessage`、`messageSeq` 都要必填的 `viewer` 参数并拼上 `messageVisibleTo(viewer)`，用量、今天、项目页、skill、审批、上下文窗口的聚合同样如此。HTTP 一律传 `{ kind: "user" }`，派活拼上下文传被派的 Bot。新写读 `messages` 列表的查询先带 `viewer`。不带 viewer 的读只剩 `test/messages-read-guard.test.ts` 的 `EXCEPTIONS` 里登记的几处，每处写了理由。这个测试扫 `src/` 源码，`repo/messages.ts` 之外直接读 `messages` 的查询，既没在同一条查询链里拼 `messageVisibleTo(viewer)` 又不在白名单里就红。行为由 `test/p3-visible-read.test.ts` 钉着。
- 注释只留代码说不出来的原因。测试断言信息就是文档。
- 控制面测试只通过 HTTP 和两条 WebSocket 碰服务，不直接调路由函数。等异步效果不靠超时，发一条确定会落地的报文，断言它先到。
- Prettier `printWidth` 120，双引号，尾逗号。oxlint 的 `typescript/no-explicit-any` 是 error。
- `spikes/` 是技术验证，不是产品代码。
