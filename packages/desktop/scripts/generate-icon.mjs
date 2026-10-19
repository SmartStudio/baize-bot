import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(root, "../..");
const assets = join(root, "assets");
const iconset = join(assets, "icon.iconset");
const require = createRequire(join(repo, "packages/web/package.json"));
const { chromium } = require("@playwright/test");

const variants = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const svg = await readFile(join(assets, "app-A.svg"), "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  const page = await browser.newPage();
  for (const [name, size] of variants) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.locator("svg").screenshot({ path: join(iconset, name), animations: "disabled" });
  }
} finally {
  await browser.close();
}

const { spawnSync } = await import("node:child_process");
const generated = spawnSync("iconutil", ["--convert", "icns", "--output", join(assets, "icon.icns"), iconset], {
  encoding: "utf8",
});
if (generated.status !== 0) {
  throw new Error(`iconutil 生成失败：${generated.stderr || generated.stdout}`);
}
console.log(`已生成 ${variants.length} 张 PNG 和 ${join(assets, "icon.icns")}`);
