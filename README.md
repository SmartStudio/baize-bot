# 白泽 Bot

产品方向是个人助理。规格在 spec/规格.md，用户故事在 spec/用户故事.md，交互原型在 spec/原型/个人助理-v4.html，开发计划在 plan/开发计划.md，竞品对照在 research/。下面描述的是主干现在的样子，按 v0.1 的企业版做的，要改成什么样看规格。bot-application-prototype/ 是 v0.1 的静态原型，Web 的样式变量还从它取。

## 目录

- `packages/shared` 对象模型、控制面与电脑代理的报文、HTTP API 契约。全部是 zod schema，其他包只从这里引用类型。
- `packages/control-plane` 控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js，迁移用 drizzle-kit。端口 3001。见下面「控制面」。
- `packages/web` Web 客户端。Vite 加 React 18 加 react-router。样式只用 `bot-application-prototype/_ds/.../tokens` 里的变量。端口 5173，`/api` 代理到 3001。单跑前端用 `pnpm --filter @baize/web mock` 起假控制面；要连真控制面就先 `docker compose up -d`、`pnpm --filter @baize/control-plane migrate`、`pnpm --filter @baize/control-plane seed`，再 `pnpm dev`。侧栏分两段：Bot 是一对一的群，群是多 Bot 的群。加号菜单里「新建 Bot」开前者，「建群」选 2 到 6 个自己的 Bot、写清主题和截止，开后者。Bot 设置抽屉分「设置」「例行」「会做的活」三页：例行页列出这个 Bot 的例行任务和下次什么时候跑，编辑器写每次运行做什么、加触发器（每天、工作日、每小时、每分钟这几个预设，或者一个 webhook 地址）、挑失败时停下告诉你还是下次再试，能「试跑一次」，下面是最近 20 条运行记录。群顶部钉着任务卡，编号由系统发（`T-2482` 这种），上面是清单、截止和当前经手，清单勾一下就是一次 `PATCH /api/tasks/:id`。群里打 `@` 弹成员名单，只有被 @ 的那个 Bot 接活并维护清单，没 @ 谁就落到当前经手身上。Bot 之间交接在群里是一张交接报文卡，写清做了什么、没做什么、下一步和清单指到哪一项，目标 Bot 确认之前卡上是「等某某确认」，侧栏记一笔「等 Bot 确认 N」；这跟「等你点头」是两本账，交接不用你动手，也不弹通知。确认之后任务卡的当前经手和任务详情的经手记录一起跟着换。会做的活页列出这个 Bot 的 skill，一行是名字、来源和用过几次，点进去是编号步骤，能改一改、删掉、复制给自己别的 Bot，也能「教它一个」，名称加一行一步的步骤。群里 Bot 干完一趟活会问「存成 skill「名」？」，那是一张带「存」「不存」两个按钮的卡，点完卡上留下「已存」或「没存」。输入框打 `/` 弹这个群里 Bot 会做的活，选中就插进去一段 `/名 `。
- `packages/computer-agent` 电脑上的常驻进程。启动配置 `{ url, computerId, token, dataDir }` 作为一行 JSON 经 stdin 传入，出站 WebSocket 连控制面的 `/agent`；这四项不放进代理环境。按 v0.1 规格的结论，它平时跟 App 一起装在用户自己的 Mac 上，另有一份跑在公司那台过夜机上。
- `packages/bot-runner` Bot 运行器。用 @earendil-works/pi-coding-agent 的 SDK，每个 Bot 一个 AgentSession。
- `packages/e2e` 端到端联调。真控制面、真电脑代理、真运行器一起跑，只有模型上游是假的。见下面「端到端」。
- `spikes/` 技术验证，不是产品代码。

## 约定

- TypeScript strict，ESM，Node 22 以上。根 tsconfig.base.json 是唯一的编译选项来源。
- 测试用 vitest。Web 的端到端用 @playwright/test。
- 外部输入在边界用 shared 的 schema parse，内部函数信任类型。
- 状态用字面量联合，不用布尔组合。
- 注释只留代码说不出来的原因。测试的断言信息就是文档。
- 密码哈希用 Node 自带的 crypto.scrypt。会话是 httpOnly cookie `baize_session`。
- 开发账号 chen@baize.dev，密码 baize-dev，由 control-plane 的 seed 脚本创建。
- PostgreSQL 用 docker compose 起在 5434 端口，库名 baize，用户和密码都是 baize。

## 控制面

四个对外的面：`/api` 给 Web 客户端，`/api/ws` 推消息，`/agent` 给电脑上的电脑代理，`/gateway/v1` 是模型网关。四个都在同一个 3001 端口上，WebSocket 由同一个 http server 按路径分流。

一人一台电脑。用户第一次登录时建出 computers 行，状态 creating，同时生成电脑 token 和模型网关 key，库里只存 sha256。电脑代理在 `/agent` 上用 `hello` 报 computerId 加 token，对得上才回 `welcome`，紧接着一条 `config`（该用户的全部 Bot、模型网关地址与 key）。Bot 增删改会重发 `config`。握手就算在线，断开变休眠，同一台电脑新连接顶掉旧连接。

拿电脑 token：

```
pnpm --filter @baize/control-plane seed           # 第一次建账号时打印 AGENT_TOKEN=...
pnpm --filter @baize/control-plane computer-token # 重置并打印本机 token
pnpm --filter @baize/control-plane computer-token -- remote [邮箱] # 创建或重置远程电脑 token
```

模型网关把电脑代理的请求转到 `UPSTREAM_BASE_URL`，Bearer 换成 `UPSTREAM_API_KEY`。电脑代理只可请求 `baize:plan` 和 `baize:fast`，网关分别映射到 `GATEWAY_MODELS` 的真实上游模型名；`GATEWAY_MODELS` 非空时优先使用它，同时设置两个变量会告警；未设置或仅含空白时两个用途都回退到 `GATEWAY_MODEL`，两者都未设置则使用开发默认值。请求除 `model` 外原样转发；响应（非流式 JSON 与 SSE data JSON）只把顶层 `model` 改回 baize 别名，其他内容透传。`image_url` 内容也不改写，请求体上限为 20 MiB。电脑那把网关 key 每次 `hello` 换一把，明文只随 `config` 下发一次，控制面不长期留存。

Bot 走到要点头的工具时群里出一张审批卡，点按钮或在群里回「批准」「拒绝」都算数，详见 `packages/control-plane/README.md`。

环境变量：

| 名字 | 默认值 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://baize:baize@localhost:5434/baize` | Postgres 连接串 |
| `PORT` | `3001` | 监听端口 |
| `COOKIE_SECURE` | 空 | 设成 `1` 时会话 cookie 带 Secure |
| `PUBLIC_BASE_URL` | 空，用实际监听的地址拼 | 下发给电脑代理的模型网关地址前缀 |
| `GATEWAY_MODEL` | `baize-default` | 兼容旧配置；未设置 `GATEWAY_MODELS` 时同时作为 plan 和 fast 的上游模型名 |
| `GATEWAY_MODELS` | 空，回退 `GATEWAY_MODEL` | 按 `plan=模型,fast=模型` 配置两个用途；设置后必须同时包含 plan 和 fast |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | 模型上游 |
| `UPSTREAM_API_KEY` | 空 | 转发给上游的 key，只能是可打印 ASCII，否则启动时失败 |
| `PRICE_INPUT_PER_M` | `0` | 每百万输入 token 的价，用来折算 run 的花费 |
| `PRICE_OUTPUT_PER_M` | `0` | 每百万输出 token 的价 |

## 跑起来

```
pnpm install
docker compose up -d
pnpm --filter @baize/control-plane migrate
pnpm --filter @baize/control-plane seed
pnpm dev
```

`pnpm dev` 起控制面和 Web。要连电脑代理，就把 seed 打印的 `COMPUTER_ID=` 和 `AGENT_TOKEN=` 填进根目录的 `.env` 或 shell，再跑 `pnpm dev --agent`。脚本会把 `{ url, computerId, token, dataDir }` 写入代理 stdin，代理环境不会带 `COMPUTER_ID`、`AGENT_TOKEN`、`CONTROL_PLANE_AGENT_URL`、`BAIZE_DATA_DIR`。`pnpm dev --agent` 下代理不热重载。

`pnpm check` 跑类型检查、lint 和测试。

## 端到端

`packages/e2e` 里一条用例走完整条链路：Web 发的那个 HTTP 请求进控制面，控制面派活给电脑代理，代理里的运行器用 Pi 跑一次 `ls`，结果经模型网关回到群里，最后落一张花费卡和一行 `runs`。只有模型上游是假的，其余都是产品代码。

```
docker compose up -d
pnpm --filter @baize/e2e test
```

它自己建一个临时库、临时 Bot 数据目录、系统分配的端口，跑完都拆掉，所以重复跑和与 `pnpm dev` 并行跑都不打架。用例最后会打印从 POST 到第一条 `message_delta` 的毫秒数，这是「一句话到 Bot 第一个字」的基线。
