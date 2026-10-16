import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Account, Computer, LoginAttemptId } from "@baize/shared";
import { createClock } from "../state/stamped.js";
import type { LoginFlow } from "../state/types.js";
import { LoginCard } from "./LoginCard.js";

const at = "2020-01-02T03:04:00.000Z";

const remote = Computer.parse({
  id: "cmp_remote",
  ownerId: "usr_1",
  kind: "remote",
  status: "online",
  host: "mac-mini",
  idleSince: null,
  lastSeenAt: at,
  dispatchable: true,
});

const account = (login: Account["login"]) =>
  Account.parse({
    id: "acc_1",
    ownerId: "usr_1",
    computerId: "cmp_remote",
    platform: "xiaohongshu",
    handle: "要务机械星球",
    tier: "confirm_publish",
    login,
    loginChangedAt: at,
    lastLoginFailure: null,
    createdAt: at,
  });

const card = (login: Account["login"], flow: LoginFlow | undefined) => {
  const html = renderToStaticMarkup(
    <LoginCard account={account(login)} computer={remote} flow={flow} onLogin={async () => undefined} />,
  );
  const text = (testId: string) => new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(html)?.[1];
  return { note: text("login-card-note"), button: text("login-open") };
};

describe("登录卡写在哪台电脑上登录", () => {
  it("还没点：主机名和后面的汉字隔一个空格，不说只能扫码", () => {
    expect(card("none", undefined)).toEqual({
      note: "稿子等着发到这个号，在远程电脑 mac-mini 的助理浏览器里登录一次。密码不经过 Bot。",
      button: "打开登录窗口",
    });
  });

  it("窗口开着：扫码和短信登上都算，按钮等的是登录", () => {
    const opening: LoginFlow = {
      status: "opening",
      startedAt: createClock()(),
      attempt: LoginAttemptId.parse("try_1"),
    };
    expect(card("none", opening)).toEqual({
      note: "登录窗口已在远程电脑 mac-mini 打开，登上后这里会变成已登录。",
      button: "等你登录…",
    });
  });

  it("电脑不在线：主机名后面隔空格再接「不在线」", () => {
    expect(card("none", { status: "offline" }).note).toBe("远程电脑 mac-mini 不在线，打开电脑上的白泽后再点登录。");
  });

  it("过期：主机名后面是全角逗号，不留空格", () => {
    expect(card("expired", undefined).note).toBe("1月2日 11:04 过期的 · 账号在远程电脑 mac-mini，稿子先不发。");
  });
});
