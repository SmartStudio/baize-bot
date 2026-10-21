import { dirname, join } from "node:path";
import type { ComputerKind } from "@baize/shared";
import type { SandboxKind } from "./gate.js";

export type ContainmentLevel = "none" | "closed";

/**
 * closed 时带着沙箱 bash 的系统 PATH、这个 Bot 的工具箱和这台云电脑所有 Bot 共用的 HOME。都由 createSandboxedBash 给出，
 * 批 pip 时写路径就是这个工具箱。
 */
export type Containment =
  | { readonly level: "none" }
  | { readonly level: "closed"; readonly searchPath: string; readonly toolboxDir: string; readonly homeDir: string };

/** 只有远程电脑上的 bwrap 是 closed。Mac 的 seatbelt 不在拍板范围里，一条都不放宽。 */
export function containmentFor(computerKind: ComputerKind, sandbox: SandboxKind): { readonly level: ContainmentLevel } {
  return { level: computerKind === "remote" && sandbox === "bwrap" ? "closed" : "none" };
}

export type ClosedContainment = Extract<Containment, { level: "closed" }>;

export const toolboxShimDir = (toolboxDir: string): string => join(dirname(toolboxDir), "toolbox-bin");
/** 云电脑的 HOME。主人在网页终端里登录的 CLI 把登录态留在这里，所有 Bot 共用一份。 */
export const cliHomeDir = (dataDir: string): string => join(dataDir, "home");
/** 主人在终端里 `npm i -g` 装的命令落在这里（终端的 NPM_CONFIG_PREFIX 是 `<homeDir>/.local`）。 */
export const homeBinDir = (homeDir: string): string => join(homeDir, ".local", "bin");

// .local/bin 里的命令放行时能写 HOME（续期登录态），但改不动别的命令和 shell 启动文件：.local/bin 在所有 Bot 的 PATH 上，
// 启动文件在主人的终端里跑。Debian 默认的 .bashrc 会 source .bash_aliases，一并锁上。
export const HOME_LOCKED_DIRS = [".local"] as const;
export const HOME_LOCKED_FILES = [
  ".bashrc",
  ".bash_aliases",
  ".profile",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".inputrc",
  ".npmrc",
] as const;

/** 沙箱在可写的 HOME 之上只读挂回它们，闸门也不为它们开审批。只有主人的网页终端改得动。 */
export const homeLockedPaths = (homeDir: string): readonly string[] =>
  [...HOME_LOCKED_DIRS, ...HOME_LOCKED_FILES].map((name) => join(homeDir, name));
/** `npm i -g` 在云电脑上的 prefix。全局包的命令落在它的 bin 下。 */
export const toolboxNodeDir = (toolboxDir: string): string => join(toolboxDir, "node");

/**
 * 云电脑上 bash 的 PATH：四个名字的 shim 在最前，系统目录居中，venv/bin、node/bin 和 HOME 的 .local/bin 垫底。
 * pip、npm -g 和主人在终端里装的程序还能用，但盖不住系统和工具箱里的同名程序。自动放行和批准的命令是同一串，批准过的装包之后不问的 python3 也用得上。
 * 闸门认命令行工具时按的也是这一串，两边不能各算各的。
 */
export const toolboxSearchPath = (containment: ClosedContainment): string =>
  [
    toolboxShimDir(containment.toolboxDir),
    containment.searchPath,
    join(containment.toolboxDir, "venv", "bin"),
    join(toolboxNodeDir(containment.toolboxDir), "bin"),
    homeBinDir(containment.homeDir),
  ].join(":");

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

const DELETE_OR_MOVE: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mv",
  "truncate",
  "dd",
  "rename",
  "mmv",
  "trash",
  "trash-put",
  "gio",
  "srm",
  "wipe",
  "xz",
  "bzip2",
  "gzip",
  "unxz",
  "bunzip2",
  "gunzip",
  "pigz",
  "unpigz",
  "lzma",
  "unlzma",
  "rimraf",
]);

const DELETING_OPTIONS: ReadonlySet<string> = new Set([
  "--remove-files",
  "--remove-source-files",
  "--remove-destination",
  "-sdel",
]);

const deletingOption = (word: string): boolean =>
  word === "-delete" || word === "--del" || word.startsWith("--delete") || DELETING_OPTIONS.has(word);

const removesSource = (args: readonly string[]): boolean => args.includes("--rm");
const sevenZipDeletes = (args: readonly string[]): boolean => args[0] === "d";

// 归档工具删源文件、删成员的写法是短选项或子命令，同样的字母在别的命令里意思各不相同（git commit -m、python -m），
// 只在这些名字后面认。zip 的短选项串里出现 m（移进归档）或 d（删成员）就算，-9m 这类带压缩级别的也认。
const ARCHIVE_DELETES: ReadonlyMap<string, (args: readonly string[]) => boolean> = new Map([
  ["zip", (args) => args.some((word) => word === "--move" || /^-[A-Za-z0-9]*[md]/.test(word))],
  ["7z", sevenZipDeletes],
  ["7za", sevenZipDeletes],
  ["7zr", sevenZipDeletes],
  ["ar", (args) => /^-?[a-z]*d/.test(args[0] ?? "")],
  ["zstd", removesSource],
  ["lz4", removesSource],
]);

const archiveDeletes = (names: readonly string[], words: readonly string[]): boolean =>
  names.some((name, at) => ARCHIVE_DELETES.get(name)?.(words.slice(at + 1)) ?? false);

// 内联代码里的删除扫不出来，主人拍板照问。认的是跟在解释器名后面的执行代码选项（合写的短选项也算），
// 以及从标准输入读代码的写法：`-`、heredoc、here-string，或者解释器在段首、后面只有选项（管道喂进去的代码）。
const INLINE_CODE: readonly (readonly [RegExp, RegExp])[] = [
  [/^(python|pypy)[0-9.]*$/, /^-[A-Za-z]*c/],
  [/^(sh|bash|zsh|dash|ksh|mksh|ash|fish|busybox)$/, /^-[A-Za-z]*c/],
  [/^(node|nodejs|bun)$/, /^(-[A-Za-z]*[ep]|--eval|--print)$/],
  [/^deno$/, /^eval$/],
  [/^perl[0-9.]*$/, /^-[A-Za-z]*[eE]/],
  [/^ruby[0-9.]*$/, /^-[A-Za-z]*e/],
  [/^php[0-9.]*$/, /^-r$/],
  [/^lua(jit|[0-9.]*)$/, /^-e$/],
];

const INFO_OPTIONS: ReadonlySet<string> = new Set(["-V", "-v", "--version", "-h", "--help"]);

const runsInlineCode = (segment: string, names: readonly string[], words: readonly string[]): boolean =>
  names.some((name, at) => {
    const flag = INLINE_CODE.find(([interpreter]) => interpreter.test(name))?.[1];
    if (flag === undefined) return false;
    const args = words.slice(at + 1);
    if (args.some((word) => flag.test(word)) || args[0] === "-" || segment.includes("<<")) return true;
    return at === 0 && args.every((word) => word.startsWith("-") && !INFO_OPTIONS.has(word));
  });

const GIT_KEEPS_CHANGES: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "add",
  "commit",
  "fetch",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
]);

const GIT_BRANCH_REWRITES = /^(-[A-Za-z]*[dDmMf][A-Za-z]*|--delete|--move|--force)$/;
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

// 引号里的空格、括号、$(...) 留在同一个词里，路径写成 'repo(1)' 或 "$(pwd)" 也切不开 git 和它的子命令。没配对的引号吃到行尾。
const SHELL_TOKEN = /[;&|\n\r]+|(?:'[^']*(?:'|$)|"(?:[^"\\]|\\.)*(?:"|$)|[^\s'";&|])+/g;
const SEPARATOR = /^[;&|\n\r]/;
const bare = (word: string): string => word.replace(/['"\\]/g, "").replace(/^[$(`{]+|[)`}]+$/g, "");

/** 反着判：只认几个不丢改动的子命令，其余一律问。 */
const gitDiscards = (text: string): boolean => {
  const tokens = text.match(SHELL_TOKEN) ?? [];
  return tokens.some((token, index) => {
    const name = bare(token);
    if (name.slice(name.lastIndexOf("/") + 1) !== "git") return false;
    const end = tokens.findIndex((word, at) => at > index && SEPARATOR.test(word));
    const args = tokens.slice(index + 1, end === -1 ? undefined : end);
    let at = 0;
    while ((args[at] ?? "").startsWith("-")) at += GIT_OPTIONS_WITH_VALUE.has(args[at] ?? "") ? 2 : 1;
    if (at >= args.length) return false;
    const sub = bare(args[at] ?? "");
    if (!GIT_KEEPS_CHANGES.has(sub)) return true;
    return sub === "branch" && args.slice(at + 1).some((word) => GIT_BRANCH_REWRITES.test(word));
  });
};

export const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "socat",
  "ftp",
]);
const NETWORK_PROBES = new Set(["ping", "dig", "nslookup", "getent", "npx"]);
const NETWORK_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["i", "install", "add", "ci", "update", "up", "upgrade", "view", "v", "info", "show", "exec", "x"]),
  pnpm: new Set(["i", "install", "add", "update", "up", "dlx"]),
  yarn: new Set(["add", "install", "upgrade", "dlx"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  uv: new Set(["pip", "add", "sync", "tool"]),
  git: new Set(["clone", "fetch", "pull", "ls-remote"]),
};

// 段首这些词后面才是真正跑的命令：套壳、shell 关键字、变量赋值、选项和时长。
const COMMAND_PREFIXES = new Set(["timeout", "nohup", "nice", "env", "xargs", "exec", "time", "command"]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
const skippedPrefix = (word: string): boolean =>
  COMMAND_PREFIXES.has(word) ||
  SHELL_KEYWORDS.has(word) ||
  /^\w+=/.test(word) ||
  word.startsWith("-") ||
  /^\d/.test(word);

/**
 * 命令里有没有要联网的程序。和 stillAsksInSandbox 一样不解析结构，按分隔符切段，只看每段的命令头，
 * `for c in node npx` 里当参数的名字不算。闸门解析不了、只能当普通命令的那些（套了 timeout、放到后台、带变量）靠它补上联网：
 * 不补的话云电脑上直接断网放行，批了也照样没网。
 */
export function reachesNetwork(command: string): boolean {
  const flat = command.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "");
  return flat.split(/[;&|()`{}\n\r]+/).some((segment) => {
    const words = segment.split(/\s+/).filter((word) => word !== "");
    const head = words.findIndex((word) => !skippedPrefix(word));
    if (head === -1) return false;
    const name = (words[head] ?? "").slice((words[head] ?? "").lastIndexOf("/") + 1);
    if (NETWORK_COMMANDS.has(name) || NETWORK_PROBES.has(name)) return true;
    const verb = words.slice(head + 1).find((word) => !word.startsWith("-"));
    return verb !== undefined && (NETWORK_VERBS[name]?.has(verb) ?? false);
  });
}

/**
 * 沙箱兜住了联网和写工作区外，兜不住的只剩在工作区和共享区里删、移，以及内联代码。这里不解析结构：先像 bash 那样合并反斜杠续行，
 * 再去掉引号和反斜杠按分隔符切词，$(...)、反引号、循环体、xargs、find -exec、sh -c '...' 里的词都扫得到。
 * 只扫闸门本来就要问的命令，扫到了就照问，宁多问。
 */
export function stillAsksInSandbox(command: string): boolean {
  const joined = command.replace(/\\\r?\n/g, "");
  const flat = joined.replace(/['"\\]/g, "");
  if (gitDiscards(joined) || gitDiscards(flat)) return true;
  return flat.split(/[;&|()`{}\n\r]+/).some((segment) => {
    const words = segment.split(/[\s<>=$,]+/).filter((word) => word !== "");
    const names = words.map((word) => word.slice(word.lastIndexOf("/") + 1));
    return (
      names.some((name) => DELETE_OR_MOVE.has(name)) ||
      words.some(deletingOption) ||
      archiveDeletes(names, words) ||
      runsInlineCode(segment, names, words)
    );
  });
}
