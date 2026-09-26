// 远程电脑容器的主进程：node --import tsx src/supervise.ts <启动文件>
import { fileURLToPath } from "node:url";
import { supervise, type SupervisorHandle } from "./supervisor.js";

const launchFile = process.argv[2];
if (launchFile === undefined || launchFile === "") {
  console.error("用法：supervise.ts <启动文件>");
  process.exit(1);
}

let handle: SupervisorHandle | null = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (handle === null) process.exit(0);
    void handle.stop().finally(() => process.exit(0));
  });
}

try {
  handle = await supervise({
    launchFile,
    env: process.env,
    // 代理和看护进程用同一套 loader，tsx 起的就还用 tsx 起。
    agentCommand: [process.execPath, ...process.execArgv, fileURLToPath(new URL("main.ts", import.meta.url))],
  });
} catch (error) {
  console.error(`看护进程拒绝启动：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
