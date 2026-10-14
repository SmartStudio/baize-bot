import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { format } from "node:util";
import { expect, it, vi } from "vitest";
import type { AgentHandle } from "@baize/computer-agent";
import { AccountResponse, LoginAccountResponse, LoginAttemptId } from "@baize/shared";
import { FAKE_FRAME_JPEG, fakeChrome } from "../acceptance/fake-chrome.js";
import { cookieFor, pushUntil, startRemoteComputer, watchLive } from "../src/live.js";
import { startStack, type Stack } from "../src/stack.js";

// 用户在画面上打的字只过内存：送进页面之后，库、电脑的数据目录、两边的日志里都不能有它。
const SENTINEL = "BZ-SENTINEL-9f3a-密码";
// 逐键时每个键单独过一遍，ASCII 前缀也查：哪怕非 ASCII 的部分被转义了，前缀照样能认出来。
const NEEDLES = [SENTINEL, "BZ-SENTINEL-9f3a"];
const HANDLE = "白泽工厂日记";
const POLL = { timeout: 30_000 } as const;

const leaks = (text: string): boolean => NEEDLES.some((needle) => text.includes(needle));

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

it("远程电脑上走画面登录：哨兵密码逐键、整段各输一次，送进了页面，库、数据目录和两边日志里都没有", async () => {
  const consoleLines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(format(...args));
    });
  }
  // 电脑代理的状态行绕过 console 直接写 stdout，照样要扫。
  const streams = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
  const chrome = fakeChrome({ kind: "remote" });
  let stack: Stack | undefined;
  let agent: AgentHandle | undefined;
  let agentLog = "";
  try {
    // 模型上游连不上也无妨：这条用例不派活。
    stack = await startStack({
      upstreamBaseUrl: "http://127.0.0.1:9",
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
    });
    const remote = await startRemoteComputer(stack, {
      makeChrome: chrome.factory,
      log: (line) => {
        agentLog += `${line}\n`;
      },
    });
    agent = remote.agent;

    const { account } = AccountResponse.parse(
      await stack.post("/api/accounts", { platform: "xiaohongshu", computerId: remote.computerId }),
    );
    expect(account.computerId, "小红书账号挂在远程电脑上").toBe(remote.computerId);
    const attempt = LoginAttemptId.parse(randomUUID());
    LoginAccountResponse.parse(await stack.post(`/api/accounts/${account.id}/login`, { attempt }));
    const session = await pushUntil(stack, (push) =>
      push.type === "live_session" && push.session.purpose.kind === "login" && push.session.purpose.attempt === attempt
        ? push.session
        : undefined,
    );
    expect(session.computerId).toBe(remote.computerId);

    const viewer = await watchLive(stack.port, await cookieFor(stack.port), session.liveId);
    await expect.poll(() => viewer.frames().length, POLL).toBeGreaterThan(0);
    expect(Buffer.from(viewer.frames()[0] ?? []).equals(Buffer.from(FAKE_FRAME_JPEG)), "收到的是假 Chrome 那一帧").toBe(
      true,
    );

    for (const char of SENTINEL) {
      for (const phase of ["down", "up"] as const) {
        viewer.input({ kind: "key", phase, key: char, code: "", keyCode: 0, text: char, modifiers: 0 });
      }
    }
    viewer.input({ kind: "text", text: SENTINEL });
    await expect
      .poll(
        () =>
          chrome
            .inputs()
            .filter((call) => call.method === "Input.dispatchKeyEvent" && call.params.type === "keyDown")
            .map((call) => call.params.text)
            .join(""),
        POLL,
      )
      .toBe(SENTINEL);
    await expect
      .poll(
        () => chrome.inputs().flatMap((call) => (call.method === "Input.insertText" ? [call.params.text] : [])),
        POLL,
      )
      .toEqual([SENTINEL]);

    chrome.scan(HANDLE);
    const signedIn = await pushUntil(stack, (push) =>
      push.type === "account_updated" && push.account.id === account.id && push.account.login === "valid"
        ? push.account
        : undefined,
    );
    expect(signedIn.handle).toBe(HANDLE);
    viewer.close();
    await agent.stop();
    agent = undefined;

    const tables = await stack.sql<{ schema: string; name: string }[]>`
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`;
    expect(tables.length, "前提：扫到了全部的表").toBeGreaterThan(20);
    const rows: { table: string; text: string }[] = [];
    for (const { schema, name } of tables) {
      const found = await stack.sql.unsafe<{ text: string }[]>(
        `SELECT row_to_json(t)::text AS text FROM "${schema}"."${name}" t`,
      );
      for (const { text } of found) rows.push({ table: name, text });
    }
    expect(
      rows.some((row) => row.table === "accounts" && row.text.includes(HANDLE)),
      "前提：扫得到这次登上的账号",
    ).toBe(true);
    expect(
      rows.filter((row) => leaks(row.text)).map((row) => row.table),
      "库里没有哨兵",
    ).toEqual([]);

    const files = filesUnder(stack.dataDir);
    expect(
      files.some((file) => relative(stack!.dataDir, file).startsWith(join(".agent", "outbox"))),
      "前提：电脑的发件箱也在扫的范围里",
    ).toBe(true);
    const leakedFiles = files
      .filter((file) => leaks(readFileSync(file, "utf8")))
      .map((file) => relative(stack!.dataDir, file));
    expect(leakedFiles, "数据目录里没有哨兵").toEqual([]);

    expect(agentLog.length, "前提：电脑代理记了日志").toBeGreaterThan(0);
    expect(leaks(agentLog), "电脑代理的日志里没有哨兵").toBe(false);
    const written = streams.flatMap((spy) =>
      spy.mock.calls.map(([chunk]) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))),
    );
    expect(written.join(""), "前提：电脑代理的状态行也收到了").toContain('"online"');
    expect([...consoleLines, ...written].filter(leaks), "控制面、运行器打到控制台和标准输出的日志里没有哨兵").toEqual(
      [],
    );
  } finally {
    await agent?.stop();
    await stack?.close();
    vi.restoreAllMocks();
  }
});
