# 远程电脑部署

一台服务器上跑三样东西：控制面、Postgres、一台远程电脑。远程电脑是个容器，里面有电脑代理、Xvfb 和 Chromium，用户的本机不在线时，不要求账号的活派到这里。

```
deploy/remote/
  Dockerfile           控制面和远程电脑两个镜像，构建上下文是仓库根
  docker-compose.yml   postgres、migrate（一次性）、control-plane、remote-computer
  seccomp-bwrap.json   远程电脑的 seccomp：docker 默认 profile 加一条规则
  remote-entrypoint.sh 起 Xvfb，再 exec 看护进程
  put-launch.sh        换一份远程电脑 token，写成启动文件放进容器
```

Web 前端不在这份 compose 里，控制面也不托管静态文件。上线要另起一个静态站或反向代理，把 `/api`、`/api/ws` 转给控制面。

## 要准备的东西

**域名和 TLS。** 给控制面一个域名，比如 `baize.example.com`。TLS 在反向代理上终结（Caddy、nginx 都行），反向代理转到本机的 `CONTROL_PLANE_PORT`（默认 3201）。`/api/ws` 和 `/agent` 是 WebSocket，反向代理要放行 Upgrade。上了 HTTPS 以后把 `COOKIE_SECURE=1` 打开。

**上游 key。** `UPSTREAM_BASE_URL` 是 OpenAI 兼容的上游地址，`UPSTREAM_API_KEY` 是它的 key，必须是 ASCII，否则每次上游请求都是 502。`GATEWAY_MODELS` 写 `plan=<模型>,fast=<模型>`。

**工具凭据的加密密钥。** `TOOL_SECRET_KEY` 是 64 位十六进制，用 `openssl rand -hex 32` 生成一次，之后不要换。换了，库里已存的工具凭据全部解不开。

**GitHub App 和 X 应用的回调地址。** 这两处 OAuth 回调由 P1-5 的控制面 `src/http/oauth.ts` 实现，路径以那边为准。在 GitHub App 和 X 开发者后台登记的回调要落在上面那个域名的 HTTPS 下，形如 `https://baize.example.com/api/oauth/github/callback` 和 `https://baize.example.com/api/oauth/x/callback`。当前控制面还没有这两条路由。

远程电脑上不能登录 GitHub 或 X 账号。要求登录的活派到远程电脑，会回登录失败，日志写「远程电脑上不能登录，请在本机登录这个账号」。账号请在本机的桌面壳里登录。

以上配置写进 `deploy/remote/.env`（compose 默认读它），不要提交：

```
UPSTREAM_BASE_URL=https://上游/v1
UPSTREAM_API_KEY=...
GATEWAY_MODELS=plan=...,fast=...
TOOL_SECRET_KEY=...
POSTGRES_PASSWORD=...
COOKIE_SECURE=1
CONTROL_PLANE_PORT=3201
```

## 起服务

```
cd deploy/remote
docker compose build
docker compose up -d                 # migrate 先跑完，控制面才起
docker compose exec control-plane node --import tsx src/scripts/seed.ts   # 只在要开发账号时跑
```

`docker compose ps` 里 `migrate` 是 `Exited (0)`，其余三个是 `Up`。远程电脑的日志停在「等启动文件 /run/baize/launch.json」，是在等下一节放文件。

## 启动文件

远程电脑不从环境变量拿身份。`COMPUTER_ID`、`AGENT_TOKEN`、`CONTROL_PLANE_AGENT_URL`、`BAIZE_DATA_DIR` 出现在容器环境里，看护进程直接拒绝启动。身份只走一个启动文件：

```
./put-launch.sh [账号邮箱]            # 不给邮箱就是 seed 的开发账号
```

它做三件事：

1. 在控制面容器里跑 `computer-token remote`，给这个账号的远程电脑发一份新 token，旧 token 立刻作废。
2. 拼成一行 `{ url, computerId, token, dataDir }`，经 `docker compose exec -T` 的 stdin 送进远程电脑容器，以 `umask 077` 写成 `/run/baize/launch.json`，权限生来就是 600。token 不落宿主机磁盘。
3. 看护进程看到文件，检查是普通文件、属主是 node、权限正好 600，读完立刻删掉，再起电脑代理，把这一行写进代理的 stdin。

检查不过（比如权限是 644，或者是个符号链接），看护进程报一句中文错误退出，不读也不删那个文件。容器随即按 `restart: unless-stopped` 原地重启，`/run/baize` 这块内存盘跟着清空，那份没通过检查的文件也就没了，远程电脑又停在「等启动文件」。重新跑一遍 `put-launch.sh` 即可。

`/run/baize` 是容器里的内存盘，容器停掉就没了。看护进程只在内存里留着这份配置，代理退出了按退避重起，用的是同一份，不用再放。

**容器重建或重启后要重新放一次。** `docker compose up -d --force-recreate`、`docker compose restart remote-computer`、镜像升级、服务器重启，都会让远程电脑重新停在「等启动文件」。每次都要重跑一遍 `./put-launch.sh`，它先重启 remote-computer 让看护进程回到「等启动文件」，再重跑 `computer-token remote` 换一份新 token 放文件。远程电脑在线时也可以直接跑，代价是正在跑的活会断。旧 token 这时已经不在任何地方，不必找回。

看是否上线：

```
docker compose logs remote-computer | tail
```

依次出现「启动文件已读取并删除」「已发 hello」「控制面已接纳」和 `{"type":"online"}`，就是上线了。

## 安全选项

远程电脑容器没有 `--privileged`，没有加任何 capability。放宽只有两项：

- `seccomp=./seccomp-bwrap.json`。它等于 docker 默认 profile 再加一条规则，放行 `clone`、`unshare`、`mount`、`umount2`、`pivot_root`、`setns`。bubblewrap 建 user、mount、net 命名空间要这几个，Chromium 自带的沙箱也要。默认 profile 下 bubblewrap 报「No permissions to create new namespace」，Chromium 报「No usable sandbox」。
- `apparmor=unconfined`。在带 AppArmor 的主机上，docker 的默认 profile `docker-default` 禁止容器里的 mount，bubblewrap 要在新命名空间里 mount。这一条是按 profile 内容推断的，本机 OrbStack 没有 AppArmor，没有实测。

Ubuntu 23.10 以后的内核默认开着 `kernel.apparmor_restrict_unprivileged_userns=1`，它在宿主机层面限制非特权 user namespace，容器的 `apparmor=unconfined` 管不到它。部署前在服务器上跑一遍：

```
docker compose exec remote-computer bwrap --ro-bind / / --dev /dev --unshare-net --unshare-pid /bin/true && echo 能用
```

不通的话，要么在宿主机上把那个 sysctl 设成 0，要么给 bwrap 单独配一份宿主机的 AppArmor profile。这件事只在 OrbStack（没有 AppArmor）上验过，没在 Ubuntu 服务器上验过。

## 数据

- `pgdata` 卷是 Postgres 的数据。
- `bots` 卷挂在远程电脑的 `/home/node/.baize/bots`，每个 Bot 一个目录，Pi 的会话和 skill 都在里面。助理 Chrome 的 profile 也在这个目录下。

`docker compose down` 保留卷，`down -v` 连卷一起删，删了就没了。
