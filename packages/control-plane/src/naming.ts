import { BotHue } from "@baize/shared";

export const HUE_ROTATION = BotHue.options;

// 系统起名用的字，取工作场景里常见的单字，前面固定加「小」。
const NAME_CHARS = "服销采研运财法测编设客品数智安讯";

export function hueAt(index: number): BotHue {
  const hue = HUE_ROTATION[index % HUE_ROTATION.length];
  if (hue === undefined) throw new Error("色相轮转表为空");
  return hue;
}

export function generateBotName(): string {
  const char = NAME_CHARS[Math.floor(Math.random() * NAME_CHARS.length)];
  if (char === undefined) throw new Error("起名字表为空");
  return `小${char}`;
}

export function taskNumber(n: number): string {
  if (n < 0 || n > 9999) throw new Error(`主题任务编号 ${n} 放不进 T- 四位`);
  return `T-${String(n).padStart(4, "0")}`;
}

