import { connect } from "../db/client.js";
import { databaseUrl } from "../env.js";
import { seed } from "../seed.js";

const { db, sql } = connect(databaseUrl(), { max: 1 });
try {
  const result = await seed(db);
  const account = result.createdUser ? `建了开发账号 ${result.user.email}` : `开发账号 ${result.user.email} 已在`;
  const bots = result.createdBots.length === 0 ? "Bot 齐了，没有新建" : `新建 Bot ${result.createdBots.join("、")}`;
  console.log(`${account}，${bots}`);
  console.log(`COMPUTER_ID=${result.computerId}`);
  // token 明文只在建电脑那一刻存在，库里存的是哈希，所以重跑 seed 打不出旧的。
  if (result.computerToken === null) {
    console.log("电脑已在，要一把新 token 就跑 pnpm --filter @baize/control-plane computer-token");
  } else {
    console.log(`AGENT_TOKEN=${result.computerToken}`);
  }
} finally {
  await sql.end();
}
