import { connect } from "../db/client.js";
import { databaseUrl } from "../env.js";
import { seed } from "../seed.js";

const { db, sql } = connect(databaseUrl(), { max: 1 });
try {
  const result = await seed(db);
  const account = result.createdUser ? `建了开发账号 ${result.user.email}` : `开发账号 ${result.user.email} 已在`;
  const bots = result.createdBots.length === 0 ? "Bot 齐了，没有新建" : `新建 Bot ${result.createdBots.join("、")}`;
  console.log(`${account}，${bots}`);
} finally {
  await sql.end();
}
