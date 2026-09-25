import { ComputerKind } from "@baize/shared";
import { connect } from "../db/client.js";
import { databaseUrl } from "../env.js";
import { ensureComputer, resetComputerToken } from "../repo/computers.js";
import { findUserByEmail } from "../repo/users.js";
import { DEV_EMAIL } from "../seed.js";

// 创建或重置并打印指定 kind 的电脑 token。旧 token 立刻作废，正连着的电脑代理下一次重连会被拒。
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const first = args[0];
const parsedKind = ComputerKind.safeParse(first);
const kind = parsedKind.success ? parsedKind.data : "local";
const email = (parsedKind.success ? args[1] : first) ?? DEV_EMAIL;

const { db, sql } = connect(databaseUrl(), { max: 1 });
try {
  const user = await findUserByEmail(db, email);
  if (user === null) {
    console.error(`没有 ${email} 这个账号，先跑 seed`);
    process.exitCode = 1;
  } else {
    const ensured = await ensureComputer(db, user.id, kind);
    const reset =
      ensured.token === null
        ? await resetComputerToken(db, user.id, kind)
        : { computerId: ensured.computer.id, token: ensured.token };
    if (reset === null) {
      console.error(`${email} 的 ${kind} 电脑无法生成 token`);
      process.exitCode = 1;
    } else {
      console.log(`COMPUTER_ID=${reset.computerId}`);
      console.log(`AGENT_TOKEN=${reset.token}`);
    }
  }
} finally {
  await sql.end();
}
