class Unproven extends Error {}

/** 证明不了时抛，provablyContained 接住后照原来的判定问。 */
export const unproven = (why: string): never => {
  throw new Unproven(why);
};

export type RedirectOp = "<" | ">" | ">>";
export type Separator = "&&" | "||" | "|" | ";";

export interface Segment {
  readonly words: readonly string[];
  readonly redirects: readonly { readonly op: RedirectOp; readonly target: string }[];
}

export interface Chain {
  readonly segments: readonly Segment[];
  /** separators[i] 在 segments[i] 和 segments[i + 1] 之间。 */
  readonly separators: readonly Separator[];
}

// 没加引号时 bash 会拿它们做变量、glob、花括号、波浪号、注释、历史和子 shell。词中间的 # 和 ~ 本是字面量，一并不认，省得逐个分情况。
const EXPANDING = new Set("$*?[]{}~#!()");
const DUP_FOLLOWERS = new Set(" \t;|&<>");

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return (code < 0x20 && code !== 0x09) || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
};

export function lex(command: string): Chain {
  const chars = [...command];
  const segments: Segment[] = [];
  const separators: Separator[] = [];
  let words: string[] = [];
  let redirects: { op: RedirectOp; target: string }[] = [];
  let text = "";
  let started = false;
  let quoted = false;
  let pending: RedirectOp | null = null;

  const endWord = (): void => {
    if (!started) return;
    if (pending === null) {
      words.push(text);
    } else {
      if (text === "") unproven("重定向的目标是空的");
      redirects.push({ op: pending, target: text });
      pending = null;
    }
    text = "";
    started = false;
    quoted = false;
  };
  const endSegment = (separator: Separator | null): void => {
    endWord();
    if (pending !== null) unproven("重定向后面没有目标");
    if (words.length === 0) unproven("有一段没有命令");
    segments.push({ words, redirects });
    words = [];
    redirects = [];
    if (separator !== null) separators.push(separator);
  };
  // 紧贴在 < > 前面、没加引号的一串数字是 fd 号，不是参数。
  const takeFd = (): void => {
    if (pending !== null) unproven("重定向后面没有目标");
    if (started && !quoted && /^\d+$/.test(text)) {
      text = "";
      started = false;
      return;
    }
    endWord();
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const next = chars[index + 1];
    if (char === "`" || isControl(char)) unproven("有反引号、换行或控制字符");
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "'" || char === '"') {
      const close = chars.indexOf(char, index + 1);
      if (close < 0) unproven("引号没闭合");
      const inner = chars.slice(index + 1, close);
      if (char === '"' && inner.some((c) => c === "$" || c === "\\")) unproven("双引号里有 $ 或反斜杠");
      text += inner.join("");
      started = true;
      quoted = true;
      index = close;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) unproven("命令以反斜杠结尾");
      text += next;
      started = true;
      quoted = true;
      index += 1;
      continue;
    }
    if (char === "&") {
      if (next !== "&") unproven("后台运行或 &> 不认");
      endSegment("&&");
      index += 1;
      continue;
    }
    if (char === "|") {
      if (next === "&") unproven("|& 不认");
      endSegment(next === "|" ? "||" : "|");
      if (next === "|") index += 1;
      continue;
    }
    if (char === ";") {
      if (next === ";") unproven(";; 不认");
      endSegment(";");
      continue;
    }
    if (char === "<") {
      if (next === "<" || next === "&" || next === ">" || next === "(") unproven("here-doc、<&、<> 和进程替换不认");
      takeFd();
      pending = "<";
      continue;
    }
    if (char === ">") {
      if (next === "|" || next === "(") unproven(">| 和进程替换不认");
      if (next === "&") {
        let cursor = index + 2;
        let digits = "";
        while (/^\d$/.test(chars[cursor] ?? "")) {
          digits += chars[cursor];
          cursor += 1;
        }
        const after = chars[cursor];
        if (digits === "" || (after !== undefined && !DUP_FOLLOWERS.has(after))) unproven("只认 N>&M 这种 fd 复制");
        takeFd();
        index = cursor - 1;
        continue;
      }
      takeFd();
      pending = next === ">" ? ">>" : ">";
      if (next === ">") index += 1;
      continue;
    }
    if (EXPANDING.has(char)) unproven(`没加引号的 ${char} 会被 shell 展开`);
    text += char;
    started = true;
  }
  endSegment(null);
  return { segments, separators };
}
