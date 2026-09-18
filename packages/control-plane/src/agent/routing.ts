import type { BotId } from "@baize/shared";

// 派活路由的两个纯函数。不碰数据库，群成员由调用方查好传进来。

export type RoutingMember = { readonly id: BotId; readonly name: string };

/**
 * 这条消息该派给谁。
 * mentions 是写入时按成员名解析出来的，这里照样按成员表过滤一遍：函数因此是全函数，
 * 上游哪条路径漏了校验都不会把活派到群外的 Bot。
 */
export function routeTargets(input: {
  readonly members: readonly RoutingMember[];
  readonly currentBotId: BotId | null;
  readonly mentions: readonly BotId[];
}): BotId[] {
  const [first] = input.members;
  if (first === undefined) return [];
  // 单 Bot 群只有一个去处，@ 了谁、上一句谁经手都改变不了它。
  if (input.members.length === 1) return [first.id];

  // 遍历成员留下被 @ 的：去重和「按成员顺序排」都是这一遍遍历的副产品，结果因此稳定可断言。
  const mentioned = new Set<string>(input.mentions);
  const targets = input.members.filter((member) => mentioned.has(member.id)).map((member) => member.id);
  if (targets.length > 0) return targets;

  const current = input.currentBotId;
  if (current === null) return [];
  return input.members.some((member) => member.id === current) ? [current] : [];
}

/** 正文里 @ 到的群成员。单 Bot 群不解析，@ 谁都派给那一个。 */
export function parseMentions(text: string, members: readonly RoutingMember[]): BotId[] {
  if (members.length < 2) return [];

  // 名字长的先试，「@小销售」因此不会先命中成员「小销」。排序键只有长度，规范保证稳定排序，等长时保持成员顺序。
  const byNameLength = members.toSorted((a, b) => b.name.length - a.name.length);
  const hit = new Set<string>();
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    for (const member of byNameLength) {
      // 按索引扫而不是拼正则：名字里带正则元字符（Bot 叫「小(销)」）时，转义这个问题在这里根本不存在。
      if (!text.startsWith(member.name, at + 1)) continue;
      // 名后必须断开，否则「@小销售」里的「小销」也算命中。空串 trim 还是空串，所以「到结尾」不用单独判。
      const after = text.slice(at + 1 + member.name.length, at + 2 + member.name.length);
      if (after.trim() !== "") continue;
      hit.add(member.id);
      break;
    }
  }
  return members.filter((member) => hit.has(member.id)).map((member) => member.id);
}
