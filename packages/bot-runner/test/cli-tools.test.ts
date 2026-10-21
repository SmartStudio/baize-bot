import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotId, type CliInstall, CliToolConfig, CliToolId, ComputerId, GroupId, installCommand } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliToolsFor, homeCommands, renderCliToolsSection } from "../src/cli-tools.js";
import { decide, type GateAccess, type GateCall } from "../src/gate.js";
import { botDirs, ensureBotDirs, forbiddenZones } from "../src/paths.js";
import { createSandboxedBash, redactSecrets, sandboxKind, toolboxCommand, whitelistEnv } from "../src/sandbox.js";

const SECRET = "xai-test-secret-0123456789";
const GROK = CliToolConfig.parse({
  id: "tool-grok",
  command: "baize-test-cli",
  install: { manager: "npm", package: "@vibe-kit/grok-cli" },
  env: [{ name: "GROK_API_KEY", value: SECRET }],
  bots: null,
});
const OTHER = CliToolConfig.parse({
  id: "tool-other",
  command: "other",
  install: null,
  env: [{ name: "OTHER_KEY", value: "abc" }],
  bots: ["bot-2"],
});

let root = "";
let sysBin = "";
const bot1 = BotId.parse("bot-1");
const dirs = () => botDirs(root, bot1);
const nodeBin = () => join(dirs().toolboxDir, "node", "bin");
const homeDir = () => join(root, "home");
const homeBin = () => join(homeDir(), ".local", "bin");

const executable = (path: string, body = "#!/bin/sh\necho ran\n"): void => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "baize-cli-tools-"));
  ensureBotDirs(dirs());
  sysBin = join(root, "sysbin");
  mkdirSync(sysBin);
  // 照 npm -g 的布局：bin 下是指向 lib/node_modules 里入口的软链。
  const pkg = join(dirs().toolboxDir, "node", "lib", "node_modules", "@vibe-kit", "grok-cli", "dist");
  mkdirSync(pkg, { recursive: true });
  executable(join(pkg, "index.js"));
  mkdirSync(nodeBin(), { recursive: true });
  symlinkSync(join(pkg, "index.js"), join(nodeBin(), "baize-test-cli"));
  // 指到工具箱外的软链：恶意包可以这么放，真实路径出了工具箱就不认。
  const outside = join(root, "outside-escape");
  executable(outside);
  symlinkSync(outside, join(nodeBin(), "escape"));
  // 系统目录里有同名程序时，PATH 先找到系统的那个。
  executable(join(sysBin, "shadow"));
  executable(join(nodeBin(), "shadow"));
  // 主人在终端里 npm i -g 装的：prefix 是 ~/.local，bin 下同样是指向 lib/node_modules 的软链。
  const homePkg = join(homeDir(), ".local", "lib", "node_modules", "@xai-official", "grok", "bin");
  mkdirSync(homePkg, { recursive: true });
  executable(join(homePkg, "grok.js"));
  mkdirSync(homeBin(), { recursive: true });
  symlinkSync(join(homePkg, "grok.js"), join(homeBin(), "home-cli"));
  // HOME 的 bin 里指到 HOME 外（这里是工具箱里）的软链，真实路径不在 HOME 里就不认。
  symlinkSync(join(pkg, "index.js"), join(homeBin(), "home-escape"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NPM_PKG = "@baize-test/cli";
const PIP_PKG = "baize-test-py";
const tool = (command: string, install: CliInstall | null = null) => ({
  id: CliToolId.parse(`tool-${command}`),
  command,
  install,
});
const TOOLS = [
  tool("baize-test-cli", { manager: "npm", package: NPM_PKG }),
  tool("baize-test-py", { manager: "pip", package: PIP_PKG }),
  tool("missing"),
  tool("escape"),
  tool("shadow"),
  tool("home-cli"),
  tool("home-escape"),
];

const cloud = (command: string, overrides: Partial<GateCall> = {}): GateCall => ({
  workDir: dirs().workDir,
  zones: forbiddenZones(dirs(), null),
  groupId: GroupId.parse("group-1"),
  computerId: ComputerId.parse("computer-1"),
  platform: "linux",
  toolName: "bash",
  input: { command },
  sandbox: "bwrap",
  containment: { level: "closed", searchPath: sysBin, toolboxDir: dirs().toolboxDir, homeDir: homeDir() },
  source: null,
  routine: null,
  cliTools: TOOLS,
  ...overrides,
});

describe("命令行工具的门禁判定", () => {
  const cliAllowed = () => ({
    verdict: "allow",
    action: "shell",
    access: { network: true, writePaths: [homeDir()], cliTools: ["tool-baize-test-cli"] },
  });

  it.each([
    'baize-test-cli -p "hi"',
    "baize-test-cli",
    "baize-test-cli | head -n 5",
    "baize-test-cli -p 'x' | grep -i x",
    "baize-test-cli | tail -n 1 | wc -l",
  ])("%s：云电脑上判 cli，不问、带网络和工具", (command) => {
    expect(decide(cloud(command), [], [])).toMatchObject(cliAllowed());
  });

  it.each([
    "baize-test-cli; rm x",
    "baize-test-cli && ls",
    "baize-test-cli || ls",
    "baize-test-cli > out.txt",
    "baize-test-cli < in.txt",
    "baize-test-cli -p $(cat prompt)",
    'baize-test-cli -p "$X"',
    "baize-test-cli -p `cat prompt`",
    "echo $GROK_API_KEY",
    "env",
    "printenv GROK_API_KEY",
    "GROK_API_KEY=x baize-test-cli",
    "baize-test-cli | cat /etc/passwd",
    "baize-test-cli | sh",
    "baize-test-cli | python3",
    "baize-test-cli # c",
    "baize-test-cli &",
    `${nodeBin()}/baize-test-cli`,
    "sh -c baize-test-cli",
    "(baize-test-cli)",
    "ls | head",
  ])("%s：不算 cli，拿不到工具 env", (command) => {
    const decision = decide(cloud(command), [], []);
    expect(decision.access.cliTools ?? [], decision.verdict).toEqual([]);
  });

  it.each(["npm i -g @vibe-kit/grok-cli", "npm install --global @vibe-kit/grok-cli"])(
    "%s：装进工具箱的 node 前缀，要问，写路径只开这个目录，不带工具 env",
    (command) => {
      const decision = decide(cloud(command), [], []);
      expect(decision).toMatchObject({
        verdict: "ask",
        action: "install",
        access: { network: true, writePaths: [join(dirs().toolboxDir, "node")] },
      });
      expect(decision.access.cliTools).toBeUndefined();
    },
  );

  it("pip install 不带工具 env", () => {
    expect(decide(cloud("pip install six"), [], []).access.cliTools).toBeUndefined();
  });

  it.each([
    ["missing", "登记了但没装"],
    ["escape", "bin 软链指到工具箱外"],
    ["shadow", "系统目录里有同名程序"],
    ["home-escape", "HOME 的 bin 软链指到 HOME 外"],
  ])("%s（%s）：不算 cli", (command) => {
    expect(decide(cloud(command), [], []).access.cliTools ?? []).toEqual([]);
  });

  it("主人在终端里装进 ~/.local/bin 的登记工具也认，放行时 HOME 可写，登录态写得回去", () => {
    expect(decide(cloud("home-cli -p hi"), [], [])).toMatchObject({
      verdict: "allow",
      action: "shell",
      access: { network: true, writePaths: [homeDir()], cliTools: ["tool-home-cli"] },
    });
  });

  it.each(["ls -la", "cat README.md", "python3 script.py", "home-cli; ls"])(
    "%s：不是登记工具的命令 HOME 不放开写",
    (command) => {
      expect(decide(cloud(command), [], []).access.writePaths, command).not.toContain(homeDir());
    },
  );

  it("没登记的 ~/.local/bin 命令当主人装的工具：不问、联网、HOME 可写，不带任何登记工具的 env", () => {
    for (const command of ["home-cli -p hi", "home-cli | head -n 3"]) {
      expect(decide(cloud(command, { cliTools: [] }), [], []), command).toMatchObject({
        verdict: "allow",
        action: "shell",
        access: { network: true, writePaths: [homeDir()], cliTools: [] },
      });
    }
    expect(decide(cloud("home-cli | baize-test-cli", { cliTools: [TOOLS[0]!] }), [], [])).toMatchObject({
      verdict: "allow",
      access: { network: true, cliTools: ["tool-baize-test-cli"] },
    });
  });

  it.each([
    ["home-escape", "软链指到 HOME 外"],
    ["baize-test-cli", "在工具箱的 node/bin 里，没登记"],
    ["home-cli; ls", "带连接符"],
    ["home-cli > out.txt", "带重定向"],
  ])("%s（%s）：没登记就不当工具，不给网", (command) => {
    const decision = decide(cloud(command, { cliTools: [] }), [], []);
    expect(decision.access.network, decision.verdict).toBe(false);
    expect(decision.access.writePaths).not.toContain(homeDir());
  });

  it("~/.local/bin 的命令只在云电脑上认，没沙箱和只读例行照旧", () => {
    expect(decide(cloud("home-cli", { cliTools: [], sandbox: "none" }), [], []).access.network).toBe(false);
    expect(decide(cloud("home-cli", { cliTools: [], routine: { boundary: "read_only" } }), [], []).access.network).toBe(
      false,
    );
  });

  it("工具不属于这个 Bot（没传进来）就不认", () => {
    expect(decide(cloud("baize-test-cli", { cliTools: [tool("other")] }), [], []).access.cliTools ?? []).toEqual([]);
    expect(decide(cloud("baize-test-cli", { cliTools: [] }), [], []).access.cliTools ?? []).toEqual([]);
  });

  it("PATH 里有相对项时 bash 按 cwd 找，不认", () => {
    const containment = {
      level: "closed",
      searchPath: `./node_modules/.bin:${sysBin}`,
      toolboxDir: dirs().toolboxDir,
      homeDir: homeDir(),
    };
    expect(decide(cloud("baize-test-cli", { containment } as Partial<GateCall>), [], []).access.cliTools ?? []).toEqual(
      [],
    );
  });

  it.each([
    ["Mac", { platform: "darwin", sandbox: "seatbelt", containment: { level: "none" } }],
    ["本机 Linux", { containment: { level: "none" } }],
    ["没有系统沙箱", { sandbox: "none" }],
    ["只读例行", { routine: { boundary: "read_only" } }],
  ] as const)("%s 上的 baize-test-cli 不判 cli，照原规则", (label, overrides) => {
    const decision = decide(cloud("baize-test-cli", overrides as Partial<GateCall>), [], []);
    expect(decision.access.cliTools ?? []).toEqual([]);
    expect(decision.access.network, "放行也只是原规则里不联网的普通命令").toBe(false);
    if (label === "Mac" || label === "本机 Linux") expect(decision.verdict).toBe("ask");
  });

  it("内联解释器照问", () => {
    expect(decide(cloud("python3 -c 'print(1)'"), [], []).verdict).toBe("ask");
  });
});

describe("云电脑上装登记工具的包", () => {
  const nodeWrite = () => ({ network: true, writePaths: [join(dirs().toolboxDir, "node")] });
  const venvWrite = () => ({ network: true, writePaths: [dirs().toolboxDir] });

  it.each([
    [`npm i -g ${NPM_PKG}`, nodeWrite],
    [`npm install -g ${NPM_PKG}`, nodeWrite],
    [`npm i --global ${NPM_PKG}`, nodeWrite],
    [`npm install --location=global ${NPM_PKG}`, nodeWrite],
    [`npm i -g '${NPM_PKG}'`, nodeWrite],
    [`pip install ${PIP_PKG}`, venvWrite],
  ])("%s：不问，口子和批准后的装包一样，不带工具 env", (command, access) => {
    const decision = decide(cloud(command), [], []);
    expect(decision).toMatchObject({ verdict: "allow", action: "install", access: access() });
    expect(decision.access.cliTools).toBeUndefined();
  });

  it.each([
    { manager: "npm", package: NPM_PKG },
    { manager: "npm", package: "@baize-test/cli@^1.2" },
    { manager: "pip", package: PIP_PKG },
    { manager: "pip", package: "baize-test-py[all]>=2.0" },
  ] satisfies CliInstall[])("登记的装法原样执行不问：$package", (install) => {
    const command = installCommand(install);
    const decision = decide(cloud(command, { cliTools: [tool("baize-test-cli", install)] }), [], []);
    expect(decision, command).toMatchObject({ verdict: "allow", action: "install" });
    expect(decision.access.cliTools).toBeUndefined();
  });

  it.each([
    [`npm i -g @baize-test/clj`, "包名差一个字符"],
    [`npm i -g @baize-test/cl`, "包名少一个字符"],
    [`npm i -g ${NPM_PKG}@latest`, "多了版本"],
    [`npm i -g ${NPM_PKG} left-pad`, "多装一个包"],
    [`npm i -g ${NPM_PKG} --registry=https://example.invalid`, "多一个参数"],
    [`npm i -g --ignore-scripts ${NPM_PKG}`, "多一个参数"],
    [`npm i ${NPM_PKG} -g`, "参数换了位置"],
    [`npm i ${NPM_PKG}`, "不是全局"],
    [`pip install -U ${PIP_PKG}`, "多一个参数"],
    [`pip install ${PIP_PKG} --index-url https://example.invalid`, "换了下载源"],
    [`pip3 install ${PIP_PKG}`, "不是 pip"],
    [`pip install ${NPM_PKG}`, "装法对不上"],
    [`npm i -g ${PIP_PKG}`, "装法对不上"],
    [`npm i -g ${NPM_PKG} && baize-test-cli`, "接了别的命令"],
    [`npm i -g ${NPM_PKG}; ls`, "接了别的命令"],
    [`npm i -g ${NPM_PKG} | head`, "接了管道"],
    [`npm i -g ${NPM_PKG} > log.txt`, "重定向"],
    [`NPM_CONFIG_PREFIX=/tmp/x npm i -g ${NPM_PKG}`, "前缀赋值"],
    [`npm i -g $PKG`, "变量"],
  ])("%s（%s）：按原规则判，不会不问就联网", (command) => {
    const decision = decide(cloud(command), [], []);
    expect(decision.verdict === "allow" && decision.access.network, "不问就联网").toBe(false);
    expect(decision.access.cliTools).toBeUndefined();
  });

  it("同一个包登记在别的 Bot 的工具上，这个 Bot 照问", () => {
    const othersOnly = cliToolsFor(bot1, [{ ...OTHER, install: { manager: "npm", package: NPM_PKG } }]);
    expect(decide(cloud(`npm i -g ${NPM_PKG}`, { cliTools: othersOnly }), [], []).verdict).toBe("ask");
  });

  it.each([
    ["Mac", { platform: "darwin", sandbox: "seatbelt", containment: { level: "none" } }],
    ["本机 Linux", { containment: { level: "none" } }],
    ["只读例行", { routine: { boundary: "read_only" } }],
  ] as const)("%s 上照原规则，不自动放行", (_label, overrides) => {
    expect(decide(cloud(`npm i -g ${NPM_PKG}`, overrides as Partial<GateCall>), [], []).verdict).not.toBe("allow");
  });
});

describe("命令行工具的 env 和 node 工具箱", () => {
  it("whitelistEnv 并入工具 env，盖不住已有的键", () => {
    const env = whitelistEnv(
      { HOME: "/home/x", PATH: "/bin" },
      "/w",
      "/t",
      { searchPath: "/bin", homeDir: "/data/home" },
      {
        GROK_API_KEY: SECRET,
        PATH: "/evil",
        TMPDIR: "/evil",
      },
    );
    expect(env["GROK_API_KEY"]).toBe(SECRET);
    expect(env["PATH"]).toBe("/bin");
    expect(env["TMPDIR"]).toBe("/t");
  });

  it("批准写 node 前缀的命令设 NPM_CONFIG_PREFIX，venv 那条不变", () => {
    const toolbox = "/data/bot-1/toolbox";
    expect(
      toolboxCommand(toolbox, { network: true, writePaths: [`${toolbox}/node`] }, "npm i -g @vibe-kit/grok-cli"),
    ).toBe("export NPM_CONFIG_PREFIX='/data/bot-1/toolbox/node'; npm i -g @vibe-kit/grok-cli");
  });
});

describe("脱敏", () => {
  it("长的先换，短值也照换", () => {
    expect(redactSecrets("abcdef abc", ["abc", "abcdef"])).toBe("[已隐藏] [已隐藏]");
    expect(redactSecrets("k=ab", ["ab"])).toBe("k=[已隐藏]");
    expect(redactSecrets("nothing", [])).toBe("nothing");
  });
});

const text = (result: { content: readonly { type: string; text?: string }[] }): string =>
  result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

// 封闭沙箱里的 env 和脱敏在 Mac 上用 seatbelt 跑：给了 toolboxDir，containment 就是 closed。
describe.skipIf(sandboxKind() === "none")("沙箱 bash 里的工具 env 和脱敏", () => {
  const sandboxWith = (cloudBox: boolean, tools: readonly CliToolConfig[] = [GROK]) =>
    createSandboxedBash(
      dirs().workDir,
      forbiddenZones(dirs(), null),
      () => "run-1",
      cloudBox ? { toolboxDir: dirs().toolboxDir, homeDir: homeDir() } : null,
      () => tools,
    );
  const PRINT = 'printf "[%s]" "${GROK_API_KEY:-none}"';

  it("cli permit 拿得到 env，输出里的值被换掉；别的 permit 和没 permit 一个都拿不到", async () => {
    const sandbox = sandboxWith(true);
    const CLI: GateAccess = { network: true, writePaths: [], cliTools: [GROK.id] };
    sandbox.allow("run-1", "cli", CLI);
    expect(text(await sandbox.tool.execute("cli", { command: PRINT }, undefined, undefined, undefined as never))).toBe(
      "[[已隐藏]]",
    );
    sandbox.allow("run-1", "net", { network: true, writePaths: [] });
    expect(text(await sandbox.tool.execute("net", { command: PRINT }, undefined, undefined, undefined as never))).toBe(
      "[none]",
    );
    sandbox.allow("run-1", "install", { network: true, writePaths: [join(dirs().toolboxDir, "node")] });
    expect(
      text(await sandbox.tool.execute("install", { command: PRINT }, undefined, undefined, undefined as never)),
    ).toBe("[none]");
    expect(
      text(await sandbox.tool.execute("plain", { command: PRINT }, undefined, undefined, undefined as never)),
    ).toBe("[none]");
  });

  it("自动放行的装包拿不到工具 env", async () => {
    const sandbox = sandboxWith(true);
    const decision = decide(
      cloud(`npm i -g ${NPM_PKG}`, { cliTools: [{ ...GROK, install: { manager: "npm", package: NPM_PKG } }] }),
      [],
      [],
    );
    expect(decision.verdict).toBe("allow");
    sandbox.allow("run-1", "auto-install", decision.access);
    expect(
      text(await sandbox.tool.execute("auto-install", { command: PRINT }, undefined, undefined, undefined as never)),
    ).toBe("[none]");
  });

  it("Mac 和本机（containment none）permit 带着工具也不给 env", async () => {
    const sandbox = sandboxWith(false);
    sandbox.allow("run-1", "cli", { network: true, writePaths: [], cliTools: [GROK.id] });
    expect(text(await sandbox.tool.execute("cli", { command: PRINT }, undefined, undefined, undefined as never))).toBe(
      "[none]",
    );
  });

  it("allow 只带工具也记下 permit", async () => {
    const sandbox = sandboxWith(true);
    sandbox.allow("run-1", "only-tools", { network: false, writePaths: [], cliTools: [GROK.id] });
    expect(
      text(await sandbox.tool.execute("only-tools", { command: PRINT }, undefined, undefined, undefined as never)),
    ).toBe("[[已隐藏]]");
  });

  it("普通命令从文件里读出密钥，结果、structuredContent、onUpdate、失败结果里都换掉", async () => {
    writeFileSync(join(dirs().workDir, "leak.txt"), `key=${SECRET}\n`);
    const sandbox = sandboxWith(false);
    const updates: string[] = [];
    const result = await sandbox.tool.execute(
      "read-file",
      { command: "cat leak.txt" },
      undefined,
      (partial) => updates.push(JSON.stringify(partial)),
      undefined as never,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(text(result)).toContain("key=[已隐藏]");
    expect(updates.join("")).not.toContain(SECRET);
    const failed = await sandbox.tool.execute(
      "failed",
      { command: "cat leak.txt; exit 3" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  it("截断时 Pi 写的完整输出文件也换掉", async () => {
    const sandbox = sandboxWith(false);
    const result = await sandbox.tool.execute(
      "big",
      { command: `for i in $(seq 1 3000); do echo "line $i"; done; cat leak.txt` },
      undefined,
      undefined,
      undefined as never,
    );
    const path = (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
    expect(path, "输出该被截断").toBeTypeOf("string");
    const full = readFileSync(path as string, "utf8");
    rmSync(path as string, { force: true });
    expect(full).toContain("line 1\n");
    expect(full).toContain("key=[已隐藏]");
    expect(full).not.toContain(SECRET);
  });

  it("没有工具时原样跑", async () => {
    const sandbox = sandboxWith(false, []);
    expect(
      text(await sandbox.tool.execute("raw", { command: "cat leak.txt" }, undefined, undefined, undefined as never)),
    ).toContain(SECRET);
  });
});

describe("系统提示和按 Bot 过滤", () => {
  it("bots 为 null 是全部，否则只给列出的 Bot", () => {
    expect(cliToolsFor(bot1, [GROK, OTHER]).map((one) => one.command)).toEqual(["baize-test-cli"]);
    expect(cliToolsFor(BotId.parse("bot-2"), [GROK, OTHER]).map((one) => one.command)).toEqual([
      "baize-test-cli",
      "other",
    ]);
  });

  it("云电脑上列命令名和装法，不带值；Mac 和什么都没有时不给这一段", () => {
    const section = renderCliToolsSection([OTHER, GROK], []) ?? "";
    expect(section).toContain("这些命令能联网、自带密钥，直接用；没装就照下面的装法原样装");
    expect(section).toContain("- baize-test-cli（装法：npm install -g @vibe-kit/grok-cli）");
    expect(section).toContain("- other（装法：没有登记装法，没装就告诉主人）");
    expect(section.indexOf("- baize-test-cli")).toBeLessThan(section.indexOf("- other"));
    expect(section).not.toContain("主人在云电脑终端里装好");
    expect(section).not.toContain(SECRET);
    expect(section).not.toContain("GROK_API_KEY");
    expect(renderCliToolsSection([GROK], null)).toBeNull();
    expect(renderCliToolsSection([], [])).toBeNull();
  });

  it("~/.local/bin 里的可执行文件现读现列，和登记工具重名的只按登记工具列", () => {
    writeFileSync(join(homeBin(), "notes.txt"), "not a command");
    writeFileSync(join(homeBin(), ".hidden"), "");
    chmodSync(join(homeBin(), ".hidden"), 0o755);
    const home = homeCommands(homeDir());
    expect(home).toEqual(["home-cli", "home-escape"]);
    expect(homeCommands(join(root, "no-such-home"))).toEqual([]);

    const section = renderCliToolsSection([], home) ?? "";
    expect(section).toContain(
      "主人在云电脑终端里装好、登录过的命令，能联网，登录态在 HOME 里，直接用：\n- home-cli\n- home-escape",
    );
    expect(section).not.toContain("自带密钥");
    expect(section).toContain("告诉主人去「设置 › 账号与电脑」的终端里装好、登录");

    const both = renderCliToolsSection([CliToolConfig.parse({ ...GROK, command: "home-cli" })], home) ?? "";
    expect(both).toContain("- home-cli（装法：");
    expect(both).toContain("直接用：\n- home-escape");
    expect(renderCliToolsSection([], ["grok"])).not.toBeNull();
    expect(renderCliToolsSection([], null)).toBeNull();
  });
});
