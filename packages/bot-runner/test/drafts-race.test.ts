import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotId, GroupId, MessageId, RunId, type AgentToControl } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 在 imageOf 做完 realpath、还没 open 的那一刻把上级目录换成指向禁区的链接，复现核验者说的竞争窗口。
const swap = vi.hoisted(() => ({ target: "", run: (): void => {} }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (swap.target !== "" && String(args[0]) === swap.target) {
        swap.target = "";
        swap.run();
      }
      return actual.open(...args);
    },
  };
});

const { createDraftTools } = await import("../src/drafts.js");

const SECRET = "profile-cookie-secret-bytes";
let root = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "baize-drafts-race-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("配图读的时候上级目录被换成禁区链接", () => {
  it("打开后再核一次路径，发现被换就报错，禁区的字节不进 drafts 也不上行", async () => {
    const workDir = join(root, "work");
    const draftsDir = join(root, "drafts");
    const profile = join(root, "chrome-profile");
    mkdirSync(join(workDir, "pics"), { recursive: true });
    mkdirSync(draftsDir);
    mkdirSync(profile);
    writeFileSync(join(workDir, "pics", "a.png"), "ordinary-image-bytes");
    writeFileSync(join(profile, "a.png"), SECRET);

    const pics = join(workDir, "pics");
    swap.target = join(pics, "a.png");
    swap.run = () => {
      renameSync(pics, join(workDir, "pics-old"));
      symlinkSync(profile, pics);
    };

    const sent: AgentToControl[] = [];
    const tools = createDraftTools({
      activeRun: () => ({
        run: {
          runId: RunId.parse("run-1"),
          botId: BotId.parse("bot-1"),
          groupId: GroupId.parse("group-1"),
          messageId: MessageId.parse("message-1"),
        },
        task: null,
        members: [],
        handoffId: undefined,
        projects: [],
      }),
      accounts: () => [],
      images: { workDir, draftsDir, hidden: [profile] },
      send: (message) => sent.push(message),
    });
    const edit = tools.find((tool) => tool.name === "edit_draft");
    if (edit === undefined) throw new Error("没有 edit_draft");

    const error = await edit
      .execute(
        "call-1",
        {
          draftId: "draft-1",
          content: { kind: "post", title: "标题", text: "正文", images: [{ path: "pics/a.png" }] },
        },
        undefined,
        undefined,
        undefined as never,
      )
      .then(
        () => "（没有报错）",
        (reason: unknown) => String(reason),
      );

    expect(swap.target, "竞争窗口确实被触发了").toBe("");
    expect(error).toContain("被换掉");
    expect(sent, "改动没上行").toEqual([]);
    const copies = readdirSync(draftsDir).map((name) => readFileSync(join(draftsDir, name), "utf8"));
    expect(copies.join("\n"), "drafts 目录里没有禁区的字节").not.toContain(SECRET);
  });
});
