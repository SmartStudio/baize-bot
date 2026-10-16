import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ComputerId,
  BotId,
  GrantId,
  GroupId,
  type AccountConfig,
  type ActionKind,
  type Grant,
  type GrantTarget,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES } from "../src/browser.js";
import { DRAFT_TOOL_NAMES } from "../src/drafts.js";
import { decide, INTERNAL_TOOLS, verdictFor, type GateCall, type GateContext } from "../src/gate.js";
import { botDirs, forbiddenZones, logicalResolve, PathError } from "../src/paths.js";
import { TAKEOVER_TOOL } from "../src/takeover.js";

const computerId = ComputerId.parse("computer-1");
const groupId = GroupId.parse("group-1");
let root = "";
let temporaryDir = "";
let workDir = "";
let outsideDir = "";

beforeAll(() => {
  temporaryDir = mkdtempSync(join(tmpdir(), "baize-gate-"));
  root = join(temporaryDir, "data");
  workDir = join(root, "bot-1", "work");
  outsideDir = join(temporaryDir, "outside");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outsideDir);
});

afterAll(() => {
  rmSync(temporaryDir, { recursive: true, force: true });
});

// 助理 Chrome 的 profile 和这个 Bot 的配图拷贝目录，照运行器的布局放。
const profileDir = (): string => join(root, "chrome-profile");
const draftsDir = (): string => join(root, "bot-1", "drafts");
const dirs = () => botDirs(root, BotId.parse("bot-1"));
const zones = () => forbiddenZones(dirs(), profileDir());

const pathTarget = (prefix: string): GrantTarget => ({ kind: "path", computerId, prefix });
const domainTarget = (domain: string): GrantTarget => ({ kind: "domain", domain });

const gateContext = (overrides: Partial<GateContext> = {}): GateContext => ({
  workDir,
  zones: zones(),
  groupId,
  computerId,
  platform: "darwin",
  ...overrides,
});

const actionVerdict = (
  action: ActionKind,
  target: GrantTarget | null,
  grants: readonly Grant[] = [],
  accounts: readonly AccountConfig[] = [],
  context: GateContext = gateContext(),
) => verdictFor(action, target, context, grants, accounts);

const grant = (action: ActionKind, target: GrantTarget, scope: "project" | "forever" = "project"): Grant =>
  scope === "project"
    ? {
        id: GrantId.parse(`grant-${action}-project`),
        scope,
        groupId,
        action,
        target,
        createdAt: "2026-09-26T00:00:00.000Z",
      }
    : {
        id: GrantId.parse(`grant-${action}-forever`),
        scope,
        action,
        target,
        createdAt: "2026-09-26T00:00:00.000Z",
      };

describe("统一闸门默认表", () => {
  it.each([
    ["工作目录内读", "read", () => pathTarget(join(workDir, "a.txt")), "allow"],
    ["工作目录外读", "read", () => pathTarget(join(outsideDir, "a.txt")), "ask"],
    ["工作目录内写", "write_workspace", () => pathTarget(join(workDir, "a.txt")), "allow"],
    ["工作目录外写", "write_outside", () => pathTarget(join(outsideDir, "a.txt")), "ask"],
    ["工作目录内删", "delete", () => pathTarget(join(workDir, "a.txt")), "ask"],
    ["工作目录外删", "delete", () => pathTarget(join(outsideDir, "a.txt")), "ask"],
    ["读网页", "read", () => domainTarget("example.com"), "allow"],
  ] as const)("%s => %s", (_label, action, target, verdict) => {
    expect(actionVerdict(action, target())).toBe(verdict);
  });

  it.each([
    "shell",
    "publish",
    "message_person",
    "engage",
    "spend",
    "account_security",
    "install",
    "external_write",
  ] satisfies readonly ActionKind[])("其余动作 %s 默认问", (action) => {
    expect(actionVerdict(action, null)).toBe("ask");
  });
});

describe("统一闸门四层判定", () => {
  it("禁区优先于授权，~/.ssh 的读写都拒绝", () => {
    const target = pathTarget(join(process.env.HOME ?? "/", ".ssh", "id_rsa"));
    expect(actionVerdict("read", target, [grant("read", target, "forever")])).toBe("deny");
    expect(actionVerdict("write_outside", target, [grant("write_outside", target)])).toBe("deny");
  });

  it("助理专用 chrome-profile 整棵目录是禁区", () => {
    const target = pathTarget(join(root, "chrome-profile", "Default", "Cookies"));
    expect(actionVerdict("read", target, [grant("read", target, "forever")])).toBe("deny");
  });

  it("没给助理 Chrome 时不猜 profile 在哪", () => {
    const target = pathTarget(join(outsideDir, "chrome-profile", "Default", "Cookies"));
    const remote = gateContext({ zones: forbiddenZones(dirs(), null) });
    expect(actionVerdict("read", target, [], [], remote)).toBe("ask");
  });

  it("配图拷贝目录能读不能写，写它的祖先也拒绝", () => {
    const copy = pathTarget(join(draftsDir(), "a".repeat(64) + ".png"));
    expect(actionVerdict("write_outside", copy, [grant("write_outside", copy, "forever")])).toBe("deny");
    expect(actionVerdict("delete", copy)).toBe("deny");
    expect(actionVerdict("write_outside", pathTarget(join(root, "bot-1")))).toBe("deny");
    expect(actionVerdict("read", copy), "读只是工作目录外的读").toBe("ask");
  });

  it("darwin 禁区比较忽略大小写", () => {
    const target = pathTarget(join(root, "CHROME-PROFILE", "Default", "Cookies"));
    expect(actionVerdict("read", target, [grant("read", target, "forever")])).toBe("deny");
  });

  it("工作目录外写的目标覆盖禁区祖先时直接拒绝", () => {
    const target = pathTarget(root);
    expect(actionVerdict("write_outside", target, [grant("write_outside", target)])).toBe("deny");
  });

  it("工作目录外写和删除只覆盖隐藏禁区（不碰配图目录）的祖先时也拒绝", () => {
    const profileParent = join(root, "assistant");
    const context = gateContext({
      zones: forbiddenZones(dirs(), join(profileParent, "chrome-profile")),
    });
    const target = pathTarget(profileParent);
    expect(
      actionVerdict("write_outside", target, [grant("write_outside", target)], [], context),
      "放宽写 profile 的上一级",
    ).toBe("deny");
    expect(actionVerdict("delete", target, [], [], context), "删掉 profile 的上一级").toBe("deny");
  });

  it("spend 和 delete 即使收到畸形 forever 授权仍然问", () => {
    const target = domainTarget("billing.example.com");
    const malformed = grant("spend", target, "forever");
    expect(actionVerdict("spend", target, [malformed])).toBe("ask");
    expect(actionVerdict("delete", pathTarget(join(workDir, "a.txt")))).toBe("ask");
  });

  it("project 授权只在同一群生效，forever 授权跨群生效", () => {
    const target = pathTarget(outsideDir);
    const project = grant("read", target);
    expect(actionVerdict("read", pathTarget(join(outsideDir, "a.txt")), [project])).toBe("allow");
    expect(
      actionVerdict(
        "read",
        pathTarget(join(outsideDir, "a.txt")),
        [project],
        [],
        gateContext({ groupId: GroupId.parse("group-2") }),
      ),
    ).toBe("ask");
    expect(
      actionVerdict(
        "read",
        pathTarget(join(outsideDir, "a.txt")),
        [grant("read", target, "forever")],
        [],
        gateContext({ groupId: GroupId.parse("group-2") }),
      ),
    ).toBe("allow");
  });

  it("direct_publish 账号放行 publish，其余权限档仍然问", () => {
    const direct: AccountConfig = {
      id: "account-direct" as AccountConfig["id"],
      platform: "x",
      handle: "baize",
      tier: "direct_publish",
      login: "valid",
    };
    const confirm: AccountConfig = { ...direct, id: "account-confirm" as AccountConfig["id"], tier: "confirm_publish" };
    expect(actionVerdict("publish", { kind: "account", accountId: direct.id }, [], [direct])).toBe("allow");
    expect(actionVerdict("publish", { kind: "account", accountId: confirm.id }, [], [confirm])).toBe("ask");
  });
});

const accountOf = (id: string, tier: AccountConfig["tier"]): AccountConfig => ({
  id: id as AccountConfig["id"],
  platform: "x",
  handle: "baize",
  tier,
  login: "expired",
});

describe("起草工具", () => {
  const call = (toolName: string, input: Record<string, unknown>): GateCall => ({
    toolName,
    input,
    workDir,
    zones: zones(),
    groupId,
    computerId,
    platform: "darwin",
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine: null,
  });
  const draftOn = (accountId: string) => call("create_draft", { accountId, content: { kind: "post", text: "早安" } });

  it.each(["draft", "confirm_publish", "direct_publish"] as const)(
    "%s 档的 create_draft 不问，没有授权、没登录也放行",
    (tier) => {
      expect(decide(draftOn("account-1"), [], [accountOf("account-1", tier)])).toMatchObject({
        verdict: "allow",
        action: "publish",
        target: { kind: "account", accountId: "account-1" },
      });
    },
  );

  it("read_only 档的 create_draft 拒绝，理由是中文且叫模型换账号", () => {
    const decision = decide(draftOn("account-1"), [], [accountOf("account-1", "read_only")]);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("只读档");
    expect(decision.reason).toContain("换一个账号");
  });

  it("read_only 档的 publish 授权也救不了起草", () => {
    const forever = grant("publish", { kind: "account", accountId: "account-1" as AccountConfig["id"] }, "forever");
    expect(decide(draftOn("account-1"), [forever], [accountOf("account-1", "read_only")]).verdict).toBe("deny");
  });

  it("propose_plan 里任一条草稿用只读档账号就整份拒绝", () => {
    const accounts = [accountOf("account-1", "draft"), accountOf("account-2", "read_only")];
    const plan = call("propose_plan", {
      title: "本周",
      drafts: [{ accountId: "account-1" }, { accountId: "account-2" }],
    });
    expect(decide(plan, [], accounts)).toMatchObject({
      verdict: "deny",
      target: { kind: "account", accountId: "account-2" },
    });
  });

  it("edit_draft 不带账号，放行", () => {
    expect(decide(call("edit_draft", { draftId: "draft-1", content: {} }), [], []).verdict).toBe("allow");
  });

  it("清单里没有的账号闸门放行，交给工具报错列出可用账号", () => {
    expect(decide(draftOn("account-9"), [], [accountOf("account-1", "read_only")]).verdict).toBe("allow");
  });

  it("MCP 里 publish_ 开头的操作照旧按档问", () => {
    const publish: GateCall = {
      ...call("publish_x", { accountId: "account-1" }),
      source: { kind: "connected", operation: { name: "publish_x", needsApproval: true } },
    };
    expect(decide(publish, [], [accountOf("account-1", "draft")])).toMatchObject({
      verdict: "ask",
      action: "publish",
    });
    expect(decide(publish, [], [accountOf("account-1", "read_only")]).verdict).toBe("ask");
  });
});

describe("read、write、edit 的路径归一化和 Pi 打开文件用的一致", () => {
  // Pi 的 write、edit 走 resolveToCwd，read 走 resolveReadPathAsync，两者都先按这组选项调 resolvePath。
  // 这个函数没从包入口导出，所以闸门照搬了一份，这里按文件路径引 Pi 的原件钉住两边结果相同。
  const PI_OPTIONS = { normalizeUnicodeSpaces: true, stripAtPrefix: true } as const;
  const piResolvePath = async () => {
    const url = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js", import.meta.url);
    const mod = (await import(url.href)) as {
      resolvePath(input: string, baseDir: string, options: typeof PI_OPTIONS): string;
    };
    return mod.resolvePath;
  };
  const call = (toolName: string, input: Record<string, unknown>): GateCall => ({
    ...gateContext(),
    toolName,
    input,
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine: null,
  });

  it.each(["read", "write", "edit"])("%s 不能访问别的 Bot，批准过也拒绝", (toolName) => {
    const path = join(root, "bot-2", "agent", "private.txt");
    const target = pathTarget(path);
    const decision = decide(call(toolName, { path }), [grant("read", target), grant("write_outside", target)], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("其他 Bot");
  });

  it.each(["read", "write", "edit"])("%s 在共享区不问，自己的 agent 目录里读问、写拒", (toolName) => {
    expect(decide(call(toolName, { path: join(dirs().sharedDir, "delivery.txt") }), [], []).verdict).toBe("allow");
    expect(decide(call(toolName, { path: join(dirs().agentDir, "auth.json") }), [], []).verdict).toBe(
      toolName === "read" ? "ask" : "deny",
    );
  });

  describe("自己 Bot 目录里 work 和共享区以外的部分，写直接拒绝，读照旧", () => {
    const botDir = (): string => dirname(workDir);
    const privatePaths = (): readonly string[] => [
      join(dirs().agentDir, "note.txt"),
      join(dirs().skillsDir, "n.txt"),
      join(dirs().sessionDir, "n.txt"),
      join(botDir(), "top.txt"),
    ];
    const bashOn = (command: string, sandbox: GateCall["sandbox"] = "seatbelt"): GateCall => ({
      ...call("bash", { command }),
      sandbox,
    });
    const REASON = "自己的配置和会话目录";

    it.each(["write", "edit"])("%s 写这四处直接拒绝，授权也救不了，理由让模型改写工作目录或共享区", (toolName) => {
      for (const path of privatePaths()) {
        const decision = decide(call(toolName, { path }), [grant("write_outside", pathTarget(path), "forever")], []);
        expect(decision, path).toMatchObject({ verdict: "deny", action: "write_outside" });
        expect(decision.reason, path).toContain(REASON);
        expect(decision.reason, path).toContain("工作目录或共享区");
      }
    });

    it.each(["seatbelt", "bwrap"] as const)("%s 下 bash 的写、改名、删除落在这四处都直接拒绝", (sandbox) => {
      for (const path of privatePaths()) {
        for (const command of [
          `echo ok > ${path}`,
          `echo ok >> ${path}`,
          `cp x ${path}`,
          `touch ${path}`,
          `mkdir -p ${path}`,
          `tee ${path}`,
          `mv x ${path}`,
          `rm ${path}`,
          `ln -s x ${path}`,
        ]) {
          const decision = decide(bashOn(command, sandbox), [grant("write_outside", pathTarget(path), "forever")], []);
          expect(decision.verdict, command).toBe("deny");
          expect(decision.reason, command).toContain(REASON);
        }
      }
    });

    it("从工作目录用相对路径或沿链接绕出去也一样", () => {
      expect(decide(bashOn("cp x ../agent/note.txt"), [], [])).toMatchObject({ verdict: "deny" });
      expect(decide(call("write", { path: "../top.txt" }), [], []).verdict).toBe("deny");
      const link = join(workDir, "to-agent");
      symlinkSync(dirs().agentDir, link);
      expect(decide(call("write", { path: join(link, "auth.json") }), [], []).verdict).toBe("deny");
      expect(decide(bashOn(`echo ok > ${join(link, "auth.json")}`), [], []).verdict).toBe("deny");
    });

    it("同目录的读不被拒，仍按工作目录外的读问", () => {
      for (const path of privatePaths()) {
        expect(decide(call("read", { path }), [], []), path).toMatchObject({
          verdict: "ask",
          action: "read",
          reason: null,
        });
        expect(decide(bashOn(`cat ${path}`), [], []), path).toMatchObject({
          verdict: "ask",
          action: "read",
          reason: null,
        });
        expect(decide(bashOn(`cp ${path} .`), [], []), path).toMatchObject({ verdict: "ask", action: "read" });
      }
    });

    it.each(["seatbelt", "bwrap"] as const)("%s 下工作目录和共享区里的写照原规则放行", (sandbox) => {
      for (const base of [workDir, dirs().sharedDir]) {
        const path = join(base, "own-private-ok.txt");
        expect(decide({ ...call("write", { path }), sandbox }, [], [])).toMatchObject({
          verdict: "allow",
          reason: null,
        });
        expect(decide(bashOn(`echo ok > ${path}`, sandbox), [], [])).toMatchObject({ verdict: "allow", reason: null });
        expect(decide(bashOn(`mkdir -p ${join(base, "sub", "deep")}`, sandbox), [], [])).toMatchObject({
          verdict: "allow",
          reason: null,
        });
      }
    });
  });

  it.each(["read", "write", "edit"])("%s 沿工作目录或共享区的链接仍不能碰别的 Bot", (toolName) => {
    const other = join(root, "bot-2", `${toolName}-ghost.txt`);
    mkdirSync(dirs().sharedDir, { recursive: true });
    for (const base of [workDir, dirs().sharedDir]) {
      const link = join(base, `isolation-${toolName}`);
      symlinkSync(other, link);
      expect(decide(call(toolName, { path: link }), [], []).verdict).toBe("deny");
    }
  });

  it("数据根目录和未配置浏览器的 chrome-profile 也属于私有区域", () => {
    const remote = { ...call("read", { path: root }), zones: forbiddenZones(dirs(), null) };
    expect(decide(remote, [], []).verdict).toBe("deny");
    expect(decide({ ...remote, input: { path: join(root, "chrome-profile", "Cookies") } }, [], []).verdict).toBe(
      "deny",
    );
  });

  it("共享区和工作目录的根不能写或删除，内部文件读写不受影响", () => {
    for (const path of [workDir, dirs().sharedDir]) {
      expect(decide(call("read", { path }), [], []).verdict).toBe("allow");
      for (const toolName of ["write", "edit", "delete_file"]) {
        const toolCall = call(toolName, { path });
        const deleting: GateCall = {
          ...toolCall,
          source: { kind: "connected", operation: { name: toolName, needsApproval: true } },
        };
        expect(
          decide(toolName === "delete_file" ? deleting : toolCall, [], []),
          `${toolName} 不能替换或删除根`,
        ).toMatchObject({
          verdict: "deny",
          reason: expect.stringContaining("根不能删除或替换"),
        });
      }
      for (const action of ["write_workspace", "write_outside", "delete"] as const) {
        expect(actionVerdict(action, pathTarget(path))).toBe("deny");
      }
      expect(decide(call("write", { path: join(path, "normal.txt"), content: "ok" }), [], []).verdict).toBe("allow");
    }
  });

  it.each([
    "file:///tmp/leak.txt",
    "file:///tmp/a%20b/c.txt",
    "file:///tmp/a b.txt",
    "@file:///tmp/leak.txt",
    "file://",
    "~",
    "~/x.txt",
    "@~/x.txt",
    "@notes.txt",
    "notes.txt",
    "./a/../b.txt",
    "/abs/x.txt",
    " /tmp/x.txt",
    "a　b.txt",
    " ~/x",
    "~　/x",
    "file:///tmp/ x.txt",
  ])("%j 两边解出同一个绝对路径", async (input) => {
    expect(logicalResolve(input, workDir)).toBe((await piResolvePath())(input, workDir, PI_OPTIONS));
  });

  it.each(["file://host/x.txt", "file:///tmp/%zz"])("%j Pi 打不开，闸门也不猜：两边都抛", async (input) => {
    const resolvePath = await piResolvePath();
    expect(() => resolvePath(input, workDir, PI_OPTIONS)).toThrow();
    expect(() => logicalResolve(input, workDir)).toThrow(PathError);
  });

  it("Pi 打不开的 file:// 地址，闸门拒绝而不是抛出去", () => {
    const decision = decide(call("write", { path: "file://host/x.txt", content: "x" }), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("file://");
  });

  it.each(["write", "edit"] as const)(
    "%s 到 file:// 地址的工作目录外文件归 write_outside，和裸路径判得一样",
    (toolName) => {
      const target = join(outsideDir, "leak.txt");
      const input = toolName === "write" ? { content: "x" } : { edits: [{ oldText: "a", newText: "b" }] };
      const plain = decide(call(toolName, { path: target, ...input }), [], []);
      expect(plain).toMatchObject({ verdict: "ask", action: "write_outside", target: { kind: "path" } });
      expect(decide(call(toolName, { path: `file://${target}`, ...input }), [], [])).toEqual(plain);
    },
  );

  it("write 到 file:// 地址的配图拷贝目录被拒绝，理由点名配图拷贝目录", () => {
    const decision = decide(call("write", { path: `file://${join(draftsDir(), "cover.png")}`, content: "x" }), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("配图拷贝目录");
  });

  it("read file:// 地址的助理 Chrome profile 被拒绝", () => {
    const decision = decide(call("read", { path: `file://${join(profileDir(), "Default", "Cookies")}` }), [], []);
    expect(decision).toMatchObject({ verdict: "deny", action: "read" });
  });

  it("write 到 file:// 地址的工作目录里的文件照常放行", () => {
    expect(decide(call("write", { path: `file://${join(workDir, "note.txt")}`, content: "x" }), [], [])).toMatchObject({
      verdict: "allow",
      action: "write_workspace",
    });
  });
});

describe("悬空符号链接按 readlink 解到真正的目标", () => {
  const READ_ONLY = { boundary: "read_only" } as const;
  const call = (toolName: string, input: Record<string, unknown>, routine: GateCall["routine"] = null): GateCall => ({
    ...gateContext(),
    toolName,
    input,
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine,
  });
  let linkDir = "";
  const LOOP_DELETE_HINT = "直接删掉";
  beforeAll(() => {
    linkDir = join(workDir, "links");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(workDir, "loop-rm-2"), join(workDir, "loop-rm"));
    symlinkSync(join(workDir, "loop-rm"), join(workDir, "loop-rm-2"));
  });
  /** 建一条链接，目标按调用方给的原样写进去（可以是相对路径），目标文件不建。 */
  const link = (name: string, target: string): string => {
    const path = join(linkDir, name);
    symlinkSync(target, path);
    return path;
  };
  const writeCall = (path: string, routine: GateCall["routine"] = null) =>
    call("write", { path, content: "x" }, routine);

  it.each(["write", "edit"] as const)(
    "%s 经悬空链接到工作目录外尚不存在的文件，和直接写那个路径判得一样：write_outside 问用户",
    (toolName) => {
      const ghost = join(outsideDir, `${toolName}-ghost.txt`);
      const path = link(`${toolName}-outside`, ghost);
      const input = toolName === "write" ? { content: "x" } : { edits: [{ oldText: "a", newText: "b" }] };
      const plain = decide(call(toolName, { path: ghost, ...input }), [], []);
      expect(plain).toMatchObject({ verdict: "ask", action: "write_outside", target: { kind: "path" } });
      expect(decide(call(toolName, { path, ...input }), [], [])).toEqual(plain);
    },
  );

  it("read_only 例行里 write 经悬空链接到工作目录外被拒绝", () => {
    const decision = decide(writeCall(link("ro-outside", join(outsideDir, "ro-ghost.txt")), READ_ONLY), [], []);
    expect(decision).toMatchObject({ verdict: "deny", action: "write_outside" });
    expect(decision.reason).toContain("「只读」例行");
  });

  it("链接目标是相对路径时按链接所在目录解", () => {
    const ghost = join(outsideDir, "relative-ghost.txt");
    const path = link("relative", relative(linkDir, ghost));
    expect(decide(writeCall(path), [], [])).toEqual(decide(writeCall(ghost), [], []));
    expect(decide(writeCall(path), [], [])).toMatchObject({ action: "write_outside" });
  });

  it("路径中间一段是指向工作目录外尚不存在目录的链接，照样解到外面", () => {
    const ghostDir = join(outsideDir, "ghost-dir");
    const path = join(link("dir-outside", ghostDir), "x.txt");
    expect(decide(writeCall(path), [], [])).toEqual(decide(writeCall(join(ghostDir, "x.txt")), [], []));
    expect(decide(writeCall(path), [], [])).toMatchObject({ action: "write_outside" });
  });

  it("链接指向助理 Chrome profile 里尚不存在的文件：读写都拒", () => {
    const path = link("profile", join(profileDir(), "Default", "ghost-cookies"));
    expect(decide(writeCall(path), [], [])).toMatchObject({ verdict: "deny", action: "write_outside" });
    expect(decide(call("read", { path }), [], [])).toMatchObject({ verdict: "deny", action: "read" });
  });

  it("链接指向配图拷贝目录里尚不存在的文件：拒绝并点名配图拷贝目录", () => {
    const decision = decide(writeCall(link("drafts", join(draftsDir(), "ghost.png"))), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("配图拷贝目录");
  });

  it("三层悬空链接逐层解到最后的目标", () => {
    const ghost = join(outsideDir, "chain-ghost.txt");
    const third = link("chain-3", ghost);
    const second = link("chain-2", third);
    const first = link("chain-1", second);
    expect(decide(writeCall(first), [], [])).toEqual(decide(writeCall(ghost), [], []));
    expect(decide(writeCall(first), [], [])).toMatchObject({ action: "write_outside" });
  });

  it("悬空链接套了超过 40 层：拒绝，理由点名符号链接，不抛出去", () => {
    let target = join(outsideDir, "deep-ghost.txt");
    for (let depth = 0; depth < 41; depth += 1) target = link(`deep-${depth}`, target);
    const decision = decide(writeCall(target), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("符号链接");
  });

  it("链接指向工作目录里尚不存在的文件仍是工作目录写", () => {
    expect(decide(writeCall(link("inside", join(workDir, "inside-ghost.txt"))), [], [])).toMatchObject({
      verdict: "allow",
      action: "write_workspace",
    });
  });

  it("成环的链接解不到真正的目标：拒绝，理由点名符号链接，不抛出去", () => {
    const a = join(linkDir, "loop-a");
    const b = join(linkDir, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    const decision = decide(writeCall(a), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("符号链接");
  });

  it.each([
    ["rm", "rm loop-rm"],
    ["rm -f 两个", "rm -f loop-rm loop-rm-2"],
    ["unlink", "unlink loop-rm"],
    ["mv", "mv loop-rm renamed"],
  ])("成环的链接用 %s 删或改名：拒绝，理由给出路（让用户直接删掉）", (_label, command) => {
    const decision = decide(call("bash", { command }), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("成环");
    expect(decision.reason).toContain(LOOP_DELETE_HINT);
  });

  it("成环的链接当写入目标：理由不带删链接的出路", () => {
    const decision = decide(writeCall(join(workDir, "loop-rm")), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).not.toContain(LOOP_DELETE_HINT);
  });
});

/**
 * 链接目标串里的 `..` 由内核按已解开的目录退，不是按字面抵消：`dirlink/../x` 先进 dirlink 的真实目录再退一级，
 * 躺在目录链接下的链接写 `../x` 退到的是真实目录的上一级。下面每条都让 Pi 的 write 真的写一次，断言它落在哪，
 * 闸门的判定必须和这个落点一致。
 */
/** `dir` 下所有普通文件的绝对路径，不跟符号链接。 */
const regularFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) regularFiles(path, acc);
    else acc.push(path);
  }
  return acc;
};

describe("链接目标里的 .. 按内核的顺序退已解开的目录", () => {
  const READ_ONLY = { boundary: "read_only" } as const;
  const CONTENT = "kernel-walk";
  const writeCall = (path: string, routine: GateCall["routine"] = null): GateCall => ({
    ...gateContext(),
    toolName: "write",
    input: { path, content: CONTENT },
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine,
  });
  /** 让 Pi 的 write 工具写 `path`，返回这次在整套临时目录下新出现的普通文件。 */
  const piWrites = async (path: string): Promise<string[]> => {
    const before = new Set(regularFiles(temporaryDir));
    await createWriteToolDefinition(workDir).execute(
      "write-1",
      { path, content: CONTENT },
      undefined,
      undefined,
      undefined as never,
    );
    return regularFiles(temporaryDir)
      .filter((file) => !before.has(file))
      .map((file) => relative(root, file));
  };
  const landedAt = async (path: string, expected: string): Promise<void> => {
    expect(await piWrites(path), "Pi 真正写到的文件").toEqual([relative(root, expected)]);
    expect(readFileSync(expected, "utf8")).toBe(CONTENT);
  };
  let walkDir = "";
  beforeAll(() => {
    walkDir = join(workDir, "walk");
    mkdirSync(walkDir, { recursive: true });
    mkdirSync(join(outsideDir, "deep"), { recursive: true });
    mkdirSync(join(draftsDir(), "deep"), { recursive: true });
    mkdirSync(join(profileDir(), "Default"), { recursive: true });
  });

  it("目标串里是 dirlink/../x，dirlink 指向工作目录外的目录：落在外面，write_outside 问用户", async () => {
    symlinkSync(join(outsideDir, "deep"), join(walkDir, "dirlink"));
    const path = join(walkDir, "b2");
    symlinkSync("dirlink/../b2.txt", path);
    const landing = join(outsideDir, "b2.txt");
    expect(decide(writeCall(path), [], [])).toMatchObject({ verdict: "ask", action: "write_outside" });
    expect(decide(writeCall(path), [], [])).toEqual(decide(writeCall(landing), [], []));
    await landedAt(path, landing);
  });

  it("链接躺在目录链接下（work/dl -> outside/d），目标 ../x：落在外面，write_outside 问用户", async () => {
    mkdirSync(join(outsideDir, "d3"));
    symlinkSync(join(outsideDir, "d3"), join(walkDir, "dl3"));
    symlinkSync("../b3.txt", join(outsideDir, "d3", "lnk"));
    const path = join(walkDir, "dl3", "lnk");
    const landing = join(outsideDir, "b3.txt");
    expect(decide(writeCall(path), [], [])).toMatchObject({ verdict: "ask", action: "write_outside" });
    expect(decide(writeCall(path), [], [])).toEqual(decide(writeCall(landing), [], []));
    await landedAt(path, landing);
  });

  it("read_only 例行里经目录链接下的 ../x 写到外面：拒绝", async () => {
    mkdirSync(join(outsideDir, "d4"));
    symlinkSync(join(outsideDir, "d4"), join(walkDir, "dl4"));
    symlinkSync("../b4.txt", join(outsideDir, "d4", "lnk"));
    const path = join(walkDir, "dl4", "lnk");
    const decision = decide(writeCall(path, READ_ONLY), [], []);
    expect(decision).toMatchObject({ verdict: "deny", action: "write_outside" });
    expect(decision.reason).toContain("「只读」例行");
    await landedAt(path, join(outsideDir, "b4.txt"));
  });

  it("目录链接指向配图拷贝目录的子目录，链接写 ../x.png：拒绝并点名配图拷贝目录", async () => {
    symlinkSync(join(draftsDir(), "deep"), join(walkDir, "dl5"));
    symlinkSync("../b5.png", join(draftsDir(), "deep", "lnk"));
    const path = join(walkDir, "dl5", "lnk");
    const decision = decide(writeCall(path), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("配图拷贝目录");
    await landedAt(path, join(draftsDir(), "b5.png"));
  });

  it("dirlink 指向助理 Chrome profile 的子目录，目标 dirlink/../x：拒绝并点名固定禁区", async () => {
    symlinkSync(join(profileDir(), "Default"), join(walkDir, "dirlink6"));
    const path = join(walkDir, "b6");
    symlinkSync("dirlink6/../b6.txt", path);
    const decision = decide(writeCall(path), [], []);
    expect(decision).toMatchObject({ verdict: "deny", action: "write_outside" });
    expect(decision.reason).toContain("固定禁区");
    await landedAt(path, join(profileDir(), "b6.txt"));
  });

  it("两跳链，第一跳的目标串里有 dirlink/..：逐跳按内核顺序解，落在外面", async () => {
    mkdirSync(join(outsideDir, "jd"));
    symlinkSync(join(outsideDir, "jd"), join(walkDir, "jdl"));
    symlinkSync("jdl/../j1.txt", join(walkDir, "j1a"));
    const path = join(walkDir, "j1b");
    symlinkSync(join(walkDir, "j1a"), path);
    const landing = join(outsideDir, "j1.txt");
    expect(decide(writeCall(path), [], [])).toMatchObject({ verdict: "ask", action: "write_outside" });
    expect(decide(writeCall(path), [], [])).toEqual(decide(writeCall(landing), [], []));
    await landedAt(path, landing);
  });
});

describe("bash 分类", () => {
  const bashCall = (command: string): GateCall => ({
    toolName: "bash",
    input: { command },
    workDir,
    zones: zones(),
    groupId,
    computerId,
    platform: "darwin",
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine: null,
  });

  it.each(["seatbelt", "bwrap"] as const)("%s 下 bash 把 work 或 shared 根当目标目录时不误拒", (sandbox) => {
    for (const command of [
      "cp x .",
      "cp x ./",
      "touch .",
      `cp x ${dirs().sharedDir}/`,
      `mkdir -p ${dirs().sharedDir}`,
      `mkdir -p ${workDir}`,
    ]) {
      expect(decide({ ...bashCall(command), sandbox }, [], []), command).toMatchObject({
        verdict: "allow",
        reason: null,
      });
    }
    for (const command of ["mv x .", `mv x ${dirs().sharedDir}/`]) {
      expect(decide({ ...bashCall(command), sandbox }, [], []), command).toMatchObject({
        verdict: "ask",
        action: "delete",
        reason: null,
      });
    }
  });

  it("批准数据根及祖先写权限仍拒绝，理由点名其他 Bot 私有区域", () => {
    const fixture = mkdtempSync(join(homedir(), "baize-gate-ancestor-"));
    try {
      const data = join(fixture, "data");
      const own = botDirs(data, BotId.parse("bot-1"));
      mkdirSync(own.workDir, { recursive: true });
      const context = { workDir: own.workDir, zones: forbiddenZones(own, null) };
      for (const path of [data, fixture, "~"]) {
        const target = pathTarget(path === "~" ? homedir() : path);
        const decision = decide(
          { ...bashCall(`cp x ${path}/`), ...context },
          [grant("write_outside", target, "forever")],
          [],
        );
        expect(decision.verdict, path).toBe("deny");
        expect(decision.reason, path).toContain("其他 Bot");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    const safe = decide(bashCall(`cp x ${outsideDir}/`), [grant("write_outside", pathTarget(outsideDir))], []);
    expect(safe.verdict).toBe("allow");
  });

  it("识别管道、&& 和重定向", () => {
    expect(decide(bashCall("cat a.txt | grep needle && echo ok > result.txt"), [], []).verdict).toBe("allow");
    expect(decide(bashCall(`echo ok > ${join(outsideDir, "result.txt")}`), [], []).verdict).toBe("ask");
  });

  it("写固定设备不弹审批", () => {
    for (const path of ["/dev/null", "/dev/stdout", "/dev/stderr"]) {
      expect(decide(bashCall(`echo ok > ${path}`), [], []).verdict).toBe("allow");
    }
  });

  it("换行和回车不交给 shell-quote 宽松解析", () => {
    expect(decide(bashCall("echo ok\nrm -f a.txt"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
    expect(decide(bashCall("echo ok\rrm -f a.txt"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
  });

  it.each([
    ["echo", "echo --definitely-unknown"],
    ["printf", "printf --definitely-unknown"],
    ["pwd", "pwd --definitely-unknown"],
    ["date", "date -f /etc/passwd"],
    ["whoami", "whoami --definitely-unknown"],
    ["id", "id --definitely-unknown"],
    ["uname", "uname --definitely-unknown"],
    ["env", "env rm -f a.txt"],
    ["true", "true --definitely-unknown"],
    ["false", "false --definitely-unknown"],
    ["test", "test -e /etc/passwd"],
    ["[", "[ -e /etc/passwd ]"],
    ["ls", "ls --definitely-unknown"],
    ["cat", "cat --definitely-unknown"],
    ["head", "head --definitely-unknown"],
    ["tail", "tail --definitely-unknown"],
    ["less", "less --definitely-unknown"],
    ["more", "more --definitely-unknown"],
    ["wc", "wc --definitely-unknown"],
    ["stat", "stat --definitely-unknown"],
    ["file", "file --definitely-unknown"],
    ["du", "du --definitely-unknown"],
    ["grep", "grep --definitely-unknown"],
    ["find", "find . -delete"],
  ])("%s 的危险或未知参数不能放行", (_name, command) => {
    expect(decide(bashCall(command), [], []).verdict).not.toBe("allow");
  });

  it("子 shell 和解析失败都按 shell 问", () => {
    expect(decide(bashCall("echo $(date)"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
    expect(decide(bashCall('echo "没收尾'), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
  });

  it.each([
    ["seatbelt", "darwin"],
    ["bwrap", "linux"],
  ] as const)("%s 下反引号是命令替换，不能拆成几个词当读文件放行", (sandbox, platform) => {
    for (const command of ["cat `rm x`", "echo `date`", 'echo "`rm x`"', "ls && cat `rm x`"]) {
      expect(decide({ ...bashCall(command), platform, sandbox }, [], []), command).toMatchObject({
        verdict: "ask",
        action: "shell",
      });
    }
  });

  it("外部 curl 归 shell，target 是域名并要求网络放宽", () => {
    expect(decide(bashCall("curl -F file=@a.txt https://upload.example.com/inbox"), [], [])).toMatchObject({
      verdict: "ask",
      action: "shell",
      target: { kind: "domain", domain: "upload.example.com" },
      access: { network: true },
    });
  });

  it("多个目的地或代理选项不能用域名授权直接放行", () => {
    const allowed = grant("shell", domainTarget("upload.example.com"), "forever");
    expect(decide(bashCall("curl https://upload.example.com/a https://other.example/b"), [allowed], [])).toMatchObject({
      verdict: "ask",
      target: null,
      access: { network: true },
    });
    expect(
      decide(bashCall("curl --proxy http://127.0.0.1:8888 https://upload.example.com/a"), [allowed], []),
    ).toMatchObject({
      verdict: "ask",
      target: null,
      access: { network: true },
    });
  });

  it("没有沙箱时 bash 一律问", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(
        decide({ ...bashCall("ls"), platform, sandbox: "none" }, [], []),
        `${platform} 上没有沙箱，工作目录里的 ls 也要问`,
      ).toMatchObject({ verdict: "ask", action: "shell" });
    }
  });

  it("bwrap 下工作目录里的 bash 直接放行，分类结果和 seatbelt 一致", () => {
    const commands = [
      "ls",
      "cat a.txt | grep needle && echo ok > result.txt",
      `echo ok > ${join(outsideDir, "result.txt")}`,
      "cat ~/.ssh/id_ed25519",
      "curl https://example.com/",
      "echo $(date)",
    ];
    for (const command of commands) {
      const seatbelt = decide(bashCall(command), [], []);
      expect(decide({ ...bashCall(command), platform: "linux", sandbox: "bwrap" }, [], []), command).toEqual(seatbelt);
    }
    expect(decide({ ...bashCall("ls"), platform: "linux", sandbox: "bwrap" }, [], []).verdict).toBe("allow");
  });
});

describe("云电脑上沙箱兜得住的 bash 不问", () => {
  // 云电脑镜像里的 PATH；工具箱的 venv/bin 由 createSandboxedBash 放在它前面。
  const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/usr/local/bin";
  const toolboxDir = (): string => join(root, "bot-1", "toolbox");
  const venvBin = (): string => join(toolboxDir(), "venv", "bin");
  const cloud = (command: string, overrides: Partial<GateCall> = {}): GateCall => ({
    ...gateContext({ platform: "linux" }),
    toolName: "bash",
    input: { command },
    sandbox: "bwrap",
    containment: { level: "closed", searchPath: `${venvBin()}:${SYSTEM_PATH}`, toolboxDir: toolboxDir() },
    source: null,
    routine: null,
    ...overrides,
  });
  const mac = (command: string): GateCall =>
    cloud(command, { platform: "darwin", sandbox: "seatbelt", containment: { level: "none" } });
  const localLinux = (command: string): GateCall => cloud(command, { containment: { level: "none" } });
  const SYSTEM_PACKAGE_REASON =
    "云电脑的沙箱里没有 root，装不了系统包。Python 包用 pip 装进你的工具箱，Node 包用 npm 装进工作区；要系统包请主人改 deploy/remote/Dockerfile。";

  beforeAll(() => {
    mkdirSync(join(outsideDir, "escape"), { recursive: true });
    symlinkSync(join(outsideDir, "escape"), join(workDir, "escape-link"));
  });

  // 今天这些都按 shell 问，批了也只是在同一个沙箱里改工作区。
  const CONTAINED = [
    "sed -i s/a/b/ notes.txt",
    "sed -n 1,20p notes.txt",
    "ls -la",
    "cd sub && ls",
    "grep -rn TODO .",
    "find . -name '*.md'",
    "jq .name package.json",
    "awk '{print $1}' data.txt",
    "sort data.txt | uniq -c",
    "tar -czf out.tgz out",
    "cp -r src dst",
    "gzip -k data.csv",
    "head -20 report.csv 2>&1",
  ];

  it.each(CONTAINED)("云电脑上 %s 直接放行，沙箱权限不放宽", (command) => {
    expect(decide(cloud(command), [], [])).toEqual({
      verdict: "allow",
      action: "shell",
      target: null,
      reason: null,
      access: { network: false, writePaths: [] },
    });
  });

  it.each(CONTAINED)("Mac 和本机 Linux 上 %s 照旧问", (command) => {
    expect(decide(mac(command), [], []).verdict).toBe("ask");
    expect(decide(localLinux(command), [], []).verdict).toBe("ask");
  });

  it.each([
    ["删除", "rm a.txt"],
    ["移动", "mv a.txt b.txt"],
    ["工作区外的读", "cat /etc/passwd"],
    ["经工作区里的链接读外面", "cat escape-link/secret.txt"],
    ["经 .. 读外面", "cat ../agent/auth.json"],
    ["反引号", "cat `rm x`"],
    ["awk 里调 system", `awk '{system("rm x")}' data.txt`],
    ["awk 里接管道", `awk '{print | "sh"}' data.txt`],
    ["变量", "echo $HOME"],
    ["变量拼路径", "cat $HOME/x"],
    ["双引号里的变量", 'cat "$HOME/x"'],
    ["glob", "ls *.md"],
    ["家目录", "cat ~/x"],
    ["不带 -k 的 gzip 会删原文件", "gzip data.csv"],
    ["sed 的 w 写文件", "sed 's/a/b/w out' notes.txt"],
    ["sed 的 e 执行命令", "sed 's/a/b/e' notes.txt"],
    ["find 删除", "find . -delete"],
    ["解包之后还有别的段", "tar -xzf a.tgz && cat a/x"],
    ["联网", "curl https://example.com"],
    ["解释器", "python3 -c 'print(1)'"],
    ["重定向到工作区外", "echo ok > /etc/x"],
  ])("云电脑上%s照问：%s", (_label, command) => {
    expect(decide(cloud(command), [], []).verdict).toBe("ask");
  });

  it("联网命令照问，批准时照旧放宽网络", () => {
    expect(decide(cloud("curl https://example.com"), [], [])).toMatchObject({
      verdict: "ask",
      access: { network: true },
    });
  });

  it.each([
    "apt-get install -y jq",
    "sudo apt-get install -y jq",
    "apt install jq",
    "dpkg -i x.deb",
    "su -c id",
    "yum install jq",
    "apk add jq",
    "dnf install jq",
    "brew install jq",
    "ls && /usr/bin/apt-get install jq",
  ])("云电脑上系统包管理器直接拒绝，理由让模型改用工具箱：%s", (command) => {
    expect(decide(cloud(command), [], [])).toMatchObject({
      verdict: "deny",
      action: "install",
      reason: SYSTEM_PACKAGE_REASON,
    });
  });

  it("Mac 和本机 Linux 上系统包管理器照旧问", () => {
    expect(decide(mac("apt-get install -y jq"), [], [])).toMatchObject({ verdict: "ask", action: "install" });
    expect(decide(mac("brew install jq"), [], [])).toMatchObject({ verdict: "ask", action: "install" });
    expect(decide(mac("sudo apt-get install -y jq"), [], [])).toMatchObject({ verdict: "ask", reason: null });
    expect(decide(localLinux("apt-get install -y jq"), [], [])).toMatchObject({ verdict: "ask", action: "install" });
  });

  describe("pip 装进工具箱", () => {
    const TOOLBOX_REASON = "联网安装到这个 Bot 自己的工具箱";

    it.each(["pip install six", "pip3 install six", "python3 -m pip install six", "pip install --upgrade six"])(
      "云电脑上 %s 照问，卡上写联网安装到工具箱，批准后放开网络和工具箱",
      (command) => {
        expect(decide(cloud(command), [], [])).toEqual({
          verdict: "ask",
          action: "install",
          target: null,
          reason: TOOLBOX_REASON,
          access: { network: true, writePaths: [toolboxDir()] },
        });
      },
    );

    it("Mac 和本机 Linux 上 pip 的判定和今天逐字一样", () => {
      const today = {
        verdict: "ask",
        action: "install",
        target: null,
        reason: null,
        access: { network: false, writePaths: [] },
      };
      for (const command of ["pip install six", "pip3 install six"]) {
        expect(decide(mac(command), [], []), command).toEqual(today);
        expect(decide(localLinux(command), [], []), command).toEqual(today);
      }
      expect(decide(mac("python3 -m pip install six"), [], [])).toEqual({ ...today, action: "shell" });
    });

    it("云电脑上 npm、pnpm、yarn 的 install、add、ci 照问，批准后放开网络但不开工具箱", () => {
      for (const command of ["npm install left-pad", "pnpm add left-pad", "yarn add left-pad", "npm ci"]) {
        expect(decide(cloud(command), [], []), command).toEqual({
          verdict: "ask",
          action: "install",
          target: null,
          reason: null,
          access: { network: true, writePaths: [] },
        });
      }
    });

    it("Mac 上 npm install 的判定不变，npm ci 照旧归 shell", () => {
      expect(decide(mac("npm install left-pad"), [], [])).toEqual({
        verdict: "ask",
        action: "install",
        target: null,
        reason: null,
        access: { network: false, writePaths: [] },
      });
      expect(decide(mac("npm ci"), [], [])).toMatchObject({ verdict: "ask", action: "shell", reason: null });
    });
  });

  describe("证明器按沙箱的 PATH 解析命令名", () => {
    it("工具箱 venv/bin 里放了可执行的 cat，云电脑上 cat a.txt 必须问", () => {
      mkdirSync(venvBin(), { recursive: true });
      writeFileSync(join(venvBin(), "cat"), "#!/bin/sh\nrm -rf .\n");
      chmodSync(join(venvBin(), "cat"), 0o755);
      try {
        expect(decide(cloud("cat a.txt"), [], [])).toEqual({
          verdict: "ask",
          action: "shell",
          target: null,
          reason: null,
          access: { network: false, writePaths: [] },
        });
        expect(decide(cloud("ls -la"), [], []).verdict).toBe("allow");
      } finally {
        rmSync(join(venvBin(), "cat"));
      }
    });

    it("云电脑上带目录的命令名和前置赋值都问，分类器剥目录的老规矩不在云上放行", () => {
      expect(decide(cloud("./bin/cat a.txt"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
      expect(decide(cloud("/bin/cat a.txt"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
      expect(decide(cloud("PATH=./bin cat a.txt"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
    });

    it("PATH 里只有系统目录时照常放行，PATH 带相对目录整条问", () => {
      expect(
        decide(
          cloud("cat a.txt", {
            containment: { level: "closed", searchPath: "/usr/bin:/bin", toolboxDir: toolboxDir() },
          }),
          [],
          [],
        ).verdict,
      ).toBe("allow");
      expect(
        decide(
          cloud("cat a.txt", {
            containment: { level: "closed", searchPath: `.:/usr/bin:/bin`, toolboxDir: toolboxDir() },
          }),
          [],
          [],
        ).verdict,
      ).toBe("ask");
    });
  });

  it("拒绝不会被放宽：助理 Chrome profile 放在工作区里，读它照旧拒绝", () => {
    const inside = forbiddenZones(dirs(), join(workDir, "chrome"));
    for (const command of ["cat chrome/Cookies", "ls -la && cat chrome/Cookies"]) {
      expect(decide(cloud(command, { zones: inside }), [], []), command).toMatchObject({
        verdict: "deny",
        action: "read",
      });
    }
  });

  it("助理 Chrome profile 放在工作区里时，分类器看不见路径的命令也不放宽", () => {
    const inside = forbiddenZones(dirs(), join(workDir, "chrome"));
    for (const command of ["sed -n 1p chrome/Cookies", "grep -rn token .", "tar -czf out.tgz ."]) {
      expect(decide(cloud(command, { zones: inside }), [], []).verdict, command).toBe("ask");
    }
  });

  it("只有 bash 的询问会被放宽，别的工具照旧", () => {
    const write = cloud("ls", { toolName: "write", input: { path: join(outsideDir, "a.txt"), content: "x" } });
    expect(decide(write, [], [])).toMatchObject({ verdict: "ask", action: "write_outside" });
  });
});

describe("浏览器工具", () => {
  const call = (toolName: string, input: Record<string, unknown>): GateCall => ({
    ...gateContext(),
    toolName,
    input,
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine: null,
  });

  it.each([
    ["browser_open", { url: "https://example.com/a" }],
    ["browser_snapshot", {}],
    ["browser_screenshot", {}],
  ] as const)("%s 归 read，直接放行", (toolName, input) => {
    expect(decide(call(toolName, input), [], [])).toMatchObject({ verdict: "allow", action: "read" });
  });

  it.each([
    ["browser_click", { ref: 3 }],
    ["browser_type", { ref: 3, text: "你好" }],
  ] as const)("%s 归 engage，默认问", (toolName, input) => {
    expect(decide(call(toolName, input), [], [])).toMatchObject({ verdict: "ask", action: "engage" });
  });

  it("browser_ask_user 归 read 直接放行，动手的是用户自己；它不在 BROWSER_TOOL_NAMES 里，会话闸门不为它持锁", () => {
    expect(TAKEOVER_TOOL).toBe("browser_ask_user");
    expect(decide(call(TAKEOVER_TOOL, { reason: "请你登录一下" }), [], [])).toMatchObject({
      verdict: "allow",
      action: "read",
      target: null,
    });
    expect(BROWSER_TOOL_NAMES).not.toContain(TAKEOVER_TOOL);
    expect(BROWSER_TOOL_NAMES).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_screenshot",
      "browser_click",
      "browser_type",
    ]);
  });

  it("点和填的授权目标是浏览器当前页的主机名，命中 engage 的域名授权就不问", () => {
    const grants = [grant("engage", domainTarget("127.0.0.1"))];
    expect(decide({ ...call("browser_click", { ref: 3 }), browserHost: "127.0.0.1" }, grants, [])).toMatchObject({
      verdict: "allow",
      action: "engage",
      target: { kind: "domain", domain: "127.0.0.1" },
    });
    expect(
      decide({ ...call("browser_type", { ref: 3, text: "你好" }), browserHost: "127.0.0.1" }, grants, []).verdict,
    ).toBe("allow");
  });

  it("当前页是别的域名，engage 的域名授权不算，照样问", () => {
    const grants = [grant("engage", domainTarget("127.0.0.1"))];
    expect(decide({ ...call("browser_click", { ref: 3 }), browserHost: "localhost" }, grants, [])).toMatchObject({
      verdict: "ask",
      target: { kind: "domain", domain: "localhost" },
    });
  });

  it("没有当前页时授权目标为空，模型在入参里塞的 hostname 不算数", () => {
    const grants = [grant("engage", domainTarget("127.0.0.1"))];
    const decision = decide(
      { ...call("browser_click", { ref: 3, hostname: "127.0.0.1", url: "http://127.0.0.1/" }), browserHost: null },
      grants,
      [],
    );
    expect(decision).toMatchObject({ verdict: "ask", target: null });
  });

  it.each([
    ["localhost.", "localhost", "localhost"],
    ["localhost", "localhost.", "localhost"],
    ["xn--fiq228c.example", "中文.example", "xn--fiq228c.example"],
    ["中文.example.", "xn--fiq228c.example", "xn--fiq228c.example"],
    ["[::1]", "[::1]", "[::1]"],
  ] as const)("当前页主机 %s 与授权 %s 是同一个域名，放行且目标写成 %s", (host, grantedDomain, expected) => {
    const grants = [grant("engage", domainTarget(grantedDomain))];
    expect(decide({ ...call("browser_click", { ref: 3 }), browserHost: host }, grants, [])).toMatchObject({
      verdict: "allow",
      target: { kind: "domain", domain: expected },
    });
  });

  it("当前页主机名是空串，目标为空，有授权也问", () => {
    const grants = [grant("engage", domainTarget("localhost"))];
    expect(decide({ ...call("browser_click", { ref: 3 }), browserHost: "" }, grants, [])).toMatchObject({
      verdict: "ask",
      target: null,
    });
  });

  it("account_read 归 read，没有授权也直接放行", () => {
    expect(decide(call("account_read", { accountId: "acc-gh", path: "repos/o/r/issues" }), [], [])).toMatchObject({
      verdict: "allow",
      action: "read",
    });
  });

  it("bash 读 profile 下的 Cookies 被拒", () => {
    const decision = decide(call("bash", { command: `cat ${join(profileDir(), "Default", "Cookies")}` }), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("固定禁区");
  });

  it("bash 往配图拷贝目录里写被拒", () => {
    const decision = decide(
      call("bash", { command: `echo x > ${join(draftsDir(), "b".repeat(64) + ".png")}` }),
      [],
      [],
    );
    expect(decision.verdict).toBe("deny");
  });
});

describe("例行边界", () => {
  const READ_ONLY = { boundary: "read_only" } as const;
  const DRAFT = { boundary: "draft" } as const;
  const call = (
    toolName: string,
    input: Record<string, unknown>,
    routine: GateCall["routine"],
    overrides: Partial<GateCall> = {},
  ): GateCall => ({
    ...gateContext(),
    toolName,
    input,
    sandbox: "seatbelt",
    containment: { level: "none" },
    source: null,
    routine,
    ...overrides,
  });
  // 表在收集阶段就要展开，那时 beforeAll 还没跑，outsideDir 是空的，所以这里另给一个不依赖它的工作目录外路径。
  const outside = join(tmpdir(), "baize-gate-elsewhere", "a.txt");
  const account = accountOf("account-1", "direct_publish");
  const post = { accountId: "account-1", content: { kind: "post", text: "早安" } };

  const BARRED: ReadonlyArray<readonly [label: string, GateCall["toolName"], GateCall["input"], Partial<GateCall>]> = [
    ["bash 里 git push", "bash", { command: "git push origin main" }, {}],
    ["bash 里 rm", "bash", { command: "rm a.txt" }, {}],
    ["bash 往工作目录外写", "bash", { command: `echo x > ${outside}` }, {}],
    ["write 工作目录外的文件", "write", { path: outside, content: "x" }, {}],
    ["write file:// 地址的工作目录外文件", "write", { path: `file://${outside}`, content: "x" }, {}],
    [
      "edit file:// 地址的工作目录外文件",
      "edit",
      { path: `file://${outside}`, edits: [{ oldText: "a", newText: "b" }] },
      {},
    ],
    ["查不到归属的工具", "send_email", { to: "a@b.c" }, { source: null }],
    ["调用方注入的扩展工具", "send_email", { to: "a@b.c" }, { source: { kind: "extension" } }],
    [
      "名字以读类开头但后面带写动词的 MCP 操作",
      "get_and_delete_rows",
      {},
      { source: { kind: "connected", operation: { name: "get_and_delete_rows", needsApproval: false } } },
    ],
    ["浏览器点", "browser_click", { ref: 3 }, { browserHost: "example.com" }],
    ["浏览器填", "browser_type", { ref: 3, text: "你好" }, { browserHost: "example.com" }],
    [
      "MCP 里的 publish_ 操作",
      "publish_x",
      { accountId: "account-1" },
      { source: { kind: "connected", operation: { name: "publish_x", needsApproval: true } } },
    ],
    [
      "MCP 里的 send_ 操作",
      "send_email",
      { to: "a@b.c" },
      { source: { kind: "connected", operation: { name: "send_email", needsApproval: true } } },
    ],
    [
      "MCP 里的 delete_ 操作",
      "delete_row",
      { id: 1 },
      { source: { kind: "connected", operation: { name: "delete_row", needsApproval: true } } },
    ],
    ["propose_project 方案卡", "propose_project", { name: "小红书起号" }, {}],
    ["propose_team 建队卡", "propose_team", { projectGroupId: "group-1" }, {}],
    ["propose_routine 例行卡", "propose_routine", { name: "周报" }, {}],
    ["propose_skill 存 skill 的提议", "propose_skill", { name: "报价", steps: ["a", "b"] }, {}],
    ["set_cadence 改项目节奏", "set_cadence", { projectGroupId: "group-1", cadence: "每周 3 篇" }, {}],
    ["update_checklist 改任务卡清单", "update_checklist", { items: [] }, {}],
    ["set_chief 换首席", "set_chief", { name: "小黑" }, {}],
    ["handoff_task 发起交接", "handoff_task", { to: "小黑", done: "a", notDone: "b", next: "c" }, {}],
    ["accept_handoff 接手交接", "accept_handoff", {}, {}],
    ["mention_bot 叫别的 Bot 干活", "mention_bot", { name: "小黑", text: "帮我看一眼" }, {}],
    [
      "免审批的 MCP publish_ 操作",
      "publish_x",
      { accountId: "account-1" },
      { source: { kind: "connected", operation: { name: "publish_x", needsApproval: false } } },
    ],
    [
      "免审批的 MCP send_ 操作",
      "send_email",
      { to: "a@b.c" },
      { source: { kind: "connected", operation: { name: "send_email", needsApproval: false } } },
    ],
    [
      "免审批的 MCP delete_ 操作",
      "delete_row",
      { id: 1 },
      { source: { kind: "connected", operation: { name: "delete_row", needsApproval: false } } },
    ],
    [
      "免审批的 MCP like_ 操作",
      "like_post",
      { id: 1 },
      { source: { kind: "connected", operation: { name: "like_post", needsApproval: false } } },
    ],
  ];

  const ALLOWED: ReadonlyArray<readonly [label: string, GateCall["toolName"], GateCall["input"], Partial<GateCall>]> = [
    ["读网页 browser_open", "browser_open", { url: "https://example.com/a" }, {}],
    ["browser_snapshot", "browser_snapshot", {}, {}],
    ["browser_screenshot", "browser_screenshot", {}, {}],
    ["account_read", "account_read", { accountId: "acc-gh", path: "repos/o/r/issues" }, {}],
    ["读工作目录里的文件", "read", { path: join(workDir, "a.txt") }, {}],
    ["bash 读工作目录", "bash", { command: "cat a.txt | grep needle" }, {}],
    ["bash 往工作目录里写", "bash", { command: "echo ok > result.txt" }, {}],
    ["write 工作目录里的文件", "write", { path: join(workDir, "r.md"), content: "x" }, {}],
    ["report_metric", "report_metric", { value: 3 }, {}],
    ["submit_review", "submit_review", { body: "复盘" }, {}],
    ["remember_preference", "remember_preference", { text: "报价单不带折扣" }, {}],
    ["call_helper", "call_helper", { task: "查一下竞品" }, {}],
    [
      "MCP 里不用批的读操作",
      "list_rows",
      {},
      { source: { kind: "connected", operation: { name: "list_rows", needsApproval: false } } },
    ],
  ];

  it.each(BARRED)("read_only：%s 拒绝，理由是中文且指明下一步", (_label, toolName, input, overrides) => {
    const decision = decide(call(toolName, input, READ_ONLY, overrides), [], [account]);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("「只读」例行");
    expect(decision.reason).toContain("「草稿等你批」");
  });

  it.each(["create_draft", "edit_draft", "propose_plan"] as const)("read_only：起草工具 %s 拒绝", (toolName) => {
    const decision = decide(
      call(toolName, toolName === "propose_plan" ? { drafts: [post] } : post, READ_ONLY),
      [],
      [account],
    );
    expect(decision).toMatchObject({ verdict: "deny", action: "publish" });
    expect(decision.reason).toContain("不能起草");
  });

  const TOOL_BARS: ReadonlyArray<readonly [toolName: string, bar: string]> = [
    ["propose_project", "出方案卡"],
    ["propose_team", "出建队卡"],
    ["propose_routine", "出例行卡"],
    ["propose_skill", "问用户存不存 skill"],
    ["set_cadence", "改项目节奏"],
    ["update_checklist", "改任务卡清单"],
    ["set_chief", "换首席"],
    ["handoff_task", "发起交接"],
    ["accept_handoff", "接手交接"],
    ["mention_bot", "叫别的 Bot 干活"],
    ["poker_act", "出牌"],
    ["poker_review", "交复盘"],
  ];

  it.each(TOOL_BARS)("read_only：%s 拒绝，理由点名不能%s，不是一句空话", (toolName, bar) => {
    const decision = decide(call(toolName, {}, READ_ONLY), [], [account]);
    expect(decision).toMatchObject({ verdict: "deny", action: "write_workspace" });
    expect(decision.reason).toContain(`不能${bar}`);
  });

  it.each(TOOL_BARS.map(([toolName]) => toolName))("read_only：永久授权也救不了 %s", (toolName) => {
    const forever = grant("write_workspace", pathTarget(workDir), "forever");
    expect(decide(call(toolName, {}, READ_ONLY), [forever], [account]).verdict).toBe("deny");
  });

  // 每个内部工具和起草工具都得在这里表态：放行的写在清单里，其余一律拒。新增工具没表态，这里红。
  const READ_ONLY_OPEN_TOOLS: ReadonlySet<string> = new Set([
    "read_task",
    "recall_memory",
    "report_metric",
    "remember_preference",
    "call_helper",
    "submit_review",
  ]);

  it("read_only：内部工具和起草工具除了放行清单里的，全部拒绝，新增工具忘了表态时这里红", () => {
    const names = [...INTERNAL_TOOLS, ...DRAFT_TOOL_NAMES];
    expect(names.length, "探针得先看得见这些工具，不然下面的循环是空的").toBeGreaterThanOrEqual(15);
    expect(
      [...READ_ONLY_OPEN_TOOLS].filter((name) => !names.includes(name)),
      "清单里的名字得是真工具",
    ).toEqual([]);
    const verdicts = Object.fromEntries(
      names.map((name) => [name, decide(call(name, { drafts: [post] }, READ_ONLY), [], [account]).verdict]),
    );
    const wrong = names.filter((name) => (verdicts[name] === "allow") !== READ_ONLY_OPEN_TOOLS.has(name));
    expect(wrong, "这些工具在只读例行里的结论和清单不一致").toEqual([]);
  });

  it.each(ALLOWED)("read_only：%s 照常放行", (_label, toolName, input, overrides) => {
    expect(decide(call(toolName, input, READ_ONLY, overrides), [], [account]).verdict).toBe("allow");
  });

  it("read_only：工作目录外的读、联网命令这些边界之外的动作照旧问", () => {
    expect(decide(call("read", { path: outside }, READ_ONLY), [], []).verdict).toBe("ask");
    expect(decide(call("bash", { command: "curl -s https://example.com" }, READ_ONLY), [], []).verdict).toBe("ask");
  });

  it("read_only：永久授权也救不了，边界排在授权前面", () => {
    const publish = call("bash", { command: "git push origin main" }, READ_ONLY);
    const forever = grant("publish", { kind: "account", accountId: account.id }, "forever");
    expect(decide(publish, [forever], [account]).verdict).toBe("deny");
    const clicking = call("browser_click", { ref: 3 }, READ_ONLY, { browserHost: "127.0.0.1" });
    expect(decide(clicking, [grant("engage", domainTarget("127.0.0.1"), "forever")], []).verdict).toBe("deny");
  });

  it("read_only：直发档账号照样不能起草", () => {
    expect(decide(call("create_draft", post, READ_ONLY), [], [accountOf("account-1", "direct_publish")]).verdict).toBe(
      "deny",
    );
  });

  it("read_only：只读档账号的起草也是拒绝，说的是例行边界在先", () => {
    const decision = decide(call("create_draft", post, READ_ONLY), [], [accountOf("account-1", "read_only")]);
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("「只读」例行");
  });

  it("read_only：多段 bash 里有一段碰了边界整条拒绝", () => {
    const decision = decide(call("bash", { command: "cat a.txt && rm a.txt" }, READ_ONLY), [], []);
    expect(decision.verdict).toBe("deny");
    expect(decision.action).toBe("delete");
  });

  it.each([...BARRED, ...ALLOWED])("draft 边界和不是例行触发的 run 一样：%s", (_label, toolName, input, overrides) => {
    const free = decide(call(toolName, input, null, overrides), [], [account]);
    expect(decide(call(toolName, input, DRAFT, overrides), [], [account])).toEqual(free);
  });

  describe("插件操作：只读例行里失败即关，不看免审批设置", () => {
    const mcpCall = (name: string, needsApproval: boolean, routine: GateCall["routine"], input = {}) =>
      call(name, input, routine, { source: { kind: "connected", operation: { name, needsApproval } } });

    it.each([true, false])("read_only：写动作的名字 needsApproval=%s 一样拒绝，理由点名是哪类动作", (needsApproval) => {
      const reasons = [
        ["publish_x", "发布"],
        ["post_note", "发布"],
        ["send_email", "联系别人"],
        ["dm_user", "联系别人"],
        ["delete_row", "删东西"],
        ["remove_file", "删东西"],
        ["like_post", "在网页上点或填"],
        ["follow_user", "在网页上点或填"],
      ] as const;
      for (const [name, bar] of reasons) {
        const decision = decide(mcpCall(name, needsApproval, READ_ONLY), [], [account]);
        expect(decision.verdict, name).toBe("deny");
        expect(decision.reason, name).toContain(`不能${bar}`);
      }
    });

    const UNKNOWN_REASON = "不能用不确定是否只读的插件操作";

    it.each([
      ["render_chart", false],
      ["render_chart", true],
      ["sync_orders", false],
      ["sendEmail", false],
      ["get", false],
      ["Get", false],
      ["get-", false],
      ["pay_invoice", true],
      ["pay_invoice", false],
      ["install_pkg", true],
      ["authorize_app", true],
    ] as const)("read_only：不认识的名字 %s（needsApproval=%s）拒绝，理由说不确定是否只读", (name, needsApproval) => {
      const decision = decide(mcpCall(name, needsApproval, READ_ONLY), [], [account]);
      expect(decision).toMatchObject({ verdict: "deny", action: "external_write" });
      expect(decision.reason).toContain(UNKNOWN_REASON);
    });

    const READ_PREFIXED = [
      "get_orders",
      "list_files",
      "read_note",
      "search_docs",
      "fetch_page",
      "query_rows",
      "find_user",
      "lookup_stock",
      "describe_table",
      "view_report",
      "count_rows",
    ];

    it.each(READ_PREFIXED)("read_only：读类前缀 %s 且免审批时放行", (name) => {
      expect(decide(mcpCall(name, false, READ_ONLY), [], [account])).toMatchObject({
        verdict: "allow",
        action: "read",
      });
    });

    it.each(READ_PREFIXED)("read_only：读类前缀 %s 但用户设了要审批，仍然问，不因为是只读例行就放宽", (name) => {
      expect(decide(mcpCall(name, true, READ_ONLY), [], [account]).verdict).toBe("ask");
    });

    const COMPOUND_WRITE = [
      "get_and_delete_rows",
      "list_then_publish_posts",
      "search_send_email",
      "fetch_pay_invoice",
      "read_create_user",
      "view_update_profile",
      "find_remove_item",
      "lookup_set_price",
      "query_write_rows",
      "describe_upload_file",
      "fetch_and_store",
      "get_and_store",
      "get_and_drop_table",
      "query_and_truncate",
      "get_truncate_table",
      "list_drop_index",
      "fetch_exec_script",
      "find_kill_job",
      "get_store_file",
      "get_and_open_pr",
      "fetch_and_exec",
      "list_and_kill",
      "get_or_create_user",
      "list_then_archive",
      "get_and_Delete_x",
      "get_x-delete",
      "get_x.delete",
      "get_xDelete",
      "getXDelete",
      "GET_X_DELETE",
      "get__delete__x",
      "fetch_reboot",
      "list_restart_services",
      "get_reset_password",
      "query_wipe",
      "find_replace_text",
      "get_unlock_account",
      "fetch_deploy",
      "search_ban_user",
      "list_enable_feature",
      "get_invite",
      "describe_shutdown",
      "get_import_data",
      "read_clear_cache",
      "get_mark_read",
      "list_assign_owner",
      "fetch_refund",
      "view_edit_page",
    ];

    it.each(COMPOUND_WRITE)("read_only：读类开头但后面带写动词的 %s 不算读类，免审批也拒绝", (name) => {
      const decision = decide(mcpCall(name, false, READ_ONLY), [], [account]);
      expect(decision).toMatchObject({ verdict: "deny", action: "external_write" });
      expect(decision.reason).toContain(UNKNOWN_REASON);
    });

    it.each([
      "get_user_posts",
      "list_deleted_rows",
      "search_sent_mail",
      "count_updates",
      "get_run",
      "get_update",
      "get_comment",
      "get_user_email",
      "list_message",
      "read_dm",
      "get_open_issues",
      "get_open_ticket",
      "list_open_prs",
      "get_store",
      "getOrders",
      "GET_orders",
      "list-files",
      "get.orders",
    ])("read_only：%s 后面的段只是像写动词或名词位置上的写词，仍按读类放行", (name) => {
      expect(decide(mcpCall(name, false, READ_ONLY), [], [account])).toMatchObject({
        verdict: "allow",
        action: "read",
      });
    });

    it("普通 run 里复合名仍按 needsApproval 定：免审批放行，要审批就问", () => {
      expect(decide(mcpCall("get_and_delete_rows", false, null), [], [account]).verdict).toBe("allow");
      expect(decide(mcpCall("get_and_delete_rows", true, null), [], [account]).verdict).toBe("ask");
    });

    const UNTRACED_REASON = "只能用运行器自带的工具和认得出是只读的插件操作";

    it.each([
      ["lookup_stock", { sku: "SKU-1" }],
      ["send_email", { to: "a@b.c" }],
      ["render_chart", {}],
    ] as const)("read_only：查不到归属的 %s 拒绝，读类前缀也不救", (name, input) => {
      const decision = decide(call(name, input, READ_ONLY, { source: null }), [], [account]);
      expect(decision).toMatchObject({ verdict: "deny", action: "external_write" });
      expect(decision.reason).toContain(UNTRACED_REASON);
      expect(decision.reason).toContain("「草稿等你批」");
    });

    it.each([
      ["用户当面派的 run", null],
      ["draft 边界的例行", DRAFT],
    ] as const)("%s里查不到归属的工具当未知外部操作，问用户", (_label, routine) => {
      expect(decide(call("lookup_stock", { sku: "SKU-1" }, routine, { source: null }), [], [account])).toMatchObject({
        verdict: "ask",
        action: "external_write",
      });
    });

    it("read_only：调用方注入的扩展工具拒绝，普通 run 里照旧按运行器自己的工具放行", () => {
      const extension = { source: { kind: "extension" } } as const;
      const denied = decide(call("list_files", { dir: "." }, READ_ONLY, extension), [], [account]);
      expect(denied).toMatchObject({ verdict: "deny", action: "external_write" });
      expect(denied.reason).toContain(UNTRACED_REASON);
      expect(decide(call("list_files", { dir: "." }, null, extension), [], [account])).toMatchObject({
        verdict: "allow",
        action: "write_workspace",
      });
    });

    it("read_only：永久授权也救不了免审批的写动作和不认识的名字", () => {
      const publishing = grant("publish", { kind: "account", accountId: account.id }, "forever");
      expect(
        decide(mcpCall("publish_x", false, READ_ONLY, { accountId: "account-1" }), [publishing], [account]).verdict,
      ).toBe("deny");
      const writing = grant("external_write", domainTarget("example.com"), "forever");
      const unknown = mcpCall("sync_orders", true, READ_ONLY, { url: "https://example.com/x" });
      expect(decide(mcpCall("sync_orders", true, null, { url: "https://example.com/x" }), [writing], []).verdict).toBe(
        "allow",
      );
      expect(decide(unknown, [writing], []).verdict).toBe("deny");
    });

    it.each([
      ["不是例行触发的 run", null],
      ["draft 边界的例行", DRAFT],
    ] as const)("%s：免审批的 MCP 操作照旧放行，要审批的照旧问", (_label, routine) => {
      for (const name of ["publish_x", "send_email", "delete_row", "like_post", "sync_orders", "get_orders"]) {
        expect(decide(mcpCall(name, false, routine), [], [account]), `${name} 免审批`).toMatchObject({
          verdict: "allow",
          action: "read",
        });
      }
      expect(decide(mcpCall("send_email", true, routine), [], [account])).toMatchObject({
        verdict: "ask",
        action: "message_person",
      });
      expect(decide(mcpCall("sync_orders", true, routine), [], [account])).toMatchObject({
        verdict: "ask",
        action: "external_write",
      });
    });
  });

  describe("没有系统沙箱：只读例行里 bash 一律拒绝，不退化成审批", () => {
    const NO_SANDBOX_REASON = "这台电脑没有沙箱，只读例行里不能执行命令";
    const bash = (command: string, routine: GateCall["routine"], sandbox: GateCall["sandbox"]) =>
      call("bash", { command }, routine, { sandbox });

    it.each([
      ["读文件", "cat a.txt"],
      ["往工作目录里写", "echo ok > result.txt"],
      ["rm", "rm a.txt"],
      ["git push", "git push origin main"],
      ["联网", "curl -s https://example.com"],
      ["不认识的命令", "my-tool --run"],
    ])("sandbox=none：%s 拒绝，理由说没有沙箱", (_label, command) => {
      const decision = decide(bash(command, READ_ONLY, "none"), [], [account]);
      expect(decision).toMatchObject({ verdict: "deny", action: "shell" });
      expect(decision.reason).toContain(NO_SANDBOX_REASON);
      expect(decision.reason, "告诉模型下一步怎么办").toContain("「草稿等你批」");
    });

    it("sandbox=none：授权也救不了，边界排在授权前面", () => {
      const forever = grant("shell", domainTarget("example.com"), "forever");
      expect(decide(bash("curl -s https://example.com", READ_ONLY, "none"), [forever], []).verdict).toBe("deny");
    });

    it.each(["seatbelt", "bwrap"] as const)(
      "sandbox=%s：保持现有分类，读放行、rm 拒绝、联网和不认识的命令照旧问",
      (kind) => {
        expect(decide(bash("cat a.txt", READ_ONLY, kind), [], []).verdict).toBe("allow");
        expect(decide(bash("rm a.txt", READ_ONLY, kind), [], []).reason).toContain("不能删东西");
        expect(decide(bash("curl -s https://example.com", READ_ONLY, kind), [], []).verdict).toBe("ask");
        expect(decide(bash("my-tool --run", READ_ONLY, kind), [], []).verdict).toBe("ask");
      },
    );

    it.each([
      ["不是例行触发的 run", null],
      ["draft 边界的例行", DRAFT],
    ] as const)("sandbox=none：%s 的 bash 照旧问", (_label, routine) => {
      expect(decide(bash("cat a.txt", routine, "none"), [], [])).toMatchObject({ verdict: "ask", action: "shell" });
      expect(decide(bash("rm a.txt", routine, "none"), [], []).verdict).toBe("ask");
    });

    it("sandbox=none 只管 bash：只读例行里读工作目录里的文件照常放行", () => {
      expect(
        decide(call("read", { path: join(workDir, "a.txt") }, READ_ONLY, { sandbox: "none" }), [], []).verdict,
      ).toBe("allow");
    });
  });

  it("不是例行触发的 run：起草放行、rm 和 git push 照旧问", () => {
    expect(decide(call("create_draft", post, null), [], [accountOf("account-1", "draft")]).verdict).toBe("allow");
    expect(decide(call("bash", { command: "rm a.txt" }, null), [], []).verdict).toBe("ask");
    expect(decide(call("bash", { command: "git push origin main" }, null), [], []).verdict).toBe("ask");
  });

  it("draft 边界下起草照常：只读档账号仍按账号档拒绝，其余放行", () => {
    expect(decide(call("create_draft", post, DRAFT), [], [accountOf("account-1", "confirm_publish")]).verdict).toBe(
      "allow",
    );
    expect(decide(call("create_draft", post, DRAFT), [], [accountOf("account-1", "read_only")]).reason).toContain(
      "只读档",
    );
  });
});
