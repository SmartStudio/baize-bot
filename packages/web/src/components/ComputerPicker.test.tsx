import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BotId, Computer, GroupId, type ComputerKind } from "@baize/shared";
import { ComputerPicker, hasChoice, pickerNotes } from "./ComputerPicker.js";

const computer = (kind: ComputerKind, reach: { status: Computer["status"]; dispatchable: boolean }) =>
  Computer.parse({
    id: `cmp_${kind}`,
    ownerId: "usr_1",
    kind,
    status: reach.status,
    host: null,
    idleSince: null,
    lastSeenAt: null,
    dispatchable: reach.dispatchable,
  });

const UP = { status: "online", dispatchable: true } as const;
const DOWN = { status: "sleeping", dispatchable: false } as const;
type Reach = typeof UP | typeof DOWN;
const both = (local: Reach = UP, remote: Reach = UP) => [computer("local", local), computer("remote", remote)];

const render = (computers: Computer[], choice: ComputerKind | null, runningOn: ComputerKind | null) => {
  const html = renderToStaticMarkup(
    <ComputerPicker
      groupId={GroupId.parse("grp_1")}
      botId={BotId.parse("bot_1")}
      computers={computers}
      choice={choice}
      runningOn={runningOn}
      onChoose={async () => undefined}
    />,
  );
  const text = (testId: string) => new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(html)?.[1];
  return { html, label: text("computer-picker-label"), offline: text("computer-picker-offline") };
};

describe("群头的电脑选择器画不画", () => {
  it("账号下只有一台电脑时什么都不画，单机用户的头部一个元素都不多", () => {
    expect(hasChoice([computer("local", UP)])).toBe(false);
    expect(hasChoice([computer("remote", UP)])).toBe(false);
    expect(render([computer("local", UP)], null, null).html).toBe("");
  });

  it("你的电脑和云电脑都在才画，按钮上写这个群里现在用哪台", () => {
    expect(hasChoice(both())).toBe(true);
    expect(render(both(), "remote", null).label).toBe("云电脑");
    expect(render(both(), "local", null).label).toBe("你的电脑");
  });

  it("没选过时按默认说：你的电脑能派就是它，派不过去才是云电脑", () => {
    expect(render(both(), null, null).label).toBe("默认：你的电脑");
    expect(render(both(DOWN, UP), null, null).label).toBe("默认：云电脑");
  });
});

describe("头部小字", () => {
  it("选了的那台派不过去就明说不会改派到另一台", () => {
    expect(pickerNotes(both(UP, DOWN), "remote", null)).toEqual({
      offline: "云电脑不在线，发消息不会改派到你的电脑",
      running: null,
    });
    expect(pickerNotes(both(DOWN, UP), "local", null).offline).toBe("你的电脑不在线，发消息不会改派到云电脑");
    expect(render(both(UP, DOWN), "remote", null).offline, "小字跟着按钮一起画在头部").toBe(
      "云电脑不在线，发消息不会改派到你的电脑",
    );
  });

  it("能不能派只看 dispatchable：库里写着在线但拒了 config 的那台照样算不在线", () => {
    const stuck = { status: "online", dispatchable: false } as const;
    expect(pickerNotes([computer("local", UP), computer("remote", stuck)], "remote", null).offline).toBe(
      "云电脑不在线，发消息不会改派到你的电脑",
    );
    const waking = { status: "sleeping", dispatchable: true } as const;
    expect(pickerNotes([computer("local", UP), computer("remote", waking)], "remote", null).offline).toBeNull();
  });

  it("这一轮还在原来那台上跑时说明下一条才换过去；跑在同一台或没在跑都不说", () => {
    expect(pickerNotes(both(), "remote", "local").running).toBe("这一轮还在你的电脑上跑完，下一条起用云电脑");
    expect(pickerNotes(both(), "local", "remote").running).toBe("这一轮还在云电脑上跑完，下一条起用你的电脑");
    expect(pickerNotes(both(), "remote", "remote").running).toBeNull();
    expect(pickerNotes(both(), "remote", null).running).toBeNull();
  });

  it("没选过就没有「下一条起用哪台」可说，两句都不出", () => {
    expect(pickerNotes(both(UP, UP), null, "remote")).toEqual({ offline: null, running: null });
    expect(pickerNotes(both(DOWN, DOWN), null, null)).toEqual({ offline: null, running: null });
  });
});
