import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Computer, LiveSession, MessageBody, MessageId, ToolCallStatus } from "@baize/shared";
import type { ContentBook } from "../../state/types.js";
import type { ContentActions } from "./DraftCards.js";
import { TakeoverCard } from "./TakeoverCard.js";

const LIVE_ID = "00000000-0000-4000-8000-00000000000a";
const REASON = "知乎要登录，请扫码或用短信登录，登好后点交还";

const remote = Computer.parse({
  id: "cmp_remote",
  ownerId: "usr_1",
  kind: "remote",
  status: "online",
  host: "remote.baize.dev",
  idleSince: null,
  lastSeenAt: "2026-10-14T10:00:00.000Z",
});

const session = LiveSession.parse({
  liveId: LIVE_ID,
  purpose: { kind: "takeover", botId: "bot_service", groupId: "grp_service", reason: REASON },
  origin: "https://www.zhihu.com",
  computerId: "cmp_remote",
});

const call = (status: ToolCallStatus) => {
  const body = MessageBody.parse({
    kind: "tool_call",
    runId: "run_1",
    botId: "bot_service",
    tool: "browser_ask_user",
    view: { kind: "takeover", liveId: LIVE_ID, reason: REASON },
    status,
    durationMs: status === "running" ? null : 1200,
  });
  if (body.kind !== "tool_call" || body.view.kind !== "takeover") throw new Error("不是接手的工具调用");
  return { body, view: body.view };
};

const book = (live: boolean): ContentBook => ({
  drafts: {},
  plans: {},
  accounts: {},
  computers: { [remote.id]: remote },
  publications: {},
  logins: {},
  live: live ? { [session.liveId]: { ...session, id: session.liveId } } : {},
  takeover: null,
  stamps: {},
});

const actions: ContentActions = {
  decideDraft: vi.fn(() => Promise.resolve()),
  approvePlan: vi.fn(() => Promise.resolve()),
  returnPlan: vi.fn(() => Promise.resolve()),
  loginAccount: vi.fn(() => Promise.resolve()),
  openTakeover: vi.fn(() => Promise.resolve()),
};

const render = (status: ToolCallStatus, live: boolean) =>
  renderToStaticMarkup(
    <TakeoverCard
      messageId={MessageId.parse("msg_1")}
      {...call(status)}
      botName="小服"
      content={book(live)}
      actions={actions}
      selected={false}
      onInspect={() => undefined}
    />,
  );

const result = (html: string) => html.match(/data-testid="takeover-result">([^<]+)</)?.[1] ?? null;

describe("TakeoverCard", () => {
  it("画面还在：写哪个 Bot、原话和电脑，「打开画面」可点", () => {
    const html = render("running", true);
    expect(html).toContain("<b>小服请你接手这一页</b>");
    expect(html).toContain(REASON);
    expect(html).toContain("页面开在远程电脑 remote.baize.dev");
    expect(html).toContain('data-testid="takeover-open"');
    expect(html).toContain(">打开画面</button>");
    expect(result(html)).toBeNull();
  });

  it("画面没了、工具调用成功：写「已交还」，不给打开", () => {
    const html = render("ok", false);
    expect(result(html)).toBe("已交还");
    expect(html).not.toContain('data-testid="takeover-open"');
    expect(html, "原话照样留在卡上").toContain(REASON);
  });

  it("画面没了、工具调用失败：写「没接手」", () => {
    const html = render("failed", false);
    expect(result(html)).toBe("没接手");
    expect(html).not.toContain('data-testid="takeover-open"');
  });

  it("工具调用还在跑、画面却不在：写「画面还没出来」，不给打开", () => {
    const html = render("running", false);
    expect(result(html)).toBe("画面还没出来");
    expect(html).not.toContain('data-testid="takeover-open"');
    expect(html, "画面不在就不知道页面在哪台电脑上").not.toContain("页面开在");
  });

  it("开检查器的按钮和「打开画面」并排，不套在一起", () => {
    const html = render("running", true);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/);
  });
});
