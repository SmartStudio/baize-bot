import { describe, expect, it } from "vitest";
import { Computer } from "@baize/shared";
import { beforeChinese, computerName } from "./content.js";

const computer = (kind: Computer["kind"], host: string | null) =>
  Computer.parse({
    id: `cmp_${kind}`,
    ownerId: "usr_1",
    kind,
    status: "online",
    host,
    idleSince: null,
    lastSeenAt: "2026-10-14T10:00:00.000Z",
    dispatchable: true,
  });

describe("电脑名后面接汉字", () => {
  it("本机不带主机名，以汉字结尾，不加空格", () => {
    expect(beforeChinese(computerName(computer("local", "mac-mini")))).toBe("本机");
  });

  it("没有主机名的远程电脑以汉字结尾，不加空格", () => {
    expect(beforeChinese(computerName(computer("remote", null)))).toBe("远程电脑");
  });

  it("主机名以字母或数字结尾，后面隔一个空格", () => {
    expect(beforeChinese(computerName(computer("remote", "mac-mini")))).toBe("远程电脑 mac-mini ");
    expect(beforeChinese(computerName(computer("remote", "remote.baize.dev")))).toBe("远程电脑 remote.baize.dev ");
    expect(beforeChinese(computerName(computer("remote", "node-2")))).toBe("远程电脑 node-2 ");
  });

  it("名字以汉字结尾，不加空格", () => {
    expect(beforeChinese(computerName(computer("remote", "办公室")))).toBe("远程电脑 办公室");
    expect(beforeChinese("账号所在的电脑")).toBe("账号所在的电脑");
  });
});
