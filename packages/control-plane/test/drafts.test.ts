import { randomUUID } from "node:crypto";
import {
  AccountListResponse,
  ApprovePlanResponse,
  ContentPlanId,
  DecideDraftResponse,
  ReturnPlanResponse,
  TodayResponse,
  type DraftSpec,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccount } from "../src/repo/accounts.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import {
  IMAGE,
  contentJob,
  createDraft,
  draftOnPage,
  issuePost,
  messagesOf,
  newDraftId,
  nextOf,
  sendDraft,
  setTier,
  specOf,
  tweet,
  type ContentJob,
} from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";

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

const GITHUB = { platform: "github", handle: "baize-dev", token: "ghp_unit" } as const;
const X = { platform: "x", handle: "baize_x", token: "x-unit" } as const;

async function withJob(test: (job: ContentJob) => Promise<void>): Promise<void> {
  const job = await contentJob(server, database.db, [GITHUB, X]);
  try {
    await test(job);
  } finally {
    job.close();
  }
}

function proposePlan(job: ContentJob, specs: readonly DraftSpec[], title = "本周计划") {
  const planId = ContentPlanId.parse(randomUUID());
  job.agent.send({
    type: "plan_propose",
    runId: job.runId,
    botId: job.botId,
    groupId: job.groupId,
    planId,
    title,
    drafts: [...specs],
  });
  return planId;
}

describe("账号", () => {
  it("列出自己的账号，改档读回新值，小红书不许设成可直接发布", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      const listed = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json());
      expect(listed.accounts.map((account) => [account.platform, account.handle, account.tier, account.login])).toEqual(
        [
          ["github", "baize-dev", "confirm_publish", "valid"],
          ["x", "baize_x", "confirm_publish", "valid"],
        ],
      );

      await setTier(job, github, "direct_publish");
      const reread = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json());
      expect(reread.accounts.find((account) => account.id === github.id)?.tier).toBe("direct_publish");

      const xhs = await addAccount(database.db, {
        ownerId: job.user.id,
        computerId: job.computer.computerId,
        platform: "xiaohongshu",
        handle: "白泽",
      });
      const refused = await job.client.patch(`/api/accounts/${xhs.id}`, { tier: "direct_publish" });
      expect(refused.status).toBe(400);
      const afterRefusal = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json());
      expect(afterRefusal.accounts.find((account) => account.id === xhs.id)?.tier).toBe("confirm_publish");
    });
  });

  it("别人的账号列不出来，也改不了", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      const other = await contentJob(server, database.db, []);
      try {
        const listed = AccountListResponse.parse(await (await other.client.get("/api/accounts")).json());
        expect(listed.accounts).toEqual([]);
        expect((await other.client.patch(`/api/accounts/${github.id}`, { tier: "read_only" })).status).toBe(404);
      } finally {
        other.close();
      }
    });
  });
});

describe("起草", () => {
  it("只读档的账号不能建草稿", async () => {
    await withJob(async (job) => {
      const [github, x] = job.accounts;
      if (github === undefined || x === undefined) throw new Error("没挂上账号");
      await setTier(job, github, "read_only");
      const refused = specOf(github, issuePost("只读档写的"));
      sendDraft(job, refused);
      const accepted = specOf(x, tweet("可以发的"));
      const draft = await createDraft(job, accepted);
      expect(draft.status).toBe("pending");

      const page = await messagesOf(job);
      expect(page.drafts.map((one) => one.id)).toEqual([accepted.draftId]);
    });
  });

  it("可直接发布档的草稿建出来就是已批", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      await setTier(job, github, "direct_publish");
      const spec = specOf(github, issuePost("直接发"));
      const created = await createDraft(job, spec);
      expect(created.status).toBe("approved");
      expect(created.decidedAt).not.toBeNull();
      const { draft } = await draftOnPage(job, spec.draftId);
      expect(draft.status).toBe("approved");
    });
  });

  it("GitHub 草稿带图被拒收", async () => {
    await withJob(async (job) => {
      const [github, x] = job.accounts;
      if (github === undefined || x === undefined) throw new Error("没挂上账号");
      sendDraft(job, specOf(github, { ...issuePost("带图的 issue"), images: [IMAGE] }));
      sendDraft(job, specOf(x, { ...tweet("带图的推"), images: [IMAGE] }));
      proposePlan(job, [
        specOf(x, tweet("计划里没图的")),
        specOf(github, { ...issuePost("计划里带图的"), images: [IMAGE] }),
      ]);
      const accepted = specOf(github, issuePost("不带图的"));
      await createDraft(job, accepted);

      const page = await messagesOf(job);
      expect(
        page.drafts.map((one) => one.id),
        "带图的草稿和带图的整份计划都没落",
      ).toEqual([accepted.draftId]);
      expect(page.plans).toEqual([]);

      const withImage = await job.client.post(`/api/drafts/${accepted.draftId}`, {
        decision: "approve",
        content: { ...issuePost("批的时候加图"), images: [IMAGE] },
      });
      expect(withImage.status).toBe(400);
      expect((await draftOnPage(job, accepted.draftId)).draft.status).toBe("pending");
    });
  });

  it("别人的账号不能用来起草，重复的 draftId 不再出卡", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      const other = await contentJob(server, database.db, [{ platform: "github", handle: "someone-else" }]);
      try {
        const [theirs] = other.accounts;
        if (theirs === undefined) throw new Error("没挂上账号");
        sendDraft(job, specOf(theirs, issuePost("拿别人的账号")));
        const spec = specOf(x, tweet("第一次"));
        await createDraft(job, spec);
        sendDraft(job, spec);
        const sentinel = specOf(x, tweet("哨兵"));
        await createDraft(job, sentinel);
        const page = await messagesOf(job);
        expect(page.drafts.map((one) => one.id)).toEqual([spec.draftId, sentinel.draftId]);
      } finally {
        other.close();
      }
    });
  });
});

describe("人的决定", () => {
  it("批过的草稿被 Bot 改过后重新待批", async () => {
    await withJob(async (job) => {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      const spec = specOf(github, issuePost("第一版"));
      await createDraft(job, spec);
      const approved = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
      expect(approved.status).toBe(200);
      expect(DecideDraftResponse.parse(await approved.json()).draft.status).toBe("approved");
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("approved");

      job.agent.send({
        type: "draft_edit",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        draftId: spec.draftId,
        content: issuePost("第一版"),
      });
      job.agent.send({
        type: "draft_edit",
        runId: job.runId,
        botId: job.botId,
        groupId: job.groupId,
        draftId: spec.draftId,
        content: issuePost("Bot 改过的第二版"),
      });
      const unchanged = await nextOf(job.push, "draft_updated");
      expect(unchanged.draft.status, "改成一模一样的内容不打回").toBe("approved");
      const reopened = await nextOf(job.push, "draft_updated");
      expect(reopened.draft).toMatchObject({ status: "pending", decidedAt: null, failure: null });

      const { draft } = await draftOnPage(job, spec.draftId);
      expect(draft).toMatchObject({ status: "pending", decidedAt: null });
      expect(draft.content.text).toBe("Bot 改过的第二版");
    });
  });

  it("打回之后读回 returned，第二次决定回 409，别人的草稿回 404", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      const spec = specOf(x, tweet("要打回的"));
      await createDraft(job, spec);
      const returned = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "return" });
      expect(returned.status).toBe(200);
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("returned");
      expect((await draftOnPage(job, spec.draftId)).draft.status).toBe("returned");

      expect((await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" })).status).toBe(409);
      const other = await contentJob(server, database.db, []);
      try {
        expect((await other.client.post(`/api/drafts/${spec.draftId}`, { decision: "return" })).status).toBe(404);
      } finally {
        other.close();
      }
      expect((await draftOnPage(job, spec.draftId)).draft.status).toBe("returned");
    });
  });

  it("批一份计划后五条都不再问", async () => {
    await withJob(async (job) => {
      const [github, x] = job.accounts;
      if (github === undefined || x === undefined) throw new Error("没挂上账号");
      const specs = [
        specOf(github, issuePost("周一"), "2026-09-28T01:00:00.000Z"),
        specOf(x, tweet("周二"), "2026-09-29T01:00:00.000Z"),
        specOf(x, tweet("周三"), "2026-09-30T01:00:00.000Z"),
        specOf(github, issuePost("周四"), "2026-10-01T01:00:00.000Z"),
        specOf(x, tweet("周五"), null),
      ];
      const planId = proposePlan(job, specs);
      for (const spec of specs) expect((await nextOf(job.push, "draft_updated")).draft.id).toBe(spec.draftId);
      const proposed = await nextOf(job.push, "plan_updated");
      expect(proposed.plan.draftIds, "计划里的草稿按 Bot 排的顺序").toEqual(specs.map((spec) => spec.draftId));
      const card = await nextOf(job.push, "message");
      expect(card.message.body).toEqual({ kind: "plan", planId });

      const before = TodayResponse.parse(await (await job.client.get("/api/today")).json());
      expect(
        before.pending.map((item) => item.kind),
        "计划下的草稿只随计划出现",
      ).toEqual(["plan"]);

      const [first, second] = specs;
      if (first === undefined || second === undefined) throw new Error("计划是空的");
      const outsider = await job.client.post(`/api/plans/${planId}/approve`, {
        edits: [{ draftId: newDraftId(), content: tweet("不在计划里的") }],
      });
      expect(outsider.status).toBe(400);

      const approved = await job.client.post(`/api/plans/${planId}/approve`, {
        edits: [{ draftId: second.draftId, content: tweet("周二改过") }],
      });
      expect(approved.status).toBe(200);
      const body = ApprovePlanResponse.parse(await approved.json());
      expect(body.plan.status).toBe("approved");
      expect(body.drafts.map((draft) => draft.status)).toEqual(Array(5).fill("approved"));
      expect((await nextOf(job.push, "plan_updated")).plan.status).toBe("approved");
      for (let index = 0; index < 5; index += 1) {
        expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("approved");
      }

      const page = await messagesOf(job);
      expect(page.plans.map((plan) => [plan.id, plan.status])).toEqual([[planId, "approved"]]);
      expect(page.drafts.map((draft) => draft.status)).toEqual(Array(5).fill("approved"));
      const edited = page.drafts.find((draft) => draft.id === second.draftId);
      expect(edited?.content.text).toBe("周二改过");
      expect(edited?.edits.map((edit) => ({ before: edit.before, after: edit.after }))).toEqual([
        { before: "周二", after: "周二改过" },
      ]);

      const after = TodayResponse.parse(await (await job.client.get("/api/today")).json());
      expect(after.pending, "批完之后五条都不再等确认").toEqual([]);
      expect((await job.client.post(`/api/plans/${planId}/approve`, { edits: [] })).status).toBe(409);
      expect((await job.client.post(`/api/drafts/${first.draftId}`, { decision: "approve" })).status).toBe(409);
    });
  });

  it("退回计划，计划和它的草稿一起退，读回 returned", async () => {
    await withJob(async (job) => {
      const x = job.accounts.find((account) => account.platform === "x");
      if (x === undefined) throw new Error("没挂上账号");
      const specs = [specOf(x, tweet("一")), specOf(x, tweet("二"))];
      const planId = proposePlan(job, specs, "要退的计划");
      await nextOf(job.push, "draft_updated");
      await nextOf(job.push, "draft_updated");
      await nextOf(job.push, "plan_updated");
      await nextOf(job.push, "message");

      const returned = await job.client.post(`/api/plans/${planId}/return`, {});
      expect(returned.status).toBe(200);
      expect(ReturnPlanResponse.parse(await returned.json()).plan.status).toBe("returned");
      expect((await nextOf(job.push, "plan_updated")).plan.status).toBe("returned");
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("returned");
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("returned");

      const page = await messagesOf(job);
      expect(page.plans.map((plan) => plan.status)).toEqual(["returned"]);
      expect(page.drafts.map((draft) => draft.status)).toEqual(["returned", "returned"]);
      expect((await job.client.post(`/api/plans/${planId}/return`, {})).status).toBe(409);
    });
  });
});
