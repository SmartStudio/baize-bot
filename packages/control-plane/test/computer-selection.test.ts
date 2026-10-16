import { AccountConfig, AccountId, ComputerId, UserId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import type { ComputerAvailability, ComputerReach } from "../src/agent/computer-availability.js";
import {
  selectAvailable,
  selectComputer,
  selectionNotice,
  type ComputerCandidate,
} from "../src/agent/computer-selection.js";
import type { ComputerRecord } from "../src/repo/rows.js";

const ownerId = UserId.parse("user-selection");

const computer = (kind: "local" | "remote", status: "online" | "sleeping"): ComputerRecord => ({
  id: ComputerId.parse(`computer-${kind}`),
  ownerId,
  kind,
  status,
  host: null,
  idleSince: null,
  lastSeenAt: null,
});

const account = AccountConfig.parse({
  id: AccountId.parse("account-local"),
  platform: "xiaohongshu",
  handle: "白泽工厂日记",
  tier: "confirm_publish",
  login: "valid",
});

const candidates = (
  localStatus: "online" | "sleeping",
  remoteStatus: "online" | "sleeping",
  localAccounts = [] as readonly (typeof account)[],
): readonly ComputerCandidate[] => [
  { computer: computer("local", localStatus), accounts: localAccounts },
  { computer: computer("remote", remoteStatus), accounts: [] },
];

describe("选电脑", () => {
  it.each([
    ["本机和远程都在线时派本机", "online", "online", "local"],
    ["只有本机在线时派本机", "online", "sleeping", "local"],
    ["只有远程在线时派远程", "sleeping", "online", "remote"],
  ] as const)("%s", (_name, localStatus, remoteStatus, kind) => {
    const selected = selectComputer([], candidates(localStatus, remoteStatus));
    expect(selected.kind).toBe("selected");
    expect(selected.kind === "selected" ? selected.computer.kind : null).toBe(kind);
  });

  it("两台都离线时说电脑都不在线，看得出不止一台", () => {
    expect(selectComputer([], candidates("sleeping", "sleeping"))).toEqual({
      kind: "failed",
      reason: "all_computers_offline",
    });
  });

  it("只有一台且离线时照旧说电脑不在线", () => {
    expect(selectComputer([], [{ computer: computer("local", "sleeping"), accounts: [] }])).toEqual({
      kind: "failed",
      reason: "no_computer_online",
    });
  });

  it("碰本机账号的活在本机离线时记失败而不是派到远程", () => {
    expect(selectComputer([account], candidates("sleeping", "online", [account]))).toEqual({
      kind: "failed",
      reason: "required_computer_offline",
    });
  });

  it("碰远程账号的活本机在线也派远程，按账号选不按本机优先", () => {
    const selected = selectComputer(
      [account],
      [
        { computer: computer("local", "online"), accounts: [] },
        { computer: computer("remote", "online"), accounts: [account] },
      ],
    );
    expect(selected.kind === "selected" ? selected.computer.kind : selected).toBe("remote");
  });
});

describe("选不到电脑时群里那句话", () => {
  it.each([
    ["no_computer_online", "电脑不在线，这条没派出去，电脑回来后再说一次"],
    ["all_computers_offline", "你的电脑都不在线，这条没派出去，有一台回来后再说一次"],
    ["required_account_not_found", "要用的账号已经不在账号页里，这条没派出去，把账号挂上后再说一次"],
    ["accounts_on_multiple_computers", "要用的账号分在两台电脑上，这条没派出去，拆成两句，每句只碰一台电脑上的账号"],
    [
      "required_computer_offline",
      "要用的账号所在的那台电脑不在线，这条没派出去，也不会改派到另一台，那台回来后再说一次",
    ],
  ] as const)("%s", (reason, text) => {
    expect(selectionNotice(reason)).toBe(text);
  });
});

const picked = (selection: ReturnType<typeof selectAvailable>) =>
  selection.kind === "selected" ? selection.computer.kind : selection;

describe("按这个群里选的电脑挑", () => {
  const both = [computer("local", "sleeping"), computer("remote", "sleeping")];
  const reach = (local: ComputerReach, remote: ComputerReach): readonly ComputerAvailability[] =>
    both.map((one) => {
      const state = one.kind === "local" ? local : remote;
      return { id: one.id, kind: one.kind, reach: state, dispatchable: state === "online" || state === "grace" };
    });

  it.each([
    ["选了云电脑，本机也在线照样派云电脑", "online", "online", "remote", "remote"],
    ["选了云电脑，云电脑在断线宽限里也派它", "online", "grace", "remote", "remote"],
    ["选了你的电脑，云电脑在线也派本机", "online", "online", "local", "local"],
    ["没选过，两台都在线派本机", "online", "online", null, "local"],
    ["没选过，本机在宽限里而云电脑连着，先派连着的", "grace", "online", null, "remote"],
    ["没选过，只有本机在宽限里也派它", "grace", "offline", null, "local"],
  ] as const)("%s", (_name, local, remote, preference, kind) => {
    expect(picked(selectAvailable(both, reach(local, remote), preference))).toBe(kind);
  });

  it.each([
    ["选了云电脑而它不在线，不落到本机", "online", "offline", "remote", "chosen_remote_offline"],
    ["选了你的电脑而它不在线，不落到云电脑", "offline", "online", "local", "chosen_local_offline"],
    ["选了云电脑而它拒了 config，说版本对不上", "online", "rejected", "remote", "config_rejected"],
    ["没选过，两台都不在线", "offline", "offline", null, "all_computers_offline"],
    ["没选过，一台拒了 config 一台不在线，说版本对不上", "rejected", "offline", null, "config_rejected"],
  ] as const)("%s", (_name, local, remote, preference, reason) => {
    expect(selectAvailable(both, reach(local, remote), preference)).toEqual({ kind: "failed", reason });
  });

  it("选了云电脑而账号下没有云电脑，照样报云电脑不在线", () => {
    const local = computer("local", "online");
    const available: readonly ComputerAvailability[] = [
      { id: local.id, kind: "local", reach: "online", dispatchable: true },
    ];
    expect(selectAvailable([local], available, "remote")).toEqual({ kind: "failed", reason: "chosen_remote_offline" });
  });
});

describe("选了的电脑不在线时群里那句话", () => {
  it.each([
    [
      "chosen_remote_offline",
      "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，这条没派出去，也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑",
    ],
    [
      "chosen_local_offline",
      "这个 Bot 在这个群里选了用你的电脑，你的电脑现在不在线，这条没派出去，也不会改派到云电脑，电脑回来后再说一次，或在群顶部改用云电脑",
    ],
  ] as const)("%s", (reason, text) => {
    expect(selectionNotice(reason)).toBe(text);
  });

  it("换电脑后的接续派不出去，说的是那段活而不是「这条」", () => {
    expect(selectionNotice("chosen_remote_offline", { continuation: true })).toBe(
      "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，刚才换电脑后要接着做的活没派出去，也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑",
    );
  });
});
