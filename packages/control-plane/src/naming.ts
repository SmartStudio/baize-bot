import { BotHue, BotShape } from "@baize/shared";

export const HUE_ROTATION = BotHue.options;
export const SHAPE_ROTATION = BotShape.options;

// 系统起名用的字，取工作场景里常见的单字，前面固定加「小」。
const NAME_CHARS = "服销采研运财法测编设客品数智安讯";

export function hueAt(index: number): BotHue {
  const hue = HUE_ROTATION[index % HUE_ROTATION.length];
  if (hue === undefined) throw new Error("色相轮转表为空");
  return hue;
}

export function shapeAt(index: number): BotShape {
  const shape = SHAPE_ROTATION[index % SHAPE_ROTATION.length];
  if (shape === undefined) throw new Error("形状轮转表为空");
  return shape;
}

export function generateBotName(): string {
  const char = NAME_CHARS[Math.floor(Math.random() * NAME_CHARS.length)];
  if (char === undefined) throw new Error("起名字表为空");
  return `小${char}`;
}

const BOT_NAME_MAX = 20;

/** 名字上限按 JS 的码元算。截到 units 个码元以内，落在代理对中间就把整个字丢掉，不留半个。 */
function headWithin(text: string, units: number): string {
  let head = "";
  for (const char of text) {
    if (head.length + char.length > units) break;
    head += char;
  }
  return head;
}

/**
 * 没被占的名字：base 空着就用 base，否则依次试 base2、base3……，超长时截掉 base 的尾巴给数字让位。
 * 序号位数相同的候选头一样、数字不同，彼此不会撞，位数往上走总有一档候选比 taken 多，所以一定挑得出。
 * 以数字结尾的 base 会让不同位数的候选拼出同一个名字（stem1 接 2、stem 接 12），那只是白试一次。
 */
export function untakenBotName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = headWithin(base, BOT_NAME_MAX - String(suffix).length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export function taskNumber(n: number): string {
  if (n < 0 || n > 9999) throw new Error(`主题任务编号 ${n} 放不进 T- 四位`);
  return `T-${String(n).padStart(4, "0")}`;
}
