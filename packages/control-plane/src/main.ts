import { connect } from "./db/client.js";
import {
  credentialsKey,
  databaseUrl,
  logFormat,
  port,
  runtimeConfig,
  secureCookie,
  toolSecretKey,
  trustedProxyHops,
} from "./env.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { configureLog, log } from "./log.js";
import { startServer, type RunningServer } from "./server.js";

/** 要短于编排器的宽限：docker 默认 10 秒后 SIGKILL。 */
const SHUTDOWN_TIMEOUT_MS = 8_000;
/**
 * 同一次停机，同一个信号可能到两遍：tsx 父进程等子进程回报只等 30ms，等不到会再转发一次；
 * pnpm dev 下 Ctrl+C 既直接送到进程组，又经 dev.mjs、pnpm 一层层转发。
 */
const DUPLICATE_SIGNAL_MS = 1_000;

let server: RunningServer | null = null;
let stopping = false;

function stop(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    log.error(`停机 ${SHUTDOWN_TIMEOUT_MS / 1000} 秒还没走完，强制退出`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  void (async () => {
    try {
      await server?.close();
    } catch (error) {
      log.error("停机出错", { err: error });
      process.exit(1);
    }
    process.exit(exitCode);
  })();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  let receivedAt: number | undefined;
  process.on(signal, () => {
    const now = performance.now();
    if (receivedAt !== undefined && now - receivedAt < DUPLICATE_SIGNAL_MS) {
      log.info(`1 秒内又收到 ${signal}，当作同一次`);
      return;
    }
    receivedAt ??= now;
    if (stopping) {
      log.error(`停机中又收到 ${signal}，强制退出`);
      process.exit(1);
    }
    log.info(`收到 ${signal}，开始停机`);
    stop(0);
  });
}
process.on("unhandledRejection", (reason) => {
  log.error("未处理的 Promise 拒绝，按停机流程退出", { err: reason });
  stop(1);
});
process.on("uncaughtException", (error) => {
  log.error("未捕获的异常，按停机流程退出", { err: error });
  stop(1);
});

try {
  configureLog({ format: logFormat() });
  // 钥匙先验：缺了直接拒绝启动，不去连库，也不占单实例锁。
  const keys = { toolSecretKey: toolSecretKey(), credentialsKey: credentialsKey() };
  await acquireInstanceLock(databaseUrl(), () => {
    log.error("持有单实例锁的库连接断了，别的实例可能已经拿走了锁，按停机流程退出");
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
  log.error("控制面没起来", { err: error });
  process.exit(1);
}
log.info(`控制面在 http://localhost:${server.port}`);
