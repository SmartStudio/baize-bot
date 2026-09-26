import { drizzle } from "drizzle-orm/postgres-js";
import type { Db, Sql } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export type QueryGate = {
  /** 匹配上的那条查询停在发出之前时兑现。 */
  readonly reached: Promise<void>;
  release(): void;
};

type Armed = { readonly pattern: RegExp; readonly hit: () => void; readonly open: Promise<void> };

/**
 * 在 postgres.js 这一层包一道屏障：`arm` 之后，SQL 文本匹配 pattern 的下一条查询停在发出之前，测试放行才发。
 * 事务里的查询一样拦，所以服务端怎么组织查询都不影响屏障落在哪条 SQL 上。
 */
export function gatedDb(sql: Sql): { readonly db: Db; arm(pattern: RegExp): QueryGate } {
  let armed: Armed | null = null;

  const wrap = (client: Sql): Sql =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === "unsafe") {
          return (query: string, ...rest: unknown[]) => {
            const run = () =>
              (target.unsafe as (q: string, ...r: unknown[]) => ReturnType<Sql["unsafe"]>)(query, ...rest);
            const gate = armed;
            if (gate === null || !gate.pattern.test(query)) return run();
            armed = null;
            gate.hit();
            // drizzle 拿到查询对象后当场决定要不要 .values()，放行时照它选的形状只发一次。
            let asValues = false;
            const held = gate.open.then(() => (asValues ? run().values() : run()));
            return Object.assign(held, {
              values: () => {
                asValues = true;
                return held;
              },
            });
          };
        }
        // drizzle 的嵌套事务走 tx.savepoint，回调里拿到的客户端也要包，否则嵌套层的查询绕过屏障。
        if (prop === "begin" || prop === "savepoint") {
          return (...args: unknown[]) => {
            const last = args.at(-1);
            if (typeof last !== "function") throw new Error(`${prop} 没有回调`);
            const body = last as (tx: Sql) => unknown;
            const open = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
            return open.call(target, ...args.slice(0, -1), (tx: Sql) => body(wrap(tx)));
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return {
    db: drizzle(wrap(sql), { schema }),
    arm: (pattern) => {
      let hit!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (hit = resolve));
      const open = new Promise<void>((resolve) => (release = resolve));
      armed = { pattern, hit, open };
      return { reached, release };
    },
  };
}
