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

    notifyNotice(notice, settings);

    expect(notification).toHaveBeenCalledWith("等你确认", { body: notice.text });
  });

  it("没办成的事标题说没办成，不能说成做完了", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice({ ...notice, kind: "failed", text: "小红书的登录窗口出错", groupId: null }, settings);

    expect(notification).toHaveBeenCalledWith("没办成", { body: "小红书的登录窗口出错" });
  });

  it("关闭通知设置时不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    notifyNotice(notice, { ...settings, notify: false });

    expect(notification).not.toHaveBeenCalled();
  });

  it("菜单栏不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    vi.stubGlobal("window", { location: { pathname: "/menubar" } });
    notifyNotice(notice, settings);

    expect(notification).not.toHaveBeenCalled();
  });

  it("Electron 主页面不显示", () => {
    const notification = vi.fn();
    Object.defineProperty(notification, "permission", { value: "granted" });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", { location: { pathname: "/" } });
    vi.stubGlobal("navigator", { userAgent: "Electron/32.0" });

    notifyNotice(notice, settings);

    expect(notification).not.toHaveBeenCalled();
  });
});
