import postgres from "postgres";

const INSTANCE_LOCK = 0x627a6370;

export async function acquireInstanceLock(url: string, onLost: () => void): Promise<void> {
  let held = false;
  const sql = postgres(url, {
    max: 1,
    // postgres.js 默认 30 到 60 分钟轮换连接，会话级锁会跟着丢。
    max_lifetime: null,
    // 0 是不关。不显式给就会取 PGIDLE_TIMEOUT 或 URL 的 ?idle_timeout=，持锁连接一直空闲，到点就被关。
    idle_timeout: 0,
    onclose: () => {
      if (held) onLost();
    },
  });
  const [row] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${INSTANCE_LOCK}) AS locked`;
  if (row?.locked !== true) {
    await sql.end();
    throw new Error(
      "同一个库上已经有一个控制面在跑。控制面只能单实例运行：先停掉那一个，或者在 .env 里把 DATABASE_URL 指到别的库（工作树里跑 pnpm db:own 建一个自己的）",
    );
  }
  held = true;
}
