# 构建上下文是仓库根：docker build -f deploy/remote/Dockerfile .
# 基础镜像钉在多架构索引（含 amd64、arm64）的 digest 上，标签只给人读，升级时换这一处。
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# 只装控制面和电脑代理（连带 shared、bot-runner）的依赖，桌面壳和 Web 的依赖不进镜像。
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/bot-runner/package.json packages/bot-runner/
COPY packages/computer-agent/package.json packages/computer-agent/
COPY packages/desktop/package.json packages/desktop/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
COPY spikes/pi-embed/package.json spikes/pi-embed/
RUN pnpm install --frozen-lockfile --filter "@baize/control-plane..." --filter "@baize/computer-agent..."
COPY packages/shared packages/shared
COPY packages/control-plane packages/control-plane
COPY packages/bot-runner packages/bot-runner
COPY packages/computer-agent packages/computer-agent

FROM ${NODE_IMAGE} AS control-plane
COPY --from=deps /app /app
WORKDIR /app/packages/control-plane
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/main.ts"]

# 远程电脑：看护进程是主进程，Xvfb 给助理 Chrome 一块没人看的屏幕，bubblewrap 留给运行器的 bash 沙箱。
# git、python3 给 Bot 的 bash 用，运行器的命令分类认这两个命令（bot-runner/src/gate.ts）。
# chromium-l10n：Linux 的 chromium 不认 --lang，只按 LANG 找语言包，没有它 navigator.languages 和 Accept-Language 是 en-US。
# fonts-liberation2：补上和 Arial、Helvetica 同宽的字体，只剩 Noto CJK 的字体表一看就是空容器。
# python3-venv 给批准后的 pip 用：工具箱第一次装包时 `python3 -m venv` 建环境，Debian 把 ensurepip 的 wheel 拆在这个包里，
# 没有它 venv 建得出来但里面没有 pip。
FROM ${NODE_IMAGE} AS remote-computer
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#http://deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-l10n fonts-liberation2 xvfb xauth bubblewrap procps curl ca-certificates fonts-noto-cjk git python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app /app
COPY deploy/remote/remote-entrypoint.sh /usr/local/bin/remote-entrypoint.sh
RUN install -d -o node -g node -m 700 /home/node/.baize /home/node/.baize/bots \
  && install -d -m 1777 /tmp/.X11-unix
WORKDIR /app/packages/computer-agent
USER node
ENV DISPLAY=:99
ENTRYPOINT ["/usr/local/bin/remote-entrypoint.sh"]
