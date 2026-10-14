import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(desktop, "scripts/release-feed.mjs");
const scratch = mkdtempSync(join(tmpdir(), "baize-release-feed-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const packageVersion = (JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { version: string }).version;

describe("release-feed.mjs", () => {
  it("生成 Squirrel.Mac 静态 JSON，版本取自 package.json", () => {
    const out = join(scratch, "releases.json");
    const url = "https://dl.example.com/Baize-darwin-arm64-9.9.9.zip";
    execFileSync("node", [script, url, "--notes=修了几个问题", `--out=${out}`], { encoding: "utf8" });

    const feed = JSON.parse(readFileSync(out, "utf8")) as {
      currentRelease: string;
      releases: { version: string; updateTo: Record<string, string> }[];
    };
    expect(feed.currentRelease).toBe(packageVersion);
    expect(feed.releases).toHaveLength(1);
    const release = feed.releases[0]!;
    expect(release.version).toBe(packageVersion);
    expect(release.updateTo).toMatchObject({
      version: packageVersion,
      name: packageVersion,
      notes: "修了几个问题",
      url,
    });
    expect(new Date(release.updateTo["pub_date"]!).toISOString()).toBe(release.updateTo["pub_date"]);
  });

  it("缺 URL 或 URL 不是 http(s) 时报错退出", () => {
    expect(() => execFileSync("node", [script], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", [script, "file:///x.zip"], { stdio: "pipe" })).toThrow();
  });
});
