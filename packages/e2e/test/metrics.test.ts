import { describe, expect, it } from "vitest";
import { BotListResponse, CreateGroupResponse, GroupResponse, type TopicTask } from "@baize/shared";
import { startFakePlatforms } from "../src/fake-platforms.js";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

async function nextTask(stack: Stack, groupId: string): Promise<TopicTask> {
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "task_updated" && push.task.groupId === groupId) return push.task;
  }
}

describe("端到端：GitHub 星数自动取样", () => {
  it("同格多次扫描只读一次、不改样本、不推更新，下一格再读并经 WebSocket 推 520", async () => {
    const fake = await startFakePlatforms();
    const upstream = await startUpstream(() => ({ textChunks: ["收到"], usage: { input: 1, output: 1 } }));
    let stack: Stack | undefined;
    let now = new Date();
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        githubApiBaseUrl: fake.githubBaseUrl,
        metricsNow: () => now,
        startComputer: false,
      });
      const account = await stack.addAccount({
        platform: "github",
        handle: fake.handles.github,
        token: "gh-e2e-metrics",
      });
      const bots = BotListResponse.parse(await stack.get("/api/bots")).items.slice(0, 2);
      expect(bots).toHaveLength(2);
      const { group, task } = CreateGroupResponse.parse(
        await stack.post("/api/groups", { title: "星数自动取样", botIds: bots.map((item) => item.bot.id) }),
      );
      await stack.patch(`/api/tasks/${task.id}`, {
        goal: { target: 1000, unit: "星", dueAt: null },
        metricSource: { kind: "github_stars", accountId: account.id, repo: "baize/demo" },
      });
      expect((await nextTask(stack, group.id)).metric).toBeNull();
      const currentTask = async () => GroupResponse.parse(await stack!.get(`/api/groups/${group.id}`)).task;
      const reads = () => fake.requests().filter((request) => request.path === "/repos/baize/demo");

      fake.setGithubStars("baize/demo", 500);
      await stack.metricsTick();
      const first = await nextTask(stack, group.id);
      expect(first.metric?.current, "真实控制面经 WebSocket 推自动读回的 500").toBe(500);
      expect((await currentTask()).metric).toEqual(first.metric);
      expect(reads()).toMatchObject([{ method: "GET", authorization: "Bearer gh-e2e-metrics" }]);

      fake.setGithubStars("baize/demo", 520);
      await stack.metricsTick();
      await stack.metricsTick();
      expect(reads(), "同格反复扫描不再访问平台").toHaveLength(1);
      expect((await currentTask()).metric, "HTTP 读到的样本连时间也没有变化").toEqual(first.metric);
      // PATCH 的推送作为屏障；扫描如果错误推了更新，必定排在这条前面，不靠等待超时断言没有推送。
      await stack.patch(`/api/tasks/${task.id}`, { summary: "同格推送屏障" });
      const barrier = await nextTask(stack, group.id);
      expect(barrier.summary, "同格扫描没有额外 task_updated").toBe("同格推送屏障");
      expect(barrier.metric).toEqual(first.metric);

      const windowMs = 6 * 60 * 60 * 1_000;
      now = new Date((Math.floor(now.getTime() / windowMs) + 1) * windowMs);
      await stack.metricsTick();
      const next = await nextTask(stack, group.id);
      expect(next.metric?.current).toBe(520);
      expect(next.metric?.sampledAt).toBe(now.toISOString());
      expect((await currentTask()).metric).toEqual(next.metric);
      expect(reads()).toHaveLength(2);
    } finally {
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });
});
