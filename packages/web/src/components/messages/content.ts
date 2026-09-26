import type { Account, AccountLogin, AccountTier, Computer, Draft, LoginFailure, Platform } from "@baize/shared";

export const PLATFORM: Record<Platform, string> = {
  github: "GitHub",
  x: "X",
  xiaohongshu: "小红书",
};

export const COMPUTER_KIND_TEXT: Record<Computer["kind"], string> = {
  local: "本机",
  remote: "远程电脑",
};

export const COMPUTER_STATUS_TEXT: Record<Computer["status"], string> = {
  online: "在线",
  sleeping: "休眠",
  creating: "创建中",
  failed: "失败",
};

export const COMPUTER_STATUS_CLASS: Record<Computer["status"], string> = {
  online: "status-ok",
  sleeping: "status-blocked",
  creating: "status-running",
  failed: "status-failed",
};

// 本机就叫本机；远程电脑有主机名就带上，好和另一台分开。
export const computerName = (computer: Computer): string =>
  computer.kind === "local" ? "本机" : computer.host === null ? "远程电脑" : `远程电脑 ${computer.host}`;

export const LOGIN_TEXT: Record<AccountLogin, string> = {
  none: "未登录",
  valid: "已登录",
  expired: "登录已过期",
};

export const LOGIN_FAILURE_TEXT: Record<LoginFailure, string> = {
  window_failed: "登录窗口出错或到时间还没登上，账号状态没变，可以再点一次。",
  remote_refused: "远程电脑上不能登录这个平台，请在本机登录这个账号。",
};

export const TIER: Record<AccountTier, { title: string; note: string }> = {
  read_only: { title: "只读", note: "只看数据和评论，不写任何东西。" },
  draft: { title: "可起草", note: "它写好草稿放在「今天」，你自己去发。" },
  confirm_publish: { title: "发布要确认", note: "它会发，但每条对外内容先给你看。批一份计划就不再逐条问。" },
  direct_publish: { title: "可直接发布", note: "这个号发帖不再问你，每晚简报里汇总。私信和花钱仍然问。" },
};

export const TIERS = Object.keys(TIER) as AccountTier[];

// 平台的规矩，不是我们的：档位本身合法，小红书这个号挂在这一档上会被封。控制面同样拒成 400。
export const blockedTier = (platform: Platform, tier: AccountTier): string | null =>
  platform === "xiaohongshu" && tier === "direct_publish" ? "平台 2026-03-10 起封 AI 托管账号" : null;

export const draftText = (draft: Draft): string =>
  draft.content.kind === "post" ? (draft.content.title ?? draft.content.text) : `回复 ${draft.content.replyTo.author}`;

export const accountText = (account: Account | undefined): string =>
  account === undefined ? "账号未同步" : (account.handle ?? "账号未命名");

export const computerText = (account: Account | undefined, computers: Record<string, Computer>): string => {
  const computer = account === undefined ? undefined : computers[account.computerId];
  return computer === undefined ? "电脑未同步" : COMPUTER_KIND_TEXT[computer.kind];
};

export const timeText = (at: string, now = new Date()): string => {
  const date = new Date(at);
  const day = (value: Date): string => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(date) === day(now)) return `今天 ${clock}`;
  if (day(date) === day(tomorrow)) return `明天 ${clock}`;
  if (day(date) === day(yesterday)) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
};
