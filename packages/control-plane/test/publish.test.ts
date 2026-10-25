import { randomBytes } from "node:crypto";
import { format } from "node:util";
import {
  AccountListResponse,
  AccountResponse,
  ComputerTokenResponse,
  DecideDraftResponse,
  LoginAttemptId,
  TodayResponse,
  type Account,
  type DraftContent,
  type DraftId,
  type DraftSpec,
  type ServerPush,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialCrypto, saveAccessToken } from "../src/credentials.js";
import { accounts as accountsTable, drafts, publications } from "../src/db/schema.js";
import { startFakePlatforms, type FakePlatforms } from "../src/fake-platforms.js";
import { withAccountLock } from "../src/repo/account-lock.js";
import { helloAgent, openAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import {
  IMAGE,
  contentJob,
  createDraft,
  draftOnPage,
  issuePost,
  messagesOf,
  nextOf,
  sendDraft,
  setTier,
  specOf,
  tweet,
  uploadImage,
  type AccountSpec,
  type ContentJob,
} from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, waitFor } from "./helpers/fixtures.js";
import { logLine } from "./helpers/log.js";
import { connectPush } from "./helpers/ws.js";

const GITHUB = { platform: "github", handle: "baize-dev", token: "ghp_publish_secret_1" } as const;
const X = { platform: "x", handle: "baize_x", token: "x_publish_secret_2" } as const;
const XHS = { platform: "xiaohongshu", handle: "白泽" } as const;
/** 同一个 X 号在电脑浏览器里登录出来的那一行，和授权连上的 X 是两条账号。 */
const X_WEB = { platform: "x", via: "computer", handle: "baize_x" } as const;
const X_HOME = "https://x.com/home";
const MINUTE = 60_000;
/** 电脑报的链接不可信时落账用的笔记管理页，和运行器发布器里读不到链接时回的是同一个页面。 */
const XHS_MANAGE_URL = "https://creator.xiaohongshu.com/new/note-manager";

type Clock = () => Date;

/** 每条用例一个库：发布循环扫的是全库，别的用例留下的已批草稿会被它一起抢走。 */
type Stack = {
  readonly database: TestDb;
  readonly fake: FakePlatforms;
  serve(now?: Clock, sleep?: (ms: number) => Promise<void>): Promise<TestServer>;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function stack(): Promise<Stack> {
  const database = await createTestDb();
  const fake = await startFakePlatforms();
  cleanups.push(async () => {
    await fake.close();
    await database.close();
  });
  return {
    database,
    fake,
    serve: async (now, sleep) => {
      const server = await startTestServer(
        database.db,
        { githubApiBaseUrl: fake.githubBaseUrl, xApiBaseUrl: fake.xBaseUrl },
        undefined,
        undefined,
        { ...(now === undefined ? {} : { now }), ...(sleep === undefined ? {} : { sleep }) },
      );
      // 重启用例会先手动关掉旧进程，收尾时不再关第二次。
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await server.close();
      };
      cleanups.push(close);
      return { ...server, close };
    },
  };
}

async function jobOn(s: Stack, server: TestServer, specs: readonly AccountSpec[]): Promise<ContentJob> {
  const job = await contentJob(server, s.database.db, specs);
  cleanups.push(async () => job.close());
  return job;
}

function accountOf(job: ContentJob, platform: Account["platform"], via?: Account["via"]): Account {
  const account = job.accounts.find((one) => one.platform === platform && (via === undefined || one.via === via));
  if (account === undefined) throw new Error(`没挂 ${platform} 账号`);
  return account;
}

async function approve(job: ContentJob, draftId: DraftId, content?: DraftContent) {
  const response = await job.client.post(
    `/api/drafts/${draftId}`,
    content === undefined ? { decision: "approve" } : { decision: "approve", content },
  );
  expect(response.status).toBe(200);
  const { draft } = DecideDraftResponse.parse(await response.json());
  expect(draft.status).toBe("approved");
  expect((await nextOf(job.push, "draft_updated")).draft).toEqual(draft);
  return draft;
}

async function createApproved(job: ContentJob, spec: DraftSpec) {
  await createDraft(job, spec);
  return approve(job, spec.draftId);
}

/** 一轮发布之后这条草稿在推送里走过的状态：先 publishing，再 published 或 failed。 */
async function publishedPushes(job: ContentJob) {
  expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
  const publication = (await nextOf(job.push, "publication_created")).publication;
  const done = (await nextOf(job.push, "draft_updated")).draft;
  expect(done.status).toBe("published");
  return { publication, draft: done };
}

/** Bot 在自己的 run 里改稿。 */
function editByBot(job: ContentJob, draftId: DraftId, content: DraftContent): void {
  job.agent.send({ type: "draft_edit", runId: job.runId, botId: job.botId, groupId: job.groupId, draftId, content });
}

/** 代理连接上的报文按到达顺序处理：再发一条一定会落地的起草，等它出现在消息页，之前发的就都处理完了。 */
async function agentCaughtUp(job: ContentJob, account: Account, content: DraftContent): Promise<void> {
  const sentinel = specOf(account, content);
  sendDraft(job, sentinel);
  await waitFor(
    async () => (await messagesOf(job)).drafts.some((draft) => draft.id === sentinel.draftId),
    "哨兵草稿落地",
  );
}

/** 重启后重新登录、重新连推送，拿到一个挂在新进程上的 job。 */
async function reconnect(job: ContentJob, server: TestServer): Promise<ContentJob> {
  const client = server.client();
  expect((await client.login(job.user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  cleanups.push(async () => push.close());
  return { ...job, client, push };
}

/** 截下 console 的全部输出，收尾时还原。 */
/** 0016 上线前就在发的存量草稿：claimed_login_generation 是 null。 */
async function claimedBeforeMigration(s: Stack, spec: DraftSpec) {
  await s.database.db.update(drafts).set({ claimedLoginGeneration: null }).where(eq(drafts.id, spec.draftId));
}

function captureConsole(): string[] {
  const logged: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(format(...args));
    });
  }
  cleanups.push(async () => {
    vi.restoreAllMocks();
  });
  return logged;
}

/** 登录过期的那一次，草稿和通知之间还夹一条账号变成过期的推送。 */
async function failedPushes(job: ContentJob) {
  expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
  const failed = (await nextOf(job.push, "draft_updated")).draft;
  expect(failed.status).toBe("failed");
  let next = await job.push.next();
  let account: Account | null = null;
  if (next.type === "account_updated") {
    account = next.account;
    next = await job.push.next();
  }
  if (next.type !== "notify") throw new Error(`本应推 notify，实际是 ${JSON.stringify(next)}`);
  const notice = next.notice;
  expect(notice.kind).toBe("failed");
  expect(notice.groupId).toBe(job.groupId);
  return { draft: failed, notice, account };
}

describe("发布循环", () => {
  it("同一条草稿到点只发一次", async () => {
    const s = await stack();
    const first = await s.serve();
    const second = await s.serve();
    const job = await jobOn(s, first, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("两个循环抢同一条"));
    await createApproved(job, spec);

    await Promise.all([first.server.publisher.tick(), second.server.publisher.tick()]);
    await first.server.publisher.tick();

    expect(s.fake.requests().map((request) => request.path)).toEqual(["/repos/baize/demo/issues"]);
    const { page, draft } = await draftOnPage(job, spec.draftId);
    expect(draft.status).toBe("published");
    expect(page.publications.map((publication) => publication.draftId)).toEqual([spec.draftId]);
  });

  it("在卡上改字再批，发出去的是改后的正文，edits 里有这一对", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("原稿"));
    await createDraft(job, spec);
    const approved = await approve(job, spec.draftId, issuePost("改过的稿"));
    expect(approved.content.text).toBe("改过的稿");
    expect(
      (await nextOf(job.push, "brand_updated")).brand.edits.map(({ before, after }) => ({ before, after })),
      "改过字的批准顺手进品牌手册",
    ).toEqual([{ before: "原稿", after: "改过的稿" }]);
    expect(approved.edits.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: "原稿", after: "改过的稿" },
    ]);

    await server.server.publisher.tick();
    await publishedPushes(job);
    expect(s.fake.requests().map((request) => request.body)).toEqual([{ title: "周报", body: "改过的稿" }]);
    const { draft } = await draftOnPage(job, spec.draftId);
    expect(draft.edits.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: "原稿", after: "改过的稿" },
    ]);
  });

  it("批的时候带了一模一样的正文，edits 不多一条", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("不改"));
    await createDraft(job, spec);
    expect((await approve(job, spec.draftId, issuePost("不改"))).edits).toEqual([]);
    const kindChanged = await job.client.post(`/api/drafts/${spec.draftId}`, {
      decision: "approve",
      content: {
        kind: "reply",
        text: "x",
        images: [],
        replyTo: { url: "https://x.com/a/status/1", author: "a", quote: "" },
      },
    });
    expect(kindChanged.status, "已经批过了，先到的是 409").toBe(409);
  });

  it("帖子不能在卡上改成回复", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const spec = specOf(accountOf(job, "x"), tweet("原来是帖子"));
    await createDraft(job, spec);
    const response = await job.client.post(`/api/drafts/${spec.draftId}`, {
      decision: "approve",
      content: {
        kind: "reply",
        text: "改成回复",
        images: [],
        replyTo: { url: "https://x.com/a/status/1", author: "a", quote: "" },
      },
    });
    expect(response.status).toBe(400);
    expect((await draftOnPage(job, spec.draftId)).draft).toMatchObject({ status: "pending", edits: [] });
  });

  it("可起草档的草稿批了也不发，没到时间的也不发", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB, X]);
    await setTier(job, accountOf(job, "github"), "draft");
    const drafted = specOf(accountOf(job, "github"), issuePost("可起草档写的"));
    const created = await createDraft(job, drafted);
    expect(created.status, "可起草档建出来要人批").toBe("pending");
    await approve(job, drafted.draftId);
    const later = specOf(accountOf(job, "x"), tweet("一小时后发"), new Date(Date.now() + 60 * MINUTE).toISOString());
    await createApproved(job, later);
    const now = specOf(accountOf(job, "x"), tweet("没定时间，批完就发"));
    await createApproved(job, now);

    await server.server.publisher.tick();
    await publishedPushes(job);

    expect(s.fake.requests().map((request) => request.body)).toEqual([{ text: "没定时间，批完就发" }]);
    const page = await messagesOf(job);
    const statusOf = (id: DraftId) => page.drafts.find((draft) => draft.id === id)?.status;
    expect([statusOf(drafted.draftId), statusOf(later.draftId), statusOf(now.draftId)]).toEqual([
      "approved",
      "approved",
      "published",
    ]);
  });

  it("重启时超时的 publishing 记 failed，停机期间到点的不补发", async () => {
    const s = await stack();
    const old = await s.serve(() => new Date(Date.now() - 20 * MINUTE));
    const job = await jobOn(s, old, [GITHUB]);
    const github = accountOf(job, "github");

    const stuck = specOf(github, issuePost("发到一半进程没了"));
    await createApproved(job, stuck);
    const release = s.fake.hold();
    const inflight = old.server.publisher.tick();
    await waitFor(async () => s.fake.requests().length === 1, "旧进程把请求打到假 GitHub");
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({ id: stuck.draftId, status: "publishing" });

    const missed = specOf(github, issuePost("停机期间到点的"), new Date(Date.now() + 60 * MINUTE).toISOString());
    await createApproved(job, missed);
    const anytime = specOf(github, issuePost("没定时间的"));
    await createApproved(job, anytime);
    job.close();
    await old.close();

    const restarted = await s.serve(() => new Date(Date.now() + 120 * MINUTE));
    release();
    await inflight;

    const after = await reconnect(job, restarted);

    const recovered = await draftOnPage(after, stuck.draftId);
    expect(recovered.draft, "旧进程抢到没发完的，重启时记 failed").toMatchObject({
      status: "failed",
      failure: "error",
    });
    expect(recovered.page.publications, "旧进程的请求后来回来了也不补记发布").toEqual([]);
    expect((await draftOnPage(after, missed.draftId)).draft, "停机期间到点的打回待批").toMatchObject({
      status: "pending",
      decidedAt: null,
    });
    expect((await draftOnPage(after, anytime.draftId)).draft.status).toBe("approved");

    await restarted.server.publisher.tick();
    await publishedPushes(after);
    expect(s.fake.requests().map((request) => (request.body as { body: string }).body)).toEqual([
      "发到一半进程没了",
      "没定时间的",
    ]);
    const final = await messagesOf(after);
    expect(final.drafts.map((draft) => [draft.content.text, draft.status])).toEqual([
      ["发到一半进程没了", "failed"],
      ["停机期间到点的", "pending"],
      ["没定时间的", "published"],
    ]);
  });

  it("批的时候已经过了点、下一轮之前重启，不算错过，重启后照发", async () => {
    const s = await stack();
    const old = await s.serve();
    const job = await jobOn(s, old, [GITHUB]);
    const late = specOf(
      accountOf(job, "github"),
      issuePost("过了点才批的"),
      new Date(Date.now() - 30 * MINUTE).toISOString(),
    );
    await createApproved(job, late);
    job.close();
    await old.close();

    const restarted = await s.serve();
    const after = await reconnect(job, restarted);
    expect(
      (await draftOnPage(after, late.draftId)).draft,
      "批准时刻晚于到点时刻，按批准时刻算，还没等到下一轮，不算错过",
    ).toMatchObject({ status: "approved" });

    await restarted.server.publisher.tick();
    await publishedPushes(after);
    expect(s.fake.requests().map((request) => (request.body as { body: string }).body)).toEqual(["过了点才批的"]);
  });

  it("抢到的草稿还在途时再跑一轮，不当成超时，结果回来照常落账", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("慢慢发"));
    await createApproved(job, spec);
    const release = s.fake.hold();
    const inflight = server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().length === 1, "请求在途");

    await server.server.publisher.tick();
    expect((await draftOnPage(job, spec.draftId)).draft, "刚抢到的还在发，下一轮不记失败").toMatchObject({
      status: "publishing",
      failure: null,
    });

    release();
    await inflight;
    const { draft, page } = await draftOnPage(job, spec.draftId);
    expect(draft.status).toBe("published");
    expect(page.publications.map((publication) => publication.url)).toEqual([
      "https://github.com/baize/demo/issues/101",
    ]);
    expect(s.fake.requests()).toHaveLength(1);
  });

  it("超时记失败、改稿重批再被抢，旧那次的结果晚到不落账", async () => {
    const s = await stack();
    let offset = 0;
    const server = await s.serve(() => new Date(Date.now() + offset));
    const job = await jobOn(s, server, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("第一次"));
    await createApproved(job, spec);

    const releaseFirst = s.fake.hold();
    const first = server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().length === 1, "第一次请求在途");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    offset = 11 * MINUTE;
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft, "在途超过十分钟记失败").toMatchObject({
      status: "failed",
      failure: "error",
    });
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");

    editByBot(job, spec.draftId, issuePost("第二次"));
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      status: "pending",
      content: { text: "第二次" },
    });
    await approve(job, spec.draftId);
    const releaseSecond = s.fake.hold();
    const second = server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().length === 2, "第二次请求在途");

    // 先放第一次：它的结果先到，这时行已经是第二次认领的 publishing。
    releaseFirst();
    await first;
    releaseSecond();
    await second;

    expect(s.fake.requests().map((request) => (request.body as { body: string }).body)).toEqual(["第一次", "第二次"]);
    const { draft, page } = await draftOnPage(job, spec.draftId);
    expect(draft.status).toBe("published");
    expect(
      page.publications.map((publication) => publication.url),
      "落账的是第二次那条，第一次晚到的链接不算",
    ).toEqual(["https://github.com/baize/demo/issues/102"]);
  });

  it("发出去的草稿 Bot 再改也不动，读回仍是已发布、正文不变", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const github = accountOf(job, "github");
    const spec = specOf(github, issuePost("发出去的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    await publishedPushes(job);

    editByBot(job, spec.draftId, issuePost("发完又想改"));
    await agentCaughtUp(job, github, issuePost("哨兵"));

    const { draft } = await draftOnPage(job, spec.draftId);
    expect(draft, "已发布的草稿不回待批，正文还是发出去的那版").toMatchObject({
      status: "published",
      content: issuePost("发出去的"),
    });
    expect((await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" })).status).toBe(409);
    await server.server.publisher.tick();
    expect(s.fake.requests(), "平台上只发过一次").toHaveLength(1);
  });

  it("Bot 经中枢改稿：改成了回 200 并推新草稿；发出去的、改了类型的、找不到的都回中文原因，草稿不动", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const github = accountOf(job, "github");
    const editOnHub = async (draftId: string, content: DraftContent) => {
      const response = await fetch(`${job.config.hub.baseUrl}/drafts/${draftId}/edit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${job.config.modelGateway.apiKey}`,
          "x-baize-lane": job.lane,
        },
        body: JSON.stringify({ runId: job.runId, content }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    };

    const pending = specOf(github, issuePost("先这么写"));
    await createDraft(job, pending);
    expect(await editOnHub(pending.draftId, issuePost("改一改"))).toEqual({ status: 200, body: {} });
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      id: pending.draftId,
      status: "pending",
      content: { text: "改一改" },
    });

    const sent = specOf(github, issuePost("发出去的"));
    await createApproved(job, sent);
    await server.server.publisher.tick();
    await publishedPushes(job);
    const reply: DraftContent = {
      kind: "reply",
      text: "回一句",
      images: [],
      replyTo: { url: "https://github.com/baize/demo/issues/7", author: "a", quote: "原话" },
    };
    expect(await editOnHub(sent.draftId, issuePost("发完又想改"))).toEqual({
      status: 409,
      body: { error: "这条草稿正在发或已经发出去了，不能再改，要发新的就另起一稿" },
    });
    expect(await editOnHub(pending.draftId, reply)).toEqual({
      status: 400,
      body: { error: "不能把帖子改成回复" },
    });
    expect(await editOnHub(pending.draftId, { ...issuePost("带图"), images: [IMAGE] })).toEqual({
      status: 400,
      body: { error: "草稿配图不合这个账号：不能带图" },
    });
    expect(await editOnHub("draft-nowhere", issuePost("没这条"))).toEqual({
      status: 404,
      body: { error: "找不到这条草稿，照建草稿时拿到的 draftId 抄" },
    });
    expect((await draftOnPage(job, sent.draftId)).draft).toMatchObject({
      status: "published",
      content: issuePost("发出去的"),
    });
    expect((await draftOnPage(job, pending.draftId)).draft).toMatchObject({
      status: "pending",
      content: issuePost("改一改"),
    });
  });

  it("发出后刚做完里有这一行，带原帖链接", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const spec = specOf(accountOf(job, "github"), issuePost("本周进展", "白泽周报"));
    await createApproved(job, spec);

    await server.server.publisher.tick();
    const { publication } = await publishedPushes(job);
    expect(publication).toMatchObject({
      draftId: spec.draftId,
      groupId: job.groupId,
      platform: "github",
      url: "https://github.com/baize/demo/issues/101",
    });

    const today = TodayResponse.parse(await (await job.client.get("/api/today")).json());
    expect(today.done.filter((item) => item.kind === "publication")).toEqual([
      {
        kind: "publication",
        at: publication.publishedAt,
        groupId: job.groupId,
        title: "白泽周报",
        platform: "github",
        url: "https://github.com/baize/demo/issues/101",
      },
    ]);
    const { page, draft } = await draftOnPage(job, spec.draftId);
    expect(draft.status).toBe("published");
    expect(page.publications).toEqual([publication]);
  });

  it("令牌不出现在任何推送、下行报文和日志里", async () => {
    const logged = captureConsole();
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB, X]);
    const seen: string[] = [];
    job.push.socket.on("message", (raw: Buffer) => seen.push(raw.toString()));
    job.agent.socket.on("message", (raw: Buffer) => seen.push(raw.toString()));

    await setTier(job, accountOf(job, "github"), "confirm_publish");
    await createApproved(job, specOf(accountOf(job, "github"), issuePost("会发出去的")));
    await server.server.publisher.tick();
    await publishedPushes(job);
    s.fake.failNext(401);
    await createApproved(job, specOf(accountOf(job, "x"), tweet("会被 401 的")));
    await server.server.publisher.tick();
    await failedPushes(job);
    seen.push(await (await job.client.get("/api/accounts")).text());
    seen.push(await (await job.client.get(`/api/groups/${job.groupId}/messages`)).text());
    seen.push(await (await job.client.get("/api/today")).text());

    expect(
      s.fake.requests().map((request) => request.authorization),
      "令牌确实拿去打了平台",
    ).toEqual([`Bearer ${GITHUB.token}`, `Bearer ${X.token}`]);
    expect(seen.length).toBeGreaterThan(10);
    for (const token of [GITHUB.token, X.token]) {
      expect(seen.filter((text) => text.includes(token))).toEqual([]);
      expect(logged.filter((text) => text.includes(token))).toEqual([]);
    }
  });

  it("令牌解不开的这一轮就记出错，推送和日志里没有令牌也没有密文", async () => {
    const logged = captureConsole();
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [{ platform: "github", handle: "key_rotated" }]);
    const github = accountOf(job, "github");
    const token = "ghp_rotated_key_secret";
    const staleKey = new CredentialCrypto(randomBytes(32).toString("base64"));
    await withAccountLock(s.database.db, github.id, (lock) => saveAccessToken(lock, staleKey, token));
    const seen: string[] = [];
    job.push.socket.on("message", (raw: Buffer) => seen.push(raw.toString()));
    job.agent.socket.on("message", (raw: Buffer) => seen.push(raw.toString()));

    const spec = specOf(github, issuePost("钥匙换过了"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const { draft, notice } = await failedPushes(job);
    expect(draft.failure).toBe("error");
    expect((await draftOnPage(job, spec.draftId)).draft).toMatchObject({ status: "failed", failure: "error" });
    expect(s.fake.requests(), "解不开就不打平台").toEqual([]);

    expect(
      logged.filter((text) => text.includes(spec.draftId)),
      "日志里记了这条没发出去",
    ).toHaveLength(1);
    const texts = [...seen, ...logged, notice.text];
    expect(texts.filter((text) => text.includes(token))).toEqual([]);
    expect(
      texts.filter((text) => text.includes("v1:")),
      "密文以 v1: 开头",
    ).toEqual([]);
  });
});

describe("各平台的发法", () => {
  it("X 发帖和回复，回复带 in_reply_to_tweet_id，链接指向这个账号的帖子", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    await createApproved(job, specOf(x, tweet("一条推")));
    await server.server.publisher.tick();
    const post = await publishedPushes(job);
    await createApproved(
      job,
      specOf(x, {
        kind: "reply",
        text: "谢谢",
        images: [],
        replyTo: { url: "https://x.com/someone/status/1234567890", author: "someone", quote: "好用" },
      }),
    );
    await server.server.publisher.tick();
    const reply = await publishedPushes(job);

    expect(s.fake.requests().map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/2/tweets", body: { text: "一条推" } },
      { path: "/2/tweets", body: { text: "谢谢", reply: { in_reply_to_tweet_id: "1234567890" } } },
    ]);
    expect(post.publication.url).toBe("https://x.com/baize_x/status/18101");
    expect(reply.publication.url).toBe("https://x.com/baize_x/status/18102");
  });

  it("GitHub 按目标建 discussion，回复评论到原 issue 下", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const github = accountOf(job, "github");
    await createApproved(
      job,
      specOf(github, {
        kind: "post",
        title: "路线图",
        text: "讨论一下",
        images: [],
        github: { repo: "baize/demo", as: "discussion" },
      }),
    );
    await server.server.publisher.tick();
    const discussion = await publishedPushes(job);
    await createApproved(
      job,
      specOf(github, {
        kind: "reply",
        text: "已经修了",
        images: [],
        replyTo: { url: "https://github.com/baize/demo/issues/7", author: "someone", quote: "出错了" },
      }),
    );
    await server.server.publisher.tick();
    const comment = await publishedPushes(job);

    const requests = s.fake.requests();
    expect(requests.map((request) => request.path)).toEqual([
      "/graphql",
      "/graphql",
      "/repos/baize/demo/issues/7/comments",
    ]);
    expect(requests[1]?.body).toMatchObject({
      variables: { repositoryId: "R_fake", categoryId: "DIC_general", title: "路线图", body: "讨论一下" },
    });
    expect(requests[2]?.body).toEqual({ body: "已经修了" });
    expect(discussion.publication.url).toBe("https://github.com/baize/demo/discussions/101");
    expect(comment.publication.url).toBe("https://github.com/baize/demo/issues/7#issuecomment-102000");
  });

  it("平台回 401 记登录过期，账号跟着记过期，别的错记出错，都推一条没办成", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB, { platform: "x", handle: "no_token" }]);
    const broken = specOf(accountOf(job, "github"), issuePost("会 500"));
    await createApproved(job, broken);
    s.fake.failNext(500);
    await server.server.publisher.tick();
    const plain = await failedPushes(job);
    expect(plain.draft.failure).toBe("error");
    expect(plain.account, "出错不动账号").toBeNull();

    const expired = specOf(accountOf(job, "github"), issuePost("会 401"));
    await createApproved(job, expired);
    s.fake.failNext(401);
    await server.server.publisher.tick();
    const first = await failedPushes(job);
    expect(first.draft.failure).toBe("login_expired");
    expect(first.account).toMatchObject({ id: accountOf(job, "github").id, login: "expired" });

    const tokenless = specOf(accountOf(job, "x"), tweet("没有令牌"));
    await createApproved(job, tokenless);
    await server.server.publisher.tick();
    const missing = await failedPushes(job);
    expect(missing.draft.failure, "读不到令牌当作登录过期").toBe("login_expired");
    expect(missing.account).toMatchObject({ id: accountOf(job, "x").id, login: "expired" });

    const page = await messagesOf(job);
    expect(page.drafts.map((draft) => [draft.status, draft.failure])).toEqual([
      ["failed", "error"],
      ["failed", "login_expired"],
      ["failed", "login_expired"],
    ]);
    expect(page.publications).toEqual([]);
    expect(s.fake.requests()).toHaveLength(2);
  });
});

describe("X 接口带图", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const JPEG = Buffer.from([255, 216, 255, 224, 0, 16]);
  const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
  const BIG = Buffer.concat([PNG, Buffer.alloc(5 * 1000 * 1000)]);

  it("先把每张图传到 X 拿 media_id，再带着 media_id 发帖；GIF 单独一张按 tweet_gif 传", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    const images = [await uploadImage(job, PNG, "image/png"), await uploadImage(job, JPEG, "image/jpeg")];
    await createApproved(job, specOf(x, { ...tweet("带两张图"), images }));
    await server.server.publisher.tick();
    const photos = await publishedPushes(job);
    await createApproved(job, specOf(x, { ...tweet("一张动图"), images: [await uploadImage(job, GIF, "image/gif")] }));
    await server.server.publisher.tick();
    const animated = await publishedPushes(job);

    const bearer = `Bearer ${X.token}`;
    expect(s.fake.requests().map(({ path, authorization, body }) => ({ path, authorization, body }))).toEqual([
      {
        path: "/2/media/upload",
        authorization: bearer,
        body: { media: PNG.toString("base64"), media_category: "tweet_image" },
      },
      {
        path: "/2/media/upload",
        authorization: bearer,
        body: { media: JPEG.toString("base64"), media_category: "tweet_image" },
      },
      {
        path: "/2/tweets",
        authorization: bearer,
        body: { text: "带两张图", media: { media_ids: ["17101", "17102"] } },
      },
      {
        path: "/2/media/upload",
        authorization: bearer,
        body: { media: GIF.toString("base64"), media_category: "tweet_gif" },
      },
      { path: "/2/tweets", authorization: bearer, body: { text: "一张动图", media: { media_ids: ["17104"] } } },
    ]);
    expect(photos.publication.url).toBe("https://x.com/baize_x/status/18103");
    expect(animated.publication.url).toBe("https://x.com/baize_x/status/18105");
  });

  it("第二张图传不上去整条不发帖，草稿记出错，不落发布记录", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    const images = [await uploadImage(job, PNG, "image/png"), await uploadImage(job, JPEG, "image/jpeg")];
    await createApproved(job, specOf(x, { ...tweet("第二张会传失败"), images }));
    let uploads = 0;
    s.fake.failNext(500, (request) => request.path === "/2/media/upload" && ++uploads === 2);
    await server.server.publisher.tick();
    const { draft, account } = await failedPushes(job);

    expect(draft.failure).toBe("error");
    expect(account, "传图出错不动账号").toBeNull();
    expect(
      s.fake.requests().map((request) => request.path),
      "缺图的帖子不发",
    ).toEqual(["/2/media/upload", "/2/media/upload"]);
    expect((await messagesOf(job)).publications).toEqual([]);
  });

  it("超过 4 张、单张超过 5 MB、GIF 和别的图放一起、附件对不上，起草不落，批的时候换成这些回 400", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    const png = await uploadImage(job, PNG, "image/png");
    const big = await uploadImage(job, BIG, "image/png");
    const gif = await uploadImage(job, GIF, "image/gif");
    const tooMany = Array.from({ length: 5 }, () => png);
    sendDraft(job, specOf(x, { ...tweet("五张"), images: tooMany }));
    sendDraft(job, specOf(x, { ...tweet("大图"), images: [big] }));
    sendDraft(job, specOf(x, { ...tweet("动图配图"), images: [gif, png] }));
    sendDraft(job, specOf(x, { ...tweet("指纹对不上"), images: [{ ...png, sha256: "b".repeat(64) }] }));
    const accepted = specOf(x, { ...tweet("一张图"), images: [png] });
    await createDraft(job, accepted);
    expect(
      (await messagesOf(job)).drafts.map((one) => one.id),
      "过不了 X 限制的都没落",
    ).toEqual([accepted.draftId]);

    const refusals: [DraftContent["images"], string][] = [
      [tooMany, "草稿配图不合这个账号：一条最多带 4 张图"],
      [[big], "草稿配图不合这个账号：第 1 张图超过 5 MB"],
      [[png, gif], "草稿配图不合这个账号：GIF 只能单独发一张，不能和别的图放在一条里"],
      [[png, IMAGE], "草稿第 2 张图在控制面上找不到，接口授权的号发不了"],
    ];
    for (const [images, error] of refusals) {
      const response = await job.client.post(`/api/drafts/${accepted.draftId}`, {
        decision: "approve",
        content: { ...tweet("批的时候换图"), images },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    expect((await draftOnPage(job, accepted.draftId)).draft.status).toBe("pending");
    expect(s.fake.requests(), "批之前拒的不打 X").toEqual([]);
  });

  it("X 回 403 说缺 media.write：账号记缺发图权限、登录照旧有效，这条记权限不够；不带图的照发", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    await createApproved(job, specOf(x, { ...tweet("带一张图"), images: [await uploadImage(job, PNG, "image/png")] }));
    s.fake.failNext(403, (request) => request.path === "/2/media/upload", {
      title: "Forbidden",
      type: "https://api.twitter.com/2/problems/client-forbidden",
      status: 403,
      detail: "Forbidden: Missing permission media.write",
    });
    await server.server.publisher.tick();
    const { draft, account, notice } = await failedPushes(job);

    expect(draft.failure).toBe("missing_scope");
    expect(account, "账号推一次新状态，不是过期").toMatchObject({
      id: x.id,
      login: "valid",
      missingScope: "media.write",
    });
    expect(notice.text).toContain("X 账号缺发图权限，重新连接一次就好");
    const listed = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(listed).toEqual([expect.objectContaining({ id: x.id, login: "valid", missingScope: "media.write" })]);

    await createApproved(job, specOf(x, tweet("只有字")));
    await server.server.publisher.tick();
    await publishedPushes(job);
    expect(s.fake.requests().map((request) => request.path)).toEqual(["/2/media/upload", "/2/tweets"]);
  });

  it("X 别的 403 和 GitHub 的 403 都不动账号，只这一条失败，原因写明是平台拒了这一条", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X, GITHUB]);
    await createApproved(job, specOf(accountOf(job, "x"), tweet("和上一条一模一样")));
    s.fake.failNext(403, (request) => request.path === "/2/tweets", {
      title: "Forbidden",
      type: "about:blank",
      status: 403,
      detail: "You are not allowed to create a Tweet with duplicate content.",
    });
    await server.server.publisher.tick();
    const duplicate = await failedPushes(job);
    expect(duplicate.draft.failure).toBe("forbidden");
    expect(duplicate.account, "账号不动").toBeNull();
    expect(duplicate.notice.text).toContain("平台拒绝了这一条，账号授权还有效");

    await createApproved(job, specOf(accountOf(job, "github"), issuePost("没有这个仓库的权限")));
    s.fake.failNext(403, undefined, { message: "Resource not accessible by integration" });
    await server.server.publisher.tick();
    const github = await failedPushes(job);
    expect(github.draft.failure).toBe("forbidden");
    expect(github.account, "账号不动").toBeNull();

    const listed = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(listed.map((one) => [one.platform, one.login, one.missingScope])).toEqual([
      ["x", "valid", null],
      ["github", "valid", null],
    ]);
  });

  it("授权时没给 media.write 的 X 号，带图的稿子发之前就挡下，一条请求都不打；不带图的照发", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [{ ...X, scope: "tweet.read users.read tweet.write offline.access" }]);
    const x = accountOf(job, "x");
    expect(x.missingScope, "挂号那一刻就看得出缺发图权限").toBe("media.write");
    await createApproved(job, specOf(x, { ...tweet("带一张图"), images: [await uploadImage(job, PNG, "image/png")] }));
    await server.server.publisher.tick();
    const blocked = await failedPushes(job);

    expect(blocked.draft.failure).toBe("missing_scope");
    expect(blocked.account, "账号早就记着缺权限，不再推").toBeNull();
    expect(blocked.notice.text).toContain("X 账号缺发图权限，重新连接一次就好");
    expect(s.fake.requests(), "发之前就挡下").toEqual([]);

    await createApproved(job, specOf(x, tweet("只有字")));
    await server.server.publisher.tick();
    await publishedPushes(job);
    expect(s.fake.requests().map((request) => request.path)).toEqual(["/2/tweets"]);
  });

  it("GIF 传上去 X 还在处理：按 check_after_secs 等着查，查到 succeeded 再发帖", async () => {
    const s = await stack();
    const waits: number[] = [];
    const server = await s.serve(undefined, async (ms) => {
      waits.push(ms);
    });
    const job = await jobOn(s, server, [X]);
    await createApproved(
      job,
      specOf(accountOf(job, "x"), { ...tweet("动图"), images: [await uploadImage(job, GIF, "image/gif")] }),
    );
    s.fake.processNextMedia(["pending", "in_progress", "succeeded"], 3);
    await server.server.publisher.tick();
    await publishedPushes(job);

    expect(s.fake.requests().map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /2/media/upload",
      "GET /2/media/upload?command=STATUS&media_id=17101",
      "GET /2/media/upload?command=STATUS&media_id=17101",
      "POST /2/tweets",
    ]);
    expect(s.fake.requests()[3]?.body).toEqual({ text: "动图", media: { media_ids: ["17101"] } });
    expect(waits, "每次等的都是 X 给的 check_after_secs").toEqual([3000, 3000]);
  });

  it("GIF 在 X 那边处理失败，或者一直处理不完等够上限，这一条记传图失败，不发帖", async () => {
    const s = await stack();
    const waits: number[] = [];
    const server = await s.serve(undefined, async (ms) => {
      waits.push(ms);
    });
    const job = await jobOn(s, server, [X]);
    const x = accountOf(job, "x");
    const gif = await uploadImage(job, GIF, "image/gif");
    await createApproved(job, specOf(x, { ...tweet("处理会失败"), images: [gif] }));
    s.fake.processNextMedia(["pending", "failed"], 2);
    await server.server.publisher.tick();
    const failed = await failedPushes(job);
    expect(failed.draft.failure).toBe("media_failed");
    expect(failed.account, "账号不动").toBeNull();
    expect(failed.notice.text).toContain("X 没处理好这张动图");
    expect(waits).toEqual([2000]);

    waits.length = 0;
    await createApproved(job, specOf(x, { ...tweet("一直处理不完"), images: [gif] }));
    s.fake.processNextMedia(["in_progress"], 60);
    await server.server.publisher.tick();
    const stuck = await failedPushes(job);
    expect(stuck.draft.failure).toBe("media_failed");
    expect(waits, "一共只等 5 分钟").toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(
      s.fake.requests().filter((request) => request.path === "/2/tweets"),
      "没处理好的动图不发帖",
    ).toEqual([]);
  });
});

describe("小红书走电脑", () => {
  it("认领后暂停，电脑上报 paused，草稿和通知保留暂停原因；恢复后失败草稿仍不能直接重批", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, {
      kind: "post",
      title: "暂停没发出去",
      text: "这条要等恢复",
      images: [IMAGE],
      github: null,
    });
    await createApproved(job, spec);
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const claim = await job.agent.expect("publish_draft");
    expect((await job.client.post(`/api/bots/${job.botId}/pause`)).status).toBe(200);
    expect(await job.agent.expect("pause")).toEqual({ type: "pause", botId: job.botId });
    expect((await nextOf(job.push, "bot_updated")).bot.runState).toBe("paused");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "paused", detail: "Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿。" },
    });
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      id: spec.draftId,
      status: "failed",
      failure: "paused",
    });
    expect((await nextOf(job.push, "notify")).notice).toMatchObject({
      kind: "failed",
      text: "小红书上的「暂停没发出去」没发出去：Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿",
      groupId: job.groupId,
    });
    expect((await draftOnPage(job, spec.draftId)).draft).toMatchObject({ status: "failed", failure: "paused" });
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json());
    expect(accounts.accounts.find((account) => account.id === xhs.id)?.login).toBe("valid");

    expect((await job.client.post(`/api/bots/${job.botId}/resume`)).status).toBe(200);
    expect(await job.agent.expect("resume")).toEqual({ type: "resume", botId: job.botId });
    expect((await nextOf(job.push, "bot_updated")).bot.runState).toBe("running");
    expect((await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" })).status).toBe(409);
    expect((await draftOnPage(job, spec.draftId)).draft).toMatchObject({ status: "failed", failure: "paused" });
  });

  it("Bot 暂停期间到点的已批草稿不认领，恢复后下一轮才下发", async () => {
    const s = await stack();
    let now = new Date("2026-10-14T01:00:00.000Z");
    const server = await s.serve(() => now);
    const job = await jobOn(s, server, [XHS]);
    const spec = specOf(accountOf(job, "xiaohongshu"), {
      kind: "post",
      title: "暂停期间到点",
      text: "恢复后发布",
      images: [IMAGE],
      github: null,
    });
    const due = { ...spec, scheduledAt: new Date(now.getTime() + MINUTE).toISOString() };
    await createApproved(job, due);
    expect((await job.client.post(`/api/bots/${job.botId}/pause`)).status).toBe(200);
    expect(await job.agent.expect("pause")).toEqual({ type: "pause", botId: job.botId });
    expect((await nextOf(job.push, "bot_updated")).bot).toMatchObject({ id: job.botId, runState: "paused" });
    now = new Date(due.scheduledAt);

    await server.server.publisher.tick();
    expect((await draftOnPage(job, due.draftId)).draft.status).toBe("approved");
    expect(job.agent.received().filter((message) => message.type === "publish_draft")).toEqual([]);

    expect((await job.client.post(`/api/bots/${job.botId}/resume`)).status).toBe(200);
    // resume 是同一连接上的屏障；此前那轮若下发过发布，下一条就不会是 resume。
    expect(await job.agent.next()).toEqual({ type: "resume", botId: job.botId });
    expect((await nextOf(job.push, "bot_updated")).bot).toMatchObject({ id: job.botId, runState: "running" });
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({ id: due.draftId, status: "publishing" });
    const claim = await job.agent.expect("publish_draft");
    expect(claim).toMatchObject({ draftId: due.draftId, botId: job.botId, content: due.content });
    job.agent.send({
      type: "publish_result",
      draftId: due.draftId,
      attempt: claim.attempt,
      result: { status: "ok", url: "https://www.xiaohongshu.com/explore/resumed", externalId: "resumed" },
    });
    await nextOf(job.push, "publication_created");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");
  });

  it("电脑在线就下发 publish_draft，等上行 publish_result 落账", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const content: DraftContent = { kind: "post", title: "上新", text: "图文笔记", images: [IMAGE], github: null };
    const ok = specOf(xhs, content);
    await createApproved(job, ok);

    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const claim = await job.agent.expect("publish_draft");
    expect(claim).toEqual({
      type: "publish_draft",
      draftId: ok.draftId,
      botId: job.botId,
      accountId: xhs.id,
      platform: "xiaohongshu",
      content,
      attempt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    job.agent.send({
      type: "publish_result",
      draftId: ok.draftId,
      attempt: claim.attempt,
      result: { status: "ok", url: "https://www.xiaohongshu.com/explore/abc", externalId: "abc" },
    });
    expect((await nextOf(job.push, "publication_created")).publication.url).toBe(
      "https://www.xiaohongshu.com/explore/abc",
    );
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");

    const changed = specOf(xhs, { ...content, text: "页面改版了" });
    await createApproved(job, changed);
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const changedClaim = await job.agent.expect("publish_draft");
    expect(changedClaim.draftId).toBe(changed.draftId);
    job.agent.send({
      type: "publish_result",
      draftId: changed.draftId,
      attempt: changedClaim.attempt,
      result: { status: "failed", reason: "page_changed", detail: "找不到发布按钮" },
    });
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      status: "failed",
      failure: "page_changed",
    });
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");

    job.agent.send({
      type: "publish_result",
      draftId: ok.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "error", detail: "重复的结果" },
    });
    const sentinel = specOf(xhs, { ...content, text: "哨兵" });
    await createDraft(job, sentinel);
    expect((await draftOnPage(job, ok.draftId)).draft.status, "发完的再收到结果不改").toBe("published");
  });

  it("电脑报上来的结果只认走电脑的平台，走接口在发的草稿它结算不了", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB]);
    const github = accountOf(job, "github");
    const spec = specOf(github, issuePost("走接口的"));
    await createApproved(job, spec);
    const release = s.fake.hold();
    const inflight = server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().length === 1, "请求在途");
    // 伪造的结果带上库里这一次认领的标识，挡它的只剩平台这一条。
    const [claimed] = await s.database.db
      .select({ claimedAt: drafts.claimedAt })
      .from(drafts)
      .where(eq(drafts.id, spec.draftId));
    if (claimed === undefined || claimed.claimedAt === null) throw new Error("草稿没被认领");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claimed.claimedAt.toISOString(),
      result: { status: "ok", url: "https://evil.example/forged", externalId: "forged" },
    });
    await agentCaughtUp(job, github, issuePost("哨兵"));
    expect((await draftOnPage(job, spec.draftId)).draft.status, "电脑报的结果不动走接口的草稿").toBe("publishing");

    release();
    await inflight;
    const { draft, page } = await draftOnPage(job, spec.draftId);
    expect(draft.status).toBe("published");
    expect(page.publications.map((publication) => publication.url)).toEqual([
      "https://github.com/baize/demo/issues/101",
    ]);
  });

  it("超时记失败、改稿重批再被抢，旧那次的 failed 和 ok 晚到都不改新那次", async () => {
    const s = await stack();
    let offset = 0;
    const server = await s.serve(() => new Date(Date.now() + offset));
    const job = await jobOn(s, server, [XHS]);
    const content: DraftContent = { kind: "post", title: "上新", text: "第一次", images: [IMAGE], github: null };
    const spec = specOf(accountOf(job, "xiaohongshu"), content);
    await createApproved(job, spec);

    await server.server.publisher.tick();
    const first = await job.agent.expect("publish_draft");
    expect(first.content).toMatchObject({ text: "第一次" });
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    offset = 11 * MINUTE;
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft, "在途超过十分钟记失败").toMatchObject({
      status: "failed",
      failure: "error",
    });
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");

    editByBot(job, spec.draftId, { ...content, text: "第二次" });
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      status: "pending",
      content: { text: "第二次" },
    });
    await approve(job, spec.draftId);
    await server.server.publisher.tick();
    const second = await job.agent.expect("publish_draft");
    expect(second.content).toMatchObject({ text: "第二次" });
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: first.attempt,
      result: { status: "failed", reason: "error", detail: "第一次那次超时了" },
    });
    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: first.attempt,
      result: { status: "ok", url: "https://www.xiaohongshu.com/explore/first", externalId: "first" },
    });
    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: second.attempt,
      result: { status: "ok", url: "https://www.xiaohongshu.com/explore/second", externalId: "second" },
    });
    expect(
      (await nextOf(job.push, "publication_created")).publication.url,
      "第一次那次的 failed 和 ok 晚到，都不结算第二次",
    ).toBe("https://www.xiaohongshu.com/explore/second");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");
    const { draft, page } = await draftOnPage(job, spec.draftId);
    expect({ status: draft.status, urls: page.publications.map((one) => one.url) }).toEqual({
      status: "published",
      urls: ["https://www.xiaohongshu.com/explore/second"],
    });
    expect(second.attempt, "两次认领的标识不同").not.toBe(first.attempt);
  });

  it("读不到笔记 id 时 externalId 为 null，publications 记下 null", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const spec = specOf(accountOf(job, "xiaohongshu"), {
      kind: "post",
      title: "读不到",
      text: "发出去了但管理页上没找到",
      images: [IMAGE],
      github: null,
    });
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "ok", url: XHS_MANAGE_URL, externalId: null },
    });
    expect((await nextOf(job.push, "publication_created")).publication.url).toBe(XHS_MANAGE_URL);
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");
    const rows = await s.database.db
      .select({ externalId: publications.externalId })
      .from(publications)
      .where(eq(publications.draftId, spec.draftId));
    expect(rows).toEqual([{ externalId: null }]);
  });

  it("电脑报上来的链接只认 https、默认端口、小红书域名，放行的落规范化后的串，别的换成笔记管理页", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    // 反斜杠这条浏览器解析成小红书，Python 的 urlsplit 解析成 evil.example：落原串的话换个消费方就指到别的站。
    const backslash = "https://www.xiaohongshu.com\\@evil.example/";
    const reported = [
      ["https://evil.example/forged", XHS_MANAGE_URL],
      ["http://www.xiaohongshu.com/explore/plain", XHS_MANAGE_URL],
      ["https://www.xiaohongshu.com:8443/explore/port", XHS_MANAGE_URL],
      [backslash, "https://www.xiaohongshu.com/@evil.example/"],
      ["https://xiaohongshu.com.evil.example/explore/suffix", XHS_MANAGE_URL],
      ["https://evilxiaohongshu.com/explore/prefix", XHS_MANAGE_URL],
      ["javascript:alert(1)//xiaohongshu.com", XHS_MANAGE_URL],
      [
        "https://www.xiaohongshu.com/explore/signed?xsec_token=t",
        "https://www.xiaohongshu.com/explore/signed?xsec_token=t",
      ],
      ["https://xiaohongshu.com/explore/bare", "https://xiaohongshu.com/explore/bare"],
    ] as const;
    const cases = reported.map(([url, expected], index) => ({
      url,
      expected,
      spec: specOf(xhs, { kind: "post", title: `第 ${index} 条`, text: "正文", images: [IMAGE], github: null }),
    }));
    for (const { spec } of cases) await createApproved(job, spec);
    await server.server.publisher.tick();
    const attempts = new Map<string, string>();
    for (let received = 0; received < cases.length; received += 1) {
      const claim = await job.agent.expect("publish_draft");
      attempts.set(claim.draftId, claim.attempt);
    }

    for (const [index, { url, spec }] of cases.entries()) {
      job.agent.send({
        type: "publish_result",
        draftId: spec.draftId,
        attempt: attempts.get(spec.draftId) ?? "",
        result: { status: "ok", url, externalId: `note-${index}` },
      });
    }
    await waitFor(
      async () => (await messagesOf(job)).drafts.every((draft) => draft.status === "published"),
      "每条都按 ok 结算",
    );
    const { publications: landed } = await messagesOf(job);
    const urlOf = new Map(landed.map((one) => [one.draftId, one.url]));
    expect(cases.map(({ spec }) => urlOf.get(spec.draftId))).toEqual(cases.map(({ expected }) => expected));
    for (const url of urlOf.values()) {
      expect(new URL(url).hostname, `落账的 ${url} 主机是小红书`).toMatch(/(^|\.)xiaohongshu\.com$/);
    }
  });

  it("格式无效的可靠 publish_result 被拒并累计确认，日志只记安全摘要", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, { kind: "post", title: "旧版", text: "新旧混跑", images: [IMAGE], github: null });
    await createApproved(job, spec);
    await server.server.publisher.tick();
    await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    const logged = captureConsole();
    const seq = job.agent.sendMalformedReliable({
      type: "publish_result",
      draftId: spec.draftId,
      result: { status: "ok", url: "https://www.xiaohongshu.com/explore/private-url", externalId: "private-id" },
    });
    const malformed = await openAgent(server.server.port);
    malformed.socket.send('{"type":"publish_result"');
    await malformed.closed();
    await waitFor(async () => job.agent.uplinkAcks().some((ack) => ack.upTo >= seq), "无效 publish_result 被确认");
    expect(job.agent.uplinkAcks().flatMap((ack) => ack.rejected)).toContainEqual({ seq, code: "invalid" });
    await agentCaughtUp(job, xhs, { kind: "post", title: "哨兵", text: "哨兵", images: [], github: null });

    expect((await draftOnPage(job, spec.draftId)).draft.status, "不合形状的结果不结算").toBe("publishing");
    expect(logged.map((line) => logLine(line)).map(({ time: _time, ...line }) => line)).toEqual(
      expect.arrayContaining([
        {
          level: "warn",
          msg: "上行 publish_result 被拒收 invalid",
          computerId: job.computer.computerId,
          seq,
          fields: "body.attempt",
        },
        { level: "warn", msg: "未握手的连接 报的不是 JSON，丢弃" },
      ]),
    );
    expect(logged).toHaveLength(2);
    for (const secret of ["private-url", "private-id", spec.draftId]) {
      expect(logged.join("\n"), "日志不带报文正文").not.toContain(secret);
    }
  });

  it("电脑断线宽限期内仍认领草稿并把 publish_draft 留在 outbox", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const spec = specOf(accountOf(job, "xiaohongshu"), {
      kind: "post",
      title: "离线",
      text: "电脑关着",
      images: [],
      github: null,
    });
    await createApproved(job, spec);
    job.agent.close();
    expect((await nextOf(job.push, "computer_updated")).computer.status).toBe("sleeping");

    await server.server.publisher.tick();
    expect((await draftOnPage(job, spec.draftId)).draft.status).toBe("publishing");
    const queued = await s.database.sql<{ type: string }[]>`
      SELECT body->>'type' AS type FROM agent_outbox WHERE computer_id = ${job.computer.computerId}
    `;
    expect(queued).toContainEqual({ type: "publish_draft" });
  });
});

const post = (text: string): DraftContent => ({ kind: "post", title: text, text, images: [], github: null });

describe("X 走电脑", () => {
  it("电脑浏览器登录的 X 能带图，草稿下发到电脑、不打接口；授权连上的 X 带电脑上的路径图被拒", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X, X_WEB]);
    const api = accountOf(job, "x", "api");
    const web = accountOf(job, "x", "computer");
    sendDraft(job, specOf(api, { ...tweet("接口带图"), images: [IMAGE] }));
    const content: DraftContent = { kind: "post", title: null, text: "带图的推", images: [IMAGE], github: null };
    const spec = specOf(web, content);
    await createApproved(job, spec);
    expect(
      (await messagesOf(job)).drafts.map((one) => one.id),
      "接口那一行带图的草稿没落",
    ).toEqual([spec.draftId]);

    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const claim = await job.agent.expect("publish_draft");
    expect(claim).toMatchObject({ draftId: spec.draftId, accountId: web.id, platform: "x", content });
    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "ok", url: "https://x.com/baize_x/status/1900", externalId: "1900" },
    });
    expect((await nextOf(job.push, "publication_created")).publication.url).toBe("https://x.com/baize_x/status/1900");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");
    expect(s.fake.requests(), "走电脑的 X 不打 X 接口").toEqual([]);
  });

  it("同一个号两种连法的草稿各走各的：接口那条打接口，电脑那条下发给电脑", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X, X_WEB]);
    const viaApi = specOf(accountOf(job, "x", "api"), tweet("走接口"));
    const viaComputer = specOf(accountOf(job, "x", "computer"), tweet("走浏览器"));
    await createApproved(job, viaApi);
    await createApproved(job, viaComputer);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect(claim.draftId).toBe(viaComputer.draftId);
    await waitFor(async () => (await draftOnPage(job, viaApi.draftId)).draft.status === "published", "接口那条发完");
    expect(s.fake.requests().map(({ body }) => body)).toEqual([{ text: "走接口" }]);
  });

  it("电脑报上来的 X 链接只认 https 的 x.com，twitter.com 和别的站都换成首页", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [X_WEB]);
    const web = accountOf(job, "x", "computer");
    const reported = [
      ["https://x.com/baize_x/status/1", "https://x.com/baize_x/status/1"],
      ["https://twitter.com/baize_x/status/2", X_HOME],
      ["https://evil.example/baize_x/status/3", X_HOME],
      ["http://x.com/baize_x/status/4", X_HOME],
      ["https://x.com.evil.example/status/5", X_HOME],
    ] as const;
    const cases = reported.map(([url, expected], index) => ({
      url,
      expected,
      spec: specOf(web, tweet(`第 ${index} 条`)),
    }));
    for (const { spec } of cases) await createApproved(job, spec);
    await server.server.publisher.tick();
    const attempts = new Map<string, string>();
    for (let received = 0; received < cases.length; received += 1) {
      const claim = await job.agent.expect("publish_draft");
      attempts.set(claim.draftId, claim.attempt);
    }
    for (const [index, { url, spec }] of cases.entries()) {
      job.agent.send({
        type: "publish_result",
        draftId: spec.draftId,
        attempt: attempts.get(spec.draftId) ?? "",
        result: { status: "ok", url, externalId: `${index}` },
      });
    }
    await waitFor(
      async () => (await messagesOf(job)).drafts.every((draft) => draft.status === "published"),
      "每条都按 ok 结算",
    );
    const urlOf = new Map((await messagesOf(job)).publications.map((one) => [one.draftId, one.url]));
    expect(cases.map(({ spec }) => urlOf.get(spec.draftId))).toEqual(cases.map(({ expected }) => expected));
  });
});

describe("电脑浏览器里已经登上、账号页不知道", () => {
  it("批了的稿子卡在没确认登上的 X 号上：发布循环让那台电脑静默查一次，报登上了就记成已登录、下一轮发出去；五分钟内不重复查", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, []);
    const created = await job.client.post("/api/accounts", { platform: "x", computerId: job.computer.computerId });
    expect(created.status).toBe(201);
    const placeholder = AccountResponse.parse(await created.json()).account;
    expect(placeholder.login, "账号页建出来的是占位").toBe("none");
    await nextOf(job.push, "account_updated");
    await job.agent.expect("config");
    const spec = specOf(placeholder, tweet("在 Bot 的浏览器里登过"));
    await createApproved(job, spec);

    await server.server.publisher.tick();
    const check = await job.agent.expect("login_check");
    expect(check).toEqual({ type: "login_check", accountId: placeholder.id, platform: "x" });
    await server.server.publisher.tick();
    await job.client.post(`/api/bots/${job.botId}/pause`);
    await job.agent.expect("pause");
    expect(
      job.agent.received().filter((frame) => frame.type === "login_check" || frame.type === "publish_draft"),
      "第二轮没登上不抢稿，五分钟内也不再查",
    ).toEqual([]);
    await job.client.post(`/api/bots/${job.botId}/resume`);
    await job.agent.expect("resume");

    job.agent.send({ type: "login_state", accountId: placeholder.id, state: { login: "valid", handle: "baize_x" } });
    const config = await job.agent.expect("config");
    expect(config.accounts.find((one) => one.id === placeholder.id)).toMatchObject({
      login: "valid",
      handle: "baize_x",
    });
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect(claim.draftId, "登上之后这条已批的稿子照常发").toBe(spec.draftId);
  });
});

describe("小红书登录过期", () => {
  it("小红书草稿只下发到账号所在的电脑", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const spec = specOf(accountOf(job, "xiaohongshu"), post("只在本机发"));
    await createApproved(job, spec);
    const remote = ComputerTokenResponse.parse(await (await job.client.post("/api/computers/remote")).json());
    const { agent: other } = await helloAgent(server.server.port, remote.computerId, remote.token);
    cleanups.push(async () => other.close());

    await server.server.publisher.tick();
    expect((await job.agent.expect("publish_draft")).draftId).toBe(spec.draftId);
    // 改档给两台电脑都重发 config：远程电脑下一条收到的是它，说明发布那条没给它。
    expect((await job.client.patch(`/api/accounts/${spec.accountId}`, { tier: "draft" })).status).toBe(200);
    expect((await other.next()).type, "远程电脑没收到 publish_draft").toBe("config");
  });

  it("账号过期后，这个账号的已批草稿不再下发，别的账号的草稿照发", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS, { platform: "xiaohongshu", handle: "小号" }]);
    const [main, spare] = job.accounts;
    if (main === undefined || spare === undefined) throw new Error("两个小红书账号没挂上");

    job.agent.send({ type: "login_state", accountId: main.id, state: { login: "expired" } });
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: main.id, login: "expired" });
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");
    expect((await job.agent.expect("config")).accounts.find((one) => one.id === main.id)?.login).toBe("expired");

    const stuck = specOf(main, post("过期账号的稿"));
    const other = specOf(spare, post("另一个账号的稿"));
    await createApproved(job, stuck);
    await createApproved(job, other);

    await server.server.publisher.tick();
    const claimed = await nextOf(job.push, "draft_updated");
    expect(claimed.draft, "只抢了没过期那个账号的稿").toMatchObject({ id: other.draftId, status: "publishing" });
    expect((await job.agent.expect("publish_draft")).draftId).toBe(other.draftId);
    expect((await draftOnPage(job, stuck.draftId)).draft.status, "过期账号的稿留在已批，等重新登录").toBe("approved");
    expect((await job.agent.expect("login_check")).accountId, "卡着的那个号让电脑看一眼浏览器是不是已经登回来了").toBe(
      main.id,
    );

    job.agent.send({ type: "login_state", accountId: main.id, state: { login: "valid", handle: XHS.handle } });
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: main.id, login: "valid" });
    await job.agent.expect("config");
    await server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({ id: stuck.draftId, status: "publishing" });
    expect((await job.agent.expect("publish_draft")).draftId, "重新登录后下一轮照常抢").toBe(stuck.draftId);
  });

  it("发布回 login_expired 在前、账号报 expired 在后，账号记 expired，用户只收到一条通知", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("被挤下线"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "跳到了登录页" },
    });
    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    // 同一条连接上再报一次登录窗口出错，它的通知一定排在前面那些推送之后。
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
    });

    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(seen.map((pushed) => pushed.type)).toEqual([
      "draft_updated",
      "draft_updated",
      "account_updated",
      "notify",
      "account_updated",
      "login_failed",
      "notify",
    ]);
    const notices = seen.flatMap((pushed) => (pushed.type === "notify" ? [pushed.notice] : []));
    expect(notices[0], "草稿那条就是这次唯一的通知，账号过期不再另推一条").toMatchObject({
      kind: "failed",
      groupId: job.groupId,
      text: "小红书上的「被挤下线」没发出去：账号登录过期了，重新登录后让 Bot 再起一稿",
    });
    expect(seen[2]?.type === "account_updated" && seen[2].account).toMatchObject({ id: xhs.id, login: "expired" });
    expect((await job.agent.expect("config")).accounts.find((one) => one.id === xhs.id)?.login).toBe("expired");
    const today = TodayResponse.parse(await (await job.client.get("/api/today")).json());
    expect(today.pending.some((item) => item.kind === "account" && item.account.id === xhs.id)).toBe(true);
  });

  it("账号报 expired 在前、发布回 login_expired 在后，草稿照样记失败，用户只收到账号那一条通知", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("先报过期"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");

    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "跳到了登录页" },
    });
    // 同一条连接上再报一次登录窗口出错，它的通知一定排在前面那些推送之后。
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
    });

    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(seen.map((pushed) => pushed.type)).toEqual([
      "draft_updated",
      "account_updated",
      "notify",
      "draft_updated",
      "account_updated",
      "login_failed",
      "notify",
    ]);
    const notices = seen.flatMap((pushed) => (pushed.type === "notify" ? [pushed.notice] : []));
    expect(notices.slice(0, -1), "账号那条先到就是这次唯一的通知，草稿失败不再另推一条").toEqual([
      expect.objectContaining({ kind: "failed", groupId: null, text: expect.stringContaining("登录过期了") }),
    ]);
    expect(seen[1]?.type === "account_updated" && seen[1].account).toMatchObject({ id: xhs.id, login: "expired" });
    expect(seen[3]?.type === "draft_updated" && seen[3].draft, "草稿照样结算成失败").toMatchObject({
      id: spec.draftId,
      status: "failed",
      failure: "login_expired",
    });
  });

  it("账号过期期间重启仍保留已批稿，重登后照常下发", async () => {
    const s = await stack();
    const old = await s.serve(() => new Date(Date.now() - 20 * MINUTE));
    const job = await jobOn(s, old, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: xhs.id, login: "expired" });
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");
    await job.agent.expect("config");
    const waiting = specOf(xhs, post("等重新登录"), new Date(Date.now() + 60 * MINUTE).toISOString());
    await createApproved(job, waiting);
    job.close();
    await old.close();

    // 到点时刻和批准时刻都早于新进程的启动时刻减一轮，账号若是 valid 就算停机期间错过了。
    const restarted = await s.serve(() => new Date(Date.now() + 120 * MINUTE));
    const { agent } = await helloAgent(restarted.server.port, job.computer.computerId, job.computer.token);
    cleanups.push(async () => agent.close());
    const after = await reconnect(job, restarted);
    expect(
      (await draftOnPage(after, waiting.draftId)).draft,
      "过期账号的稿在重启时不打回待批，留着等重新登录",
    ).toMatchObject({ status: "approved" });

    agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
    expect((await nextOf(after.push, "account_updated")).account).toMatchObject({ id: xhs.id, login: "valid" });
    await agent.expect("config");
    await restarted.server.publisher.tick();
    expect((await nextOf(after.push, "draft_updated")).draft).toMatchObject({
      id: waiting.draftId,
      status: "publishing",
    });
    expect((await agent.expect("publish_draft")).draftId, "重新登录后下一轮照常下发").toBe(waiting.draftId);
  });

  it("旧 attempt 在重登 valid 后才回 login_expired，账号保持 valid，不推过期通知", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("重登之前发的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    expect((await nextOf(job.push, "account_updated")).account.login).toBe("expired");
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");
    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
    const relogged = (await nextOf(job.push, "account_updated")).account;
    expect(relogged.login).toBe("valid");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "重登之前跳到了登录页" },
    });
    // 同一条连接上再报一次登录窗口出错，它的通知一定排在前面那些推送之后。
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
    });

    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(
      seen.map((pushed) => pushed.type),
      "旧 attempt 只结算旧草稿，不动账号、不推过期通知",
    ).toEqual(["draft_updated", "account_updated", "login_failed", "notify"]);
    expect(
      seen[1]?.type === "account_updated" && seen[1].account,
      "唯一的账号快照是那次登录窗口失败，账号仍是 valid",
    ).toMatchObject({
      id: xhs.id,
      login: "valid",
      lastLoginFailure: { reason: "window_failed" },
    });
    expect(seen[0]?.type === "draft_updated" && seen[0].draft).toMatchObject({
      id: spec.draftId,
      status: "failed",
      failure: "login_expired",
    });
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(
      accounts.find((one) => one.id === xhs.id),
      "认领之后已经重登，账号保持重登后的样子，只多了哨兵那次登录窗口失败",
    ).toEqual({ ...relogged, lastLoginFailure: { reason: "window_failed", at: expect.any(String) } });
  });

  it("认领后账号从 valid 直接重登成 valid，旧 attempt 晚到的 login_expired 只记草稿失败，账号仍是 valid", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("重登之前发的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    // 账号一直是 valid，用户在电脑上又扫了一次码：login 没变，只有会话换了一代。
    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
    const relogged = (await nextOf(job.push, "account_updated")).account;
    expect(relogged.login).toBe("valid");
    expect((await job.agent.expect("config")).accounts.find((one) => one.id === xhs.id)?.login).toBe("valid");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "重登之前跳到了登录页" },
    });
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-2") },
    });

    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(
      seen.map((pushed) => pushed.type),
      "旧 attempt 只结算旧草稿，新会话不算过期，不推过期快照也不推过期通知",
    ).toEqual(["draft_updated", "account_updated", "login_failed", "notify"]);
    expect(
      seen[1]?.type === "account_updated" && seen[1].account,
      "唯一的账号快照是那次登录窗口失败，账号仍是 valid",
    ).toMatchObject({
      id: xhs.id,
      login: "valid",
      lastLoginFailure: { reason: "window_failed" },
    });
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(accounts.find((one) => one.id === xhs.id)?.login, "valid 重登到 valid 之后账号还是 valid").toBe("valid");
  });

  it("0016 之前认领的草稿（认领代次为 null）：账号 valid 重登成 valid 后旧 attempt 的 login_expired 不改账号", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("迁移之前认领的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    await claimedBeforeMigration(s, spec);

    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
    expect((await nextOf(job.push, "account_updated")).account.login).toBe("valid");
    await job.agent.expect("config");

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "重登之前跳到了登录页" },
    });
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-3") },
    });
    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(
      seen.map((pushed) => pushed.type),
      "认领代次为 null 的按迁移基线第 1 代算，重登后已是第 2 代，旧结论不改账号、不推过期通知",
    ).toEqual(["draft_updated", "account_updated", "login_failed", "notify"]);
    expect(
      seen[1]?.type === "account_updated" && seen[1].account,
      "唯一的账号快照是那次登录窗口失败，账号仍是 valid",
    ).toMatchObject({
      id: xhs.id,
      login: "valid",
      lastLoginFailure: { reason: "window_failed" },
    });
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(accounts.find((one) => one.id === xhs.id)?.login).toBe("valid");
  });

  it("0016 之前认领的草稿：滚动升级期间旧控制面把过期账号重登成 valid 不推进代次，认领时刻仍挡住旧 login_expired", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("迁移之前认领的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    await claimedBeforeMigration(s, spec);

    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    expect((await nextOf(job.push, "account_updated")).account.login).toBe("expired");
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");
    await job.agent.expect("config");
    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
    expect((await nextOf(job.push, "account_updated")).account.login).toBe("valid");
    await job.agent.expect("config");
    // 旧控制面记登录成功时不认识 login_generation，那一列停在迁移基线上。
    await s.database.db.update(accountsTable).set({ loginGeneration: 1 }).where(eq(accountsTable.id, xhs.id));

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "重登之前跳到了登录页" },
    });
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-4") },
    });
    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(
      seen.map((pushed) => pushed.type),
      "代次对不上时看认领时刻：登录时刻晚于认领，旧结论不改账号",
    ).toEqual(["draft_updated", "account_updated", "login_failed", "notify"]);
    expect(
      seen[1]?.type === "account_updated" && seen[1].account,
      "唯一的账号快照是那次登录窗口失败，账号仍是 valid",
    ).toMatchObject({
      id: xhs.id,
      login: "valid",
      lastLoginFailure: { reason: "window_failed" },
    });
    const listed = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(listed.find((one) => one.id === xhs.id)?.login).toBe("valid");
  });

  it("0016 之前认领的草稿：记登录成功的那个进程时钟慢一小时，登录时刻取库时钟，认领之后的重登照样挡住旧 login_expired", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [XHS]);
    const xhs = accountOf(job, "xiaohongshu");
    const spec = specOf(xhs, post("迁移之前认领的"));
    await createApproved(job, spec);
    await server.server.publisher.tick();
    const claim = await job.agent.expect("publish_draft");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    await claimedBeforeMigration(s, spec);

    job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "expired" } });
    expect((await nextOf(job.push, "account_updated")).account.login).toBe("expired");
    expect((await nextOf(job.push, "notify")).notice.kind).toBe("failed");
    await job.agent.expect("config");
    const skewed = Date.now() - 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(skewed);
      job.agent.send({ type: "login_state", accountId: xhs.id, state: { login: "valid", handle: XHS.handle } });
      expect((await nextOf(job.push, "account_updated")).account.login).toBe("valid");
      await job.agent.expect("config");
    } finally {
      vi.useRealTimers();
    }
    await s.database.db.update(accountsTable).set({ loginGeneration: 1 }).where(eq(accountsTable.id, xhs.id));

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
      attempt: claim.attempt,
      result: { status: "failed", reason: "login_expired", detail: "重登之前跳到了登录页" },
    });
    job.agent.send({
      type: "login_state",
      accountId: xhs.id,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-5") },
    });
    const seen: ServerPush[] = [];
    for (;;) {
      const next = await job.push.next();
      seen.push(next);
      if (next.type === "notify" && next.notice.text.includes("登录窗口")) break;
    }
    expect(
      seen.map((pushed) => pushed.type),
      "登录时刻和认领时刻都出自库时钟，进程时钟慢了也看得出重登在认领之后，旧结论不改账号",
    ).toEqual(["draft_updated", "account_updated", "login_failed", "notify"]);
    expect(
      seen[1]?.type === "account_updated" && seen[1].account,
      "唯一的账号快照是那次登录窗口失败，账号仍是 valid",
    ).toMatchObject({
      id: xhs.id,
      login: "valid",
      lastLoginFailure: { reason: "window_failed" },
    });
    const listed = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(listed.find((one) => one.id === xhs.id)?.login).toBe("valid");
  });
});
