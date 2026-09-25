import { AccountConfig, AccountId, Computer, ComputerId, UserId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { selectComputer, type ComputerCandidate } from "../src/agent/computer-selection.js";

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

  it("两台都离线时返回失败原因", () => {
    expect(selectComputer([], candidates("sleeping", "sleeping"))).toEqual({
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
});
