import { useEffect } from "react";
import type { Notice, Settings } from "@baize/shared";
import { pathOf } from "../routes/screen.js";

const TITLE: Record<Notice["kind"], string> = {
  confirm: "等你确认",
  result: "做完了",
  stuck: "卡住了",
  failed: "没办成",
};

const PAGE_TITLE = "白泽 Bot";

// 桌面壳的主进程自己连推送、自己弹原生通知，壳里的 Web 再弹就是两条。
export const inDesktopShell = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

export type NotifyPermission = NotificationPermission | "unsupported";

export const notifyPermission = (): NotifyPermission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

// 页面在前台、窗口有焦点才算人在看，切到别的标签页或别的应用都不算。
export const lookingAtPage = (): boolean => document.visibilityState === "visible" && document.hasFocus();

export const showNativeNotification = (title: string, body: string, onClick: () => void): void => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const notification = new Notification(title, { body });
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
};

export const notifyNotice = (notice: Notice, settings: Settings, onClick: () => void): void => {
  if (!settings.notify) return;
  if (typeof window !== "undefined" && window.location.pathname === "/menubar") return;
  if (inDesktopShell()) return;
  showNativeNotification(TITLE[notice.kind], notice.text, onClick);
};

// 用户故事 U7：点通知打开「今天」页。要你点头的落在「等你确认」，做完的在「刚做完」，卡住的没有单独一节，也落在「等你确认」。
// 「没办成」不往节里落：例行失败的记录既不进「刚做完」（today 只列 ok 的），也不进「等你确认」。
// 带群的进那个群看来龙去脉，不带群的只回「今天」页顶部，不滚。
// 落到哪一节跟着这一次跳转的 location state 走，刷新、后退回来都不再滚一遍。
export type NoticeSection = "pending" | "done";
export type NoticeState = { fromNotice: true; noticeSection: NoticeSection | null };

export const noticeTarget = (notice: Notice): { path: string; state: NoticeState } => {
  if (notice.kind === "failed") {
    const path = notice.groupId === null ? "/" : pathOf({ kind: "group", groupId: notice.groupId });
    return { path, state: { fromNotice: true, noticeSection: null } };
  }
  return { path: "/", state: { fromNotice: true, noticeSection: notice.kind === "result" ? "done" : "pending" } };
};

export const openedFromNotice = (state: unknown): boolean =>
  typeof state === "object" && state !== null && "fromNotice" in state && state.fromNotice === true;

export const noticeSectionOf = (state: unknown): NoticeSection | null =>
  typeof state === "object" &&
  state !== null &&
  "noticeSection" in state &&
  (state.noticeSection === "pending" || state.noticeSection === "done")
    ? state.noticeSection
    : null;

// 人回到页面上就算看过了。标题上的数随页面卸载一起还原，登出后不留旧数。
export const useUnreadTitle = (unread: number, markRead: () => Promise<void>): void => {
  useEffect(() => {
    document.title = unread === 0 ? PAGE_TITLE : `(${unread}) ${PAGE_TITLE}`;
  }, [unread]);
  useEffect(() => () => void (document.title = PAGE_TITLE), []);
  useEffect(() => {
    const check = () => {
      if (lookingAtPage()) void markRead();
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [markRead]);
};
