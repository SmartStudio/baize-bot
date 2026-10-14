import { randomUUID } from "node:crypto";
import { DecideDraftResponse, type ControlToAgent } from "@baize/shared";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { contentJob, createDraft, draftOnPage, nextOf, specOf, type ContentJob } from "./helpers/content.js";
import { createTestDb } from "./helpers/db.js";
import { waitFor } from "./helpers/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(disconnectGraceMs: number) {
  const database = await createTestDb();
  cleanups.push(() => database.close());
  let offset = 0;
  const running = await startServer({
    db: database.db,
    port: 0,
    toolSecretKey: "a".repeat(64),
    credentialsKey: TEST_CREDENTIALS_KEY,
    config: { ...DEFAULT_RUNTIME_CONFIG, githubApiBaseUrl: "http://127.0.0.1:9", xApiBaseUrl: "http://127.0.0.1:9" },
    disconnectGraceMs,
    publisher: { now: () => new Date(Date.now() + offset), intervalMs: 24 * 60 * 60 * 1000 },
  });
  const server: TestServer = {
    server: running,
    client: () => new ApiClient(running.port),
    close: () => running.close(),
  };
  cleanups.push(() => server.close());
  const job = await contentJob(server, database.db, [{ platform: "xiaohongshu", handle: "离线发布验收" }]);
  cleanups.push(async () => job.close());
  const account = job.accounts[0];
  if (account === undefined) throw new Error("账号没建出来");
  const spec = specOf(account, { kind: "post", title: "离线稿", text: "不可陈旧补发", images: [], github: null });
  await createDraft(job, spec);
  const response = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
  expect(response.status).toBe(200);
  expect(DecideDraftResponse.parse(await response.json()).draft.status).toBe("approved");
  await nextOf(job.push, "draft_updated");
  job.agent.close();
  await job.agent.closed();
  expect((await nextOf(job.push, "computer_updated")).computer.status).toBe("sleeping");
  await running.publisher.tick();
  expect((await draftOnPage(job, spec.draftId)).draft.status).toBe("publishing");
  return {
    database,
    running,
    job,
    account,
    spec,
    advance: () => {
      offset = 11 * 60_000;
    },
  };
}

async function reconnect(job: ContentJob, port: number) {
  const connected = await helloAgent(port, job.computer.computerId, job.computer.token);
  cleanups.push(async () => connected.agent.close());
  await job.client.post(`/api/bots/${job.botId}/pause`);
  await connected.agent.expect("pause");
  return connected;
}

it("宽限到期清空全部下行：晚重连不补发旧 publish_draft 和 browser_login", async () => {
  const s = await fixture(1_000);
  expect((await s.job.client.post(`/api/accounts/${s.account.id}/login`, { attempt: randomUUID() })).status).toBe(202);
  const before = await s.database.sql<
    { body: ControlToAgent }[]
  >`SELECT body FROM agent_outbox WHERE computer_id = ${s.job.computer.computerId} ORDER BY seq`;
  expect(before.map(({ body }) => body.type)).toEqual(["publish_draft", "browser_login"]);
  await waitFor(async () => {
    const rows = await s.database.sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM runs WHERE id = ${s.job.runId}`;
    return rows[0]?.ended_at !== null && rows[0] !== undefined;
  }, "宽限到期放弃 run");
  const rows = await s.database.sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.job.computer.computerId}`;
  expect(rows[0]?.count).toBe(0);
  const page = await draftOnPage(s.job, s.spec.draftId);
  expect(
    page.page.messages
      .filter(({ body }) => body.kind === "system")
      .map(({ body }) => (body.kind === "system" ? body.text : "")),
  ).toEqual(["电脑断过线，这次活没做完"]);
  const connected = await reconnect(s.job, s.running.port);
  expect(
    connected.agent.received().filter((frame) => frame.type === "publish_draft" || frame.type === "browser_login"),
  ).toEqual([]);
});

it("草稿记失败即清 publish_draft：仍在宽限内重连也不能交付旧认领", async () => {
  const s = await fixture(60_000);
  const before = await s.database.sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.job.computer.computerId} AND body->>'type' = 'publish_draft'`;
  expect(before[0]?.count).toBe(1);
  s.advance();
  await s.running.publisher.tick();
  expect((await draftOnPage(s.job, s.spec.draftId)).draft).toMatchObject({ status: "failed", failure: "error" });
  const stillOpen = await s.database.sql<
    { ended_at: Date | null }[]
  >`SELECT ended_at FROM runs WHERE id = ${s.job.runId}`;
  expect(stillOpen[0]?.ended_at, "宽限尚未结束，旧 run 仍在").toBeNull();
  const remaining = await s.database.sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM agent_outbox WHERE computer_id = ${s.job.computer.computerId}`;
  expect(remaining[0]?.count).toBe(0);
  const connected = await reconnect(s.job, s.running.port);
  expect(connected.agent.received().filter((frame) => frame.type === "publish_draft")).toEqual([]);
});
