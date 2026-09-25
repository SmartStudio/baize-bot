import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  GRANTABLE_SCOPES,
  AccountId,
  type AccountConfig,
  type ActionKind,
  type ComputerId,
  type Grant,
  type GrantTarget,
  type GroupId,
  type ToolOperation,
  type Verdict,
} from "@baize/shared";
import { parse, type ControlOperator, type ParseEntry } from "shell-quote";

export interface GateAccess {
  readonly network: boolean;
  readonly writePaths: readonly string[];
}

export interface GateContext {
  readonly workDir: string;
  readonly groupId: GroupId;
  readonly computerId: ComputerId;
  readonly platform: NodeJS.Platform;
}

export interface GateCall extends GateContext {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly mcpOperation: Pick<ToolOperation, "name" | "needsApproval"> | null;
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
const INTERNAL_TOOLS = new Set([
  "read_task",
  "update_checklist",
  "mention_bot",
  "handoff_task",
  "accept_handoff",
  "set_chief",
  "propose_skill",
  "set_cadence",
  "propose_project",
]);

export const forbiddenPathPrefixes = (workDir?: string): readonly string[] => {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, "Library", "Keychains"),
    "/Library/Keychains",
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "Chromium"),
    join(home, "Library", "Application Support", "Microsoft Edge"),
    join(home, "Library", "Application Support", "Firefox", "Profiles"),
    join(home, ".config", "google-chrome"),
    join(home, ".config", "chromium"),
    join(home, ".mozilla", "firefox"),
    ...(workDir === undefined ? [] : [join(dirname(dirname(workDir)), "chrome-profile")]),
  ];
};

export function logicalResolve(input: string, cwd: string): string {
  let normalized = input;
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  let expanded = normalized;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function realpathExisting(logical: string): string {
  const suffix: string[] = [];
  let current = logical;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR") return logical;
      const parent = dirname(current);
      if (parent === current) return logical;
      suffix.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function isInsideRoot(realChild: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (value: string): string => (platform === "darwin" ? value.toLocaleLowerCase("en-US") : value);
  const child = fold(realpathExisting(realChild));
  const realRoot = fold(realpathExisting(root));
  return child === realRoot || child.startsWith(`${realRoot}${sep}`);
}

const isForbiddenPath = (path: string, call: GateContext): boolean => {
  const real = realpathExisting(path);
  return forbiddenPathPrefixes(call.workDir).some((prefix) => isInsideRoot(real, prefix, call.platform));
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
    isInsideRoot(absolute, call.workDir, call.platform) ? "write_workspace" : "write_outside",
    absolute,
    call,
  );
};

const deletePath = (path: string, call: GateContext): ClassifiedAction => pathAction("delete", path, call);

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

const domainOf = (value: string): string | null => {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
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
  if (call.platform !== "darwin") return [plainAction("shell")];
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

const classifyTool = (call: GateCall): readonly ClassifiedAction[] => {
  const path = stringField(call.input, ["path"]);
  if (call.toolName === "read") return [path === null ? plainAction("read") : readPath(path, call)];
  if (call.toolName === "write" || call.toolName === "edit") {
    return [path === null ? plainAction("shell") : writePath(path, call)];
  }
  if (call.toolName === "bash") return classifyBash(call);
  if (INTERNAL_TOOLS.has(call.toolName)) {
    return [plainAction(call.toolName === "read_task" ? "read" : "write_workspace")];
  }
  if (call.mcpOperation === null) return [plainAction("write_workspace")];
  return [plainAction(mcpAction(call.toolName, call.mcpOperation.needsApproval), targetFromInput(call.input, call))];
};

const sameTarget = (left: GrantTarget, right: GrantTarget, platform: NodeJS.Platform): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "account" && right.kind === "account") return left.accountId === right.accountId;
  if (left.kind === "domain" && right.kind === "domain") {
    const granted = left.domain.toLowerCase();
    const actual = right.domain.toLowerCase();
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
  const itemPath = item.path;
  if (
    itemPath !== null &&
    (isForbiddenPath(itemPath, call) ||
      (item.action === "write_outside" &&
        forbiddenPathPrefixes(call.workDir).some((prefix) => isInsideRoot(prefix, itemPath, call.platform))))
  ) {
    return "deny";
  }
  if (HARD_ACTIONS.has(item.action)) return "ask";
  if (granted(item, call, grants)) return "allow";
  if (item.action === "publish" && item.target?.kind === "account") {
    const accountId = item.target.accountId;
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account?.tier === "direct_publish" && account.login === "valid") return "allow";
  }
  switch (item.action) {
    case "read":
      return item.path === null || isInsideRoot(item.path, call.workDir, call.platform) ? "allow" : "ask";
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

export function decide(call: GateCall, grants: readonly Grant[], accounts: readonly AccountConfig[]): GateDecision {
  const items = classifyTool(call);
  const evaluated = items.map((item) => ({ item, verdict: verdictForItem(item, call, grants, accounts) }));
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
    reason: selected.verdict === "deny" ? "这个路径属于固定禁区，不能读取或修改。" : null,
    access: mergeAccess(items),
  };
}
