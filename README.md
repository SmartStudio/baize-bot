<p align="center"><img src="docs/images/logo.svg" width="120" alt="Baize Bot"></p>

<h1 align="center">Baize Bot</h1>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">中文</a></p>

<div align="center">

[![CI](https://github.com/SmartStudio/baize-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SmartStudio/baize-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

</div>

**Baize Bot is an AI assistant that leads a team of bots. It is local-first: the bots run on your own computers.**

It is for one person or a small team doing content, community and growth work, such as promoting an open-source repo. You talk only to the main assistant. It hands the work to bots and comes back when it needs your decision, has a result, or is stuck. A post goes out only after you approve it, or approve the content plan it belongs to.

> Baize is in early development. There is no release and no download yet. You can run it from source on the main branch today.

<!-- TODO: demo GIF (one sentence on the home page → project opens → draft waiting for approval) -->
![Content plan waiting for approval](docs/images/content-plan.png)

### Try it from source in 3 steps

You need Node 22+, pnpm and Docker.

1. Clone and configure: `git clone https://github.com/SmartStudio/baize-bot && cd baize-bot && pnpm install && cp .env.example .env`. In `.env`, set `CREDENTIALS_KEY` (`openssl rand -base64 32`) and `TOOL_SECRET_KEY` (`openssl rand -hex 32`). The control plane will not start without them. Set `UPSTREAM_API_KEY` if you want bots to call a model.
2. Start the database and seed it: `docker compose up -d`, then `pnpm --filter @baize/control-plane migrate` and `pnpm --filter @baize/control-plane seed`.
3. Run `pnpm dev`, open http://localhost:5173 and sign in with `chen@baize.dev` / `baize-dev`. To connect a computer agent, see [docs/开发.md](docs/开发.md).

If you want to follow Baize until the first release, star the repo. It is the easiest way for us to see that people want it.

## What it does

- **Start with one sentence.** Tell the main assistant what you want done, for example "promote this open-source repo". It opens a project, brings in the right bots and writes a plan.
- **A squad of bots.** Each bot has its own name, description, preferences and skills. Several bots work together in one group chat. Whoever you @ takes the task, otherwise the bot currently in charge carries on. When bots hand work to each other, they write down what is done and what comes next, and the handoff completes only after the receiver accepts.
- **Projects with goals and progress.** Every project has a pinned task card with a checklist, a deadline, a target number and metrics read back on a schedule, such as GitHub stars.
- **You see it before it goes public.** Anything a bot wants to post starts as an editable draft. Approve a whole content plan at once, and posts that follow the plan go out without asking again. An edited draft goes back to pending.
- **Sensitive actions need your approval.** When a bot reaches a tool that needs confirmation, an approval card appears in the chat. Click the button or reply "approve".
- **Runs on your own machines.** You get two computers, your Mac and a remote cloud server. Accounts for Chinese platforms stay on your Mac. GitHub, X and research run on the server and keep going when your laptop is closed. Say "use the cloud computer" and the bot moves the group there. Commands on the cloud computer run in a sandbox.
- **Connects your accounts.** GitHub and X use OAuth. Credentials stay in the control plane and bots never see them. Xiaohongshu logs in through a dedicated assistant browser, and you operate the login page yourself from a live view in the web app.
- **Learns as it goes.** After a bot finishes a kind of task, it offers to save it as a skill. You can also ask it to find a public SKILL.md on GitHub and install it.
- **Routines.** Daily, weekdays, hourly, or triggered by a webhook, such as an evening briefing.
- **Plays, too.** A built-in Texas Hold'em table where three bot players deal you in, with a commentator to ask when you're unsure.

## Screenshots

Approve a whole week's content plan from the home page. Edit any draft inline before it goes out.

![Content plan waiting for approval](docs/images/content-plan.png)

A project tracks its goal, here 1,000 GitHub stars by year end, along with this week's plan.

![Project page with goal and weekly plan](docs/images/project.png)

The Texas Hold'em table with three bot players.

![Texas Hold'em table](docs/images/poker.png)

The UI is in Chinese for now.


## How it works

```
Web / desktop app
   │
   ▼
Control plane (accounts, groups, approvals, drafts, model gateway)
   │  WebSocket
   ▼
Your computers (local Mac / remote cloud server)
   └─ Computer agent → one runtime session per bot per group
```

The control plane holds state and authorization. The work runs on your computers. Each computer connects out to the control plane, so no inbound ports are needed. All model requests go through the control plane's gateway.

## Quick start

You need Node 22+, pnpm and Docker.

```
pnpm install
docker compose up -d
pnpm --filter @baize/control-plane migrate
pnpm --filter @baize/control-plane seed
pnpm dev
```

Open http://localhost:5173 and sign in with the dev account `chen@baize.dev` / `baize-dev`.

The detailed docs are in Chinese.

- First steps: [docs/上手.md](docs/上手.md)
- Development and environment variables: [docs/开发.md](docs/开发.md)
- Deploying the remote computer: [deploy/README.md](deploy/README.md)
- Product spec: [spec/规格.md](spec/规格.md)

## Tech stack

A TypeScript pnpm monorepo. The control plane uses Hono and PostgreSQL, the web app React and Vite, the desktop app Electron. The bot runtime is built on the Pi coding agent.

## License

[MIT](LICENSE)

## 延伸阅读

Notes on fxai.ai (in Chinese):

- [Grok Bot 是什么？AI Agent 云端同事的实战指南](https://fxai.ai/notes/grok-bot-persistent-ai-teammates/): how a persistent cloud bot works with skills, routines, group chats and approvals.
- [多 Agent 协作时，另一个 Agent 转来的指令能不能直接照做](https://fxai.ai/notes/agent-to-agent-trust-boundary/): how to check instructions passed between bots, which matters when bots work in groups.
- [多个 Bot 共用云电脑，文件怎么隔离](https://fxai.ai/notes/grok-bot-shared-computer-isolation/): what is and isn't isolated when several bots share one computer.
- [企业开通 Grok Bot，权限和审计要先定什么](https://fxai.ai/notes/grok-bot-enterprise-access-audit/): what to decide on access, approvals and audit logs before a company turns bots on.
- [Agent 试点能跑通，扩到生产还缺哪几项？](https://fxai.ai/notes/agent-pilot-to-production-checklist/): what a bot setup still needs after a pilot works and before it runs for real.
- [Agent 权限管理怎么分级：工具权限先开哪类](https://fxai.ai/notes/agent-tool-permission-ladder/): which tool permissions to open first, which is the idea behind Baize's approval cards.
