import { BotId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { parseMentions, routeTargets, type RoutingMember } from "../src/agent/routing.js";

function member(name: string): RoutingMember {
  return { id: BotId.parse(`bot-${name}`), name };
}

const sales = member("小销");
const buyer = member("小采");
const clerk = member("小服");
const outsider = member("群外的");

describe("派活目标", () => {
  it("多 Bot 群里只派给被 @ 的，没被 @ 又不是当前经手的不在目标里", () => {
    const targets = routeTargets({
      members: [sales, buyer, clerk],
      chiefBotId: null,
      currentBotId: null,
      mentions: [buyer.id],
    });
    expect(targets).toEqual([buyer.id]);
  });

  it("多 Bot 群没有 @ 时派给当前经手的", () => {
    const targets = routeTargets({ members: [sales, buyer], chiefBotId: null, currentBotId: sales.id, mentions: [] });
    expect(targets).toEqual([sales.id]);
  });

  it("多 Bot 群没有 @ 时首席优先于经手", () => {
    const targets = routeTargets({
      members: [sales, buyer],
      chiefBotId: buyer.id,
      currentBotId: sales.id,
      mentions: [],
    });
    expect(targets).toEqual([buyer.id]);
  });

  it("多 Bot 群没有 @、首席和当前经手时按成员顺序派全员", () => {
    expect(routeTargets({ members: [sales, buyer], chiefBotId: null, currentBotId: null, mentions: [] })).toEqual([
      sales.id,
      buyer.id,
    ]);
  });

  it("当前经手已不是群成员时退回全员", () => {
    const targets = routeTargets({
      members: [sales, buyer],
      chiefBotId: null,
      currentBotId: outsider.id,
      mentions: [],
    });
    expect(targets).toEqual([sales.id, buyer.id]);
  });

  it("单 Bot 群恒派给那一个，@ 了别人也一样", () => {
    expect(routeTargets({ members: [sales], chiefBotId: null, currentBotId: null, mentions: [] })).toEqual([sales.id]);
    expect(
      routeTargets({ members: [sales], chiefBotId: null, currentBotId: outsider.id, mentions: [outsider.id] }),
    ).toEqual([sales.id]);
  });

  it("成员为空时不派给任何人", () => {
    expect(routeTargets({ members: [], chiefBotId: null, currentBotId: sales.id, mentions: [sales.id] })).toEqual([]);
  });

  it("mentions 里混进非群成员时它被滤掉", () => {
    const targets = routeTargets({
      members: [sales, buyer],
      chiefBotId: null,
      currentBotId: null,
      mentions: [outsider.id, buyer.id],
    });
    expect(targets).toEqual([buyer.id]);
  });

  it("多个目标按 @ 首次出现的顺序排，并过滤群外目标", () => {
    const targets = routeTargets({
      members: [sales, buyer, clerk],
      chiefBotId: null,
      currentBotId: null,
      mentions: [clerk.id, outsider.id, buyer.id, clerk.id, sales.id],
    });
    expect(targets).toEqual([clerk.id, buyer.id, sales.id]);
  });

  it("交接还没确认时，不 @ 人的消息仍然派给交出去的那一个", () => {
    const targets = routeTargets({ members: [sales, buyer], chiefBotId: null, currentBotId: sales.id, mentions: [] });
    expect(targets, "确认之前当前经手没换人，小采只是收到了一份报文").toEqual([sales.id]);
  });

  it("交接确认之后，不 @ 人的消息只派给接手的那一个", () => {
    const targets = routeTargets({ members: [sales, buyer], chiefBotId: null, currentBotId: buyer.id, mentions: [] });
    expect(targets, "换完经手，群里的话不再落到小销身上").toEqual([buyer.id]);
  });

  it("同一个 Bot @ 多次只派一次", () => {
    const targets = routeTargets({
      members: [sales, buyer],
      chiefBotId: null,
      currentBotId: null,
      mentions: [buyer.id, buyer.id],
    });
    expect(targets).toEqual([buyer.id]);
  });
});

describe("解析正文里的 @", () => {
  it("@ 名字后跟空白算命中", () => {
    expect(parseMentions("@小销 查一下上季度的价", [sales, buyer])).toEqual([sales.id]);
  });

  it("@ 名字顶到结尾也算命中", () => {
    expect(parseMentions("这事交给 @小销", [sales, buyer])).toEqual([sales.id]);
  });

  it("长名字优先，「@小销售」不解析成「小销」", () => {
    const longer = member("小销售");
    expect(parseMentions("@小销售 来一下", [sales, longer])).toEqual([longer.id]);
  });

  it("名字后面粘着字就不算 @ 到它", () => {
    expect(parseMentions("@小销售 来一下", [sales, buyer])).toEqual([]);
  });

  it("同一个名字 @ 两次只出一次", () => {
    expect(parseMentions("@小销 和 @小销 一起看", [sales, buyer])).toEqual([sales.id]);
  });

  it("多个 @ 按正文首次出现的顺序去重", () => {
    expect(parseMentions("@小服 @小采 @小服 @小销 都来", [sales, buyer, clerk])).toEqual([
      clerk.id,
      buyer.id,
      sales.id,
    ]);
  });

  it("名字里带正则元字符照样解析得出来", () => {
    const parens = member("小(销)");
    expect(parseMentions("@小(销) 看一下", [parens, buyer])).toEqual([parens.id]);
    expect(parseMentions("@小x销y 看一下", [parens, buyer]), "元字符按字面匹配，不当通配符").toEqual([]);
  });

  it("单 Bot 群不解析 @", () => {
    expect(parseMentions("@小销 查一下", [sales])).toEqual([]);
  });

  it("正文里没有 @ 时返回空", () => {
    expect(parseMentions("小销 查一下", [sales, buyer])).toEqual([]);
  });

  it("@所有人 按成员表顺序派全员", () => {
    expect(parseMentions("@小服 @所有人 一起看", [sales, buyer, clerk])).toEqual([sales.id, buyer.id, clerk.id]);
  });
});
