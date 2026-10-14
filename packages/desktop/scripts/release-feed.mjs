import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = "用法：node scripts/release-feed.mjs <zip 的公开 URL> [--notes=说明] [--out=releases.json 的路径]";

const flag = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (url === undefined) throw new Error(USAGE);
const parsed = new URL(url);
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("zip 的公开 URL 必须是 http 或 https");

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const updateTo = {
  version,
  pub_date: new Date().toISOString(),
  notes: flag("notes") ?? `白泽 ${version}`,
  name: version,
  url: parsed.toString(),
};
const feed = { currentRelease: version, releases: [{ version, updateTo }] };

const out = resolve(flag("out") ?? join(root, "dist/pack/releases.json"));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(feed, null, 2)}\n`);
console.log(out);
