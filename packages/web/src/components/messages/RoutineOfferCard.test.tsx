import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Message } from "@baize/shared";
import { RoutineOfferCard } from "./RoutineOfferCard.js";

vi.mock("../../state/app.js", () => ({ useApp: () => ({ state: { status: "loading" }, actions: {} }) }));

const offer = Message.parse({
  id: "message-1",
  groupId: "group-assistant",
  body: {
    kind: "routine_offer",
    botId: "bot-assistant",
    name: "白泽开源推广周报",
    instruction: "读上周的数据写周报",
    cron: "0 18 * * 5",
    executorBotId: "bot-assistant",
    boundary: "read_only",
    purpose: "plan",
    onToday: false,
    groupId: null,
    status: "offered",
    routineId: null,
  },
  createdAt: "2026-10-10T10:00:00.000Z",
  revision: 0,
  visibleTo: null,
});

describe("RoutineOfferCard", () => {
  it("说明文案不替用户编来由：卡总是用户开口之后才出的", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RoutineOfferCard message={offer} />
      </MemoryRouter>,
    );

    expect(html, "用户自己要的例行，不能说成主助理看他常这么做").not.toContain("常这么做");
    expect(html).toContain("点「加上」之后它到点自己跑");
    expect(html).toContain("每周五 18:00");
  });
});
