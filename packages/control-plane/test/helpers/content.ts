import { randomUUID } from "node:crypto";
import {
  AccountResponse,
  CreateBotResponse,
  DraftId,
  MessageListResponse,
  type Account,
  type AccountTier,
  type BotId,
  type DraftContent,
  type DraftSpec,
  type GroupId,
  type Platform,
  type RunId,
  type ServerPush,
  type User,
} from "@baize/shared";
import { expect } from "vitest";
import { CredentialCrypto, saveAccessToken } from "../../src/credentials.js";
import type { Db } from "../../src/db/client.js";
import { addAccount } from "../../src/repo/accounts.js";
import { helloAgent, type AgentClient } from "./agent.js";
import { TEST_CREDENTIALS_KEY, type ApiClient, type TestServer } from "./client.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./fixtures.js";
import { connectPush, type PushClient } from "./ws.js";

export type AccountSpec = { readonly platform: Platform; readonly handle: string; readonly token?: string };

export type ContentJob = {
  readonly user: User;
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
  readonly runId: RunId;
  readonly accounts: readonly Account[];
  close(): void;
};

/**
 * 一个正在跑的活，外加这个用户挂好的账号。账号行和凭据走 account-add 脚本里的同一个函数写，
 * 这是控制面测试里唯一不经 HTTP 的写入：账号的 OAuth 和浏览器登录归 P1-5，这一单没有建账号的接口。
 */
export async function contentJob(server: TestServer, db: Db, specs: readonly AccountSpec[]): Promise<ContentJob> {
  const user = await makeUser(db);
  const computer = await makeComputer(db, user.id);
  const crypto = new CredentialCrypto(TEST_CREDENTIALS_KEY);
  const accounts: Account[] = [];
  for (const spec of specs) {
    const account = await addAccount(db, {
      ownerId: user.id,
      computerId: computer.computerId,
      platform: spec.platform,
      handle: spec.handle,
    });
    if (spec.token !== undefined) await saveAccessToken(db, crypto, account.id, spec.token);
    accounts.push(account);
  }

  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小内" })).json());
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  expect(
    config.accounts.map((account) => account.id),
    "config.accounts 带着这个用户的全部账号",
  ).toEqual(accounts.map((account) => account.id));
  const push = await connectPush(server.server.port, client.cookie ?? "");

  expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "排一下这周要发的" })).status).toBe(
    201,
  );
  const prompt = await agent.expect("prompt");
  const echoed = await push.next();
  expect(echoed.type).toBe("message");

  return {
    user,
    client,
    agent,
    push,
    computer,
    groupId: created.group.id,
    botId: created.bot.id,
    runId: prompt.runId,
    accounts,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

/** 改档走 HTTP，改完电脑会收到一份新 config。 */
export async function setTier(job: ContentJob, account: Account, tier: AccountTier): Promise<Account> {
  const response = await job.client.patch(`/api/accounts/${account.id}`, { tier });
  expect(response.status).toBe(200);
  const updated = AccountResponse.parse(await response.json()).account;
  const pushed = await job.push.next();
  expect(pushed).toEqual({ type: "account_updated", account: updated });
  const config = await job.agent.expect("config");
  expect(config.accounts.find((one) => one.id === account.id)?.tier, "改档之后重发 config").toBe(tier);
  return updated;
}

export const newDraftId = (): DraftId => DraftId.parse(randomUUID());

export const issuePost = (text: string, title = "周报"): DraftContent => ({
  kind: "post",
  title,
  text,
  images: [],
  github: { repo: "baize/demo", as: "issue" },
});

export const tweet = (text: string): DraftContent => ({ kind: "post", title: null, text, images: [], github: null });

export const IMAGE = { path: "/tmp/a.png", sha256: "a".repeat(64) } as const;

export function specOf(account: Account, content: DraftContent, scheduledAt: string | null = null): DraftSpec {
  return { draftId: newDraftId(), accountId: account.id, content, scheduledAt };
}

export function sendDraft(job: ContentJob, spec: DraftSpec): void {
  job.agent.send({ type: "draft_create", runId: job.runId, botId: job.botId, groupId: job.groupId, draft: spec });
}

/** 取下一条推送，并断言它的种类。 */
export async function nextOf<T extends ServerPush["type"]>(
  push: PushClient,
  type: T,
): Promise<Extract<ServerPush, { type: T }>> {
  const next = await push.next();
  if (next.type !== type) throw new Error(`本应推 ${type}，实际是 ${JSON.stringify(next)}`);
  return next as Extract<ServerPush, { type: T }>;
}

/** 建一条草稿：先推草稿本身，再推群里那张卡。 */
export async function createDraft(job: ContentJob, spec: DraftSpec) {
  sendDraft(job, spec);
  const updated = await nextOf(job.push, "draft_updated");
  expect(updated.draft.id).toBe(spec.draftId);
  const card = await nextOf(job.push, "message");
  expect(card.message.body).toEqual({ kind: "draft", draftId: spec.draftId });
  return updated.draft;
}

export async function messagesOf(job: ContentJob) {
  const response = await job.client.get(`/api/groups/${job.groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json());
}

export async function draftOnPage(job: ContentJob, draftId: DraftId) {
  const page = await messagesOf(job);
  const draft = page.drafts.find((one) => one.id === draftId);
  if (draft === undefined) throw new Error(`消息页里没有草稿 ${draftId}`);
  return { draft, page };
}
