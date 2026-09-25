import type { Notice, Settings } from "@baize/shared";

const TITLE: Record<Notice["kind"], string> = {
  confirm: "等你确认",
  result: "做完了",
  stuck: "卡住了",
};

export const showNativeNotification = (title: string, body: string): void => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  new Notification(title, { body });
};

export const notifyNotice = (notice: Notice, settings: Settings): void => {
  if (!settings.notify) return;
  if (typeof window !== "undefined" && window.location.pathname === "/menubar") return;
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")) return;
  showNativeNotification(TITLE[notice.kind], notice.text);
};
