import type { ComputerId, UserId } from "@baize/shared";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.js";
import { findComputerByGatewayKey } from "../repo/computers.js";
import { bearerToken } from "./gateway.js";

export type HubEnv = { Variables: { ownerId: UserId; computerId: ComputerId } };

export function hubAuth(db: Db): MiddlewareHandler<HubEnv> {
  return async (c, next) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    c.set("ownerId", computer.ownerId);
    c.set("computerId", computer.id);
    await next();
  };
}
