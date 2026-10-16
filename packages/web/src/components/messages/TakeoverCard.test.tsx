import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Computer, LiveSession, MessageBody, MessageId, ToolCallStatus } from "@baize/shared";
import { EMPTY_CONTENT, reduceContent } from "../../state/content.js";
import { createClock } from "../../state/stamped.js";
import type { ContentBook, ReadyState } from "../../state/types.js";
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
  dispatchable: true,
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

type Screen = "open" | "put_away" | "unseen";

// 画面表照网页收推送的路子造：put_away 是会话推来过、又收到 live_closed；unseen 是这一页从没收到过这个会话。
const book = (screen: Screen): ContentBook => {
  const next = createClock();
  let state = { content: { ...EMPTY_CONTENT, computers: { [remote.id]: remote } } } as unknown as ReadyState;
  if (screen !== "unseen") state = reduceContent(state, { type: "live_upserted", session, seq: next() });
  if (screen === "put_away")
    state = reduceContent(state, { type: "live_removed", liveId: session.liveId, seq: next() });
  return state.content;
};

const actions: ContentActions = {
  decideDraft: vi.fn(() => Promise.resolve()),
  approvePlan: vi.fn(() => Promise.resolve()),
  returnPlan: vi.fn(() => Promise.resolve()),
  loginAccount: vi.fn(() => Promise.resolve()),
  openTakeover: vi.fn(() => Promise.resolve()),
};

const render = (status: ToolCallStatus, screen: Screen) =>
  renderToStaticMarkup(
    <TakeoverCard
      messageId={MessageId.parse("msg_1")}
      {...call(status)}
      botName="小服"
      content={book(screen)}
      actions={actions}
      selected={false}
      onInspect={() => undefined}
    />,
  );

const result = (html: string) => html.match(/data-testid="takeover-result">([^<]+)</)?.[1] ?? null;

describe("TakeoverCard", () => {
  it("画面还在：写哪个 Bot、原话和电脑，「打开画面」可点", () => {
    const html = render("running", "open");
    expect(html).toContain("<b>小服请你接手这一页</b>");
    expect(html).toContain(REASON);
    expect(html).toContain("页面开在远程电脑 remote.baize.dev");
    expect(html).toContain('data-testid="takeover-open"');
    expect(html).toContain(">打开画面</button>");
    expect(result(html)).toBeNull();
  });

  it("画面没了、工具调用成功：写「已交还」，不给打开", () => {
    const html = render("ok", "put_away");
    expect(result(html)).toBe("已交还");
    expect(html).not.toContain('data-testid="takeover-open"');
    expect(html, "原话照样留在卡上").toContain(REASON);
  });

  it("画面没了、工具调用失败：写「没接手」", () => {
    const html = render("failed", "put_away");
    expect(result(html)).toBe("没接手");
    expect(html).not.toContain('data-testid="takeover-open"');
  });

  it("工具调用还在跑、这一页没见过画面：写「画面还没出来」，不给打开", () => {
    const html = render("running", "unseen");
    expect(result(html)).toBe("画面还没出来");
    expect(html).not.toContain('data-testid="takeover-open"');
    expect(html, "画面不在就不知道页面在哪台电脑上").not.toContain("页面开在");
  });

  it("画面出现过、已经收起，工具调用还在跑：写「画面已收起，等 Bot 接着做」，不说还没出来", () => {
    const html = render("running", "put_away");
    expect(result(html)).toBe("画面已收起，等 Bot 接着做");
    expect(html).not.toContain('data-testid="takeover-open"');
    expect(html, "画面不在就不知道页面在哪台电脑上").not.toContain("页面开在");
  });

  it("刷新过的页面没见过画面，工具调用有了终态照样按终态说", () => {
    expect(result(render("ok", "unseen"))).toBe("已交还");
  });

  it("开检查器的按钮和「打开画面」并排，不套在一起", () => {
    const html = render("running", "open");
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/);
  });
});
