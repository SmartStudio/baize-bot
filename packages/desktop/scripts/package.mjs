import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "dist/stage");
const out = join(root, "dist/pack");

await rm(stage, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await writeFile(
  join(stage, "package.json"),
  `${JSON.stringify({ name: "baize", productName: "白泽", version: "0.1.0", private: true, type: "module", main: "main.mjs" }, null, 2)}\n`,
);
await cp(join(root, "dist/main.mjs"), join(stage, "main.mjs"));
await cp(join(root, "dist/web"), join(stage, "web"), { recursive: true });

const apps = await packager({
  dir: stage,
  name: "Baize",
  platform: "darwin",
  arch: process.arch,
  electronVersion: "44.4.5",
  out,
  overwrite: true,
  asar: false,
  prune: true,
  extraResource: [join(root, "dist/agent.mjs")],
  quiet: false,
});
for (const directory of apps) {
  const signed = spawnSync("codesign", ["--force", "--deep", "--sign", "-", join(directory, "Baize.app")], {
    encoding: "utf8",
  });
  if (signed.status !== 0) throw new Error(`临时签名失败：${signed.stderr}`);
}
console.log(apps.join("\n"));
