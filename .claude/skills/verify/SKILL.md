---
name: verify
description: 在真浏览器里把白泽 Bot 的 Web 跑起来、点一遍、留截图和录屏。入口一是假控制面加 Web（3317/5377），入口二是真栈（Postgres + 控制面 + Web + 电脑代理）。改了 Web、控制面或运行器，要拿实机截图、录屏交验收，或者要证明一个用户故事在真应用里走得通时用它。
---

# 白泽 Bot 实机验证

所有命令都在 `/Users/zouyanjian/other-try/prepare/baize/baize-bot` 下跑。起停只用 `scripts/stack.sh`，它把每个服务放进自己的进程组，pgid 和日志落在 `.audit/verify-run/<入口>/`，停的时候只杀记下来的组。

```
S=.claude/skills/verify/scripts/stack.sh
$S entry1 up | doctor | down
$S entry2 up [--agent] | agent | doctor | down
```

功能怎么点、点完看什么，在 `features/README.md` 和它列的各个文件里。

## 选入口

- 只改了 Web，或要跑确定的剧本（审批、交接、例行、skill 卡）：入口一。数据是 `packages/web/mock/state.ts` 的预置，Bot 回复是假的，不花钱。
- 要证明控制面、电脑代理、运行器真的串起来：入口二。Bot 回复走 `.env` 里的真模型上游，每条消息都花钱。
- 整条用户故事一口气跑完：`pnpm --filter @baize/e2e acceptance`。它自带临时库、临时端口和假上游，不碰开发库，截图落 `packages/e2e/acceptance/screenshots/step-*.png`。

## 入口一：假控制面加 Web

```
$S entry1 up
```

等价于后台起 `API_PORT=3317 pnpm --filter @baize/web mock` 和 `API_PORT=3317 WEB_PORT=5377 pnpm --filter @baize/web dev`。3317 或 5377 已经有人监听时它拒绝启动，打印占用者，别去杀那个进程：可能是另一个会话在验，也可能是 `pnpm --filter @baize/web test:e2e` 正在跑，它用同一对端口。等对方用完再起。

就绪标志是脚本打出三行「就绪」：`3317/api/health → 200`、`5377/ → 200`、`5377/api/health → 200`。第三行证明 Vite 的 `/api` 代理接到的是 mock。

然后用 Playwright MCP 打开 `http://localhost:5377`（`mcp__plugin_playwright_playwright__browser_navigate`）。mock 的状态在内存里，前一个人点过的会留着。要回到预置状态就 `curl -X POST http://127.0.0.1:3317/api/test/reset`，回 204。这个接口只有 mock 有。

用完：

```
$S entry1 down
```

## 入口二：真栈

Postgres 容器 `baize-postgres` 挂在另一个 compose 项目（`control-plane`，来自 `.worktrees/control-plane`）下，数据在卷 `control-plane_baize-pgdata`。仓库的 `docker-compose.yml` 写死项目名 `baize`、容器名 `baize-postgres`，在这里 `docker compose up -d` 会撞容器名。更糟的是，把旧容器删掉再 up 会挂上另一个卷 `baize_baize-pgdata`，开发账号和数据就「不见了」。所以一律 `docker start baize-postgres`，不删容器，不 `docker compose down`。

`pnpm dev` 走 `scripts/dev.mjs`，它第一步就是 `docker compose up -d`，失败只打一行字接着起服务。`stack.sh` 绕过它，分别起：

```
$S entry2 up            # 控制面 + Web
$S entry2 up --agent    # 再加电脑代理，电脑凭据取 .env
$S entry2 agent         # 控制面已起，只补电脑代理，shell 里的电脑凭据优先于 .env
```

它做的事：

1. `docker start baize-postgres`，等 `pg_isready`。
2. 控制面：把 `.env` 按 dev.mjs 的规则导出（只认 `KEY=value`，shell 里已有的优先），跑 `pnpm --filter @baize/control-plane start`。端口取 `.env` 的 `PORT`，没写就是 3001。控制面启动要 `CREDENTIALS_KEY` 和 `TOOL_SECRET_KEY`，shell 和 `.env` 都没有时脚本各生成一把存进 `.audit/verify-run/credentials.key`、`.audit/verify-run/tool-secret.key`，之后每次都用它们。挂 GitHub、X 账号用 `stack.sh entry2 account-add --owner … --platform github --handle … --token …`，走的是同一把钥匙；实机发布把 `GITHUB_API_BASE_URL`、`X_API_BASE_URL` 指到假平台，不用真令牌。
3. Web：`API_PORT=<.env 的 API_PORT，没写取 PORT> WEB_PORT=5173 pnpm --filter @baize/web dev`。
4. 加 `--agent` 或跑 `entry2 agent` 时起电脑代理：`pnpm --filter @baize/computer-agent exec tsx src/main.ts`。`COMPUTER_ID`、`AGENT_TOKEN`、`CONTROL_PLANE_AGENT_URL`、`BAIZE_DATA_DIR` 每个先取 shell 里的值，没有再取 `.env`，拼成一行 JSON `{ url, computerId, token, dataDir }`，经 `.audit/verify-run/entry2/computer-agent.stdin` 这个 fifo 写进代理的 stdin。代理环境里去掉 `.env` 的所有键和这四个键，和 dev.mjs 一样，token 和上游密钥都不进 Bot 的 bash。环境里只要有 `AGENT_TOKEN`（空串也算），代理就拒绝启动。stdin 关闭时代理自己停机。脚本等到代理日志里出现 `{"type":"online"}` 这一整行就算连上。这行是代理在 stdout 写的状态行（shared 的 `AgentStatusLine`），控制面接纳后就写，桌面端也认它；随后几毫秒内日志里会出现「收到第 N 代 config」。日志措辞会变，别拿它判就绪。

就绪标志：控制面 `/api/bots` 回 401，经 Web 代理的 `5173/api/bots` 也回 401，body 是 `{"error":"请先登录"}`。

`up` 和 `doctor` 都会拿 `packages/control-plane/drizzle/*.sql` 对一遍库里的 `_migrations`，打出缺的迁移。缺迁移时控制面照样回 401，但新接口会在运行时出错。应用迁移要跑 `pnpm --filter @baize/control-plane migrate`，这是写开发库，先问调用方。

开发库落后于分支上的迁移时（比如 0009 删列还没经用户同意），实机验证改用单独的验证库，不碰开发库。shell 里的 `DATABASE_URL` 优先于 `.env`，`stack.sh` 的迁移检查也跟着它走：

```
V=postgres://baize:baize@localhost:5434/baize_verify
docker exec baize-postgres psql -U baize -d postgres -c "create database baize_verify"   # 只第一次
DATABASE_URL=$V pnpm --filter @baize/control-plane migrate
DATABASE_URL=$V $S entry2 up
```

验证库里没有 seed 账号，照下面的办法注册一个。

3001 在这台机器上被 Obsidian 占着（只绑 127.0.0.1），Vite 代理打的正是 `127.0.0.1:3001`。所以 `.env` 把控制面挪到了 3101，`PORT`、`API_PORT`、`CONTROL_PLANE_AGENT_URL` 三处一起改。`stack.sh` 起之前查端口占用，占了就拒绝。

账号：要登录入口二时默认新注册一个，邮箱带时间戳，比如 `verify-<yyyymmddHHMM>@example.com`。注册写的是开发库，账号删不掉，所以邮箱每次换新的。

1. 注册。`entry2 up` 之后在 `http://localhost:5173/register` 填表，或者直接调接口，回 201 并种下会话 cookie：

   ```
   J=.audit/verify-run/entry2/cookie.txt
   curl -s -c $J -H 'content-type: application/json' \
     -d '{"email":"verify-<时间戳>@example.com","password":"<密码>","name":"验证"}' \
     http://127.0.0.1:3101/api/register
   ```

   在网页上注册的，用同样的邮箱密码 `POST /api/auth/login` 拿 cookie。
2. 拿电脑凭据。`curl -s -b $J -X POST http://127.0.0.1:3101/api/computers/local` 回 `{"computerId":…,"token":…}`，token 明文只在这一次响应里。每调一次都换一把新 token，旧 token 再握手就不被接纳，所以一次代理运行只调一次。
3. 起代理。把这两个值交给 `entry2 agent`，不写进 `.env`：

   ```
   COMPUTER_ID=<computerId> AGENT_TOKEN=<token> $S entry2 agent
   ```

新账号没有 Bot，侧栏是空的，要对话先在 Web 里建一个，或者带 cookie `POST /api/bots`。

备选是 seed 的开发账号，邮箱 `chen@baize.dev`，密码 `baize-dev`，库里已有 Bot 和群。它的 `COMPUTER_ID`、`AGENT_TOKEN` 在 `.env` 里，`entry2 up --agent` 直接用。账号已存在时不要再跑 seed。token 要重置用 `pnpm --filter @baize/control-plane computer-token`，重置后把新值写回 `.env`。对 seed 账号调 `/api/computers/local` 也会换 token，`.env` 里那把随之失效。

账号、token、密码只留在 shell 和 `.audit/verify-run/` 里，不写进报告和截图文件名。上面的端口 3101 是本机 `.env` 的 `PORT`，换机器按 `.env` 改。

入口二的写操作：控制面起着时，例行调度器会按库里的例行任务触发，每小时扫一次超时的审批和交接；电脑代理握手会把 `computers` 行改成 online 并换一把网关 key，断开后回 sleeping。只要证明「能起来」就只起控制面和 Web，别带 `--agent`，也别登录。

用完：

```
$S entry2 down
```

它不停 Postgres。容器本来就开着，由别人管。

## Doctor

任何时候觉得不对，先跑：

```
$S entry1 doctor
$S entry2 doctor
```

每个服务一行：pgid 文件在、进程组活着、端口的监听者在这个进程组里。最后一行是代理探针。出现 `✗` 就先看 `.audit/verify-run/<入口>/<服务>.log`，别驱动一个不是自己起的实例。

## 驱动

用 Playwright MCP。`target` 直接写 `[data-testid=...]` 选择器，比快照里的 ref 稳，ref 每次快照都会变。本仓库的界面几乎每个可点的东西都有 `data-testid`，列表项另带 `data-bot-name`、`data-group-title`、`data-tool-name` 这类属性，卡片带 `data-status`。选择器去 `packages/web/e2e/app.spec.ts` 里找，那是现成的剧本。

- 输入框用 `browser_fill_form` 或 `browser_type`。
- 等状态用 `browser_wait_for` 的 `text`，等的是页面上会出现的中文，不是固定秒数。
- 读状态用 `browser_snapshot`，要属性值（`data-status`）用 `browser_evaluate`。
- 窄屏用 `browser_resize` 到 375 宽。

## 截图

调用方会给一个路径，形如 `.audit/v1/<单元>/<名>.png`。`browser_take_screenshot` 的 `filename` 写绝对路径，`scale` 用 `css`。`.audit/` 在 `.gitignore` 里，截图不进提交。`packages/web/e2e/screenshots/` 是测试产物，工作区里它们变了也不提交。

截图前后的检查单：

1. 页面稳定。`browser_wait_for` 等到这一步的关键文字出现，比如登录页等「欢迎回来」，主窗口等侧栏里的 Bot 名。流式回复要等花费卡出现（它最后到），不是等第一个字。
2. 没有加载中的请求。`browser_network_requests` 看一眼 `/api/` 下有没有还没回来的。登录页上 `/api/me` 401 和 `favicon.ico` 404 是正常的。
3. 控制台没有新的红字。MCP 每次操作都报 `Console: N errors`，数字涨了就去看它给的 console 日志。
4. 截完用 Read 打开那张 png，确认不是白屏，不是登录页（除非本来就要截登录页），要证明的那张卡或那行字在图里。
5. 证明一个动作，截动作前和动作后两张，再加一个不靠这张图的旁证：入口一 `curl` mock 的接口，入口二 `curl` 带 cookie 的 `/api/...`。

## 录屏

Playwright MCP 没有录屏。用 `scripts/record.mjs`，它借 `packages/web` 装的 `@playwright/test` 开一个带 `recordVideo` 的浏览器，没下 Playwright 自带 chromium 就用本机 Chrome：

```
node .claude/skills/verify/scripts/record.mjs http://127.0.0.1:5377 .audit/v1/<单元>/<名>.webm [步骤.mjs]
```

不给步骤文件就只录登录进主窗口。步骤文件是个 ES 模块：

```js
export default async (page, { login }) => {
  await login(page);
  await page.locator('[data-testid=bot-item][data-bot-name="小销"]').click();
  await page.getByTestId("composer-input").fill("把报价单发给 Lisa");
  await page.getByTestId("composer-send").click();
  await page.getByTestId("approval-card").waitFor();
  await page.waitForTimeout(1_000);
};
```

步骤文件放 `.audit/verify-run/` 下，不进仓库。录完用 `ffmpeg -sseof -1 -i <名>.webm -frames:v 1 <帧>.png` 抽最后一帧，Read 看一眼。macOS 的 `screencapture -v` 录的是整块屏幕，要屏幕录制权限，不用它。

## 收尾

- `$S entry1 down` 或 `$S entry2 down`，然后 `lsof -nP -iTCP:3317 -iTCP:5377 -sTCP:LISTEN`（入口二换成控制面端口和 5173）确认没人监听。
- Playwright MCP 那边 `browser_close`。
- 截图和视频留在 `.audit/v1/<单元>/`，收尾不删。`.audit/verify-run/` 里的日志和 pgid 是运行状态，可以删。
