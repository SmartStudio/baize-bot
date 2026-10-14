import type { LiveInput } from "@baize/shared";

/** 最近一帧的 deviceWidth / deviceHeight，单位是 CSS 像素，也就是 Input.dispatch* 要的坐标系。 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface CdpCommand {
  readonly method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  readonly params: Record<string, unknown>;
}

const MOUSE_TYPE = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;
// CDP 的 buttons 位掩码和 button 名不是一回事：左 1、右 2、中 4。
const BUTTON_BIT = { none: 0, left: 1, right: 2, middle: 4 } as const;

const point = (ratio: { readonly x: number; readonly y: number }, viewport: Viewport) => ({
  x: Math.round(ratio.x * viewport.width),
  y: Math.round(ratio.y * viewport.height),
});

export function toCdpInput(input: LiveInput, viewport: Viewport): readonly CdpCommand[] {
  switch (input.kind) {
    case "mouse":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: MOUSE_TYPE[input.phase],
            ...point(input, viewport),
            button: input.button,
            // buttons 是「此刻按着哪些键」：松开那一下已经不含它。
            buttons: input.phase === "up" ? 0 : BUTTON_BIT[input.button],
            clickCount: input.clicks,
            modifiers: input.modifiers,
          },
        },
      ];
    case "wheel":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            ...point(input, viewport),
            deltaX: input.dx,
            deltaY: input.dy,
            modifiers: input.modifiers,
          },
        },
      ];
    case "key": {
      // 带字的按下发 keyDown 才会上屏；功能键和快捷键发 rawKeyDown，不然 Chrome 会把 key 名当字插进去。
      const type = input.phase === "up" ? "keyUp" : input.text === null ? "rawKeyDown" : "keyDown";
      const text =
        input.phase === "down" && input.text !== null ? { text: input.text, unmodifiedText: input.text } : {};
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type,
            key: input.key,
            code: input.code,
            windowsVirtualKeyCode: input.keyCode,
            nativeVirtualKeyCode: input.keyCode,
            modifiers: input.modifiers,
            ...text,
          },
        },
      ];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: input.text } }];
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}
