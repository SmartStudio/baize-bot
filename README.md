# 白泽 Bot

规格在 spec/规格.md，开发计划在 plan/开发计划.md，原型在 bot-application-prototype/。

## 目录

- `packages/shared` 对象模型、控制面与电脑代理的报文、HTTP API 契约。全部是 zod schema，其他包只从这里引用类型。
- `packages/control-plane` 控制面。Hono 加 @hono/node-server，PostgreSQL 用 drizzle-orm 加 postgres.js，迁移用 drizzle-kit。端口 3001。
- `packages/web` Web 客户端。Vite 加 React 18 加 react-router。样式只用 `bot-application-prototype/_ds/.../tokens` 里的变量。端口 5173，`/api` 代理到 3001。单跑前端用 `pnpm --filter @baize/web mock` 起假控制面；要连真控制面就先 `docker compose up -d`、`pnpm --filter @baize/control-plane migrate`、`pnpm --filter @baize/control-plane seed`，再 `pnpm dev`。
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

## 跑起来

```
pnpm install
docker compose up -d
pnpm --filter @baize/control-plane migrate
pnpm --filter @baize/control-plane seed
pnpm dev
```

`pnpm check` 跑类型检查、lint 和测试。
