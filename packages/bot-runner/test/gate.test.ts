import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputerId,
  GrantId,
  GroupId,
  type AccountConfig,
  type ActionKind,
  type Grant,
  type GrantTarget,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, verdictFor, type GateCall, type GateContext } from "../src/gate.js";

const computerId = ComputerId.parse("computer-1");
const groupId = GroupId.parse("group-1");
let root = "";
let workDir = "";
let outsideDir = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "baize-gate-"));
  workDir = join(root, "bot-1", "work");
  outsideDir = join(root, "outside");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outsideDir);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const pathTarget = (prefix: string): GrantTarget => ({ kind: "path", computerId, prefix });
const domainTarget = (domain: string): GrantTarget => ({ kind: "domain", domain });

const gateContext = (overrides: Partial<GateContext> = {}): GateContext => ({
  workDir,
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

  it("darwin 禁区比较忽略大小写", () => {
    const target = pathTarget(join(root, "CHROME-PROFILE", "Default", "Cookies"));
    expect(actionVerdict("read", target, [grant("read", target, "forever")])).toBe("deny");
  });

  it("工作目录外写的目标覆盖禁区祖先时直接拒绝", () => {
    const target = pathTarget(root);
    expect(actionVerdict("write_outside", target, [grant("write_outside", target)])).toBe("deny");
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

describe("bash 分类", () => {
  const bashCall = (command: string): GateCall => ({
    toolName: "bash",
    input: { command },
    workDir,
    groupId,
    computerId,
    platform: "darwin",
    mcpOperation: null,
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

  it("Linux 上 bash 一律问", () => {
    expect(decide({ ...bashCall("echo ok"), platform: "linux" }, [], [])).toMatchObject({
      verdict: "ask",
      action: "shell",
    });
  });
});
