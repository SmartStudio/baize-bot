import { AccountConfig, AccountId, Computer, ComputerId, UserId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { selectComputer, selectionNotice, type ComputerCandidate } from "../src/agent/computer-selection.js";

const ownerId = UserId.parse("user-selection");

const computer = (kind: "local" | "remote", status: "online" | "sleeping") =>
  Computer.parse({
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
