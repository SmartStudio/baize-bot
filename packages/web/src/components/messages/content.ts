import type {
  Account,
  AccountLogin,
  AccountScope,
  AccountTier,
  Computer,
  Draft,
  LivePurpose,
  LiveUserEnd,
  LoginFailure,
  Platform,
  PublishVia,
  ToolCallStatus,
} from "@baize/shared";
import type { TakeoverScreen } from "../../state/live.js";

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

// 主机名是英文，后面紧跟汉字时隔一个空格。后面是全角标点就不用它，标点前不留空。
export const beforeChinese = (name: string): string => (/[a-z0-9]$/i.test(name) ? `${name} ` : name);

export const LOGIN_TEXT: Record<AccountLogin, string> = {
  none: "未登录",
  valid: "已登录",
  expired: "登录已过期",
};

export const ACCOUNT_SCOPE_TEXT: Record<AccountScope, string> = {
  "media.write": "发图权限",
};

export const LOGIN_FAILURE_TEXT: Record<LoginFailure, string> = {
  window_failed: "登录窗口出错或被关掉了，账号状态没变，可以再点一次。",
  timed_out: "登录窗口开了很久还没登上，已经收起，账号状态没变，可以再点一次。",
};

// 画面面板。摆哪几个按钮由 liveEndActions 定：登录只有放弃，交还只出现在接手上。
export const liveEndText = (kind: LivePurpose["kind"], action: LiveUserEnd): string =>
  action === "finish"
    ? kind === "terminal"
      ? TERMINAL_TEXT.close
      : "交还给 Bot"
    : kind === "login"
      ? "不登了"
      : "不弄了";

// 网页终端。面板和电脑页上的按钮共用这几句。
export const TERMINAL_TEXT = {
  title: "云电脑终端",
  note: "这里打的字直接进云电脑上的终端，不经过 Bot。",
  open: "打开终端",
  opening: "正在开终端…",
  back: "回到终端",
  explain:
    "在云电脑上开一个终端，用来装命令行工具、登录 grok、codex 这类要你操作一次的账号。登录态存在云电脑上，所有 Bot 共用。",
  notOpened: "终端没开起来，可以再点一次。",
  close: "关掉终端",
  connecting: "正在连上云电脑上的终端…",
  reconnecting: "终端断了，正在重连…",
  replaced: "终端在别的窗口打开了",
  ended: "终端已经关了",
} as const;

export const LIVE_TEXT = {
  // Bot 表里查不到（刚删、还没拉到）就说 Bot。
  takeover: (botName: string | undefined) => `${botName ?? "Bot"}请你接手这一页`,
  open: "打开画面",
  later: "稍后",
  connecting: "正在连上电脑上的画面…",
  reconnecting: "画面断了，正在重连…",
  replaced: "画面在别的窗口打开了",
  reclaim: "在这里看",
  ended: "画面已经结束了",
  hide: "收起",
  reveal: "到本机窗口操作",
  noOrigin: "页面还在打开",
} as const;

const TAKEOVER_RESULT: Record<Exclude<ToolCallStatus, "running">, string> = {
  ok: "已交还",
  failed: "没接手",
  blocked: "没接手",
};

const TAKEOVER_WAITING: Record<Exclude<TakeoverScreen["kind"], "open">, string> = {
  put_away: "画面已收起，等 Bot 接着做",
  unseen: "画面还没出来",
};

export const takeoverResult = (status: ToolCallStatus, screen: Exclude<TakeoverScreen["kind"], "open">): string =>
  status === "running" ? TAKEOVER_WAITING[screen] : TAKEOVER_RESULT[status];

export const TIER: Record<AccountTier, { title: string; note: string }> = {
  read_only: { title: "只读", note: "只看数据和评论，不写任何东西。" },
  draft: { title: "可起草", note: "它写好草稿放在「今天」，你自己去发。" },
  confirm_publish: { title: "发布要确认", note: "它会发，但每条对外内容先给你看。批一份计划就不再逐条问。" },
  direct_publish: { title: "可直接发布", note: "这个号发帖不再问你，每晚简报里汇总。私信和花钱仍然问。" },
};

export const TIERS = Object.keys(TIER) as AccountTier[];

export const VIA_TEXT: Record<PublishVia, string> = {
  api: "接口授权",
  computer: "电脑上的浏览器登录",
};

// 档位本身合法，但电脑浏览器登录的号不许挂在「可直接发布」，控制面同样拒成 400。
// 小红书说平台自己的规矩：2026-03-10 起封 AI 托管账号。
export const blockedTier = (account: Pick<Account, "platform" | "via">, tier: AccountTier): string | null => {
  if (account.via !== "computer" || tier !== "direct_publish") return null;
  return account.platform === "xiaohongshu"
    ? "平台 2026-03-10 起封 AI 托管账号"
    : "电脑浏览器发帖每条先给你看，不开直接发布";
};

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
