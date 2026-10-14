# 部署到 Ubuntu 服务器

这份说明给要把控制面和远程电脑跑到一台 Ubuntu 服务器上的工程师。compose 怎么起、启动文件怎么放、seccomp 和 AppArmor 两项放宽、数据卷在哪，都写在 [`remote/README.md`](remote/README.md)，这里不重复，只补那份没写或没定的事：镜像缺的包、Node 版本、AppArmor 和 bwrap 的探测、`.env` 全清单、Caddy 托管 Web、迁移前备份、升级顺序、给别人开账号。

**验证状态。** 整份说明没有一步在 Ubuntu 真机上跑过。下文凡是要在服务器上执行的命令都是「未在真机验证」，事实部分都标了代码出处，出处里的行号以提交 `8f0955d` 为准。

## 一台服务器上有什么

```
浏览器 ──https──▶ Caddy :443 ──┬─ /api、/api/ws ─────────▶ 控制面 127.0.0.1:3201（容器里 3001）
                               ├─ /agent（本机电脑代理）──▶ 同上
                               ├─ /gateway/v1、/accounts-proxy（可选，见「PUBLIC_BASE_URL」）
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

控制面容器只拿到 `remote/docker-compose.yml:41-68` 列出的变量，写进 `.env` 但没列在那里的变量到不了控制面。env.ts 读的变量里，只有旧变量 `GATEWAY_MODEL` 没列，原因见最后一张表。

**compose 传给控制面的：**

| 变量 | 必填 | compose 不设时 | 说明 |
| --- | --- | --- | --- |
| `UPSTREAM_BASE_URL` | 是 | 报错不起 | OpenAI 兼容的上游地址（`env.ts:94`） |
| `UPSTREAM_API_KEY` | 是 | 报错不起 | 只能是可打印 ASCII，否则控制面启动时抛错（`env.ts:170-176`） |
| `GATEWAY_MODELS` | 否 | `plan=baize-default,fast=baize-default` | 格式 `plan=模型,fast=模型`，两个用途都要有，写错启动时抛错（`env.ts:146-167`） |
| `TOOL_SECRET_KEY` | 是 | 报错不起 | 64 位十六进制（`packages/control-plane/src/crypto.ts:31`），`openssl rand -hex 32`。控制面本身没设时退回一把写在代码里的开发密钥（`env.ts:16-24`），compose 用 `:?` 挡住了这种情况 |
| `CREDENTIALS_KEY` | 是 | 报错不起 | 32 字节 base64，`openssl rand -base64 32`。没设或格式不对启动失败（`env.ts:27-33`、`packages/control-plane/src/credentials.ts:24`） |
| `WEB_BASE_URL` | 是 | 报错不起 | 浏览器打开 Web 的地址，如 `https://baize.example.com`，OAuth 回调拼在它上面（`env.ts:100`） |
| `PUBLIC_BASE_URL` | 否 | `http://control-plane:3001` | 下发给所有电脑的网关和账号代理前缀，见下一节 |
| `PRICE_INPUT_PER_M`、`PRICE_OUTPUT_PER_M` | 否 | `0` | 每百万 token 价格，折算 run 的花费（`env.ts:96-97`）。不设用量金额恒为 0 |
| `GITHUB_API_BASE_URL`、`X_API_BASE_URL`、`GITHUB_OAUTH_BASE_URL`、`X_OAUTH_BASE_URL` | 否 | 各家官方地址，和 `env.ts:84-87` 一致 | 只在验证时指到假平台（`env.ts:98-99`、`:122-123`），生产不用设 |
| `COOKIE_SECURE` | 上了 HTTPS 就设 | `0` | 设成 `1` 会话 cookie 才带 Secure（`env.ts:12-14`） |
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

### `PUBLIC_BASE_URL` 只有一个值

控制面给每台电脑下发的模型网关地址和账号代理地址，都拼在同一个 `PUBLIC_BASE_URL` 上，不分本机电脑和远程电脑（`packages/control-plane/src/server.ts:95-103`、`packages/control-plane/src/agent/hub.ts:523-526`）。

compose 的默认值 `http://control-plane:3001` 只有 compose 网络里的远程电脑连得上。用户自己电脑上的桌面端也连这个控制面时，会收到这个地址，模型请求和账号代理请求都发不出去。代码只能推出这一点，没有实测过。

只用远程电脑时保持默认即可。本机电脑也要连时，把 `PUBLIC_BASE_URL` 设成 `https://baize.example.com`，Caddy 再放行 `/gateway/v1` 和 `/accounts-proxy`。这样远程电脑也改走公网域名，要求容器里能解析并连上这个域名（未在真机验证）。

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
	# 只在 PUBLIC_BASE_URL 设成公网域名时需要。
	handle /gateway/v1/* {
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

**升级步骤**（未在真机验证）。备份要在 `up -d` 之前做，因为 `up` 会自动迁移：

```
cd deploy/remote
docker compose exec -T postgres psql -U baize -d baize -c 'SELECT name FROM _migrations ORDER BY name'   # 记下当前到哪条
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

- **协议号。** `hello` 带 `protocol`，不带按 1 算（`packages/shared/src/protocol.ts:96`）。低于 `MIN_AGENT_PROTOCOL`（现在是 3，`protocol.ts:555`）的连接，控制面直接用 4003 关掉（`packages/control-plane/src/agent/hub.ts:242-243`）。代理在 stdout 写一行 `{"type":"upgrade_required"}` 后停机，桌面端弹窗请用户更新白泽（`packages/desktop/src/main.ts:287-290`、`:573-577`）。
- **config 校验。** 协议号够、但 config 的形状这个代理认不出来时，代理回一条 `config_rejected`（`packages/computer-agent/src/agent.ts:304-316`）。控制面把这台电脑记成拒收，不再往它派活。群里那句写「电脑上的白泽版本和控制面对不上」（`packages/control-plane/src/agent/computer-selection.ts:23`），同时给用户推一条卡住通知（`packages/control-plane/src/agent/events.ts:820-826`）。代理回了新一代的 `config_applied` 才恢复派活。

所以升级顺序是：

- 远程电脑和控制面出自同一次构建，`docker compose build && docker compose up -d` 让两者一起升。
- 用户电脑上的桌面端不会跟着升。改了报文形状却没抬 `MIN_AGENT_PROTOCOL` 的版本，旧代理还能连上，但会卡在 config 拒收，用户看到的是「派不出去」而不是升级弹窗。改报文形状的版本要同时抬 `AGENT_PROTOCOL` 和 `MIN_AGENT_PROTOCOL`（`protocol.ts:554-555`），升级控制面前先发桌面端新版。

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
