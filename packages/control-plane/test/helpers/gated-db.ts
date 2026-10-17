import { drizzle } from "drizzle-orm/postgres-js";
import type { Db, Sql } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export type QueryGate = {
  /** 匹配上的那条查询停住时兑现：before 是停在发出之前，after 是数据库已经跑完、结果还没交回调用方。 */
  readonly reached: Promise<void>;
  /** 那条查询在数据库里跑完（成功或失败）时兑现。 */
  readonly finished: Promise<void>;
  release(): void;
};

/**
 * before：查询停在发出之前。after：查询照常发出并跑完，结果停在交回调用方之前，钉「库里已经成了、回调晚到」。
 * fail：这一条不发出去，当场抛错，只这一次，release 不用调。
 */
export type HoldAt = "before" | "after" | "fail";

type Armed = {
  readonly pattern: RegExp;
  readonly param: string | undefined;
  readonly hold: HoldAt;
  readonly hit: () => void;
  readonly done: () => void;
  readonly open: Promise<void>;
};

/**
 * 在 postgres.js 这一层包一道屏障：`arm` 之后，SQL 文本匹配 pattern 的下一条查询停住，测试放行才往下走。
 * 事务里的查询一样拦，所以服务端怎么组织查询都不影响屏障落在哪条 SQL 上。
 * 给了 param 就还要参数里带着它：调度器一次扫描会碰库里所有例行，拦的得是这条例行的那一次。
 */
export function gatedDb(sql: Sql): {
  readonly db: Db;
  arm(pattern: RegExp, hold?: HoldAt, param?: string): QueryGate;
} {
  let armed: Armed | null = null;

  const wrap = (client: Sql): Sql =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === "unsafe") {
          return (query: string, ...rest: unknown[]) => {
            const run = () =>
              (target.unsafe as (q: string, ...r: unknown[]) => ReturnType<Sql["unsafe"]>)(query, ...rest);
            const gate = armed;
            if (gate === null || !gate.pattern.test(query) || !carries(rest[0], gate.param)) return run();
            armed = null;
            // drizzle 拿到查询对象后当场决定要不要 .values()，真正发出时照它选的形状只发一次。
            let asValues = false;
            const send = () => (asValues ? run().values() : run());
            let held: Promise<unknown>;
            if (gate.hold === "fail") {
              gate.hit();
              gate.done();
              held = Promise.reject(new Error("注入的查询故障"));
            } else if (gate.hold === "before") {
              gate.hit();
              held = gate.open.then(send);
              void held.then(gate.done, gate.done);
            } else {
              // 让 drizzle 先决定形状再发；跑完就算 reached，结果或错误都扣住，放行才交回调用方。
              const ran = Promise.resolve().then(send);
              void ran.then(gate.done, gate.done);
              void ran.then(gate.hit, gate.hit);
              held = ran.finally(() => gate.open);
            }
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
    arm: (pattern, hold = "before", param) => {
      let hit!: () => void;
      let done!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (hit = resolve));
      const finished = new Promise<void>((resolve) => (done = resolve));
      const open = new Promise<void>((resolve) => (release = resolve));
      armed = { pattern, param, hold, hit, done, open };
      return { reached, finished, release };
    },
  };
}

function carries(params: unknown, param: string | undefined): boolean {
  return param === undefined || (Array.isArray(params) && params.includes(param));
}
