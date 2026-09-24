import { connect } from "../db/client.js";
import { databaseUrl } from "../env.js";
import { resetComputerToken } from "../repo/computers.js";
import { findUserByEmail } from "../repo/users.js";
import { DEV_EMAIL } from "../seed.js";

// 重置并打印电脑代理的 token。旧 token 立刻作废，正连着的电脑代理下一次重连会被拒。
const email = process.argv[2] ?? DEV_EMAIL;

const { db, sql } = connect(databaseUrl(), { max: 1 });
try {
  const user = await findUserByEmail(db, email);
  if (user === null) {
    console.error(`没有 ${email} 这个账号，先跑 seed`);
    process.exitCode = 1;
  } else {
    const reset = await resetComputerToken(db, user.id);
    if (reset === null) {
      console.error(`${email} 还没有电脑，登录一次或者跑 seed`);
      process.exitCode = 1;
    } else {
      console.log(`COMPUTER_ID=${reset.computerId}`);
      console.log(`AGENT_TOKEN=${reset.token}`);
    }
  }
} finally {
  await sql.end();
}
