import postgres from "postgres";

const INSTANCE_LOCK = 0x627a6370;

export async function acquireInstanceLock(url: string, onLost: () => void): Promise<void> {
  let held = false;
  const sql = postgres(url, {
    max: 1,
    // postgres.js 默认 30 到 60 分钟轮换连接，会话级锁会跟着丢。
    max_lifetime: null,
    onclose: () => {
      if (held) onLost();
    },
  });
  const [row] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${INSTANCE_LOCK}) AS locked`;
  if (row?.locked !== true) {
    await sql.end();
    throw new Error("同一个库上已经有一个控制面在跑。控制面只能单实例运行，先停掉那一个再起");
  }
  held = true;
}
