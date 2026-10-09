import type { BotHue, ComputerId, User } from "@baize/shared";
import type { Db } from "./db/client.js";
import { createBot, ensureAssistant, listBots } from "./repo/bots.js";
import { ensureComputer } from "./repo/computers.js";
import { appendMessage } from "./repo/messages.js";
import { createUser, findUserByEmail } from "./repo/users.js";

export const DEV_EMAIL = "chen@baize.dev";
export const DEV_PASSWORD = "baize-dev";

const DEV_BOTS: readonly { name: string; tags: readonly string[]; hue: BotHue; firstMessage: string }[] = [
  { name: "小服", tags: ["客服"], hue: "coral", firstMessage: "帮我看看今天还有哪些工单没回。" },
  { name: "小销", tags: ["销售"], hue: "tangerine", firstMessage: "把这周新进来的线索整理成一张表。" },
  { name: "小采", tags: ["采购"], hue: "lime", firstMessage: "比一下这三家供应商的报价。" },
];

export type SeedResult = {
  readonly user: User;
  readonly createdUser: boolean;
  readonly createdBots: string[];
  readonly computerId: ComputerId;
  /** 只有这一次建出电脑时才拿得到 token 明文，已经有电脑时是 null。 */
  readonly computerToken: string | null;
};

/**
 * 按邮箱认账号、按名字认 Bot，只补缺的那部分。
 * 所以上一次跑到一半崩了，再跑一次会补齐，而不是看到账号在就整段跳过。
 */
export async function seed(db: Db): Promise<SeedResult> {
  const existing = await findUserByEmail(db, DEV_EMAIL);
  const user = existing ?? (await createUser(db, { name: "陈默", email: DEV_EMAIL, password: DEV_PASSWORD }));
  // 新建的账号在 createUser 里已经有了，这一次补的是主助理之前就 seed 过的开发库。
  await db.transaction((tx) => ensureAssistant(tx, user.id));

  const computer = await ensureComputer(db, user.id);

  const present = new Set((await listBots(db, user.id)).map((item) => item.bot.name));
  const createdBots: string[] = [];
  for (const spec of DEV_BOTS) {
    if (present.has(spec.name)) continue;
    const { bot, group } = await createBot(db, user.id, {
      name: spec.name,
      tags: spec.tags,
      hue: spec.hue,
      description: `${spec.tags.join("、")}方向的活先找我。`,
    });
    await appendMessage(db, group.id, { kind: "user", text: spec.firstMessage });
    createdBots.push(bot.name);
  }

  return {
    user,
    createdUser: existing === null,
    createdBots,
    computerId: computer.computer.id,
    computerToken: computer.token,
  };
}
