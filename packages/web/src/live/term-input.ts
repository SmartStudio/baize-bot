import type { LiveInput } from "@baize/shared";

// 和 shared 里 LiveInput 的上限对齐：超了整帧会被中继丢掉，人打的字就没了。
const TERM_CHUNK = 8192;
const COLS = { min: 2, max: 500 };
const ROWS = { min: 2, max: 200 };

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

// xterm 的 onData 一次可能给一大段（粘贴），切成几帧按序发。不在代理对中间切：半个字编不成 UTF-8，到电脑上就成了乱码。
export const termInputs = (data: string): LiveInput[] => {
  const inputs: LiveInput[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(at + TERM_CHUNK, data.length);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    inputs.push({ kind: "term", data: data.slice(at, end) });
    at = end;
  }
  return inputs;
};

const clamp = (value: number, range: { min: number; max: number }): number =>
  Math.min(range.max, Math.max(range.min, Math.floor(value)));

// 面板被压得很小或者还没量出来时 fit 会给出 0 或 NaN，按协议的范围夹住，不让一帧 resize 被整个丢掉。
export const resizeInput = (cols: number, rows: number): LiveInput | null =>
  Number.isFinite(cols) && Number.isFinite(rows)
    ? { kind: "resize", cols: clamp(cols, COLS), rows: clamp(rows, ROWS) }
    : null;
