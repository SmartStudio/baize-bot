import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "dist/stage");
const out = join(root, "dist/pack");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(stage, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await writeFile(
  join(stage, "package.json"),
  `${JSON.stringify({ name: "baize", productName: "白泽", version, private: true, type: "module", main: "main.mjs" }, null, 2)}\n`,
);
await cp(join(root, "dist/main.mjs"), join(stage, "main.mjs"));
await cp(join(root, "dist/preload.cjs"), join(stage, "preload.cjs"));
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
  icon: join(root, "assets/icon.icns"),
  extraResource: [join(root, "dist/agent.mjs")],
  quiet: false,
});
const zips = [];
for (const directory of apps) {
  const signed = spawnSync("codesign", ["--force", "--deep", "--sign", "-", join(directory, "Baize.app")], {
    encoding: "utf8",
  });
  if (signed.status !== 0) throw new Error(`临时签名失败：${signed.stderr}`);
  const zip = join(out, `Baize-darwin-${process.arch}-${version}.zip`);
  const zipped = spawnSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", join(directory, "Baize.app"), zip],
    {
      encoding: "utf8",
    },
  );
  if (zipped.status !== 0) throw new Error(`打 zip 失败：${zipped.stderr}`);
  zips.push(zip);
}
console.log([...apps, ...zips].join("\n"));
