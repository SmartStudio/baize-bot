import {
  GRANTABLE_SCOPES,
  AccountId,
  type AccountConfig,
  type ActionKind,
  type ComputerId,
  type Grant,
  type GrantTarget,
  type GroupId,
  type RoutineBoundary,
  type ToolOperation,
  type Verdict,
} from "@baize/shared";
import { parse, type ControlOperator, type ParseEntry } from "shell-quote";
import { ACCOUNT_READ_TOOL } from "./account-read.js";
import { BROWSER_TOOL_ACTIONS } from "./browser.js";
import { accountLabel, DRAFT_TOOL_NAMES } from "./drafts.js";
import {
  type ForbiddenZones,
  isInsideRoot,
  LinkLoopError,
  logicalResolve,
  PathError,
  realpathExisting,
} from "./paths.js";

export interface GateAccess {
  readonly network: boolean;
  readonly writePaths: readonly string[];
}

export interface GateContext {
  readonly workDir: string;
  readonly groupId: GroupId;
  readonly computerId: ComputerId;
  readonly platform: NodeJS.Platform;
  readonly zones: ForbiddenZones;
}

/** bash 实际跑在哪种系统沙箱里。`none` 时禁区和写范围只剩命令解析，挡不住，所以 bash 一律问。 */
export type SandboxKind = "seatbelt" | "bwrap" | "none";

export type ToolSource =
  | { readonly kind: "connected"; readonly operation: Pick<ToolOperation, "name" | "needsApproval"> }
  | { readonly kind: "extension" };

export interface GateCall extends GateContext {
  readonly sandbox: SandboxKind;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /**
   * 这个名字是谁登记的。运行器自己的工具按名字认，不看它；查不到归属是 null。撤销连接后会话里残留的旧 MCP 工具
   * 到不了这里：运行器按 `mcp.resolve` 认出它已撤下，在闸门之前就拒。
   */
  readonly source: ToolSource | null;
  /** 助理浏览器当前页的主机名，点和填按它授权。没有浏览器、还没开页或停在空白页是 null。 */
  readonly browserHost?: string | null;
  /** 这次 run 是例行触发的就带它的边界，用户当面派的是 null。必填：漏传会让只读例行悄悄放开。 */
  readonly routine: { readonly boundary: RoutineBoundary } | null;
}

export interface GateDecision {
  readonly verdict: Verdict;
  readonly action: ActionKind;
  readonly target: GrantTarget | null;
  readonly reason: string | null;
  readonly access: GateAccess;
}

interface ClassifiedAction {
  readonly action: ActionKind;
  readonly target: GrantTarget | null;
  readonly path: string | null;
  readonly access: GateAccess;
}

const NO_ACCESS: GateAccess = { network: false, writePaths: [] };
const HARD_ACTIONS = new Set<ActionKind>(["spend", "account_security", "delete"]);
const COMMAND_SEPARATORS = new Set(["|", "|&", "&&", "||", ";"]);
const INPUT_REDIRECTS = new Set(["<", "<<<", "<&"]);
const OUTPUT_REDIRECTS = new Set([">", ">>", ">&"]);
const SAFE_VALUE_COMMANDS = new Set(["echo", "printf", "pwd", "date", "whoami", "id", "uname", "true", "false"]);
const READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "stat", "file", "du", "grep"]);
const WRITE_COMMANDS = new Set(["touch", "mkdir", "install"]);
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred"]);
const OPAQUE_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "osascript",
  "eval",
  "xargs",
  "env",
  "test",
  "[",
  "find",
  "less",
  "more",
]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat", "ftp"]);
const INSTALL_COMMANDS = new Set(["apt", "apt-get", "brew", "dnf", "npm", "pnpm", "pip", "pip3", "yarn"]);
/** 闸门按名字直接放行的内部工具。运行器把这里的名字全部保留，工具连接里同名的操作不注册：工厂还是空桩时名字也占着，不然同名的 MCP 操作会顶着这个名字免审批执行。 */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  "read_task",
  "update_checklist",
  "mention_bot",
  "handoff_task",
  "accept_handoff",
  "set_chief",
  "propose_skill",
  "set_cadence",
  "propose_project",
  "report_metric",
  "remember_preference",
  "propose_team",
  "call_helper",
  "propose_routine",
  "submit_review",
  "poker_act",
  "poker_review",
]);

type ZoneHit = "hidden" | "read_only" | "other_bot" | "protected_root" | null;

const MUTATIONS = new Set<ActionKind>(["write_workspace", "write_outside", "delete"]);

// 改动落在禁区的祖先上（放宽写整个数据目录、删掉上一级）也算碰禁区。
const zoneHit = (action: ActionKind, path: string, call: GateContext & { readonly toolName?: string }): ZoneHit => {
  const real = realpathExisting(path);
  const inside = (zone: readonly string[]): boolean => zone.some((prefix) => isInsideRoot(real, prefix, call.platform));
  const covers = (zone: readonly string[]): boolean =>
    MUTATIONS.has(action) &&
    action !== "write_workspace" &&
    zone.some((prefix) => isInsideRoot(prefix, path, call.platform));
  if (covers([call.zones.dataDir])) return "other_bot";
  if (inside(call.zones.hidden) || covers(call.zones.hidden)) return "hidden";
  if (MUTATIONS.has(action) && (inside(call.zones.readOnly) || covers(call.zones.readOnly))) return "read_only";
  if (
    call.toolName !== "bash" &&
    MUTATIONS.has(action) &&
    [call.workDir, call.zones.sharedDir].some(
      (root) => isInsideRoot(real, root, call.platform) && isInsideRoot(root, real, call.platform),
    )
  )
    return "protected_root";
  if (
    isInsideRoot(real, call.zones.dataDir, call.platform) &&
    !isInsideRoot(real, call.zones.botDir, call.platform) &&
    !isInsideRoot(real, call.zones.sharedDir, call.platform)
  )
    return "other_bot";
  return null;
};

const ZONE_REASONS: Readonly<Record<Exclude<ZoneHit, null>, string>> = {
  hidden: "这个路径属于固定禁区，不能读取或修改。",
  read_only: "这个路径是配图拷贝目录，属于固定禁区，只能读不能改。",
  other_bot: "这个路径属于其他 Bot 或数据目录的私有区域，不能读取或修改。请使用共享区交换文件。",
  protected_root: "工作目录和共享区的根不能删除或替换，请只修改目录里的文件。",
};

const targetForPath = (path: string, computerId: ComputerId): GrantTarget => ({
  kind: "path",
  computerId,
  prefix: path,
});

const resolvedPathAction = (action: ActionKind, absolute: string, call: GateContext): ClassifiedAction => {
  return {
    action,
    target: targetForPath(absolute, call.computerId),
    path: absolute,
    access: action === "write_outside" ? { network: false, writePaths: [absolute] } : NO_ACCESS,
  };
};

const pathAction = (action: ActionKind, path: string, call: GateContext): ClassifiedAction =>
  resolvedPathAction(action, realpathExisting(logicalResolve(path, call.workDir)), call);

const readPath = (path: string, call: GateContext): ClassifiedAction => pathAction("read", path, call);

const writePath = (path: string, call: GateContext): ClassifiedAction => {
  const logical = logicalResolve(path, call.workDir);
  if (["/dev/null", "/dev/stdout", "/dev/stderr"].includes(logical)) {
    return resolvedPathAction("write_workspace", logical, call);
  }
  const absolute = realpathExisting(logical);
  return resolvedPathAction(
    isInsideRoot(absolute, call.workDir, call.platform) || isInsideRoot(absolute, call.zones.sharedDir, call.platform)
      ? "write_workspace"
      : "write_outside",
    absolute,
    call,
  );
};

// 删或改名动的是链接本身，但闸门按链接那头判；成环的链接解不出那头，一律不放行，出路只有用户亲手删。
const LOOP_DELETE_HINT = "要删或改名的是这条成环的链接本身，请告诉用户在电脑上直接删掉它，或者换一条不经过它的路径。";

const deletePath = (path: string, call: GateContext): ClassifiedAction => {
  try {
    return pathAction("delete", path, call);
  } catch (error) {
    if (error instanceof LinkLoopError) {
      throw new LinkLoopError(`${error.message}${LOOP_DELETE_HINT}`, { cause: error });
    }
    throw error;
  }
};

const plainAction = (
  action: ActionKind,
  target: GrantTarget | null = null,
  access: GateAccess = NO_ACCESS,
): ClassifiedAction => ({
  action,
  target,
  path: target?.kind === "path" ? target.prefix : null,
  access,
});

const stringField = (input: Record<string, unknown>, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
};

/** 域名统一成 URL 解析出的主机名：小写、IDN 转 punycode、去掉末尾的根点，`localhost.` 和 `localhost` 是同一个。 */
const domainOf = (value: string): string | null => {
  try {
    const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
    const trimmed = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
};

const browserTarget = (host: string | null): GrantTarget | null => {
  const domain = host === null ? null : domainOf(host);
  return domain === null ? null : { kind: "domain", domain };
};

const targetFromInput = (input: Record<string, unknown>, call: GateContext): GrantTarget | null => {
  const accountId = stringField(input, ["accountId", "account_id"]);
  if (accountId !== null) {
    const parsed = AccountId.safeParse(accountId);
    if (parsed.success) return { kind: "account", accountId: parsed.data };
  }
  const domainValue = stringField(input, ["url", "domain", "host", "hostname"]);
  const domain = domainValue === null ? null : domainOf(domainValue);
  if (domain !== null) return { kind: "domain", domain };
  const recipient = stringField(input, ["to", "recipient", "email"]);
  if (recipient?.includes("@")) {
    const recipientDomain = recipient.slice(recipient.lastIndexOf("@") + 1).toLowerCase();
    if (recipientDomain !== "") return { kind: "domain", domain: recipientDomain };
  }
  const path = stringField(input, ["path", "file", "directory", "dir"]);
  return path === null ? null : targetForPath(realpathExisting(logicalResolve(path, call.workDir)), call.computerId);
};

const mcpAction = (toolName: string, needsApproval: boolean): ActionKind => {
  if (!needsApproval) return "read";
  if (/^(pay|purchase|charge)_/.test(toolName)) return "spend";
  if (/^(delete|remove)_/.test(toolName)) return "delete";
  if (/^(publish|post|comment|reply|create_pr)_/.test(toolName)) return "publish";
  if (/^(send|message|email|dm)_/.test(toolName)) return "message_person";
  if (/^(like|follow|favorite|star|engage)_/.test(toolName)) return "engage";
  if (/^(authorize|oauth|password|security|connect_account)_/.test(toolName)) return "account_security";
  if (/^(install|add_dependency)_/.test(toolName)) return "install";
  return "external_write";
};

const isOperator = (token: ParseEntry | VariableToken): token is ControlOperator =>
  typeof token === "object" && token !== null && "op" in token && token.op !== "glob";

interface VariableToken {
  readonly variable: string;
}

const hasUnclosedQuote = (command: string): boolean => {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") quote = quote === "single" ? null : "single";
    if (char === '"' && quote !== "single") quote = quote === "double" ? null : "double";
  }
  return quote !== null || escaped;
};

const hasUnsafeCommandSeparator = (command: string): boolean =>
  [...command].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === 0 ||
      codePoint === 10 ||
      codePoint === 11 ||
      codePoint === 12 ||
      codePoint === 13 ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });

const shellTokens = (command: string): readonly (ParseEntry | VariableToken)[] | null => {
  if (hasUnclosedQuote(command)) return null;
  try {
    return parse<VariableToken>(command, (key) => ({ variable: key }));
  } catch {
    return null;
  }
};

interface ParsedShell {
  readonly commands: readonly (readonly string[])[];
  readonly redirects: readonly { readonly direction: "input" | "output"; readonly path: string }[];
}

const parseShell = (command: string): ParsedShell | null => {
  const tokens = shellTokens(command);
  if (tokens === null) return null;
  const commands: string[][] = [];
  const redirects: Array<{ direction: "input" | "output"; path: string }> = [];
  let current: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return null;
    if (typeof token === "string") {
      current.push(token);
      continue;
    }
    if (!isOperator(token)) return null;
    if (COMMAND_SEPARATORS.has(token.op)) {
      if (current.length === 0) return null;
      commands.push(current);
      current = [];
      continue;
    }
    if (INPUT_REDIRECTS.has(token.op) || OUTPUT_REDIRECTS.has(token.op)) {
      const next = tokens[index + 1];
      if (typeof next !== "string" || next === "") return null;
      redirects.push({ direction: INPUT_REDIRECTS.has(token.op) ? "input" : "output", path: next });
      index += 1;
      continue;
    }
    return null;
  }
  if (current.length > 0) commands.push(current);
  return commands.length === 0 ? null : { commands, redirects };
};

const commandName = (raw: string): string => raw.slice(raw.lastIndexOf("/") + 1);
const argumentsOf = (words: readonly string[]): readonly string[] =>
  words.slice(1).filter((word) => !word.startsWith("-"));

const likelyPath = (value: string): boolean =>
  value === "." ||
  value === ".." ||
  value.startsWith("/") ||
  value.startsWith("~") ||
  value.startsWith("@") ||
  value.includes("/") ||
  value.includes(".");

const READ_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  ls: ["-a", "-A", "-l", "-h", "-1", "-R", "--all", "--almost-all", "--human-readable", "--long", "--recursive"],
  cat: [
    "-n",
    "-b",
    "-s",
    "-E",
    "-T",
    "-v",
    "--number",
    "--number-nonblank",
    "--squeeze-blank",
    "--show-ends",
    "--show-tabs",
    "--show-nonprinting",
  ],
  head: ["-n", "-c", "-q", "-v", "--lines", "--bytes", "--quiet", "--verbose"],
  tail: ["-n", "-c", "-q", "-v", "-f", "--lines", "--bytes", "--quiet", "--verbose", "--follow"],
  wc: ["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"],
  stat: ["-f", "-L", "-t", "--file-system", "--dereference", "--terse"],
  file: ["-b", "-i", "-L", "-h", "--brief", "--mime", "--dereference", "--no-pad"],
  du: ["-h", "-s", "-a", "-d", "--human-readable", "--summarize", "--all", "--max-depth"],
  grep: [
    "-i",
    "-n",
    "-v",
    "-r",
    "-R",
    "-E",
    "-F",
    "-w",
    "-x",
    "-l",
    "-c",
    "-q",
    "-o",
    "-e",
    "-f",
    "--ignore-case",
    "--line-number",
    "--invert-match",
    "--recursive",
    "--extended-regexp",
    "--fixed-strings",
    "--word-regexp",
    "--only-matching",
    "--count",
    "--quiet",
  ],
};

const SAFE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  echo: ["-n"],
  printf: [],
  pwd: ["-L", "-P"],
  date: ["-u"],
  whoami: [],
  id: ["-u", "-g", "-G", "-n", "-r"],
  uname: ["-a", "-m", "-n", "-p", "-r", "-s", "-v"],
  true: [],
  false: [],
};

const EXECUTING_OPTIONS = /^(?:-+)(?:exec(?:dir)?|ok(?:dir)?|delete|command|run|remove)(?:=|$)/;

const hasUnsafeOption = (name: string, words: readonly string[]): boolean => {
  if (words.some((word) => EXECUTING_OPTIONS.test(word))) return true;
  if (name === "date" && words.some((word) => word === "-f" || word === "--file")) return true;
  if (
    name === "git" &&
    words.some((word) => ["-c", "--config-env", "--exec-path", "--ext-diff", "--textconv"].includes(word))
  ) {
    return true;
  }
  return false;
};

const hasUnknownReadOption = (name: string, words: readonly string[]): boolean => {
  const known = new Set(READ_OPTIONS[name] ?? []);
  return words.some((word) => word.startsWith("-") && word !== "--" && !known.has(word));
};

const hasUnknownSafeOption = (name: string, words: readonly string[]): boolean => {
  const known = new Set(SAFE_OPTIONS[name] ?? []);
  return words.some((word) => word.startsWith("-") && !known.has(word));
};

const hasUnknownMutationOption = (name: string, words: readonly string[]): boolean => {
  const known = name === "mkdir" ? new Set(["-p"]) : name === "touch" ? new Set(["-a", "-c", "-m"]) : new Set<string>();
  return words.some((word) => word.startsWith("-") && !known.has(word));
};

const classifyCommand = (words: readonly string[], call: GateContext): readonly ClassifiedAction[] => {
  let nameIndex = 0;
  while (nameIndex < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[nameIndex] ?? "")) nameIndex += 1;
  const rawName = words[nameIndex];
  if (rawName === undefined) return [plainAction("shell")];
  const name = commandName(rawName);
  const args = argumentsOf(words.slice(nameIndex));

  const commandArgs = words.slice(nameIndex + 1);
  if (SAFE_VALUE_COMMANDS.has(name)) {
    return hasUnsafeOption(name, commandArgs) || hasUnknownSafeOption(name, commandArgs)
      ? [plainAction("shell")]
      : [plainAction("read")];
  }
  if (name === "env") return commandArgs.length === 0 ? [plainAction("read")] : [plainAction("shell")];
  if (OPAQUE_COMMANDS.has(name) || name === "cd" || name === "command") return [plainAction("shell")];
  if (NETWORK_COMMANDS.has(name)) {
    const proxyOption = commandArgs.some((arg) =>
      /^(?:-x|--proxy|--preproxy|--connect-to|--resolve|--socks(?:4a?|5(?:-hostname)?))(?:=|[^-]|$)/.test(arg),
    );
    const domainValue =
      args.find((arg) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg)) ??
      args.find((arg) => !arg.includes("=") && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(arg));
    const destinations = args.filter(
      (arg) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg) || /^[A-Za-z0-9.-]+(?::\d+)?$/.test(arg),
    );
    if (proxyOption || destinations.length !== 1)
      return [plainAction("shell", null, { network: true, writePaths: [] })];
    const domain = domainValue === undefined ? null : domainOf(domainValue);
    return [
      plainAction("shell", domain === null ? null : { kind: "domain", domain }, { network: true, writePaths: [] }),
    ];
  }
  if (INSTALL_COMMANDS.has(name) && args.some((arg) => /^(add|install|update|upgrade)$/.test(arg))) {
    return [plainAction("install")];
  }
  if (DELETE_COMMANDS.has(name)) {
    return (args.length === 0 ? ["."] : args).map((path) => deletePath(path, call));
  }
  if (name === "mv") {
    return args.length === 0
      ? [plainAction("shell")]
      : [...args.slice(0, -1).map((path) => deletePath(path, call)), writePath(args.at(-1) ?? ".", call)];
  }
  if (name === "cp") {
    if (commandArgs.some((word) => word.startsWith("-"))) return [plainAction("shell")];
    return args.length < 2
      ? [plainAction("shell")]
      : [...args.slice(0, -1).map((path) => readPath(path, call)), writePath(args.at(-1) ?? ".", call)];
  }
  if (name === "ln") {
    if (commandArgs.some((word) => word.startsWith("-") && !["-s", "--symbolic"].includes(word))) {
      return [plainAction("shell")];
    }
    const target = args.at(-1);
    return target === undefined ? [plainAction("shell")] : [writePath(target, call)];
  }
  if (name === "tee" || WRITE_COMMANDS.has(name)) {
    if (hasUnknownMutationOption(name, commandArgs)) return [plainAction("shell")];
    return args.length === 0 ? [plainAction("shell")] : args.map((path) => writePath(path, call));
  }
  if (READ_COMMANDS.has(name)) {
    if (hasUnsafeOption(name, commandArgs) || hasUnknownReadOption(name, commandArgs)) return [plainAction("shell")];
    const paths = args.filter(likelyPath);
    return paths.length === 0 ? [plainAction("read")] : paths.map((path) => readPath(path, call));
  }
  if (name === "git") {
    if (hasUnsafeOption(name, commandArgs)) return [plainAction("shell")];
    const subcommand = args[0];
    if (["status", "diff", "log", "show"].includes(subcommand ?? "")) return [plainAction("read")];
    if (subcommand === "push") return [plainAction("publish")];
  }
  return [plainAction("shell")];
};

const classifyBash = (call: GateCall): readonly ClassifiedAction[] => {
  if (call.sandbox === "none") return [plainAction("shell")];
  const command = call.input.command;
  if (typeof command !== "string" || command.trim() === "") return [plainAction("shell")];
  if (hasUnsafeCommandSeparator(command)) return [plainAction("shell")];
  const parsed = parseShell(command);
  if (parsed === null) return [plainAction("shell")];
  return [
    ...parsed.commands.flatMap((words) => classifyCommand(words, call)),
    ...parsed.redirects.map((redirect) =>
      redirect.direction === "input" ? readPath(redirect.path, call) : writePath(redirect.path, call),
    ),
  ];
};

/** 运行器自己的工具、浏览器和账号读：名字就能定动作。认不出的返回 null，那是工具连接里的操作，或调用方注入的扩展工具。 */
const classifyOwnTool = (call: GateCall): readonly ClassifiedAction[] | null => {
  const path = stringField(call.input, ["path"]);
  if (call.toolName === "read") return [path === null ? plainAction("read") : readPath(path, call)];
  if (call.toolName === "write" || call.toolName === "edit") {
    return [path === null ? plainAction("shell") : writePath(path, call)];
  }
  if (call.toolName === "bash") return classifyBash(call);
  if (INTERNAL_TOOLS.has(call.toolName)) {
    return [plainAction(call.toolName === "read_task" ? "read" : "write_workspace")];
  }
  // 只发 GET，账号越权在工具里、令牌在控制面，这里归 read 不问。
  if (call.toolName === ACCOUNT_READ_TOOL) return [plainAction("read", targetFromInput(call.input, call))];
  const browserAction = BROWSER_TOOL_ACTIONS.get(call.toolName);
  // 点和填的目标只认浏览器自己报的当前页主机名：入参是模型写的，写个 hostname 就能冒领别的域名的授权。
  if (browserAction === "engage") return [plainAction(browserAction, browserTarget(call.browserHost ?? null))];
  if (browserAction !== undefined) return [plainAction(browserAction, targetFromInput(call.input, call))];
  return null;
};

// 查不到归属的名字按未知外部操作问用户：它既不是运行器自己的，也没有 needsApproval 可看。
// 调用方注入的扩展工具是宿主代码，和运行器自己的工具一样放行。
const classifyConnected = (call: GateCall): readonly ClassifiedAction[] => {
  if (call.source === null) return [plainAction("external_write", targetFromInput(call.input, call))];
  if (call.source.kind === "extension") return [plainAction("write_workspace")];
  return [
    plainAction(mcpAction(call.toolName, call.source.operation.needsApproval), targetFromInput(call.input, call)),
  ];
};

const sameTarget = (left: GrantTarget, right: GrantTarget, platform: NodeJS.Platform): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "account" && right.kind === "account") return left.accountId === right.accountId;
  if (left.kind === "domain" && right.kind === "domain") {
    const granted = domainOf(left.domain) ?? left.domain.toLowerCase();
    const actual = domainOf(right.domain) ?? right.domain.toLowerCase();
    return actual === granted || actual.endsWith(`.${granted}`);
  }
  if (left.kind === "path" && right.kind === "path") {
    return left.computerId === right.computerId && isInsideRoot(realpathExisting(right.prefix), left.prefix, platform);
  }
  return false;
};

const granted = (item: ClassifiedAction, call: GateContext, grants: readonly Grant[]): boolean => {
  const target = item.target;
  if (target === null) return false;
  return grants.some(
    (grant) =>
      grant.action === item.action &&
      GRANTABLE_SCOPES[item.action].includes(grant.scope) &&
      (grant.scope === "forever" || grant.groupId === call.groupId) &&
      sameTarget(grant.target, target, call.platform),
  );
};

const verdictForItem = (
  item: ClassifiedAction,
  call: GateContext,
  grants: readonly Grant[],
  accounts: readonly AccountConfig[],
): Verdict => {
  if (item.path !== null && zoneHit(item.action, item.path, call) !== null) return "deny";
  if (HARD_ACTIONS.has(item.action)) return "ask";
  if (granted(item, call, grants)) return "allow";
  if (item.action === "publish" && item.target?.kind === "account") {
    const accountId = item.target.accountId;
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account?.tier === "direct_publish" && account.login === "valid") return "allow";
  }
  switch (item.action) {
    case "read":
      return item.path === null ||
        isInsideRoot(item.path, call.workDir, call.platform) ||
        isInsideRoot(item.path, call.zones.sharedDir, call.platform)
        ? "allow"
        : "ask";
    case "write_workspace":
      return "allow";
    case "write_outside":
    case "delete":
    case "shell":
    case "publish":
    case "message_person":
    case "engage":
    case "spend":
    case "account_security":
    case "install":
    case "external_write":
      return "ask";
    default: {
      const exhaustive: never = item.action;
      return exhaustive;
    }
  }
};

const mergeAccess = (items: readonly ClassifiedAction[]): GateAccess => ({
  network: items.some((item) => item.access.network),
  writePaths: [...new Set(items.flatMap((item) => item.access.writePaths))],
});

export function verdictFor(
  action: ActionKind,
  target: GrantTarget | null,
  call: GateContext,
  grants: readonly Grant[],
  accounts: readonly AccountConfig[],
): Verdict {
  return verdictForItem(plainAction(action, target), call, grants, accounts);
}

const DRAFT_TOOLS: ReadonlySet<string> = new Set(DRAFT_TOOL_NAMES);

/**
 * 「只读」例行不许做的事，值是理由里那句「不能……」。null 是不拦，归原来的判定管。
 * 每个动作都得表个态：新增 ActionKind 时这里编译不过，不会悄悄漏拦。
 */
const READ_ONLY_BARS: Readonly<Record<ActionKind, string | null>> = {
  read: null,
  write_workspace: null,
  shell: null,
  install: null,
  spend: null,
  account_security: null,
  external_write: null,
  publish: "发布",
  message_person: "联系别人",
  engage: "在网页上点或填",
  write_outside: "写工作目录以外的文件",
  delete: "删东西",
};

interface ReadOnlyDenial {
  readonly action: ActionKind;
  readonly reason: string;
}

interface ToolBar {
  readonly action: ActionKind;
  readonly bar: string;
}

/**
 * 「只读」例行里按工具名拦的：起草工具，往「等你确认」里堆卡的提案类工具，和直接改状态或叫别人干活的内部工具。
 * 这些工具平时归 write_workspace 直接放行（卡本身就是确认，改节奏是用户当面说的话），所以不能靠 READ_ONLY_BARS 按动作拦。
 * 「只读」按不改东西理解：改清单、换首席、交接都会写任务的状态；mention_bot 会让别的 Bot 起一条不带只读边界的 run，是旁路。
 * 新增的内部工具要么在这里登记，要么进 gate.test.ts 的放行清单，那里有一条用例把 INTERNAL_TOOLS 逐个过一遍。
 */
const READ_ONLY_TOOL_BARS: ReadonlyMap<string, ToolBar> = new Map<string, ToolBar>([
  ...DRAFT_TOOL_NAMES.map((name): [string, ToolBar] => [name, { action: "publish", bar: "起草" }]),
  ["propose_project", { action: "write_workspace", bar: "出方案卡" }],
  ["propose_team", { action: "write_workspace", bar: "出建队卡" }],
  ["propose_routine", { action: "write_workspace", bar: "出例行卡" }],
  ["propose_skill", { action: "write_workspace", bar: "问用户存不存 skill" }],
  ["set_cadence", { action: "write_workspace", bar: "改项目节奏" }],
  ["update_checklist", { action: "write_workspace", bar: "改任务卡清单" }],
  ["set_chief", { action: "write_workspace", bar: "换首席" }],
  ["handoff_task", { action: "write_workspace", bar: "发起交接" }],
  ["accept_handoff", { action: "write_workspace", bar: "接手交接" }],
  ["mention_bot", { action: "write_workspace", bar: "叫别的 Bot 干活" }],
  // 牌桌 run 不会带只读边界，登记只为了给每个内部工具一个表态。
  ["poker_act", { action: "write_workspace", bar: "出牌" }],
  ["poker_review", { action: "write_workspace", bar: "交复盘" }],
]);

const READ_ONLY_NEXT_STEP =
  "只读例行只读取和汇报，不产出要用户批的东西，要说的写在回复里；需要的话请告诉用户把这条例行改成「草稿等你批」。";

const readOnlyReason = (bar: string): string => `这是「只读」例行，不能${bar}。${READ_ONLY_NEXT_STEP}`;

const NO_SANDBOX_REASON = `这台电脑没有沙箱，只读例行里不能执行命令。${READ_ONLY_NEXT_STEP}`;

const UNKNOWN_CONNECTED_REASON = `这是「只读」例行，不能用不确定是否只读的插件操作。${READ_ONLY_NEXT_STEP}`;

const UNTRACED_TOOL_REASON = `这是「只读」例行，只能用运行器自带的工具和认得出是只读的插件操作，这个工具两边都不是。${READ_ONLY_NEXT_STEP}`;

const PATH_UNRESOLVED_REASON = "闸门解不出这个路径指向哪里，不猜，不放行。";

/**
 * 工具连接里的操作在「只读」例行里能放行的名字：第一段是这些读动词。needsApproval 是用户能改的审批偏好，
 * 不是操作的性质，名字之外没有别的只读标记，所以认不出的一律当不确定，失败即关。
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get",
  "list",
  "read",
  "search",
  "fetch",
  "query",
  "find",
  "lookup",
  "describe",
  "view",
  "count",
]);

/** 名字里出现连词就是两个动作接在一起（`fetch_and_store`、`get_or_create`），后半截是什么都当没把握。 */
const CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "then", "or"]);

/**
 * 读动词后面出现的写词。`verb` 在哪个位置都算写（`get_x_delete` 是删）；`verb_or_noun` 只在后面还跟着别的段时算写，
 * 落在末段是宾语（`get_update`、`list_message`、`get_user_email` 是读，`view_update_profile`、`lookup_set_price` 是写）。
 */
type WriteWord = "verb" | "verb_or_noun";
const WRITE_WORDS: ReadonlyMap<string, WriteWord> = new Map<string, WriteWord>([
  ["add", "verb"],
  ["approve", "verb"],
  ["archive", "verb_or_noun"],
  ["assign", "verb"],
  ["authorize", "verb"],
  ["ban", "verb_or_noun"],
  ["buy", "verb"],
  ["cancel", "verb"],
  ["charge", "verb_or_noun"],
  ["clear", "verb"],
  ["comment", "verb_or_noun"],
  ["connect", "verb"],
  ["create", "verb"],
  ["delete", "verb"],
  ["deploy", "verb"],
  ["dm", "verb_or_noun"],
  ["drop", "verb"],
  ["edit", "verb_or_noun"],
  ["email", "verb_or_noun"],
  ["enable", "verb"],
  ["engage", "verb"],
  ["exec", "verb"],
  ["execute", "verb"],
  ["follow", "verb"],
  ["grant", "verb_or_noun"],
  ["import", "verb_or_noun"],
  ["install", "verb"],
  ["invite", "verb"],
  ["kill", "verb"],
  ["like", "verb_or_noun"],
  ["mark", "verb_or_noun"],
  ["merge", "verb"],
  ["message", "verb_or_noun"],
  ["move", "verb"],
  ["oauth", "verb_or_noun"],
  ["password", "verb_or_noun"],
  ["patch", "verb_or_noun"],
  ["pay", "verb"],
  ["post", "verb_or_noun"],
  ["publish", "verb"],
  ["purchase", "verb_or_noun"],
  ["push", "verb"],
  ["put", "verb"],
  ["reboot", "verb"],
  ["refund", "verb"],
  ["reject", "verb"],
  ["remove", "verb"],
  ["rename", "verb"],
  ["replace", "verb"],
  ["reply", "verb_or_noun"],
  ["reset", "verb"],
  ["restart", "verb"],
  ["revoke", "verb"],
  ["run", "verb_or_noun"],
  ["send", "verb"],
  ["set", "verb_or_noun"],
  ["shutdown", "verb"],
  ["star", "verb_or_noun"],
  ["store", "verb_or_noun"],
  ["submit", "verb"],
  ["sync", "verb"],
  ["transfer", "verb_or_noun"],
  ["trigger", "verb_or_noun"],
  ["truncate", "verb"],
  ["unlock", "verb"],
  ["update", "verb_or_noun"],
  ["upload", "verb_or_noun"],
  ["wipe", "verb"],
  ["write", "verb"],
]);

/**
 * 下划线、连字符、点号、驼峰边界都是段的分隔，段统一成小写：`getXDelete`、`get_x-delete`、`GET_X_DELETE` 是同一个名字。
 * 连续大写后面接小写也是边界，`getXDelete` 的 X 和 Delete 分开。
 */
const nameSegments = (toolName: string): readonly string[] =>
  toolName
    .replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g, "_")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== "");

const isReadOnlyName = (toolName: string): boolean => {
  const [head, ...rest] = nameSegments(toolName);
  if (head === undefined || rest.length === 0 || !READ_VERBS.has(head)) return false;
  return rest.every((segment, index) => {
    if (CONJUNCTIONS.has(segment)) return false;
    const word = WRITE_WORDS.get(segment);
    return word === undefined || (word === "verb_or_noun" && index === rest.length - 1);
  });
};

/** 按名字能认出的写动作拒绝并点名是哪一类，其余没把握的拒绝并说不确定。读类名字返回 null，交给后面的原判定。 */
const readOnlyConnectedDenial = (toolName: string): ReadOnlyDenial | null => {
  if (isReadOnlyName(toolName)) return null;
  const named = mcpAction(toolName, true);
  const bar = READ_ONLY_BARS[named];
  return bar === null
    ? { action: "external_write", reason: UNKNOWN_CONNECTED_REASON }
    : { action: named, reason: readOnlyReason(bar) };
};

/** 不用分类就能定的：登记的工具名，和没有沙箱时的 bash。 */
const readOnlyNameDenial = (call: GateCall): ReadOnlyDenial | null => {
  const toolBar = READ_ONLY_TOOL_BARS.get(call.toolName);
  if (toolBar !== undefined) return { action: toolBar.action, reason: readOnlyReason(toolBar.bar) };
  // 没有沙箱时 bash 只剩命令解析，挡不住同义的写法，所以不看命令内容，一律不跑；有沙箱时仍按命令分类。
  if (call.toolName === "bash" && call.sandbox === "none") return { action: "shell", reason: NO_SANDBOX_REASON };
  return null;
};

const readOnlyDecision = (denial: ReadOnlyDenial): GateDecision => ({
  verdict: "deny",
  action: denial.action,
  target: null,
  reason: denial.reason,
  access: NO_ACCESS,
});

const draftAccountIds = (input: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(input["drafts"])
    ? input["drafts"].map((draft: unknown) =>
        typeof draft === "object" && draft !== null ? (draft as Record<string, unknown>)["accountId"] : undefined,
      )
    : [input["accountId"]];

// 起草不是真发：草稿卡本身就是确认，所以不看授权、不出审批卡，只看账号档。
// 清单里没有的账号放行，工具自己报错并列出能用的账号；edit_draft 不带账号，档在建草稿时已经看过。
function decideDraft(input: Record<string, unknown>, accounts: readonly AccountConfig[]): GateDecision {
  const used = draftAccountIds(input).flatMap((id) => accounts.filter((account) => account.id === id));
  const readOnly = used.find((account) => account.tier === "read_only");
  const target = readOnly ?? used[0];
  return {
    verdict: readOnly === undefined ? "allow" : "deny",
    action: "publish",
    target: target === undefined ? null : { kind: "account", accountId: target.id },
    reason:
      readOnly === undefined
        ? null
        : `${accountLabel(readOnly)} 是只读档，不能起草。换一个账号，或者告诉用户去账号页把它调成起草档。`,
    access: NO_ACCESS,
  };
}

/** Pi 的 tool_call 事件不接住处理器抛的错，所以路径解不出来在这里变成拒绝，不往外抛。 */
export function decide(call: GateCall, grants: readonly Grant[], accounts: readonly AccountConfig[]): GateDecision {
  try {
    return decideResolved(call, grants, accounts);
  } catch (error) {
    if (!(error instanceof PathError)) throw error;
    return {
      verdict: "deny",
      action: call.toolName === "read" ? "read" : "write_outside",
      target: null,
      reason: `${PATH_UNRESOLVED_REASON}${error.message}`,
      access: NO_ACCESS,
    };
  }
}

function decideResolved(call: GateCall, grants: readonly Grant[], accounts: readonly AccountConfig[]): GateDecision {
  const readOnly = call.routine?.boundary === "read_only";
  // 同名的 MCP 操作注册时就被跳过，所以这些名字一定是运行器自己的工具，不看 source。
  const nameDenial = readOnly ? readOnlyNameDenial(call) : null;
  if (nameDenial !== null) return readOnlyDecision(nameDenial);
  if (DRAFT_TOOLS.has(call.toolName)) return decideDraft(call.input, accounts);
  const own = classifyOwnTool(call);
  if (readOnly && own === null) {
    const denial =
      call.source?.kind === "connected"
        ? readOnlyConnectedDenial(call.toolName)
        : { action: "external_write" as const, reason: UNTRACED_TOOL_REASON };
    if (denial !== null) return readOnlyDecision(denial);
  }
  const items = own ?? classifyConnected(call);
  const evaluated = items.map((item) => {
    // 边界排在授权和默认表前面：永久授权也救不了只读例行。
    const bar = readOnly ? READ_ONLY_BARS[item.action] : null;
    return bar === null
      ? { item, verdict: verdictForItem(item, call, grants, accounts), reason: null }
      : { item, verdict: "deny" as const, reason: readOnlyReason(bar) };
  });
  const denied = evaluated.find((entry) => entry.verdict === "deny");
  const asked = evaluated.find((entry) => entry.verdict === "ask");
  const selected = denied ?? asked ?? evaluated[0];
  if (selected === undefined) {
    return { verdict: "ask", action: "shell", target: null, reason: null, access: NO_ACCESS };
  }
  return {
    verdict: selected.verdict,
    action: selected.item.action,
    target: selected.item.target,
    reason:
      selected.reason ??
      (selected.verdict === "deny" && selected.item.path !== null
        ? ZONE_REASONS[zoneHit(selected.item.action, selected.item.path, call) ?? "hidden"]
        : null),
    access: mergeAccess(items),
  };
}
