// 电脑代理的替身：记下从 stdin 拿到的启动行和自己的环境变量名。第一次起来记完就退出，好让看护进程去重启它。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const record = process.argv[2];
if (record === undefined) throw new Error("缺记录文件参数");
const earlier = existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).length : 0;

const input = createInterface({ input: process.stdin });
input.once("line", (line) => {
  appendFileSync(record, `${JSON.stringify({ line, envKeys: Object.keys(process.env).toSorted() })}\n`);
  if (earlier === 0) process.exit(3);
});
setInterval(() => {}, 1 << 30);
