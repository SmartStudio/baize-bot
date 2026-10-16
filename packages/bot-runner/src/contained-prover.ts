import { resolve } from "node:path";
import type { ContainedContext } from "./contained.js";
import { unproven } from "./contained-lex.js";
import { isInsideRoot } from "./paths.js";

// closed 只在远程电脑的 bwrap 上成立，那里是 Linux，路径区分大小写。
const PLATFORM = "linux";

export class Prover {
  cwd: string;

  constructor(private readonly ctx: ContainedContext) {
    // 禁区和工作区、共享区相交时，递归命令和不带参数时默认的当前目录都会碰到它，逐个路径查不全，整条不认。
    const roots = [ctx.workDir, ctx.sharedDir];
    const overlaps = (zone: string): boolean =>
      roots.some((root) => isInsideRoot(zone, root, PLATFORM) || isInsideRoot(root, zone, PLATFORM));
    if (ctx.forbidden.some(overlaps)) unproven("禁区和工作区或共享区相交");
    this.cwd = ctx.workDir;
  }

  resolve(word: string, base: string = this.cwd): string {
    return resolve(base, word);
  }

  /** 字面路径 realpath 之后落在工作区或共享区。`-` 是标准输入输出。 */
  path(word: string, base: string = this.cwd): void {
    if (word === "-") return;
    if (word === "") unproven("路径是空的");
    // .. 先退的是链接解开后的目录，按字面判和内核走到的地方不一定一样，不去赌。
    if (word.split("/").includes("..")) unproven(`路径带 ..：${word}`);
    const absolute = resolve(base, word);
    if (!isInsideRoot(absolute, this.ctx.workDir, PLATFORM) && !isInsideRoot(absolute, this.ctx.sharedDir, PLATFORM)) {
      unproven(`路径不在工作区或共享区：${word}`);
    }
  }

  paths(words: readonly string[], base?: string): void {
    for (const word of words) this.path(word, base);
  }
}

export type ValueKind = "text" | "number" | "path";
type LongKind = "flag" | "optional" | "pair" | ValueKind;

export interface OptionTable {
  /** 不带值的短选项。 */
  readonly flags?: string;
  /** 带值的短选项。optional 只认紧贴的值（sed 的 -i）。 */
  readonly values?: Readonly<Record<string, ValueKind | "optional">>;
  readonly long?: Readonly<Record<string, LongKind>>;
  /** head -20 这种全数字的老写法。 */
  readonly digits?: boolean;
  /** 遇到第一个操作数就不再认选项，awk 是这样。 */
  readonly stopAtOperand?: boolean;
  /** Info-ZIP 的 zip/unzip 自己拆参数，-- 的含义和 getopt 不一样。 */
  readonly noDoubleDash?: boolean;
}

export interface Options {
  /** 短选项记字母，长选项记 `--名字`。 */
  readonly seen: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly operands: readonly string[];
}

const NUMBER = /^[+-]?\d+[A-Za-z]{0,3}$/;

export function getopt(words: readonly string[], table: OptionTable, prover: Prover): Options {
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const record = (key: string, ...given: string[]): void => {
    seen.add(key);
    values.set(key, [...(values.get(key) ?? []), ...given]);
  };
  const checked = (kind: ValueKind, value: string, key: string): string => {
    if (kind === "number" && !NUMBER.test(value)) unproven(`${key} 要的是数字：${value}`);
    if (kind === "path") prover.path(value);
    return value;
  };
  let optionsDone = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (optionsDone || word === "-" || !word.startsWith("-")) {
      operands.push(word);
      if (table.stopAtOperand === true) optionsDone = true;
      continue;
    }
    if (word === "--") {
      if (table.noDoubleDash === true) unproven("-- 不认");
      optionsDone = true;
      continue;
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals < 0 ? word.slice(2) : word.slice(2, equals);
      const attached = equals < 0 ? null : word.slice(equals + 1);
      const key = `--${name}`;
      // getopt_long 认唯一前缀，但精确匹配优先；表里只放全名，缩写一律不认。
      const kind = table.long?.[name];
      if (kind === undefined) return unproven(`选项 ${key} 不在表里`);
      if (kind === "flag") {
        if (attached !== null) unproven(`${key} 不带值`);
        seen.add(key);
      } else if (kind === "optional") {
        if (attached === null) seen.add(key);
        else record(key, attached);
      } else if (kind === "pair") {
        const first = words[index + 1];
        const second = words[index + 2];
        if (attached !== null || first === undefined || second === undefined) return unproven(`${key} 要两个值`);
        record(key, first, second);
        index += 2;
      } else {
        const value = attached ?? words[index + 1];
        if (value === undefined) return unproven(`${key} 缺值`);
        if (attached === null) index += 1;
        record(key, checked(kind, value, key));
      }
      continue;
    }
    const cluster = word.slice(1);
    if (table.digits === true && /^\d+$/.test(cluster)) {
      seen.add("#");
      continue;
    }
    for (let offset = 0; offset < cluster.length; offset += 1) {
      const letter = cluster[offset] ?? "";
      if (table.flags?.includes(letter) === true) {
        seen.add(letter);
        continue;
      }
      const kind = table.values?.[letter];
      if (kind === undefined) return unproven(`选项 -${letter} 不在表里`);
      const rest = cluster.slice(offset + 1);
      if (kind === "optional") {
        if (rest === "") seen.add(letter);
        else record(letter, rest);
        break;
      }
      const value = rest === "" ? words[index + 1] : rest;
      if (value === undefined) return unproven(`-${letter} 缺值`);
      if (rest === "") index += 1;
      record(letter, checked(kind, value, `-${letter}`));
      break;
    }
  }
  return { seen, values, operands };
}

export const has = (options: Options, ...keys: readonly string[]): boolean => keys.some((key) => options.seen.has(key));

export const atMost = (options: Options, count: number): void => {
  if (options.operands.length > count) unproven(`操作数最多 ${count} 个`);
};

export const atLeast = (options: Options, count: number): void => {
  if (options.operands.length < count) unproven(`操作数至少 ${count} 个`);
};
