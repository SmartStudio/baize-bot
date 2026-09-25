import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(root, "../..");
const require = createRequire(import.meta.url);
const webDist = join(repo, "packages/web/dist");
const external = ["@silvia-odwyer/photon-node", "bufferutil", "utf-8-validate"];

async function localizeFonts(webRoot) {
  const fonts = join(webRoot, "fonts");
  await rm(fonts, { recursive: true, force: true });
  await mkdir(fonts, { recursive: true });
  const definitions = [
    { packageName: "@fontsource/inter", css: ["400.css", "500.css", "600.css", "700.css"], directory: "inter" },
    {
      packageName: "@fontsource/noto-sans-sc",
      css: ["400.css", "500.css", "600.css", "700.css"],
      directory: "noto-sans-sc",
    },
    { packageName: "@fontsource-variable/geist-mono", css: ["wght.css"], directory: "geist-mono" },
  ];
  const styles = [];
  for (const definition of definitions) {
    const packageRoot = dirname(require.resolve(`${definition.packageName}/package.json`));
    await cp(join(packageRoot, "files"), join(fonts, definition.directory), { recursive: true });
    for (const cssFile of definition.css) {
      const source = await readFile(join(packageRoot, cssFile), "utf8");
      styles.push(source.replaceAll("./files/", `./${definition.directory}/`));
    }
  }
  await writeFile(join(fonts, "fonts.css"), `${styles.join("\n")}\n`);
  const assets = join(webRoot, "assets");
  const cssFile = (await readdir(assets)).find((name) => name.endsWith(".css"));
  if (cssFile === undefined) throw new Error("Web 构建没有 CSS");
  const cssPath = join(assets, cssFile);
  const css = await readFile(cssPath, "utf8");
  const next = css.replace(
    /@import["']https:\/\/fonts\.googleapis\.com\/css2[^"']+["'];?/u,
    '@import"../fonts/fonts.css";',
  );
  if (next === css) throw new Error("Web CSS 里的远程字体没有被替换");
  await writeFile(cssPath, next);
}

await rm(join(root, "dist/web"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
await readFile(join(webDist, "index.html")).catch(() => {
  throw new Error("没有 packages/web/dist，先构建 Web");
});
await cp(webDist, join(root, "dist/web"), { recursive: true });
await localizeFonts(join(root, "dist/web"));

await esbuild.build({
  entryPoints: [join(repo, "packages/computer-agent/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(root, "dist/agent.mjs"),
  target: "node22",
  external,
  banner: {
    js: 'import { createRequire as __baizeCreateRequire } from "node:module";\nconst require = __baizeCreateRequire(import.meta.url);\n',
  },
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [join(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(root, "dist/main.mjs"),
  target: "node22",
  external: ["electron"],
  banner: {
    js: 'import { createRequire as __baizeMainCreateRequire } from "node:module";\nconst require = __baizeMainCreateRequire(import.meta.url);\n',
  },
  logLevel: "info",
});
