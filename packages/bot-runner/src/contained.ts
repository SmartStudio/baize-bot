import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ComputerKind } from "@baize/shared";
import { checkCommand } from "./contained-commands.js";
import { Prover } from "./contained-prover.js";
import { type Chain, lex, type Segment, unproven } from "./contained-lex.js";
import type { SandboxKind } from "./gate.js";
import { realpathExisting } from "./paths.js";

export type ContainmentLevel = "none" | "closed";

/**
 * closed 时带着沙箱 bash 真正用的 PATH 和这个 Bot 的工具箱。两样都由 createSandboxedBash 给出，闸门和证明器
 * 从同一个对象拿：证明器按这个 PATH 解析命令名，批 pip 时写路径就是这个工具箱。
 */
export type Containment =
  { readonly level: "none" } | { readonly level: "closed"; readonly searchPath: string; readonly toolboxDir: string };

/** 只有远程电脑上的 bwrap 是 closed。Mac 的 seatbelt 不在拍板范围里，一条都不放宽。 */
export function containmentFor(computerKind: ComputerKind, sandbox: SandboxKind): { readonly level: ContainmentLevel } {
  return { level: computerKind === "remote" && sandbox === "bwrap" ? "closed" : "none" };
}

export const SYSTEM_PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "apk",
  "brew",
  "sudo",
  "su",
]);

export const SYSTEM_PACKAGE_REASON =
  "云电脑的沙箱里没有 root，装不了系统包。Python 包用 pip 装进你的工具箱，Node 包用 npm 装进工作区；要系统包请主人改 deploy/remote/Dockerfile。";

export interface ContainedContext {
  readonly workDir: string;
  readonly sharedDir: string;
  /** 闸门的禁区。助理 Chrome 的 profile 可以配在工作区里面，沙箱会盖住它，但判定本身也不该对它说放行。 */
  readonly forbidden: readonly string[];
  /** 沙箱 bash 的 PATH。表里的命令按名字认，名字落到哪个文件由它定，工具箱里一个同名的入口脚本就能顶掉系统的。 */
  readonly searchPath: string;
}

export interface ContainedVerdict {
  readonly contained: boolean;
  /** 不证明时的首因，给测试和日志看，不进给用户的文案。 */
  readonly why: string;
}

const PROBE_FLAGS: ReadonlySet<string> = new Set(["--version", "-V", "--help"]);
// 这几个不靠参数也认得出是删或移，连 --help 都不放，免得「删除照样问」出现例外。
const NEVER_PROBED: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred", "mv", "ln"]);
const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/usr/local/bin"] as const;

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

const executable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * 按 bash 找命令的顺序，`searchPath` 里第一个有这个可执行文件的目录里的那个文件，realpath 之后必须在系统目录里。
 * 工作区或工具箱里的同名程序跑什么都有可能。
 */
export const resolvesToSystemBinary = (name: string, searchPath: string): boolean => {
  const entries = searchPath.split(":");
  // 空项和相对项跟着 cwd 走，cwd 是工作区。
  if (entries.some((entry) => !isAbsolute(entry))) return false;
  const system = new Set(SYSTEM_BIN_DIRS.flatMap((dir) => realOrNull(dir) ?? []));
  const found = entries.find((entry) => executable(join(entry, name)));
  if (found === undefined) return false;
  const real = realOrNull(join(found, name));
  return real !== null && system.has(dirname(real));
};

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function checkSegment(segment: Segment, prover: Prover, searchPath: string): { readonly makesLinks: boolean } {
  const [name = "", ...args] = segment.words;
  if (!COMMAND_NAME.test(name)) unproven(`命令名 ${name} 不是裸词`);
  if (!resolvesToSystemBinary(name, searchPath)) unproven(`${name} 不是系统目录里的程序`);
  if (args.length === 1 && PROBE_FLAGS.has(args[0] ?? "")) {
    if (NEVER_PROBED.has(name)) unproven(`${name} 连查版本也问`);
    return { makesLinks: false };
  }
  return checkCommand(name, args, prover);
}

function proveChain(chain: Chain, prover: Prover, searchPath: string): void {
  let atHead = true;
  chain.segments.forEach((segment, index) => {
    for (const redirect of segment.redirects) {
      if (redirect.target !== "/dev/null") prover.path(redirect.target);
    }
    const [name, ...args] = segment.words;
    if (name === "cd") {
      // 只有链头的 cd 后面接 && 才确定后面的段在新目录里跑：cd 失败时 && 不往下走，|| ; | 都会在原目录接着跑。
      if (!atHead) unproven("cd 只许在 && 链的开头");
      const after = chain.separators[index];
      if (after !== undefined && after !== "&&") unproven("cd 后面只能接 &&");
      const target = args[0];
      if (args.length !== 1 || target === undefined || target.startsWith("-")) unproven("cd 只认一个目录");
      prover.path(target ?? "");
      prover.cwd = realpathExisting(prover.resolve(target ?? ""));
      return;
    }
    atHead = false;
    const { makesLinks } = checkSegment(segment, prover, searchPath);
    if (makesLinks && index !== chain.segments.length - 1) unproven(`${name ?? ""} 会建链接，只许放在最后一段`);
  });
}

/**
 * 只在 decideResolved 已经给出 ask、来源是 bash、level 是 closed 时调。
 * 比分类器更保守：表里没有的命令、选项、写法一律 contained:false。
 */
export function provablyContained(command: string, ctx: ContainedContext): ContainedVerdict {
  try {
    if (command.trim() === "") unproven("空命令");
    const prover = new Prover(ctx);
    proveChain(lex(command), prover, ctx.searchPath);
    return { contained: true, why: "" };
  } catch (error) {
    // 路径解不出来（成环的链接）或 fs 报错也只是证明不了，照原来的判定问，不往外抛。
    return { contained: false, why: error instanceof Error ? error.message : String(error) };
  }
}
