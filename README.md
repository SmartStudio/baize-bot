# 白泽 Bot

产品方向是个人助理。规格在 spec/规格.md，用户故事在 spec/用户故事.md，交互原型在 spec/原型/个人助理-v4.html，开发计划在 plan/开发计划.md，竞品对照在 research/。下面描述的是主干现在的样子。2026-10-13 定下的交付补强还没做，目标架构在 plan/交付补强架构.md。bot-application-prototype/ 是 v0.1 的静态原型，Web 的样式变量还从它取。

## 目录

- `packages/shared` 对象模型、控制面与电脑代理的报文、HTTP API 契约。全部是 zod schema，其他包只从这里引用类型。
- `packages/control-plane` 控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js，迁移用 drizzle-kit。端口 3001。见下面「控制面」。
- `packages/web` Web 客户端。Vite 加 React 18 加 react-router。样式只用 `bot-application-prototype/_ds/.../tokens` 里的变量。端口 5173，`/api` 代理到 3001。单跑前端用 `pnpm --filter @baize/web mock` 起假控制面；要连真控制面就先 `docker compose up -d`、`pnpm --filter @baize/control-plane migrate`、`pnpm --filter @baize/control-plane seed`，再 `pnpm dev`。侧栏分两段：Bot 是一对一的群，群是多 Bot 的群。加号菜单里「新建 Bot」开前者，「建群」选 2 到 6 个自己的 Bot、写清主题和截止，开后者。Bot 页右侧设置栏只放设置，没有标签页。例行页列出这个 Bot 的例行任务和下次什么时候跑，编辑器写每次运行做什么、加触发器（每天、工作日、每小时、每分钟这几个预设，或者一个 webhook 地址）、挑失败时停下告诉你还是下次再试，能「试跑一次」，下面是最近 20 条运行记录。群顶部钉着任务卡，编号由系统发（`T-2482` 这种），上面是清单、截止和当前经手，清单勾一下就是一次 `PATCH /api/tasks/:id`。群里打 `@` 弹成员名单，只有被 @ 的那个 Bot 接活并维护清单，没 @ 谁就落到当前经手身上。Bot 之间交接在群里是一张交接报文卡，写清做了什么、没做什么、下一步和清单指到哪一项，目标 Bot 确认之前卡上是「等某某确认」，侧栏记一笔「等 Bot 确认 N」；这跟「等你点头」是两本账，交接不用你动手，也不弹通知。确认之后任务卡的当前经手和任务详情的经手记录一起跟着换。技能没有配置入口，Bot 页头「它知道的」里每条能点开看编号步骤、来源和用过几次，加、改、删都跟 Bot 在对话里说。Bot 干完一趟同类的活会问「存成技能「名」？」，让它去装某类技能时它找公开的 SKILL.md 改写成中文步骤，出一张「从 github.com 装技能「名」？」的卡，带原链接；说改或删哪个技能，它出一张改或删的卡。卡上点了才生效，点完卡上留下「已存」「已改」「已删」或没要的结论。输入框打 `/` 弹这个群里 Bot 会做的活，选中就插进去一段 `/名 `。
- `packages/computer-agent` 电脑上的常驻进程。启动配置 `{ url, computerId, token, dataDir }` 作为一行 JSON 经 stdin 传入，出站 WebSocket 连控制面的 `/agent`；这四项不放进代理环境。它平时跟桌面 App 一起装在用户自己的 Mac 上，远程电脑（Linux 容器）上跑另一份。
- `packages/bot-runner` Bot 运行器。用 @earendil-works/pi-coding-agent 的 SDK，每个 Bot 每个群一份 Pi 会话。
- `packages/desktop` 桌面 App，Electron 壳。起本机电脑代理，启动配置经 stdin 交给它。
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

四个对外的面：`/api` 给 Web 客户端，`/api/ws` 推消息，`/agent` 给电脑上的电脑代理，`/gateway/v1` 是模型网关。四个都在同一个 3001 端口上，WebSocket 由同一个 http server 按路径分流。电脑代理还要打同端口上的 `/hub/v1`、`/mcp-proxy`、`/accounts-proxy`，和 `/gateway/v1` 合称数据面。

每人至多两台电脑，本机（local）和远程（remote）各一台，`computers` 在 `(owner_id, kind)` 上唯一。注册或登录时建出本机那一行，状态 creating，同时生成电脑 token 和模型网关 key，库里只存 sha256。电脑代理在 `/agent` 上用 `hello` 报 computerId 加 token，对得上才回 `welcome`，紧接着一条 `config`（该用户的全部 Bot、数据面地址与网关 key，不带模型名）。`hello` 里还带 `controlOrigin`，是代理连 `/agent` 那个地址的源（`ws` 换 `http`，`wss` 换 `https`），四个数据面地址只拼在它上面，不看控制面自己的配置，也不读 `Host` 头，所以经反向代理连进来的电脑拿到的是反代的地址。协议号和下限都是 4，低于 4 用 4003 关；协议 4 的 `hello` 缺 `controlOrigin` 或格式不对用 4001 关。Bot 增删改会重发 `config`，每条 `config` 带这条连接内递增的 `generation`，代理丢掉比已应用的旧的，回执 `config_applied` 带同一个数。控制面和电脑代理按同一个版本一起升，不带代际的旧回执会被丢掉。握手就算在线，断开或 45 秒收不到任何报文就变休眠，同一台电脑新连接用 4000 顶掉旧连接。

App 通过 `POST /api/computers/local` 配对本机，无请求体或空对象按未确认处理。已有本机连上过（`lastSeenAt` 非空或此刻在线）时回 409 和 `{ error, computer }`，原 token 和连接继续有效；用户确认后带 `{ "confirmDisplace": true }` 再请求，才轮换 token 并用 4004 关闭旧本机。旧 token 再 hello 也收到 4004，电脑号不存在或 hello 不合法仍是 4001。代理收到 4004 输出一行 `{"type":"displaced"}`，清理资源、停止重连；stdout 的上线行和顶号行统一由 shared 的 `AgentStatusLine` 定义。其他关闭码仍按退避重连。桌面端确认弹框与顶号展示由后续 P3-15b 接入。

拿电脑 token：

```
pnpm --filter @baize/control-plane seed           # 第一次建账号时打印 AGENT_TOKEN=...
pnpm --filter @baize/control-plane computer-token # 重置并打印本机 token
pnpm --filter @baize/control-plane computer-token -- remote [邮箱] # 创建或重置远程电脑 token
```

模型网关把电脑代理的请求转到 `UPSTREAM_BASE_URL`，Bearer 换成 `UPSTREAM_API_KEY`。电脑代理只可请求 `baize:plan` 和 `baize:fast`（shared 的 `gatewayAlias(purpose)`），网关分别映射到 `GATEWAY_MODELS` 的真实上游模型名；`GATEWAY_MODELS` 非空时优先使用它，同时设置两个变量会告警；未设置或仅含空白时两个用途都回退到 `GATEWAY_MODEL`，两者都未设置则使用开发默认值。请求除 `model` 外原样转发；响应（非流式 JSON 与 SSE data JSON）只把顶层 `model` 改回 baize 别名，其他内容透传。`image_url` 内容也不改写，请求体上限为 20 MiB。电脑那把网关 key 每次 `hello` 换一把，明文只随 `config` 下发一次，控制面不长期留存。

Bot 走到要点头的工具时群里出一张审批卡，点按钮或在群里回「批准」「拒绝」都算数，详见 `packages/control-plane/README.md`。

用户有本机和远程电脑两台时，在对话里说「用云电脑」，Bot 就调 `switch_computer` 把这个群换到远程电脑，这一轮在那边接着做，也可以点标题栏的电脑按钮选。哪些命令会弹审批卡，两台电脑不一样。远程电脑上，命令在 bubblewrap 里跑，只有要联网、写工作区外、看得出是删或移的，或者 `python -c`、`node -e`、`sh -c` 这类内联代码才问，其余直接跑。Mac 上只收紧不放宽。面向用户的说法在 [docs/上手.md](docs/上手.md) 的「让 Bot 换到云电脑上做」和「哪些命令会先问你」，实现在 `packages/control-plane/README.md` 的「派到哪台电脑」和 `packages/bot-runner/README.md` 的「统一闸门和沙箱」「换电脑」。

环境变量：

| 名字 | 默认值 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://baize:baize@localhost:5434/baize` | Postgres 连接串 |
| `PORT` | `3001` | 监听端口 |
| `COOKIE_SECURE` | 空 | 设成 `1` 时会话 cookie 带 Secure |
| `PUBLIC_BASE_URL` | 空，用实际监听的地址拼 | 只在没设 `WEB_BASE_URL` 时给 OAuth 回调当前缀。电脑拿到的数据面地址不看它，看代理自报的 `controlOrigin` |
| `GATEWAY_MODEL` | `baize-default` | 兼容旧配置；未设置 `GATEWAY_MODELS` 时同时作为 plan 和 fast 的上游模型名 |
| `GATEWAY_MODELS` | 空，回退 `GATEWAY_MODEL` | 按 `plan=模型,fast=模型` 配置两个用途；设置后必须同时包含 plan 和 fast |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | 模型上游 |
| `UPSTREAM_API_KEY` | 空 | 转发给上游的 key，只能是可打印 ASCII，否则启动时失败 |
| `PRICE_INPUT_PER_M` | `0` | 每百万输入 token 的价，用来折算 run 的花费 |
| `PRICE_OUTPUT_PER_M` | `0` | 每百万输出 token 的价 |
| `TOOL_SECRET_KEY` | 开发密钥，启动时告警 | 加密工具连接凭据的钥匙，64 位十六进制，用 `openssl rand -hex 32` 生成。设了但格式不对（包括空值）启动失败；换了钥匙之前存的工具凭据就解不开。部署必须设 |
| `CREDENTIALS_KEY` | 无，必填 | 加密账号令牌的钥匙，32 字节 base64，用 `openssl rand -base64 32` 生成。缺了或长度不对启动失败；换了钥匙之前存的令牌就解不开 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | 发 GitHub 草稿打的接口根地址，验证时指到假 GitHub |
| `X_API_BASE_URL` | `https://api.x.com` | 发 X 草稿打的接口根地址，X 的令牌端点也在它下面 |
| `WEB_BASE_URL` | 空，用 `PUBLIC_BASE_URL` | 浏览器打开 Web 的地址，OAuth 回调 `<它>/api/oauth/github/callback`、`.../x/callback` 拼在它上面 |
| `GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET` | 空 | GitHub App 的 client id 和 secret，要一起设；不设则账号页连 GitHub 回 503 |
| `X_CLIENT_ID`、`X_CLIENT_SECRET` | 空 | X OAuth 2.0 应用；公共客户端只设 id，机密客户端再设 secret；不设 id 则连 X 回 503 |
| `GITHUB_OAUTH_BASE_URL` | `https://github.com` | GitHub 授权页和令牌端点的根地址，验证时指到假 GitHub |
| `X_OAUTH_BASE_URL` | `https://x.com` | X 授权页的根地址 |

GitHub、X 账号在账号页走 OAuth 连。开发时手里有令牌想跳过授权页，也可以用脚本挂上，令牌加密存进库里（没有刷新令牌，过期了只能再跑一次）：`pnpm --silent --filter @baize/control-plane account-add -- --owner <邮箱> --platform github --handle <名> --token <PAT>`，可选 `--tier`。不带 `--silent` 时 pnpm 会把整条命令连令牌一起回显到终端。

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
