import { describe, expect, it } from "vitest";
import { receiveServerPush } from "../src/push.js";

describe("控制面推送", () => {
  it("控制面的 notify 推送原样交给原生通知", () => {
    const notices: unknown[] = [];
    let refreshes = 0;
    const accepted = receiveServerPush(
      JSON.stringify({
        type: "notify",
        notice: { kind: "confirm", text: "批准小服发送邮件", groupId: "group-1", at: "2026-09-26T04:00:00.000Z" },
      }),
      {
        notify: (notice) => notices.push(notice),
        refreshPending: () => {
          refreshes += 1;
        },
      },
    );

    expect(accepted).toBe(true);
    expect(notices).toEqual([{ kind: "confirm", text: "批准小服发送邮件" }]);
    expect(refreshes).toBe(0);
  });

  it("审批推送只刷新等待确认数字，不发原生通知", () => {
    let notices = 0;
    let refreshes = 0;
    const accepted = receiveServerPush(
      JSON.stringify({
        type: "approval_updated",
        approval: {
          id: "approval-1",
          runId: "run-1",
          botId: "bot-1",
          groupId: "group-1",
          action: "shell",
          target: null,
          view: { kind: "bash", command: "pwd" },
          status: "pending",
          decidedAt: null,
          deadlineAt: null,
          grantId: null,
        },
      }),
      {
        notify: () => {
          notices += 1;
        },
        refreshPending: () => {
          refreshes += 1;
        },
      },
    );

    expect(accepted).toBe(true);
    expect(notices).toBe(0);
    expect(refreshes).toBe(1);
  });
});
