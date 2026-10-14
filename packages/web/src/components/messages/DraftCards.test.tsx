import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountId, BotId, Draft, DraftId, GroupId } from "@baize/shared";
import type { ContentBook } from "../../state/types.js";
import { DraftCard, type ContentActions } from "./DraftCards.js";

const draft = Draft.parse({
  id: DraftId.parse("draft-paused"),
  groupId: GroupId.parse("group-paused"),
  botId: BotId.parse("bot-paused"),
  planId: null,
  accountId: AccountId.parse("account-paused"),
  platform: "x",
  content: { kind: "post", title: "暂停中的草稿", text: "这条内容没有发出去。", images: [], github: null },
  scheduledAt: null,
  status: "failed",
  edits: [],
  failure: "paused",
  createdAt: "2026-10-10T10:00:00.000Z",
  decidedAt: "2026-10-10T10:05:00.000Z",
});

const content: ContentBook = {
  drafts: { [draft.id]: draft },
  plans: {},
  accounts: {},
  computers: {},
  publications: {},
  logins: {},
  stamps: {},
};

const actions: ContentActions = {
  decideDraft: vi.fn(() => Promise.resolve()),
  approvePlan: vi.fn(() => Promise.resolve()),
  returnPlan: vi.fn(() => Promise.resolve()),
  loginAccount: vi.fn(() => Promise.resolve()),
};

describe("DraftCard", () => {
  it("说明 Bot 暂停导致发布失败后要恢复后让 Bot 再起一稿", () => {
    const html = renderToStaticMarkup(
      <DraftCard draftId={draft.id} botName="小采" content={content} actions={actions} />,
    );

    expect(html).toContain("Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿");
    expect(html).not.toContain('data-testid="draft-approve"');
  });
});
