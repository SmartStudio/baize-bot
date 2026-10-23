import { connect } from "./db/client.js";
import {
  credentialsKey,
  databaseUrl,
  port,
  runtimeConfig,
  secureCookie,
  toolSecretKey,
  trustedProxyHops,
} from "./env.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { startServer, type RunningServer } from "./server.js";

/** 要短于编排器的宽限：docker 默认 10 秒后 SIGKILL。 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

let server: RunningServer | null = null;
let stopping = false;

function stop(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    console.error(`停机 ${SHUTDOWN_TIMEOUT_MS / 1000} 秒还没走完，强制退出`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  void (async () => {
    try {
      await server?.close();
    } catch (error) {
      console.error("停机出错", error);
      process.exit(1);
    }
    process.exit(exitCode);
  })();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) {
      console.error(`停机中又收到 ${signal}，强制退出`);
      process.exit(1);
    }
    console.log(`收到 ${signal}，开始停机`);
    stop(0);
  });
}
process.on("unhandledRejection", (reason) => {
  console.error("未处理的 Promise 拒绝，按停机流程退出", reason);
  stop(1);
});
process.on("uncaughtException", (error) => {
  console.error("未捕获的异常，按停机流程退出", error);
  stop(1);
});

try {
  // 钥匙先验：缺了直接拒绝启动，不去连库，也不占单实例锁。
  const keys = { toolSecretKey: toolSecretKey(), credentialsKey: credentialsKey() };
  await acquireInstanceLock(databaseUrl(), () => {
    console.error("持有单实例锁的库连接断了，别的实例可能已经拿走了锁，按停机流程退出");
    stop(1);
  });
  const { db } = connect(databaseUrl());
  server = await startServer({
    db,
    port: port(),
    secureCookie: secureCookie(),
    trustedProxyHops: trustedProxyHops(),
    config: runtimeConfig(),
    ...keys,
  });
} catch (error) {
  console.error("控制面没起来", error);
  process.exit(1);
}
console.log(`控制面在 http://localhost:${server.port}`);
