# 部署到 Ubuntu 服务器

这份说明给要把控制面和远程电脑跑到一台 Ubuntu 服务器上的工程师。compose 怎么起、启动文件怎么放、seccomp 和 AppArmor 两项放宽、数据卷在哪，都写在 [`remote/README.md`](remote/README.md)，这里不重复，只补那份没写或没定的事：镜像缺的包、Node 版本、AppArmor 和 bwrap 的探测、`.env` 全清单、Caddy 托管 Web、迁移前备份、升级顺序、给别人开账号。

**验证状态。** 整份说明没有一步在 Ubuntu 真机上跑过。下文凡是要在服务器上执行的命令都是「未在真机验证」，事实部分都标了代码出处，出处里的行号以提交 `8f0955d` 为准。

## 一台服务器上有什么

```
浏览器 ──https──▶ Caddy :443 ──┬─ /api、/api/ws ─────────▶ 控制面 127.0.0.1:3201（容器里 3001）
                               ├─ /agent（本机电脑代理）──▶ 同上
                               ├─ /gateway/v1、/hub/v1、/mcp-proxy、/accounts-proxy（本机电脑代理的数据面）──▶ 同上
                               └─ 其余路径 ──▶ /srv/baize-web 里 Web 的静态文件
compose 网络：postgres、migrate（一次性）、control-plane、remote-computer
```

控制面不托管 Web 的静态文件（`remote/README.md:14`），compose 里也没有 Web，所以要另外起一个反向代理。

## Node 版本

- 仓库要求 `node >=22.19.0`（`package.json:20-22`）。运行器钉的 Pi `@earendil-works/pi-coding-agent@1.1.0`（`packages/bot-runner/package.json:17`）自己的 `engines` 也是 `>=22.19.0`。
- 三个镜像阶段都用浮动标签 `node:22-bookworm-slim`（`remote/Dockerfile:3`、`:22`、`:31`），构建当天拉到哪个 22.x 就是哪个，仓库里没有钉小版本。
- 构建完核一下实际版本，低于 22.19.0 就换一个钉死的标签再构建（未在真机验证）：

```
docker run --rm --entrypoint node baize-control-plane:remote --version
docker run --rm --entrypoint node baize-remote-computer:remote --version
```

- 宿主机只在构建 Web 时需要 Node（见「Caddy 托管 Web」），版本要求同上，另需 `corepack enable` 拿到 `pnpm@9.15.9`（`package.json:4`）。Web 也可以在开发机上构建好再拷过去。

## 镜像依赖

远程电脑镜像的 apt 列表在 `remote/Dockerfile:32-34`，装的是 `chromium xvfb xauth bubblewrap procps curl ca-certificates fonts-noto-cjk git python3`。

`git` 和 `python3` 是给 Bot 的 bash 用的。运行器自己不调它们，但命令分类专门处理 `git`（`packages/bot-runner/src/gate.ts:514`），`python3` 在不透明命令表里（`gate.ts:89`）。这两个包是后补的，补之前构建的旧镜像里没有，要重建 `remote-computer`。

控制面镜像（`remote/Dockerfile:22-27`）不装任何 apt 包，它只跑 Node。

## AppArmor 与 bwrap 探测

远程电脑上 Bot 的 bash 是否进沙箱，由运行器在进程里探一次决定（`packages/bot-runner/src/sandbox.ts:110-124`）：

- Linux 上跑 `bwrap --ro-bind / / --unshare-net --unshare-pid true`，退出码 0 就用 bwrap 沙箱。
- 跑不通就退成 `none`，日志里留一行「bubblewrap 起不来（原因），这台电脑没有 bash 沙箱，Bot 的每条 bash 都要问」。退成 `none` 后每条 bash 都弹审批（`packages/bot-runner/README.md:74`），只读例行里 bash 一律拒绝（`packages/bot-runner/README.md:143`）。服务不会因此起不来，所以探测失败不显眼，要主动查。

部署后按下面的顺序查（未在真机验证）。命令和运行器的探测参数一字不差，和 `remote/README.md:109-113` 那条相同：

```
cd deploy/remote
sysctl kernel.apparmor_restrict_unprivileged_userns        # 宿主机上看，Ubuntu 23.10 以后默认是 1
docker compose exec remote-computer bwrap --ro-bind / / --unshare-net --unshare-pid true && echo 能用
docker compose logs remote-computer | grep 'bubblewrap 起不来'   # 应当没有输出
```

不通的两条出路（宿主机 sysctl 设 0，或给 bwrap 配宿主机 AppArmor profile）见 `remote/README.md:117`。

`apparmor=unconfined`（`remote/docker-compose.yml:87`）是按 `docker-default` profile 的内容推断加上的，开发时用的 OrbStack 没有 AppArmor，没实测过它是否必要（`remote/README.md:107`）。在带 AppArmor 的 Ubuntu 上可以这样判断它能不能去（未在真机验证）：

1. 先按上面的命令确认现状能用。
2. 临时去掉 `docker-compose.yml` 第 87 行，`docker compose up -d --force-recreate remote-computer`，再跑一遍探测。
3. 还能用，说明这条放宽可以去掉。报权限错误，说明它必要，恢复第 87 行。
4. 不论结果，重建容器后都要重跑 `./put-launch.sh`（`remote/README.md:92`）。

## `.env` 清单

compose 读 `deploy/remote/.env`（`remote/README.md:41`）。控制面读哪些变量以 `packages/control-plane/src/env.ts` 为准，src 里只有这一个文件读 `process.env`（`env.ts:48-51`）。

控制面容器只拿到 `remote/docker-compose.yml:41-68` 列出的变量，写进 `.env` 但没列在那里的变量到不了控制面。env.ts 读的变量里，只有旧变量 `GATEWAY_MODEL` 和 `PUBLIC_BASE_URL` 没列，原因见最后一张表。

**compose 传给控制面的：**

| 变量 | 必填 | compose 不设时 | 说明 |
| --- | --- | --- | --- |
| `UPSTREAM_BASE_URL` | 是 | 报错不起 | OpenAI 兼容的上游地址（`env.ts:94`） |
| `UPSTREAM_API_KEY` | 是 | 报错不起 | 只能是可打印 ASCII，否则控制面启动时抛错（`env.ts:170-176`） |
| `GATEWAY_MODELS` | 否 | `plan=baize-default,fast=baize-default` | 格式 `plan=模型,fast=模型`，两个用途都要有，写错启动时抛错（`env.ts:146-167`） |
| `TOOL_SECRET_KEY` | 是 | 报错不起 | 64 位十六进制，`openssl rand -hex 32`。没设或格式不对启动失败（`env.ts:15-19`、`packages/control-plane/src/crypto.ts:31`） |
| `CREDENTIALS_KEY` | 是 | 报错不起 | 32 字节 base64，`openssl rand -base64 32`。没设或格式不对启动失败（`env.ts:21-27`、`packages/control-plane/src/credentials.ts:24`） |
| `WEB_BASE_URL` | 是 | 报错不起 | 浏览器打开 Web 的地址，如 `https://baize.example.com`，OAuth 回调拼在它上面（`env.ts:100`） |
| `PRICE_INPUT_PER_M`、`PRICE_OUTPUT_PER_M` | 否 | `0` | 每百万 token 价格，折算 run 的花费（`env.ts:96-97`）。不设用量金额恒为 0 |
| `GITHUB_API_BASE_URL`、`X_API_BASE_URL`、`GITHUB_OAUTH_BASE_URL`、`X_OAUTH_BASE_URL` | 否 | 各家官方地址，和 `env.ts:84-87` 一致 | 只在验证时指到假平台（`env.ts:98-99`、`:122-123`），生产不用设 |
| `COOKIE_SECURE` | 上了 HTTPS 就设 | `0` | 设成 `1` 会话 cookie 才带 Secure（`env.ts:12-14`） |
| `TRUSTED_PROXY_HOPS` | 否 | `1` | 控制面前面有几层反向代理，登录注册按来源 IP 限频时从 `X-Forwarded-For` 右数第几项取来源（`packages/control-plane/src/http/auth-limits.ts` 的 `clientIp`）。compose 默认 `1` 对应同机一层 Caddy；设成 `0` 所有请求都算成 docker 网关一个来源，两百次失败就锁住全站登录。控制面本身不设时是 `0` |
| `GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET` | 否 | 空 | 要一起设，只设一个启动时抛错（`env.ts:113-115`） |
| `X_CLIENT_ID`、`X_CLIENT_SECRET` | 否 | 空 | 设了 secret 就要设 id（`env.ts:118`） |

`DATABASE_URL` 和 `PORT` 由 compose 写死（`docker-compose.yml:42-43`），不从 `.env` 读。

**只给 compose 用的：**

| 变量 | compose 不设时 | 说明 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `baize` | Postgres 密码，同时拼进 `DATABASE_URL`（`docker-compose.yml:10`、`:28`、`:42`）。生产要换 |
| `CONTROL_PLANE_PORT` | `3201` | 控制面映射到宿主机的端口（`docker-compose.yml:71`），只绑 `127.0.0.1` |

**控制面认但 compose 不传的：**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_MODEL` | 无 | 旧变量，只在 `GATEWAY_MODELS` 为空时作为两个用途的模型名（`env.ts:127-144`）。compose 给 `GATEWAY_MODELS` 带了非空默认值，传了它也不会生效，所以不传。todo 第 220 行记着等各环境迁完就删 |
| `PUBLIC_BASE_URL` | 空，用实际监听的 `http://localhost:<端口>` | 只在没设 `WEB_BASE_URL` 时给 OAuth 回调当前缀。compose 里 `WEB_BASE_URL` 必填，所以不传。电脑拿到的数据面地址不看它，见下一节 |

### 电脑的数据面地址跟着它连控制面的地址走

电脑代理除了 `/agent` 那条 WebSocket，还要打控制面的四个 HTTP 前缀，统称数据面：

| 前缀 | 用途 |
| --- | --- |
| `/gateway/v1` | 模型网关 |
| `/hub/v1` | 中枢，查记忆、读车道 |
| `/mcp-proxy` | 远程 MCP 工具的代执行 |
| `/accounts-proxy` | Bot 读 GitHub、X |

这四个地址随 `config` 下发，控制面一律拼在代理 `hello` 里自报的 `controlOrigin` 上（`packages/control-plane/src/agent/data-plane.ts` 的 `dataPlaneUrls`）。代理自报的就是它连 `/agent` 用的那个地址的源，`ws://` 换成 `http://`，`wss://` 换成 `https://`（`packages/shared/src/agent-launch.ts` 的 `controlOriginFromAgentUrl`）。所以每台电脑拿到的地址各是各的，不用配：

- 远程电脑连 compose 内网的 `ws://control-plane:3001/agent`（`remote/put-launch.sh` 的 `AGENT_URL` 默认值），数据面也走 `http://control-plane:3001`，不经 Caddy。
- 本机桌面端连 `wss://baize.example.com/agent`，数据面走 `https://baize.example.com`，经 Caddy 转给控制面。所以 Caddy 必须把四个前缀都转过去，漏了的那类请求会落到下面的静态文件块，回的是 `index.html`，Bot 那一侧表现成模型、记忆、工具或账号请求失败。

控制面不读请求的 `Host` 头拼地址。nginx 的 `proxy_pass` 默认把 `Host` 改写成上游地址，换 nginx 做反代也不影响下发的地址。

## Caddy 托管 Web

Web 是 Vite 单页应用，用 `BrowserRouter`（`packages/web/src/main.tsx:13`），接口一律打同源的 `/api`（`packages/web/src/api/client.ts:119`），推送连同源的 `/api/ws`（`packages/web/src/state/app.tsx:737-738`）。所以 Web 和控制面必须在同一个域名下，不认识的路径要回落到 `index.html`。

构建（在仓库根，未在真机验证）：

```
pnpm install --frozen-lockfile
pnpm --filter @baize/web build        # 产物在 packages/web/dist（vite.config.ts 没改 outDir）
sudo mkdir -p /srv/baize-web && sudo rsync -a --delete packages/web/dist/ /srv/baize-web/
```

`/etc/caddy/Caddyfile` 示例（未在真机验证）：

```
baize.example.com {
	encode zstd gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:3201
	}
	# 本机桌面端的电脑代理连这里（packages/desktop/src/main.ts:157-161）。
	handle /agent {
		reverse_proxy 127.0.0.1:3201
	}
	# 本机电脑代理的数据面，四个都要转，见「电脑的数据面地址跟着它连控制面的地址走」。
	handle /gateway/v1/* {
		reverse_proxy 127.0.0.1:3201
	}
	handle /hub/v1/* {
		reverse_proxy 127.0.0.1:3201
	}
	handle /mcp-proxy/* {
		reverse_proxy 127.0.0.1:3201
	}
	handle /accounts-proxy/* {
		reverse_proxy 127.0.0.1:3201
	}

	handle {
		root * /srv/baize-web
		try_files {path} /index.html
		file_server
	}
}
```

- 用 `handle` 分块，是因为 Caddy 里 `try_files` 排在 `reverse_proxy` 之前执行。写成平铺的指令，`/api/...` 会先被改写成 `/index.html`。
- Caddy 的 `reverse_proxy` 自动透传 WebSocket Upgrade，`/api/ws` 和 `/agent` 不用另配。
- Caddy 自动申请证书。上线后 `.env` 里设 `COOKIE_SECURE=1` 和 `WEB_BASE_URL=https://baize.example.com`，GitHub、X 后台登记的回调地址见 `remote/README.md:24-31`。
- compose 只把控制面端口绑在 `127.0.0.1`（`docker-compose.yml:69-71`），Caddy 必须和 compose 在同一台机器上，外网只经 Caddy 的 80 和 443 进来。

## 迁移

**机制。** 每次 `docker compose up -d`，一次性服务 `migrate` 先把没跑过的迁移全跑完，控制面才起（`docker-compose.yml:21-30`、`:38-40`）。所有待跑的迁移在一个事务里执行，并用咨询锁挡住并发（`packages/control-plane/src/db/migrate.ts:18-46`），中途失败整批回滚。已跑过的记在 `_migrations` 表里。迁移文件现在到 `0038`。

**会删列的迁移。** 这几条跑完数据就回不来，旧库升级前必须先备份：

| 迁移 | 删了什么 | 删之前做了什么 |
| --- | --- | --- |
| `0009_chemical_corsair.sql:1` | `users.team_name` | 无，直接删 |
| `0010_giant_lily_hollister.sql:23` | `approvals.summary` | 先把 `summary` 拼进新列 `view`（第 1-21 行） |
| `0011_messy_arclight.sql:140` | `approvals.kind` | 先按 `kind` 映射出新列 `action`（第 85-90 行），`send_external`、`pay` 以外的取值都并成 `external_write`，原值丢失 |
| `0021_p2_shape_1.sql:74-75` | `bots.tag`、`routines.enabled` | 先把 `tag` 抄进 `tags`，把 `enabled` 转成 `state`（第 56、73 行） |

任务书只点了 0009 和 0011，0010 和 0021 也删列，一并列出。

**会长时间锁表的迁移。** `0036` 和 `0037` 各把 `work_entries` 里 `stream = 'chat' AND pi_type = 'message'` 的行整批 UPDATE 一遍，回填新列 `entry_at`（`0036_p3_recall_entry_time.sql:29`、`0037_p3_recall_node_entry_time.sql:37`）。`0036` 第 1 行的 `ALTER TABLE` 拿 ACCESS EXCLUSIVE 锁，整批事务提交之前，控制面对这张表的读写全部排队，Bot 的工作记录写不进去。时间几乎全花在 `0035` 建的 trigram 索引 `work_entries_chat_search_idx` 上。每条回填的行都要重新写进这个索引，回填函数本身不到一秒。

本机实测，机器是 Apple M5 Pro，Postgres 16 跑在 OrbStack 里、默认配置，合成数据按本地库的行型比例和行长造：

| 全表行数 | 要回填的行数 | 整批耗时，也是读写被挡的时长 | 表大小 |
| --- | --- | --- | --- |
| 10 万 | 3.1 万 | 104 到 118 秒，跑了 3 次 | 464 MB 涨到约 700 MB |
| 100 万 | 31 万 | 73 分钟，跑了 1 次 | 5.15 GB 涨到 6.46 GB |

每行成本随表变大而上升，两档之间不要按比例内插。生产机的磁盘、`shared_buffers`、`max_wal_size` 和本机不同，数也会不同。

`work_entries` 是 `0032` 新建的空表，不从历史消息回填，所以先看库停在哪条。

- 库还没跑到 `0032` 时，这张表和这批迁移一起建出来，`0036`、`0037` 一行都不更新，按下面的步骤直接升级。
- 库已经跑过 `0032` 时，先数要回填的行，也就是下面步骤里的第二条命令。几千行在一分钟以内，这是按上表每行约 3.6 毫秒推算的。几万行就挑没人用的时段升级，按上表预留时间。磁盘要留出这张表当前大小的一半以上，两遍 UPDATE 留下的死元组要等 autovacuum 回收。
- 数到十万行以上先别升级，找维护者。本机实测过在同一个事务里先删这个索引、跑完迁移再按 `0035` 的定义重建，3.1 万行时整批从 112 秒降到 38 秒，但这个做法还没写进迁移。

**升级步骤**（未在真机验证）。备份要在 `up -d` 之前做，因为 `up` 会自动迁移：

```
cd deploy/remote
docker compose exec -T postgres psql -U baize -d baize -c 'SELECT name FROM _migrations ORDER BY name'   # 记下当前到哪条
docker compose exec -T postgres psql -U baize -d baize -c "SELECT count(*) FROM work_entries WHERE stream = 'chat' AND pi_type = 'message'"   # 跑过 0032 才有这张表，见上一段
docker compose exec -T postgres pg_dump -U baize -d baize -Fc > ~/baize-$(date +%Y%m%d-%H%M).dump
ls -l ~/baize-*.dump                                                                                    # 确认不是 0 字节
docker compose build
docker compose up -d
docker compose logs migrate        # 应有「应用了 N 个迁移: ...」或「迁移已是最新，没有要跑的」
./put-launch.sh                    # 镜像升级后远程电脑要重新放启动文件
```

要退回时先停控制面，再用 `pg_restore --clean -U baize -d baize` 把 dump 灌回去，并换回旧版本的镜像。新代码不能跑在回滚后的旧库上。

全新的空库不用备份，第一次 `up -d` 从 `0000` 跑到最后一条。

## 升级顺序

控制面挡旧代理有两道关。`hello` 里的 `version`（写死的 `"0.1.0"`，`packages/computer-agent/src/main.ts:5`）没有代码读，起作用的是另外两样：

- **协议号。** `hello` 带 `protocol`，不带按 1 算（`packages/shared/src/protocol.ts:96`）。低于 `MIN_AGENT_PROTOCOL`（现在是 4，`protocol.ts` 里的常量）的连接，控制面直接用 4003 关掉（`packages/control-plane/src/agent/hub.ts:242-243`）。协议 4 起 `hello` 还必须带 `controlOrigin`，缺了或格式不对用 4001 关掉，旧代理不带它也先撞上协议号，拿到的仍是 4003。代理在 stdout 写一行 `{"type":"upgrade_required"}` 后停机，桌面端弹窗请用户更新白泽（`packages/desktop/src/main.ts:287-290`、`:573-577`）。
- **config 校验。** 协议号够、但 config 的形状这个代理认不出来时，代理回一条 `config_rejected`（`packages/computer-agent/src/agent.ts:304-316`）。控制面把这台电脑记成拒收，不再往它派活。群里那句写「电脑上的白泽版本和控制面对不上」（`packages/control-plane/src/agent/computer-selection.ts:23`），同时给用户推一条卡住通知（`packages/control-plane/src/agent/events.ts:820-826`）。代理回了新一代的 `config_applied` 才恢复派活。

所以升级顺序是：

- 远程电脑和控制面出自同一次构建，`docker compose build && docker compose up -d` 让两者一起升。
- 用户电脑上的桌面端不会跟着升。改了报文形状却没抬 `MIN_AGENT_PROTOCOL` 的版本，旧代理还能连上，但会卡在 config 拒收，用户看到的是「派不出去」而不是升级弹窗。改报文形状的版本要同时抬 `AGENT_PROTOCOL` 和 `MIN_AGENT_PROTOCOL`（`protocol.ts` 里挨着的两个常量），升级控制面前先发桌面端新版。

## 单实例、停机和探活

**控制面只能跑一个。** 群回合和它的计数、电脑连接表、画面中继、接续补扫和各个轮询都在进程内存里（`packages/control-plane/src/agent/group-turn.ts`、`agent/hub.ts`、`live/relay.ts`、`server.ts`）。起第二个副本后 WebSocket 落到不同进程，推送和派活会丢。

- 控制面启动时先在库上拿一把会话级 advisory lock（`packages/control-plane/src/instance-lock.ts`），拿不到就打印「同一个库上已经有一个控制面在跑」，以 1 退出。这时它还没开始监听，也没碰库里的电脑状态。
- 不要 `docker compose up --scale control-plane=2`，也不要用先起新副本、再停旧副本的滚动升级。`docker compose up -d` 重建容器是先停旧的再起新的，正好合适。
- 锁跟着一条专用的库连接走。这条连接断了（库重启、连接被掐），锁就放了，控制面按停机流程以 1 退出，由 `restart: unless-stopped` 拉起来重新拿锁。库没回来之前它会反复起不来，库回来就好。

**停机。** SIGTERM 和 SIGINT 都走 `server.close()`。在线电脑收到 1012 后按退避重连，欠着的接续标记留给下次启动的补扫，走完以 0 退出。8 秒没走完，或者停机中又收到一次信号，以 1 强退。同一个信号 1 秒内到第二遍算同一次，tsx 父进程和 `pnpm dev` 会把一次 Ctrl+C 或 SIGTERM 转发出好几遍。8 秒短于 docker 默认的 10 秒宽限，compose 里的控制面不用另设 `stop_grace_period`。未处理的 Promise 拒绝和未捕获的异常先记日志，再走同一套停机，以 1 退出。

**探活。** `GET /api/health` 不用登录，Caddy 按 `/api` 转进来，外面也能打。

| 情况 | 状态码 | 响应 |
| --- | --- | --- |
| 库连得上 | 200 | `{"ok":true}` |
| 库连不上，或查库 2 秒没回 | 503 | `{"ok":false,"error":"连不上数据库"}` |
| 停机已经开始 | 503 | `{"ok":false,"error":"控制面正在停机"}` |

控制面镜像里没有 curl。compose 要加 healthcheck，就用 node 发请求（未在真机验证）：

```
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 10s
      timeout: 5s
```

## 给别人开账号

这是代码的现状，开放注册还是邀请制还没定（todo 第 37 行）。

- **注册是开放的。** `POST /api/register` 在免登录白名单里（`packages/control-plane/src/http/app.ts:168`、`:238-258`），Web 有 `/register` 页（`packages/web/src/app.tsx:16`）。没有邀请码，没有管理员审批，没有邮箱验证，密码只要求非空（`packages/shared/src/api.ts:72-76`）。能打开域名的人都能自己注册。
- **注册时建好的东西。** 用户行、主助理 Bot（`packages/control-plane/src/repo/users.ts:43`），一台 `local` 电脑的记录（`app.ts:249`）。
- **没有管理员建号的入口。** `src/scripts/` 下只有 `migrate`、`seed`、`computer-token`、`account-add` 四个脚本。`account-add` 挂的是 GitHub、X 平台账号，不建用户。`seed` 只建开发账号 `chen@baize.dev`，密码是代码里写死的 `baize-dev`（`packages/control-plane/src/seed.ts:8-9`），生产库上不要跑。
- **想先关掉自助注册**，可以让对方先注册，再在 Caddy 里挡掉注册接口。下面这段要放在 `handle /api/*` 之前，挡掉后 Web 的注册页也会报错（未在真机验证）：

```
	handle /api/register {
		respond 403
	}
```

**配对电脑。** 用户的本机电脑走桌面端：设置里填控制面地址，桌面端复用已存凭据，没有凭据才调 `POST /api/computers/local` 拿 token，409 时先征求顶号确认（`packages/desktop/src/main.ts:375-432`），再连这个地址下的 `/agent`。远程电脑由运维跑 `./put-launch.sh <邮箱>`（`remote/README.md:74-100`）。compose 只有一个 `remote-computer` 服务，一个容器只放一个账号的启动文件，所以一台服务器现在只给一个账号配远程电脑。多个账号各要一台远程电脑，就得在 compose 里多加服务，仓库里还没有这种写法。

## 从零部署的顺序

1. 装 Docker Engine 和 compose 插件、Caddy；宿主机构建 Web 的话再装 Node 22.19 以上。
2. 按「`.env` 清单」写 `deploy/remote/.env`。生成密钥，换掉 `POSTGRES_PASSWORD`，设 `COOKIE_SECURE=1`。
3. `cd deploy/remote && docker compose build && docker compose up -d`，然后按「Node 版本」核镜像里的 node。
4. 按「AppArmor 与 bwrap 探测」查沙箱。
5. 构建 Web，写 Caddyfile，`sudo systemctl reload caddy`。
6. 浏览器打开域名注册账号，再给要用远程电脑的账号跑 `./put-launch.sh <邮箱>`，看日志上线（`remote/README.md:94-100`）。
