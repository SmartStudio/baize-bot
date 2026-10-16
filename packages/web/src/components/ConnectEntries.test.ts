import { describe, expect, it } from "vitest";
import { Computer, type ComputerStatus } from "@baize/shared";
import { connectNote, connectTarget } from "./ConnectEntries.js";

const local = (status: ComputerStatus = "online") =>
  Computer.parse({
    id: "cmp_local",
    ownerId: "usr_1",
    kind: "local",
    status,
    host: null,
    idleSince: null,
    lastSeenAt: "2026-10-14T10:00:00.000Z",
    dispatchable: status === "online",
  });

const remote = (status: ComputerStatus = "online") =>
  Computer.parse({
    id: "cmp_remote",
    ownerId: "usr_1",
    kind: "remote",
    status,
    host: "remote.baize.dev",
    idleSince: null,
    lastSeenAt: "2026-10-14T10:00:00.000Z",
    dispatchable: status === "online",
  });

const options = (computers: Computer[]) => {
  const target = connectTarget(computers);
  if (target.kind !== "many") throw new Error(`该让人挑，实际是 ${target.kind}`);
  return target.choices.map(({ computer, blocked }) => [computer.id, blocked]);
};

describe("接入浏览器平台选哪台电脑", () => {
  it("只有一台远程电脑：直接用它，不用挑，也不要求有本机", () => {
    expect(connectTarget([remote()])).toEqual({ kind: "one", choice: { computer: remote(), blocked: null } });
  });

  it("本机和远程都在：让人挑，本机排第一，不管电脑表里谁先", () => {
    expect(options([remote(), local()])).toEqual([
      ["cmp_local", null],
      ["cmp_remote", null],
    ]);
  });

  it("不在线的那台照样列出来，灰着写原因", () => {
    expect(options([local(), remote("sleeping")])).toEqual([
      ["cmp_local", null],
      ["cmp_remote", "休眠中"],
    ]);
    expect(options([local("creating"), remote("failed")])).toEqual([
      ["cmp_local", "还在创建"],
      ["cmp_remote", "出错了"],
    ]);
  });

  it("只有一台而且不在线：不用挑，入口灰掉，旁边写哪台、为什么", () => {
    const target = connectTarget([remote("sleeping")]);
    expect(target).toEqual({ kind: "one", choice: { computer: remote("sleeping"), blocked: "休眠中" } });
    expect(connectNote(target)).toBe("远程电脑 remote.baize.dev 休眠中，开不了登录窗口");
  });

  it("本机不在线时名字和原因直接连着写；在线就不写话", () => {
    expect(connectNote(connectTarget([local("failed")]))).toBe("本机出错了，开不了登录窗口");
    expect(connectNote(connectTarget([local()]))).toBeNull();
    expect(connectNote(connectTarget([local(), remote("sleeping")])), "几台时原因写在各自的选项上").toBeNull();
  });

  it("一台电脑都没有：入口灰掉，让人先加一台，不提本机", () => {
    const target = connectTarget([]);
    expect(target).toEqual({ kind: "none" });
    expect(connectNote(target)).toBe("先在下面的「电脑」里加一台电脑，才能接入");
  });
});
