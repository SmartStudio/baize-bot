import { z } from "zod";
import { BotId, ComputerKind, Timestamp } from "./domain.js";

// 用户登记的第三方命令行工具和它要的密钥。密钥绑在命令上：只有整条命令就是这个工具的那几条才拿到值、才能联网，
// 别的 bash（包括装它的那条）拿不到。值只进不出，Web 只看得到末四位。

export const CliToolId = z.string().min(1).brand<"CliToolId">();
export type CliToolId = z.infer<typeof CliToolId>;

// 改变进程或解释器行为的变量，登记了就等于让一个工具改写别的程序怎么跑，一律不收。
const RESERVED_ENV =
  /^(PATH|HOME|SHELL|USER|LOGNAME|LANG|TERM|TMPDIR|PWD|OLDPWD|IFS|ENV|BASH_ENV|CDPATH|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|COMPUTER_ID|AGENT_TOKEN|CONTROL_PLANE_AGENT_URL|LD_\w*|DYLD_\w*|LC_\w*|NPM_CONFIG_\w*|PIP_\w*|GIT_\w*|PI_\w*|BAIZE_\w*|UPSTREAM_\w*|SSL_\w*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/;

export const EnvName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "变量名只能是大写字母、数字和下划线，不以数字开头")
  .refine((name) => !RESERVED_ENV.test(name), "这个变量名会改变别的程序怎么跑，不能登记")
  .brand<"EnvName">();
export type EnvName = z.infer<typeof EnvName>;

export const EnvValue = z.string().min(1).max(4096);

// 壳、解释器、装包和提权命令不能登记：登记了它们就等于让任意代码拿着密钥联网，内联代码照问的规矩也就破了。
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "env",
  "exec",
  "eval",
  "command",
  "builtin",
  "xargs",
  "nohup",
  "timeout",
  "time",
  "nice",
  "sudo",
  "su",
  "doas",
  "python",
  "python3",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "node",
  "nodejs",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "perl",
  "ruby",
  "php",
  "lua",
  "awk",
  "gawk",
  "sed",
  "tclsh",
  "osascript",
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "rsync",
  "git",
  "docker",
  "make",
  "cat",
  "echo",
  "printf",
  "printenv",
  "set",
  "export",
  "declare",
  "source",
  "open",
]);

export const CliCommand = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "命令名只能是小写字母、数字和 . _ -")
  .refine((command) => !RESERVED_COMMANDS.has(command), "这是壳、解释器或系统命令，不能登记成工具");
export type CliCommand = z.infer<typeof CliCommand>;

// 怎么装：只收包名，不收任意装包命令。npm 装进 Bot 工具箱的 node 前缀，pip 装进工具箱的 venv。
export const CliInstall = z.discriminatedUnion("manager", [
  z
    .object({
      manager: z.literal("npm"),
      package: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~<>=*-]+)?$/),
    })
    .strict(),
  z
    .object({
      manager: z.literal("pip"),
      package: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?([<>=!~]=?[A-Za-z0-9.*+-]+)?$/),
    })
    .strict(),
]);
export type CliInstall = z.infer<typeof CliInstall>;

export const CliToolEnvView = z.object({ name: EnvName, last4: z.string().max(4) }).strict();
export type CliToolEnvView = z.infer<typeof CliToolEnvView>;

export const CliTool = z
  .object({
    id: CliToolId,
    command: CliCommand,
    install: CliInstall.nullable(),
    env: z.array(CliToolEnvView).max(10),
    computers: z.array(ComputerKind).min(1),
    // null 是全部 Bot。
    bots: z.array(BotId).min(1).nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type CliTool = z.infer<typeof CliTool>;

const EnvEntry = z.object({ name: EnvName, value: EnvValue }).strict();
const uniqueNames = (env: readonly { name: string }[]) => new Set(env.map((one) => one.name)).size === env.length;

export const CreateCliToolRequest = z
  .object({
    command: CliCommand,
    install: CliInstall.nullable(),
    env: z.array(EnvEntry).max(10).refine(uniqueNames, "变量名重复了"),
    computers: z.array(ComputerKind).min(1),
    bots: z.array(BotId).min(1).nullable(),
  })
  .strict();
export type CreateCliToolRequest = z.infer<typeof CreateCliToolRequest>;

// 改：set 里的写入或覆盖，remove 里的删掉；值从不回读，所以没有「原样保留」以外的第三种写法。
export const UpdateCliToolRequest = z
  .object({
    install: CliInstall.nullable().optional(),
    set: z.array(EnvEntry).max(10).refine(uniqueNames, "变量名重复了").optional(),
    remove: z.array(EnvName).max(10).optional(),
    computers: z.array(ComputerKind).min(1).optional(),
    bots: z.array(BotId).min(1).nullable().optional(),
  })
  .strict();
export type UpdateCliToolRequest = z.infer<typeof UpdateCliToolRequest>;

export const CliToolResponse = z.object({ tool: CliTool });
export const CliToolListResponse = z.object({ items: z.array(CliTool) });

// 下发给电脑的：已按电脑类型筛过，值在控制面解密后带上。
export const CliToolConfig = z
  .object({
    id: CliToolId,
    command: CliCommand,
    install: CliInstall.nullable(),
    env: z.array(EnvEntry).max(10),
    bots: z.array(BotId).min(1).nullable(),
  })
  .strict();
export type CliToolConfig = z.infer<typeof CliToolConfig>;
