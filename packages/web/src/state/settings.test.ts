import { describe, expect, it } from "vitest";
import { BotId, Grant, type ToolConnection } from "@baize/shared";
import { reduceSettings } from "./settings.js";
import type { ReadyState } from "./types.js";

const grant = Grant.parse({
  id: "grant_1",
  scope: "forever",
  action: "write_workspace",
  target: { kind: "path", computerId: "cmp_local", prefix: "/workspace" },
  createdAt: "2026-09-26T08:00:00.000Z",
});

// 授权这几条动作只读写 grants 和 revokedGrantIds，别的字段用不上。
const initial = { grants: [grant], revokedGrantIds: [] } as unknown as ReadyState;

describe("授权列表", () => {
  it("列表请求在途时收到撤销，晚到的列表不把撤掉的那行带回来", () => {
    const deleted = reduceSettings(initial, { type: "grant_deleted", grantId: grant.id });
    const loaded = reduceSettings(deleted, { type: "grants_loaded", grants: [grant] });
    expect(loaded.grants).toEqual([]);
  });

  it("撤掉之后晚到的决定结果也不把它加回来", () => {
    const deleted = reduceSettings(initial, { type: "grant_deleted", grantId: grant.id });
    expect(reduceSettings(deleted, { type: "grant_upserted", grant }).grants).toEqual([]);
  });
});

describe("插件快照和本会话删掉的 Bot", () => {
  it("删 Bot 之前发出的请求晚到，快照里挂着的已删 Bot 剔掉，新旧插件都一样", () => {
    const gone = BotId.parse("bot_gone");
    const kept = BotId.parse("bot_service");
    const state = { tools: [], deletedBotIds: [gone] } as unknown as ReadyState;
    const tool = { id: "tool_a", assignedBotIds: [gone, kept] } as unknown as ToolConnection;
    const added = reduceSettings(state, { type: "tool_upserted", tool });
    expect(added.tools.map((row) => row.assignedBotIds)).toEqual([[kept]]);
    const replaced = reduceSettings(added, { type: "tool_upserted", tool });
    expect(replaced.tools.map((row) => row.assignedBotIds)).toEqual([[kept]]);
  });
});
