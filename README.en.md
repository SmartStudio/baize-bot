# Baize Bot

English | [中文](README.md)

**A personal assistant that leads a squad of bots to get work done for you.**

You talk only to the main assistant. It hands the work to bots for content, community and growth. They run on your own computers and touch only the accounts you open to them. The assistant comes to you in three cases. It needs your decision, it has a result, or it is stuck.

> Baize is in early development. There is no release and no download yet. Everything below already runs on the main branch.

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
