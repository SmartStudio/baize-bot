# 构建上下文是仓库根：docker build -f deploy/remote/Dockerfile .
# 只装控制面和电脑代理（连带 shared、bot-runner）的依赖，桌面壳和 Web 的依赖不进镜像。
FROM node:22-bookworm-slim AS deps
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

FROM node:22-bookworm-slim AS control-plane
COPY --from=deps /app /app
WORKDIR /app/packages/control-plane
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/main.ts"]

# 远程电脑：看护进程是主进程，Xvfb 给助理 Chrome 一块没人看的屏幕，bubblewrap 留给运行器的 bash 沙箱。
FROM node:22-bookworm-slim AS remote-computer
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb xauth bubblewrap procps curl ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app /app
COPY deploy/remote/remote-entrypoint.sh /usr/local/bin/remote-entrypoint.sh
RUN install -d -o node -g node -m 700 /home/node/.baize /home/node/.baize/bots \
  && install -d -m 1777 /tmp/.X11-unix
WORKDIR /app/packages/computer-agent
USER node
ENV DISPLAY=:99
ENTRYPOINT ["/usr/local/bin/remote-entrypoint.sh"]
