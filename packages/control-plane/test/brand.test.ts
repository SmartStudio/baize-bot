import { randomUUID } from "node:crypto";
import { BrandResponse, ContentPlanId, GrantListResponse, type UpdateBrandRequest } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { contentJob, createDraft, issuePost, nextOf, specOf, tweet, type ContentJob } from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly agent: AgentClient;
  readonly push: PushClient;
  close(): void;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  expect(config.brand, "没写过手册时 config.brand 是 null").toBeNull();
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    computer,
    agent,
    push,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

type BookBody = Omit<UpdateBrandRequest, "version">;

const BOOK: BookBody = {
  facts: "白泽明理，做企业内部的多 Bot 协作。",
  voice: "短句，不用感叹号。",
  taboo: "不提竞品名字。",
  assetsDir: null,
  edits: [],
};

/** version 是「基于哪一版改的」，还没有手册传 0。 */
const putBrand = (client: ApiClient, body: BookBody, version: number) =>
  client.request("PUT", "/api/brand", { ...body, version });

async function readBrand(client: ApiClient) {
  const response = await client.get("/api/brand");
  expect(response.status).toBe(200);
  return BrandResponse.parse(await response.json()).brand;
}

async function withJob(test: (job: ContentJob) => Promise<void>): Promise<void> {
  const job = await contentJob(server, database.db, [
    { platform: "github", handle: "baize-dev", token: "ghp_unit" },
    { platform: "x", handle: "baize_x", token: "x-unit" },
  ]);
  try {
    await test(job);
  } finally {
    job.close();
  }
}

describe("品牌手册", () => {
  it("改手册后下一份 config 带新 version", async () => {
    const me = await owner();
    try {
      expect((await putBrand(me.client, BOOK, 0)).status).toBe(200);
      const first = await nextOf(me.push, "brand_updated");
      expect(first.brand).toMatchObject({ voice: BOOK.voice, version: 1 });
      const firstConfig = await me.agent.expect("config");
      expect(firstConfig.brand?.version).toBe(1);
      expect(firstConfig.brand?.text).toContain("短句，不用感叹号。");

      expect((await putBrand(me.client, { ...BOOK, voice: "口语一点，可以用感叹号。" }, 1)).status).toBe(200);
      expect((await nextOf(me.push, "brand_updated")).brand.version).toBe(2);
      const secondConfig = await me.agent.expect("config");
      expect(secondConfig.brand?.version, "每写一次 version 加一，运行器据此重送").toBe(2);
      expect(secondConfig.brand?.text).toContain("口语一点，可以用感叹号。");
      expect(secondConfig.brand?.text).not.toContain("短句，不用感叹号。");
      expect((await readBrand(me.client))?.version).toBe(2);
    } finally {
      me.close();
    }
  });

  it("批准一条改过字的草稿后手册多一条改动", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      const spec = specOf(x, tweet("我们的产品非常好用！"));
      await createDraft(job, spec);

      const approved = await job.client.post(`/api/drafts/${spec.draftId}`, {
        decision: "approve",
        content: tweet("产品好用。"),
      });
      expect(approved.status).toBe(200);
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("approved");
      const pushed = await nextOf(job.push, "brand_updated");
      const edit = { draftId: spec.draftId, before: "我们的产品非常好用！", after: "产品好用。" };
      expect(pushed.brand.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([edit]);
      const config = await job.agent.expect("config");
      expect(config.brand?.version).toBe(pushed.brand.version);
      expect(config.brand?.text, "改过的地方要随手册下发给 Bot").toContain("产品好用。");

      const brand = await readBrand(job.client);
      expect(brand?.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([edit]);
    });
  });

  it("批一份计划时改过字的那条也进手册，没改的不进", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      const kept = specOf(x, tweet("周一照发"));
      const changed = specOf(x, tweet("周二原稿"));
      const planId = ContentPlanId.parse(randomUUID());
      job.agent.send({
        type: "plan_propose",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        planId,
        title: "本周计划",
        drafts: [kept, changed],
      });
      await nextOf(job.push, "draft_updated");
      await nextOf(job.push, "draft_updated");
      await nextOf(job.push, "plan_updated");
      await nextOf(job.push, "message");

      const approved = await job.client.post(`/api/plans/${planId}/approve`, {
        edits: [{ draftId: changed.draftId, content: tweet("周二改稿") }],
      });
      expect(approved.status).toBe(200);
      await nextOf(job.push, "plan_updated");
      await nextOf(job.push, "draft_updated");
      await nextOf(job.push, "draft_updated");
      const pushed = await nextOf(job.push, "brand_updated");
      expect(pushed.brand.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([
        { draftId: changed.draftId, before: "周二原稿", after: "周二改稿" },
      ]);
    });
  });

  it("同一条草稿批两次只记一次", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      const spec = specOf(github, issuePost("本周修了三个问题！"));
      await createDraft(job, spec);
      const humanVersion = issuePost("本周修了三个问题。");

      expect(
        (await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve", content: humanVersion })).status,
      ).toBe(200);
      await nextOf(job.push, "draft_updated");
      const once = await nextOf(job.push, "brand_updated");
      expect(once.brand.edits).toHaveLength(1);

      job.agent.send({
        type: "draft_edit",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        draftId: spec.draftId,
        content: issuePost("本周修了三个问题！"),
      });
      expect((await nextOf(job.push, "draft_updated")).draft.status, "Bot 改回原稿，草稿重新待批").toBe("pending");
      expect(
        (await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve", content: humanVersion })).status,
      ).toBe(200);
      const again = await nextOf(job.push, "draft_updated");
      expect(again.draft.edits, "草稿自己的改动记录照记两笔").toHaveLength(2);

      expect((await putBrand(job.client, { ...BOOK, edits: once.brand.edits }, once.brand.version)).status).toBe(200);
      const next = await nextOf(job.push, "brand_updated");
      expect(next.brand.version, "第二次批准没有新改动，不该推手册也不该涨 version").toBe(once.brand.version + 1);
      expect(next.brand.edits).toHaveLength(1);
      expect((await readBrand(job.client))?.edits).toHaveLength(1);
    });
  });

  it("手册里的改动被删掉后，同样的改动再批一次重新记一笔", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      const spec = specOf(github, issuePost("上线了！快来用！"));
      await createDraft(job, spec);
      const humanVersion = issuePost("上线了。");
      const edit = { draftId: spec.draftId, before: "上线了！快来用！", after: "上线了。" };

      expect(
        (await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve", content: humanVersion })).status,
      ).toBe(200);
      await nextOf(job.push, "draft_updated");
      const learned = await nextOf(job.push, "brand_updated");
      expect(learned.brand.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([edit]);

      expect((await putBrand(job.client, { ...BOOK, edits: [] }, learned.brand.version)).status).toBe(200);
      const removed = await nextOf(job.push, "brand_updated");
      expect(removed.brand.edits, "人在手册里删掉了这条").toEqual([]);

      job.agent.send({
        type: "draft_edit",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        draftId: spec.draftId,
        content: issuePost("上线了！快来用！"),
      });
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("pending");
      expect(
        (await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve", content: humanVersion })).status,
      ).toBe(200);
      await nextOf(job.push, "draft_updated");
      const relearned = await nextOf(job.push, "brand_updated");
      expect(relearned.brand.version, "删掉后再批是新的信号，手册涨版").toBe(removed.brand.version + 1);
      expect(relearned.brand.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([edit]);
    });
  });

  it("version 超出库里能存的范围回 400，范围内的旧版本仍回 409", async () => {
    const me = await owner();
    try {
      expect((await putBrand(me.client, BOOK, 0)).status).toBe(200);
      expect((await nextOf(me.push, "brand_updated")).brand.version).toBe(1);

      expect((await putBrand(me.client, { ...BOOK, voice: "越界" }, 2147483647)).status, "加一就超出 integer").toBe(
        400,
      );
      expect((await putBrand(me.client, { ...BOOK, voice: "到顶" }, 2147483646)).status, "最大合法值，只是对不上").toBe(
        409,
      );
      expect((await readBrand(me.client))?.version).toBe(1);

      expect((await putBrand(me.client, { ...BOOK, voice: "正常保存" }, 1)).status).toBe(200);
      const next = await nextOf(me.push, "brand_updated");
      expect(next.brand.version, "前两次都没有写也没有推").toBe(2);
      expect(next.brand.voice).toBe("正常保存");
    } finally {
      me.close();
    }
  });

  it("基于旧版本的保存回 409，新追加的改动还在", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      expect((await putBrand(job.client, BOOK, 0)).status).toBe(200);
      await nextOf(job.push, "brand_updated");
      expect((await putBrand(job.client, BOOK, 0)).status, "已经有手册了，再按「还没有」建回 409").toBe(409);
      const opened = await readBrand(job.client);
      if (opened === null) throw new Error("手册没写进去");

      const spec = specOf(x, tweet("限时抢购！！"));
      await createDraft(job, spec);
      expect(
        (await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve", content: tweet("限时优惠。") }))
          .status,
      ).toBe(200);
      await nextOf(job.push, "draft_updated");
      expect((await nextOf(job.push, "brand_updated")).brand.version).toBe(opened.version + 1);

      const { facts, taboo, assetsDir, edits } = opened;
      const stale = await putBrand(
        job.client,
        { facts, voice: "拿旧版改的口吻", taboo, assetsDir, edits },
        opened.version,
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "手册刚被更新过，请刷新后再改" });

      const kept = await readBrand(job.client);
      expect(kept?.version, "409 不涨 version").toBe(opened.version + 1);
      expect(kept?.voice).toBe(BOOK.voice);
      expect(kept?.edits.map(({ draftId, before, after }) => ({ draftId, before, after }))).toEqual([
        { draftId: spec.draftId, before: "限时抢购！！", after: "限时优惠。" },
      ]);

      expect((await putBrand(job.client, { ...BOOK, voice: "刷新后再改" }, opened.version + 1)).status).toBe(200);
      const next = await nextOf(job.push, "brand_updated");
      expect(next.brand.version, "409 那次没有推送，下一条就是刷新后的这次").toBe(opened.version + 2);
    });
  });

  it("手册超 8000 字回 400", async () => {
    const me = await owner();
    try {
      const atLimit = { ...BOOK, facts: "事".repeat(4000), voice: "声".repeat(2000), taboo: "忌".repeat(2000) };
      expect((await putBrand(me.client, atLimit, 0)).status, "四段加起来正好 8000 字可以存").toBe(200);
      expect((await nextOf(me.push, "brand_updated")).brand.version).toBe(1);

      const over = await putBrand(me.client, { ...atLimit, taboo: "忌".repeat(2001) }, 1);
      expect(over.status).toBe(400);
      expect(((await over.json()) as { error: string }).error).toContain("8000");
      const overByFolder = await putBrand(me.client, { ...atLimit, assetsDir: "/素材" }, 1);
      expect(overByFolder.status, "素材文件夹也算在 8000 字里").toBe(400);

      const stored = await readBrand(me.client);
      expect(stored?.version, "超长的那次没有写进去").toBe(1);
      expect(stored?.taboo).toHaveLength(2000);
    } finally {
      me.close();
    }
  });

  it("别人的手册读不到", async () => {
    const mine = await owner();
    const theirs = await owner();
    try {
      expect((await putBrand(mine.client, BOOK, 0)).status).toBe(200);
      await nextOf(mine.push, "brand_updated");
      expect((await mine.agent.expect("config")).brand?.version).toBe(1);

      expect(await readBrand(theirs.client), "别人看自己的手册仍是空的").toBeNull();
      expect((await putBrand(theirs.client, { ...BOOK, facts: "别人家的公司", voice: "别人的口吻" }, 0)).status).toBe(
        200,
      );
      const theirConfig = await theirs.agent.expect("config");
      expect(theirConfig.brand?.version, "别人的手册从自己的第 1 版起").toBe(1);
      expect(theirConfig.brand?.text).not.toContain(BOOK.facts);

      expect((await readBrand(mine.client))?.voice, "别人写手册不碰我这本").toBe(BOOK.voice);
    } finally {
      mine.close();
      theirs.close();
    }
  });

  it("素材文件夹和授权路径同一上限：1024 字可以存，1025 字回 400 且什么都不发生", async () => {
    const me = await owner();
    try {
      const tooLong = { ...BOOK, assetsDir: "/" + "a".repeat(1024) };
      expect((await putBrand(me.client, tooLong, 0)).status).toBe(400);
      expect(await readBrand(me.client), "超长的那次没有建手册").toBeNull();
      const none = GrantListResponse.parse(await (await me.client.get("/api/grants")).json());
      expect(none.grants, "也没有建授权").toEqual([]);

      const atLimit = "/" + "a".repeat(1023);
      expect((await putBrand(me.client, { ...BOOK, assetsDir: atLimit }, 0)).status).toBe(200);
      expect((await nextOf(me.push, "brand_updated")).brand.version, "超长那次没有推页面").toBe(1);
      const config = await me.agent.expect("config");
      expect(config.brand?.version, "超长那次也没有发 config").toBe(1);
      expect(config.grants).toEqual([
        expect.objectContaining({ target: { kind: "path", computerId: me.computer.computerId, prefix: atLimit } }),
      ]);
      const listed = GrantListResponse.parse(await (await me.client.get("/api/grants")).json());
      expect(listed.grants).toHaveLength(1);
    } finally {
      me.close();
    }
  });

  it("设了素材文件夹就给本机建一条读授权，重复保存不再多建", async () => {
    const me = await owner();
    try {
      expect(
        (await putBrand(me.client, { ...BOOK, assetsDir: "relative/素材" }, 0)).status,
        "素材文件夹要绝对路径",
      ).toBe(400);
      expect((await putBrand(me.client, { ...BOOK, assetsDir: "/Users/chen/素材" }, 0)).status).toBe(200);
      const config = await me.agent.expect("config");
      const expected = {
        scope: "forever",
        action: "read",
        target: { kind: "path", computerId: me.computer.computerId, prefix: "/Users/chen/素材" },
      };
      expect(config.grants).toEqual([expect.objectContaining(expected)]);
      expect(config.brand?.text).toContain("/Users/chen/素材");

      expect((await putBrand(me.client, { ...BOOK, voice: "换个口吻", assetsDir: "/Users/chen/素材" }, 1)).status).toBe(
        200,
      );
      const listed = GrantListResponse.parse(await (await me.client.get("/api/grants")).json());
      expect(listed.grants).toEqual([expect.objectContaining(expected)]);
    } finally {
      me.close();
    }
  });
});
