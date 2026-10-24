import { describe, expect, it } from "vitest";
import { matchItems, type SwitchItem } from "./switchItems.js";

const item = (kind: SwitchItem["kind"], name: string): SwitchItem => ({
  kind,
  key: `${kind}:${name}`,
  name,
  path: `/${kind}/${name}`,
  bot: null,
});

describe("matchItems", () => {
  const items = [
    item("project", "Globex X3 × 200 订单"),
    item("bot", "小服"),
    item("group", "Globex X3 × 200 订单"),
    item("bot", "小销"),
    item("bot", "主助理"),
  ];

  it("没输字时全列出来，按 Bot、群、项目分组", () => {
    expect(matchItems(items, "").map((found) => `${found.kind}:${found.name}`)).toEqual([
      "bot:小服",
      "bot:小销",
      "bot:主助理",
      "group:Globex X3 × 200 订单",
      "project:Globex X3 × 200 订单",
    ]);
  });

  it("只剩名字对得上的，大小写不论，字可以不挨着", () => {
    expect(matchItems(items, "小").map((found) => found.name)).toEqual(["小服", "小销"]);
    expect(matchItems(items, "globex 订单").map((found) => found.kind)).toEqual(["group", "project"]);
    expect(matchItems(items, "gx2").map((found) => found.kind)).toEqual(["group", "project"]);
    expect(matchItems(items, "助理").map((found) => found.name)).toEqual(["主助理"]);
    expect(matchItems(items, "小助")).toEqual([]);
  });

  it("同一组里打头的排在前面，连着的其次", () => {
    const bots = [item("bot", "老服务"), item("bot", "服务员"), item("bot", "客服务台")];
    expect(matchItems(bots, "服务").map((found) => found.name)).toEqual(["服务员", "老服务", "客服务台"]);
    expect(matchItems([item("bot", "服x务"), item("bot", "老服务")], "服务").map((found) => found.name)).toEqual([
      "老服务",
      "服x务",
    ]);
  });
});
