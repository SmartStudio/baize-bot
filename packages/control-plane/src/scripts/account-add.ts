import { parseArgs } from "node:util";
import { AccountTier, Platform } from "@baize/shared";
import { addAccountWithToken, CredentialCrypto } from "../credentials.js";
import { connect } from "../db/client.js";
import { credentialsKey, databaseUrl } from "../env.js";
import { ensureComputer } from "../repo/computers.js";
import { findUserByEmail } from "../repo/users.js";

// 只给开发用：手里有一把令牌，想跳过授权页直接挂一个 GitHub、X 账号调发布器。令牌加密进 account_credentials，
// 没有 refresh 令牌，过期了控制面刷不了，只能再跑一次。用户连账号走账号页的 OAuth（/api/oauth/:platform/start）。
const USAGE =
  "用法：pnpm --filter @baize/control-plane account-add -- --owner <邮箱> --platform github|x --handle <名> --token <令牌> [--tier draft|confirm_publish|direct_publish|read_only]";
// 小红书走电脑上的浏览器登录，没有令牌可挂。
const API_PLATFORMS = Platform.extract(["github", "x"]);

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    owner: { type: "string" },
    platform: { type: "string" },
    handle: { type: "string" },
    token: { type: "string" },
    tier: { type: "string" },
  },
  strict: true,
});

const platform = API_PLATFORMS.safeParse(values.platform);
const tier = values.tier === undefined ? undefined : AccountTier.safeParse(values.tier);
if (
  values.owner === undefined ||
  !platform.success ||
  values.handle === undefined ||
  values.handle === "" ||
  values.token === undefined ||
  values.token === "" ||
  (tier !== undefined && !tier.success)
) {
  console.error(USAGE);
  process.exit(1);
}

// 钥匙不对先停，不留下一个没有令牌的账号。
const crypto = new CredentialCrypto(credentialsKey());
const { db, sql } = connect(databaseUrl(), { max: 1 });
try {
  const user = await findUserByEmail(db, values.owner);
  if (user === null) {
    console.error(`没有 ${values.owner} 这个账号，先注册或跑 seed`);
    process.exitCode = 1;
  } else {
    // 账号都挂在一台电脑上。走接口的账号发布不经过电脑，挂在本机那台上，没有就建一台。
    const { computer } = await ensureComputer(db, user.id, "local");
    const account = await addAccountWithToken(
      db,
      crypto,
      {
        ownerId: user.id,
        computerId: computer.id,
        platform: platform.data,
        handle: values.handle,
        ...(tier?.success === true ? { tier: tier.data } : {}),
      },
      values.token,
    );
    console.log(`ACCOUNT_ID=${account.id}`);
    console.log(`${account.platform} @${account.handle}，档位 ${account.tier}`);
  }
} finally {
  await sql.end();
}
