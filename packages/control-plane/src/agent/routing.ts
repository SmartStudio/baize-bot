import type { BotId, SkillId } from "@baize/shared";

// 派活路由的几个纯函数。不碰数据库，群成员和 skill 由调用方查好传进来。

export type RoutingMember = { readonly id: BotId; readonly name: string };

export type RoutingSkill = { readonly id: SkillId; readonly name: string };

/**
 * 这条消息该派给谁。
 * mentions 是写入时按成员名解析出来的，这里照样按成员表过滤一遍：函数因此是全函数，
 * 上游哪条路径漏了校验都不会把活派到群外的 Bot。
 */
export function routeTargets(input: {
  readonly members: readonly RoutingMember[];
  readonly chiefBotId: BotId | null;
  readonly currentBotId: BotId | null;
  readonly mentions: readonly BotId[];
}): BotId[] {
  const [first] = input.members;
  if (first === undefined) return [];
  // 单 Bot 群只有一个去处，@ 了谁、上一句谁经手都改变不了它。
  if (input.members.length === 1) return [first.id];

  const memberIds = new Set(input.members.map((member) => member.id));
  const targets = [...new Set(input.mentions)].filter((id) => memberIds.has(id));
  if (targets.length > 0) return targets;

  if (input.chiefBotId !== null && memberIds.has(input.chiefBotId)) return [input.chiefBotId];
  const current = input.currentBotId;
  if (current !== null && memberIds.has(current)) return [current];
  return input.members.map((member) => member.id);
}

const EVERYONE = "所有人";

/** 正文里 @ 到的群成员。单 Bot 群不解析，@ 谁都派给那一个。 */
export function parseMentions(text: string, members: readonly RoutingMember[]): BotId[] {
  if (members.length < 2) return [];
  const hit = scanNames<BotId | typeof EVERYONE>(text, "@", [{ id: EVERYONE, name: EVERYONE }, ...members]);
  if (hit.has(EVERYONE)) return members.map((member) => member.id);
  return [...hit].filter((id): id is BotId => id !== EVERYONE);
}

/**
 * 正文里 `/名` 引到的 skill。
 *
 * 和 `parseMentions` 不同，这里没有「单 Bot 群不解析」那道短路：单 Bot 群里 `/名` 照样算，
 * 它引的是这个 Bot 会做的活，不是在群里点人。
 *
 * 同名的 skill 跨 Bot 可以重名，而每个 `/` 位置只认一条（`scanNames` 里的 break）：
 * Pi 按 name 去重，同名的第二条根本不会进系统提示，所以只给排在前面的那一条计数，
 * 和真正跑起来的那一条对得上。排在前面由调用方的查询顺序定。
 */
export function parseSkillRefs(text: string, skills: readonly RoutingSkill[]): SkillId[] {
  const hit = scanNames(text, "/", skills);
  return skills.filter((skill) => hit.has(skill.id)).map((skill) => skill.id);
}

type Named<Id extends string> = { readonly id: Id; readonly name: string };

/**
 * 正文里 `prefix` 后面跟着的那些名字，命中的 id 一份。
 * 名字长的先试，「@小销售」因此不会先命中成员「小销」。排序键只有长度，规范保证稳定排序，等长时保持传入顺序。
 * 一个 `prefix` 位置最多认一条，认上就不再往下试。
 */
function scanNames<Id extends string>(text: string, prefix: string, named: readonly Named<Id>[]): Set<Id> {
  const byNameLength = named.toSorted((a, b) => b.name.length - a.name.length);
  const hit = new Set<Id>();
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    const from = at + prefix.length;
    for (const one of byNameLength) {
      // 按索引扫而不是拼正则：名字里带正则元字符（Bot 叫「小(销)」、skill 叫「报价+」）时，
      // 转义这个问题在这里根本不存在。
      if (!text.startsWith(one.name, from)) continue;
      // 名后必须断开，否则「@小销售」里的「小销」也算命中。空串 trim 还是空串，所以「到结尾」不用单独判。
      const after = text.slice(from + one.name.length, from + one.name.length + 1);
      if (after.trim() !== "") continue;
      hit.add(one.id);
      break;
    }
  }
  return hit;
}
