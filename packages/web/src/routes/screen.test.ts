import { describe, expect, it } from "vitest";
import { GroupId } from "@baize/shared";
import { pathOf, screenOf, type Screen } from "./screen.js";

describe("screenOf", () => {
  it("六种入口和路径一一对应，来回转一遍不走样", () => {
    const screens: Screen[] = [
      { kind: "today" },
      { kind: "routines" },
      { kind: "team" },
      { kind: "group", groupId: GroupId.parse("grp_order") },
      { kind: "project", groupId: GroupId.parse("grp_order") },
      { kind: "table", groupId: GroupId.parse("grp_order") },
    ];
    for (const screen of screens) expect(screenOf(pathOf(screen))).toEqual(screen);
  });

  it("认不出的路径和不合法的群 id 都不算入口，交给主窗口回到今天", () => {
    expect(screenOf("/g/")).toBeNull();
    expect(screenOf("/g/a%2Fb")).toBeNull();
    expect(screenOf("/bots")).toBeNull();
    expect(screenOf("/g/grp_order/extra")).toBeNull();
    expect(screenOf("/p/")).toBeNull();
    expect(screenOf("/t/")).toBeNull();
    expect(screenOf("/g/%E0%A4%A"), "编码坏掉的群段不抛错，照样回到今天").toBeNull();
  });
});
