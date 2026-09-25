import type { ComputerId, User, UserId } from "@baize/shared";
import type { Db } from "../../src/db/client.js";
import { ensureComputer } from "../../src/repo/computers.js";
import { createUser } from "../../src/repo/users.js";

export const PASSWORD = "baize-dev";

let counter = 0;

export async function makeUser(db: Db, name = "陈默"): Promise<User> {
  counter += 1;
  return createUser(db, {
    name,
    email: `user${counter}-${Date.now()}@baize.dev`,
    password: PASSWORD,
  });
}

export type TestComputer = { readonly computerId: ComputerId; readonly token: string };

/** token 明文只在建电脑那一刻拿得到，所以电脑要在这个用户第一次登录之前建。 */
export async function makeComputer(db: Db, ownerId: UserId): Promise<TestComputer> {
  const { computer, token } = await ensureComputer(db, ownerId);
  if (token === null) throw new Error("这个用户已经有电脑了，拿不到 token 明文");
  return { computerId: computer.id, token };
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等${what}超时`);
}
