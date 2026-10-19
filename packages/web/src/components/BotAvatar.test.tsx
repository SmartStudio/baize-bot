import { describe, expect, it } from "vitest";
import { BotShape } from "@baize/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { BotAvatar, resolveBotAvatarState, SHAPES } from "./BotAvatar.js";

describe("BotAvatar", () => {
  it("按八种形状表渲染对应轮廓和状态脸，并给确认状态加角标", () => {
    expect(Object.keys(SHAPES)).toEqual(BotShape.options);
    expect(Object.values(SHAPES).map(({ y, dx }) => [y, dx])).toEqual([
      [51, 0],
      [55, 0],
      [58, 0],
      [53, -2],
      [59, 0],
      [54, 0],
      [56, -1],
      [54, 0],
    ]);
    for (const shape of BotShape.options) {
      expect(SHAPES[shape].path).toMatch(/Z$/);
      expect(SHAPES[shape].y).toBeGreaterThan(0);
      expect(renderToStaticMarkup(<BotAvatar hue="coral" shape={shape} state="idle" />)).toContain(
        `data-shape="${shape}"`,
      );
    }
    const states = ["idle", "working", "confirm", "happy", "sleep"] as const;
    expect(
      new Set(states.map((state) => renderToStaticMarkup(<BotAvatar hue="coral" shape="pillow" state={state} />))).size,
    ).toBe(5);

    const confirm = renderToStaticMarkup(<BotAvatar hue="coral" shape="pillow" state="confirm" size="xs" />);
    expect(confirm).toContain('data-state="confirm"');
    expect(confirm).toContain('class="avatar-confirm"');
    expect(confirm).toContain('width="100%" height="100%"');
  });

  it("暂停优先于待审批，待审批优先于工作中", () => {
    expect(resolveBotAvatarState({ paused: true, pendingApproval: true, working: true })).toBe("sleep");
    expect(resolveBotAvatarState({ paused: false, pendingApproval: true, working: true })).toBe("confirm");
    expect(resolveBotAvatarState({ paused: false, pendingApproval: false, working: true })).toBe("working");
    expect(resolveBotAvatarState({ paused: false, pendingApproval: false, working: false })).toBe("idle");
  });
});
