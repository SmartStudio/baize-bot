import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveSession } from "@baize/shared";
import { LivePanel } from "./LivePanel.js";

const computers = vi.hoisted(() => ({
  cmp_local: { id: "cmp_local", kind: "local" },
  cmp_remote: { id: "cmp_remote", kind: "remote", host: "remote.baize.dev" },
}));

const bots = vi.hoisted(() => ({ bot_1: { id: "bot_1", name: "小服" } }));

vi.mock("../state/app.js", () => ({
  useApp: () => ({ state: { status: "ready", bots, content: { computers } }, actions: {} }),
}));

// purpose 走 parse 打上品牌，测试里直接写字面量。
const session = (purpose: unknown, computerId = "cmp_remote") =>
  LiveSession.parse({ liveId: "00000000-0000-4000-8000-00000000000a", purpose, origin: null, computerId });

const login = session({ kind: "login", accountId: "acc_1", platform: "xiaohongshu", attempt: "try_1" });
const takeover = session({ kind: "takeover", botId: "bot_1", groupId: "grp_1", reason: "知乎要登录，请扫码" });

const endButtons = (html: string) => [...html.matchAll(/data-action="(\w+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);

describe("LivePanel 的按钮来自 liveEndActions", () => {
  it("登录只有「不登了」，没有交还", () => {
    const html = renderToStaticMarkup(<LivePanel session={login} onDismiss={() => undefined} />);
    expect(endButtons(html)).toEqual([["abandon", "不登了"]]);
  });

  it("接手有「交还给 Bot」和「不弄了」两个，标题下写 Bot 给的理由", () => {
    const html = renderToStaticMarkup(<LivePanel session={takeover} onDismiss={() => undefined} />);
    expect(endButtons(html)).toEqual([
      ["finish", "交还给 Bot"],
      ["abandon", "不弄了"],
    ]);
    expect(html).toContain("知乎要登录，请扫码");
  });

  it("接手的标题说是哪个 Bot 请的；Bot 查不到就写 Bot", () => {
    const html = renderToStaticMarkup(<LivePanel session={takeover} onDismiss={() => undefined} />);
    expect(html).toContain("<b>小服请你接手这一页</b>");
    const stranger = session({ kind: "takeover", botId: "bot_gone", groupId: "grp_1", reason: "知乎要登录" });
    expect(renderToStaticMarkup(<LivePanel session={stranger} onDismiss={() => undefined} />)).toContain(
      "<b>Bot请你接手这一页</b>",
    );
  });

  it("「到本机窗口操作」只给本机电脑：远程那台的窗口用户够不着", () => {
    const remote = renderToStaticMarkup(<LivePanel session={login} onDismiss={() => undefined} />);
    expect(remote).not.toContain("到本机窗口操作");
    const local = renderToStaticMarkup(
      <LivePanel
        session={session({ kind: "login", accountId: "acc_1", platform: "xiaohongshu", attempt: "try_1" }, "cmp_local")}
        onDismiss={() => undefined}
      />,
    );
    expect(local).toContain("到本机窗口操作");
  });

  it("页面还没导航完时地址栏不空着，连上之前说在连", () => {
    const html = renderToStaticMarkup(<LivePanel session={login} onDismiss={() => undefined} />);
    expect(html).toContain("页面还在打开");
    expect(html).toContain("正在连上电脑上的画面");
  });
});
