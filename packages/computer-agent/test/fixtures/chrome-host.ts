// 代理进程的替身，只装助理 Chrome 守护，好让测试 SIGKILL 它。真代理要等收到登录才去要连接，而登录会抢用户的前台。
import { startAssistantChrome } from "../../src/chrome.js";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("缺 dataDir 参数");
const chrome = startAssistantChrome({ dataDir, log: (line) => process.stderr.write(`${line}\n`) });
const { product } = await (await chrome.connection()).send("Browser.getVersion");
process.stdout.write(`${JSON.stringify({ pid: chrome.pid(), product })}\n`);
process.on("SIGTERM", () => {
  void chrome.stop().finally(() => process.exit(0));
});
setInterval(() => {}, 1 << 30);
