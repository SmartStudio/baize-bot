import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotId, ComputerId, GroupId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeCommands, renderCliToolsSection } from "../src/cli-tools.js";
import { decide, type GateCall } from "../src/gate.js";
import { botDirs, ensureBotDirs, forbiddenZones } from "../src/paths.js";
import { toolboxCommand } from "../src/sandbox.js";

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
  // Bot 批过的 npm -g 装进工具箱的 node/bin，照 npm 的布局是指向 lib/node_modules 里入口的软链。
  const pkg = join(dirs().toolboxDir, "node", "lib", "node_modules", "@vibe-kit", "grok-cli", "dist");
  mkdirSync(pkg, { recursive: true });
  executable(join(pkg, "index.js"));
  mkdirSync(nodeBin(), { recursive: true });
  symlinkSync(join(pkg, "index.js"), join(nodeBin(), "toolbox-cli"));
  // 主人在终端里 npm i -g 装的：prefix 是 ~/.local，bin 下同样是指向 lib/node_modules 的软链。
  const homePkg = join(homeDir(), ".local", "lib", "node_modules", "@xai-official", "grok", "bin");
  mkdirSync(homePkg, { recursive: true });
  executable(join(homePkg, "grok.js"));
  mkdirSync(homeBin(), { recursive: true });
  symlinkSync(join(homePkg, "grok.js"), join(homeBin(), "home-cli"));
  // HOME 的 bin 里指到 HOME 外（这里是工具箱里）的软链，真实路径不在 HOME 里就不认。
  symlinkSync(join(pkg, "index.js"), join(homeBin(), "home-escape"));
  // 系统目录里有同名程序时，PATH 先找到系统的那个。
  executable(join(sysBin, "shadow"));
  executable(join(homeBin(), "shadow"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

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
  ...overrides,
});

describe("~/.local/bin 里的命令的门禁判定", () => {
  it.each([
    'home-cli -p "hi"',
    "home-cli",
    "home-cli | head -n 5",
    "home-cli -p 'x' | grep -i x",
    "home-cli | tail -n 1 | wc -l",
  ])("%s：当主人装的工具，不问、联网、HOME 可写，登录态写得回去", (command) => {
    expect(decide(cloud(command), [], [])).toMatchObject({
      verdict: "allow",
      action: "shell",
      access: { network: true, writePaths: [homeDir()] },
    });
  });

  it.each([
    "home-cli; rm x",
    "home-cli && ls",
    "home-cli || ls",
    "home-cli > out.txt",
    "home-cli < in.txt",
    "home-cli -p $(cat prompt)",
    'home-cli -p "$X"',
    "home-cli -p `cat prompt`",
    "X=1 home-cli",
    "home-cli | cat /etc/passwd",
    "home-cli | sh",
    "home-cli | python3",
    "home-cli | jq .",
    "home-cli # c",
    "home-cli &",
    `${homeBin()}/home-cli`,
    "sh -c home-cli",
    "(home-cli)",
    "ls | head",
  ])("%s：不算工具，不给网，HOME 不放开写", (command) => {
    const decision = decide(cloud(command), [], []);
    expect(decision.verdict === "allow" && decision.access.network, `${decision.verdict} 不问就联网`).toBe(false);
    expect(decision.access.writePaths, command).not.toContain(homeDir());
  });

  it.each([
    ["missing", "没装"],
    ["toolbox-cli", "在工具箱的 node/bin 里，是 Bot 批过的装包写的"],
    ["shadow", "系统目录里有同名程序"],
    ["home-escape", "HOME 的 bin 软链指到 HOME 外"],
  ])("%s（%s）：不算工具", (command) => {
    const decision = decide(cloud(command), [], []);
    expect(decision.verdict === "allow" && decision.access.network, decision.verdict).toBe(false);
    expect(decision.access.writePaths).not.toContain(homeDir());
  });

  it("PATH 里有相对项时 bash 按 cwd 找，不认", () => {
    const containment = {
      level: "closed",
      searchPath: `./node_modules/.bin:${sysBin}`,
      toolboxDir: dirs().toolboxDir,
      homeDir: homeDir(),
    };
    expect(decide(cloud("home-cli", { containment } as Partial<GateCall>), [], []).access.network).toBe(false);
  });

  it.each([
    ["Mac", { platform: "darwin", sandbox: "seatbelt", containment: { level: "none" } }],
    ["本机 Linux", { containment: { level: "none" } }],
    ["没有系统沙箱", { sandbox: "none" }],
    ["只读例行", { routine: { boundary: "read_only" } }],
  ] as const)("%s 上的 home-cli 不认，照原规则", (label, overrides) => {
    const decision = decide(cloud("home-cli", overrides as Partial<GateCall>), [], []);
    expect(decision.access.network, "放行也只是原规则里不联网的普通命令").toBe(false);
    if (label === "Mac" || label === "本机 Linux") expect(decision.verdict).toBe("ask");
  });

  it("内联解释器照问", () => {
    expect(decide(cloud("python3 -c 'print(1)'"), [], []).verdict).toBe("ask");
  });
});

describe("node 工具箱", () => {
  it.each(["npm i -g @vibe-kit/grok-cli", "npm install --global @vibe-kit/grok-cli"])(
    "%s：装进工具箱的 node 前缀，要问，写路径只开这个目录",
    (command) => {
      expect(decide(cloud(command), [], [])).toMatchObject({
        verdict: "ask",
        action: "install",
        access: { network: true, writePaths: [join(dirs().toolboxDir, "node")] },
      });
    },
  );

  it("批准写 node 前缀的命令设 NPM_CONFIG_PREFIX，venv 那条不变", () => {
    const toolbox = "/data/bot-1/toolbox";
    expect(
      toolboxCommand(toolbox, { network: true, writePaths: [`${toolbox}/node`] }, "npm i -g @vibe-kit/grok-cli"),
    ).toBe("export NPM_CONFIG_PREFIX='/data/bot-1/toolbox/node'; npm i -g @vibe-kit/grok-cli");
  });
});

describe("系统提示", () => {
  it("~/.local/bin 里的可执行文件现读现列；Mac 和什么都没有时不给这一段", () => {
    writeFileSync(join(homeBin(), "notes.txt"), "not a command");
    writeFileSync(join(homeBin(), ".hidden"), "");
    chmodSync(join(homeBin(), ".hidden"), 0o755);
    const home = homeCommands(homeDir());
    expect(home).toEqual(["home-cli", "home-escape", "shadow"]);
    expect(homeCommands(join(root, "no-such-home"))).toEqual([]);

    const section = renderCliToolsSection(home) ?? "";
    expect(section).toContain(
      "主人在云电脑终端里装好、登录过的命令，能联网，登录态在 HOME 里，直接用：\n- home-cli\n- home-escape\n- shadow",
    );
    expect(section).toContain("告诉主人去「设置 › 账号与电脑」的终端里装好、登录");
    expect(renderCliToolsSection(["grok"])).not.toBeNull();
    expect(renderCliToolsSection([])).toBeNull();
    expect(renderCliToolsSection(null)).toBeNull();
  });
});
