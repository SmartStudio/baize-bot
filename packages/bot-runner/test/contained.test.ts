import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { containmentFor, provablyContained, type ContainedContext } from "../src/contained.js";

let root = "";
let ctx: ContainedContext = { workDir: "", sharedDir: "", forbidden: [] };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "baize-contained-"));
  const workDir = join(root, "data", "bot-1", "work");
  const sharedDir = join(root, "data", "shared");
  mkdirSync(join(workDir, "sub"), { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(workDir, "a.txt"), "a\n");
  writeFileSync(join(workDir, "b.txt"), "b\n");
  symlinkSync(join(root, "outside"), join(workDir, "out-link"));
  symlinkSync("loop", join(workDir, "loop"));
  ctx = { workDir, sharedDir, forbidden: [] };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const contained = (command: string): boolean => provablyContained(command, ctx).contained;

describe("containmentFor", () => {
  it.each([
    ["remote", "bwrap", "closed"],
    ["local", "bwrap", "none"],
    ["remote", "seatbelt", "none"],
    ["local", "seatbelt", "none"],
    ["remote", "none", "none"],
    ["local", "none", "none"],
  ] as const)("%s 电脑、%s 沙箱：%s", (kind, sandbox, level) => {
    expect(containmentFor(kind, sandbox)).toEqual({ level });
  });
});

describe("provablyContained", () => {
  it("不证明时给出首因，进决策日志", () => {
    const verdict = provablyContained("rm a.txt", ctx);
    expect(verdict.contained).toBe(false);
    expect(verdict.why).not.toBe("");
  });

  it.each([
    ["共享区里的绝对路径", (c: ContainedContext) => `cat ${join(c.sharedDir, "x.txt")}`],
    ["工作区里的绝对路径", (c: ContainedContext) => `wc -l ${join(c.workDir, "a.txt")}`],
    ["还不存在的工作区路径", () => "mkdir -p new/deeper && touch new/deeper/x"],
    ["两个文件比较", () => "diff a.txt b.txt"],
    ["引号里的字面量", () => "grep -n 'a b' a.txt"],
    ["反斜杠转义的字面量", () => "find . \\( -name x -o -name y \\) -print"],
    ["2>&1 和写 /dev/null", () => "ls -la 2>&1 > /dev/null"],
    ["从工作区文件读入", () => "sort < a.txt > sorted.txt"],
    ["解包放在最后一段", () => "ls && tar -xzf a.tgz"],
  ])("%s 认", (_label, command) => {
    expect(contained(command(ctx))).toBe(true);
  });

  it.each([
    ["带 .. 的路径，哪怕落回工作区", "cat sub/../a.txt"],
    ["工作区里指向外面的链接", "cat out-link/x"],
    ["成环的链接，不抛出去", "cat loop"],
    ["拷贝之后还有别的段", "cp -r sub copy && cat copy/x"],
    ["cd 不在链头", "ls && cd sub && ls"],
    ["cd 后接分号", "cd sub; ls"],
    ["cd 到外面", "cd /etc && cat passwd"],
    ["后台运行", "sleep 1 &"],
    ["here-doc", "cat <<EOF"],
    ["进程替换", "diff <(ls) a.txt"],
    ["前置赋值", "LC_ALL=C sort a.txt"],
    ["带路径的命令名", "/bin/ls"],
    ["换行", "ls\nrm a.txt"],
    ["引号没闭合", "grep 'a a.txt"],
    ["空命令", "  "],
    ["表里没有的命令", "make"],
    ["表里没有的选项", "ls --dereference"],
    ["find 跟随链接", "find -L ."],
    ["grep -R 跟随链接", "grep -R foo ."],
    ["grep -R 不带起点也跟随链接", "grep -R foo"],
    ["裸词是指向外面的链接", "cat out-link"],
    ["-- 之后的操作数是指向外面的链接", "cat -- out-link"],
    ["ln -s 指向外面", "ln -s /etc/passwd x && cat x"],
    ["git 的 --no-index 比较外面的文件", "git diff --no-index /etc/passwd a.txt"],
    ["git 的全局选项换仓库", "git --git-dir=/etc/.git log -p"],
    ["GIT_DIR 前缀换仓库", "GIT_DIR=/etc/.git git show HEAD:a.txt"],
    ["find -exec", "find . -exec cat {} +"],
    ["tar 删源文件", "tar --remove-files -czf out.tgz sub"],
    ["tar 在 c 模式下拿外面的文件", "tar -czf out.tgz -C /etc passwd"],
    ["zip 跟随链接", "zip -r out.zip sub"],
    ["zip -m 删源文件", "zip -m out.zip a.txt"],
    ["jq 读环境", "jq -n env"],
    ["jq 读外面的文件", "jq --rawfile x /etc/passwd -n ."],
    ["sed 的 r 读文件", "sed 'r /etc/passwd' a.txt"],
    ["sed -i 带后缀", "sed -i.bak s/a/b/ a.txt"],
    ["awk -f", "awk -f prog.awk a.txt"],
    ["awk 读 getline", "awk 'BEGIN{getline l < \"/etc/passwd\"}'"],
    ["chmod 设 setuid", "chmod u+s a.txt"],
    ["重定向到外面", "echo x >> /etc/x"],
    ["从外面读入", "wc -l < /etc/passwd"],
    ["dup 到文件", "ls >&out.txt"],
  ])("%s 不认", (_label, command) => {
    expect(contained(command)).toBe(false);
  });

  it.each([
    ["禁区落在工作区里", () => join(ctx.workDir, "chrome")],
    ["禁区落在共享区里", () => join(ctx.sharedDir, "chrome")],
    ["工作区落在禁区里", () => join(root, "data")],
  ])("%s时一律不认：递归命令和默认的当前目录都会碰到它", (_label, zone) => {
    const zoned = { ...ctx, forbidden: [zone()] };
    for (const command of ["cat chrome/x", "grep -rn token .", "ls -R", "cat a.txt"]) {
      expect(provablyContained(command, zoned).contained, command).toBe(false);
    }
  });

  it("禁区和工作区、共享区不相交时不影响判定", () => {
    expect(provablyContained("cat a.txt", { ...ctx, forbidden: [join(root, "outside")] }).contained).toBe(true);
  });

  describe("版本探测只认系统目录里的二进制", () => {
    it("PATH 里先找到系统目录的就认", () => {
      vi.stubEnv("PATH", "/usr/bin:/bin");
      expect(contained("ls --version")).toBe(true);
      expect(contained("bash --version")).toBe(true);
      expect(contained("ls -V")).toBe(true);
    });

    it("工作区里同名的程序排在 PATH 前面就不认", () => {
      const bin = join(ctx.workDir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "ls"), "#!/bin/sh\ncat /etc/passwd\n");
      chmodSync(join(bin, "ls"), 0o755);
      vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
      expect(contained("ls --version")).toBe(false);
    });

    it("PATH 里有相对目录就不认，那个目录跟着 cwd 走", () => {
      vi.stubEnv("PATH", "bin:/usr/bin:/bin");
      expect(contained("ls --version")).toBe(false);
    });

    it("删除和移动类命令连 --help 也不认", () => {
      vi.stubEnv("PATH", "/usr/bin:/bin");
      for (const command of ["rm --help", "mv --version", "ln --help", "rmdir --version"]) {
        expect(contained(command), command).toBe(false);
      }
    });

    it("PATH 里找不到的不认，多带参数的不认", () => {
      vi.stubEnv("PATH", "/usr/bin:/bin");
      expect(contained("definitely-not-a-binary --version")).toBe(false);
      expect(contained("bash --version -c id")).toBe(false);
    });
  });
});
