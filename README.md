# 白泽 Bot

规格在 spec/规格.md，开发计划在 plan/开发计划.md，原型在 bot-application-prototype/。

## 目录

- `packages/shared` 对象模型、控制面与电脑代理的报文、HTTP API 契约。全部是 zod schema，其他包只从这里引用类型。
- `packages/control-plane` 控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js，迁移用 drizzle-kit。端口 3001。见下面「控制面」。
- `packages/web` Web 客户端。Vite 加 React 18 加 react-router。样式只用 `bot-application-prototype/_ds/.../tokens` 里的变量。端口 5173，`/api` 代理到 3001。
- `packages/computer-agent` 云电脑里的常驻进程。出站 WebSocket 连控制面的 `/agent`。
- `packages/bot-runner` Bot 运行器。用 @earendil-works/pi-coding-agent 的 SDK，每个 Bot 一个 AgentSession。
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

四个对外的面：`/api` 给 Web 客户端，`/api/ws` 推消息，`/agent` 给云电脑里的电脑代理，`/gateway/v1` 是模型网关。四个都在同一个 3001 端口上，WebSocket 由同一个 http server 按路径分流。

一人一台电脑。用户第一次登录时建出 computers 行，状态 creating，同时生成电脑 token 和模型网关 key，库里只存 sha256。电脑代理在 `/agent` 上用 `hello` 报 computerId 加 token，对得上才回 `welcome`，紧接着一条 `config`（该用户的全部 Bot、模型网关地址与 key）。Bot 增删改会重发 `config`。握手就算在线，断开变休眠，同一台电脑新连接顶掉旧连接。

拿电脑 token：

```
pnpm --filter @baize/control-plane seed           # 第一次建账号时打印 AGENT_TOKEN=...
pnpm --filter @baize/control-plane computer-token # 之后重置并重新打印
```

模型网关把电脑代理的请求转到 `UPSTREAM_BASE_URL`，Bearer 换成 `UPSTREAM_API_KEY`，`model` 一律换成 `GATEWAY_MODEL`，流式和非流式都原样透传。电脑那把网关 key 每次 `hello` 换一把，明文只随 `config` 下发一次，控制面不长期留存。

环境变量：

| 名字 | 默认值 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://baize:baize@localhost:5434/baize` | Postgres 连接串 |
| `PORT` | `3001` | 监听端口 |
| `COOKIE_SECURE` | 空 | 设成 `1` 时会话 cookie 带 Secure |
| `PUBLIC_BASE_URL` | 空，用实际监听的地址拼 | 下发给电脑代理的模型网关地址前缀 |
| `GATEWAY_MODEL` | `baize-default` | 网关对外和对上游都用这个模型名 |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | 模型上游 |
| `UPSTREAM_API_KEY` | 空 | 转发给上游的 key |
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

`pnpm check` 跑类型检查、lint 和测试。
