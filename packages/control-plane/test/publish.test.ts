import { randomBytes } from "node:crypto";
import { format } from "node:util";
import {
  DecideDraftResponse,
  TodayResponse,
  type Account,
  type DraftContent,
  type DraftId,
  type DraftSpec,
} from "@baize/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialCrypto, saveAccessToken } from "../src/credentials.js";
import { startFakePlatforms, type FakePlatforms } from "../src/fake-platforms.js";
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
  type AccountSpec,
  type ContentJob,
} from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, waitFor } from "./helpers/fixtures.js";
import { connectPush } from "./helpers/ws.js";

const GITHUB = { platform: "github", handle: "baize-dev", token: "ghp_publish_secret_1" } as const;
const X = { platform: "x", handle: "baize_x", token: "x_publish_secret_2" } as const;
const XHS = { platform: "xiaohongshu", handle: "白泽" } as const;
const MINUTE = 60_000;

type Clock = () => Date;

/** 每条用例一个库：发布循环扫的是全库，别的用例留下的已批草稿会被它一起抢走。 */
type Stack = {
  readonly database: TestDb;
  readonly fake: FakePlatforms;
  serve(now?: Clock): Promise<TestServer>;
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
    serve: async (now) => {
      const server = await startTestServer(
        database.db,
        { githubApiBaseUrl: fake.githubBaseUrl, xApiBaseUrl: fake.xBaseUrl },
        undefined,
        undefined,
        now === undefined ? undefined : { now },
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

function accountOf(job: ContentJob, platform: Account["platform"]): Account {
  const account = job.accounts.find((one) => one.platform === platform);
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

async function failedPushes(job: ContentJob) {
  expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
  const failed = (await nextOf(job.push, "draft_updated")).draft;
  expect(failed.status).toBe("failed");
  const notice = (await nextOf(job.push, "notify")).notice;
  expect(notice.kind).toBe("failed");
  expect(notice.groupId).toBe(job.groupId);
  return { draft: failed, notice };
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
    await saveAccessToken(s.database.db, staleKey, github.id, token);
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

  it("平台回 401 记登录过期，别的错记出错，都推一条没办成", async () => {
    const s = await stack();
    const server = await s.serve();
    const job = await jobOn(s, server, [GITHUB, { platform: "x", handle: "no_token" }]);
    const expired = specOf(accountOf(job, "github"), issuePost("会 401"));
    await createApproved(job, expired);
    s.fake.failNext(401);
    await server.server.publisher.tick();
    const first = await failedPushes(job);
    expect(first.draft.failure).toBe("login_expired");

    const broken = specOf(accountOf(job, "github"), issuePost("会 500"));
    await createApproved(job, broken);
    s.fake.failNext(500);
    await server.server.publisher.tick();
    expect((await failedPushes(job)).draft.failure).toBe("error");

    const tokenless = specOf(accountOf(job, "x"), tweet("没有令牌"));
    await createApproved(job, tokenless);
    await server.server.publisher.tick();
    expect((await failedPushes(job)).draft.failure, "读不到令牌当作登录过期").toBe("login_expired");

    const page = await messagesOf(job);
    expect(page.drafts.map((draft) => [draft.status, draft.failure])).toEqual([
      ["failed", "login_expired"],
      ["failed", "error"],
      ["failed", "login_expired"],
    ]);
    expect(page.publications).toEqual([]);
    expect(s.fake.requests()).toHaveLength(2);
  });
});

describe("小红书走电脑", () => {
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
    expect(await job.agent.expect("publish_draft")).toEqual({
      type: "publish_draft",
      draftId: ok.draftId,
      accountId: xhs.id,
      platform: "xiaohongshu",
      content,
    });
    job.agent.send({
      type: "publish_result",
      draftId: ok.draftId,
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
    expect((await job.agent.expect("publish_draft")).draftId).toBe(changed.draftId);
    job.agent.send({
      type: "publish_result",
      draftId: changed.draftId,
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

    job.agent.send({
      type: "publish_result",
      draftId: spec.draftId,
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

  it("电脑不在线不抢，草稿留在已批", async () => {
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
    expect((await draftOnPage(job, spec.draftId)).draft.status).toBe("approved");
  });
});
