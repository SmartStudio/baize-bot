import type { User } from "@baize/shared";
import type { Db } from "../../src/db/client.js";
import { createUser } from "../../src/repo/users.js";

export const PASSWORD = "baize-dev";

let counter = 0;

export async function makeUser(db: Db, name = "陈默"): Promise<User> {
  counter += 1;
  return createUser(db, {
    name,
    email: `user${counter}-${Date.now()}@baize.dev`,
    password: PASSWORD,
    teamName: "白泽",
  });
}
