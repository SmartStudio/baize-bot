import type { TriggerInput } from "@baize/shared";

// 第一版只让用户挑这四种时刻，表达式由这里拼。反过来列表要说「下次什么时候跑」，也是拿表达式回到这四种上。
// 认不出来的表达式原样显示：它是从控制面或者以后的高级输入来的，猜错了比不猜更糟。
export const CRON_PRESETS = [
  { id: "daily", label: "每天", timed: true },
  { id: "weekday", label: "工作日", timed: true },
  { id: "hourly", label: "每小时", timed: false },
  { id: "minutely", label: "每分钟", timed: false },
] as const;

export type CronPresetId = (typeof CRON_PRESETS)[number]["id"];

export const DEFAULT_TIME = "09:00";

const HOURLY_EXPR = "0 * * * *";
const MINUTELY_EXPR = "* * * * *";

const DAILY_EXPR = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const WEEKDAY_EXPR = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/;
// 每周某天编辑器挑不出来，主助理的例行确认卡会提，所以只认来说给人听，不算预设。
const WEEKLY_EXPR = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/;
const WEEK_DAYS = ["日", "一", "二", "三", "四", "五", "六", "日"];

const pad = (value: number) => String(value).padStart(2, "0");

export const cronExprOf = (id: CronPresetId, time: string): string => {
  const [rawHour = "", rawMinute = ""] = time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  switch (id) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekday":
      return `${minute} ${hour} * * 1-5`;
    case "hourly":
      return HOURLY_EXPR;
    case "minutely":
      return MINUTELY_EXPR;
  }
};

// 挑不了时刻的那两种 time 恒为 null，编辑器照它决定要不要画时刻输入框。
export type CronPreset = { id: CronPresetId; time: string | null };

const clockOf = (match: RegExpExecArray): string => `${pad(Number(match[2] ?? 0))}:${pad(Number(match[1] ?? 0))}`;

export const cronPresetOf = (expr: string): CronPreset | null => {
  if (expr === MINUTELY_EXPR) return { id: "minutely", time: null };
  if (expr === HOURLY_EXPR) return { id: "hourly", time: null };
  const weekday = WEEKDAY_EXPR.exec(expr);
  if (weekday !== null) return { id: "weekday", time: clockOf(weekday) };
  const daily = DAILY_EXPR.exec(expr);
  if (daily !== null) return { id: "daily", time: clockOf(daily) };
  return null;
};

export const describeCron = (expr: string): string => {
  const preset = cronPresetOf(expr);
  const weekly = WEEKLY_EXPR.exec(expr);
  if (preset === null && weekly !== null) return `每周${WEEK_DAYS[Number(weekly[3])] ?? ""} ${clockOf(weekly)}`;
  if (preset === null) return expr;
  const label = CRON_PRESETS.find((item) => item.id === preset.id)?.label ?? expr;
  return preset.time === null ? label : `${label} ${preset.time}`;
};

export const describeTrigger = (trigger: TriggerInput): string =>
  trigger.kind === "cron" ? describeCron(trigger.expr) : "Webhook";

export const describeTriggers = (triggers: TriggerInput[]): string =>
  triggers.length === 0 ? "还没有触发器" : triggers.map(describeTrigger).join(" · ");
