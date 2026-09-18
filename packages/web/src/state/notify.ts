import type { Approval, Settings } from "@baize/shared";

// "HH:MM" 转当天分钟数。schema 已经把格式钉成两位数，这里不再防一遍。
const minutesOf = (hhmm: string): number => {
  const [hours, minutes] = hhmm.split(":");
  return Number(hours) * 60 + Number(minutes);
};

export const inDoNotDisturb = (settings: Settings, at: Date): boolean => {
  const { dndFrom, dndTo } = settings;
  // 只设了一头等于没划出区间，当作没开免打扰，而不是把另一半时间全算进去。
  if (dndFrom === null || dndTo === null) return false;
  const from = minutesOf(dndFrom);
  const to = minutesOf(dndTo);
  const now = at.getHours() * 60 + at.getMinutes();
  // 22:00–08:00 这种跨午夜的区间在数轴上是首尾两段，按 from <= now < to 判会把整个白天算成免打扰。
  return from <= to ? now >= from && now < to : now >= from || now < to;
};

export const notifyApproval = (approval: Approval, settings: Settings, at: Date): void => {
  if (!settings.notify) return;
  if (inDoNotDisturb(settings, at)) return;
  if (typeof Notification === "undefined") return;
  // 权限没给就安静跳过。一条推送不该把用户按在一个权限弹窗前，角标已经把这件事说清楚了。
  if (Notification.permission !== "granted") return;
  new Notification("等你点头", { body: approval.summary });
};
