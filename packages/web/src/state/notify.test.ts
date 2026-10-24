import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice, Settings } from "@baize/shared";
import { notifyNotice } from "./notify.js";

const settings = Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00", budget: null });
const notice = Notice.parse({
  kind: "confirm",
  text: "本周推广计划等你确认",
  groupId: "grp_service",
  at: "2026-09-26T15:10:00.000Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("系统通知", () => {
  it("收到 notify 推送时立即显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice(notice, settings, () => undefined);

    expect(notification).toHaveBeenCalledWith("等你确认", { body: notice.text });
  });

  it("点通知先把窗口叫到前面，再跳到对应位置，然后收起这条通知", () => {
    const steps: string[] = [];
    const shown: { onclick: (() => void) | null }[] = [];
    class Stub {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor() {
        shown.push(this);
      }
      close() {
        steps.push("close");
      }
    }
    vi.stubGlobal("Notification", Stub);
    vi.stubGlobal("window", { location: { pathname: "/" }, focus: () => steps.push("focus") });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice(notice, settings, () => steps.push("open"));
    expect(steps, "没点之前什么都不做").toEqual([]);
    shown[0]?.onclick?.();

    expect(steps).toEqual(["focus", "open", "close"]);
  });

  it("没办成的事标题说没办成，不能说成做完了", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice({ ...notice, kind: "failed", text: "小红书的登录窗口出错", groupId: null }, settings, () => undefined);

    expect(notification).toHaveBeenCalledWith("没办成", { body: "小红书的登录窗口出错" });
  });

  it("关闭通知设置时不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice(notice, { ...settings, notify: false }, () => undefined);

    expect(notification).not.toHaveBeenCalled();
  });

  it("菜单栏不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    vi.stubGlobal("window", { location: { pathname: "/menubar" } });
    notifyNotice(notice, settings, () => undefined);

    expect(notification).not.toHaveBeenCalled();
  });

  it("Electron 主页面不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Electron/32.0" });

    notifyNotice(notice, settings, () => undefined);

    expect(notification).not.toHaveBeenCalled();
  });
});
