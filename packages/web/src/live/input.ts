import type { ComputerKind, LiveInput } from "@baize/shared";

// 浏览器事件换成画面输入。坐标用比例，换算成远端 CSS 像素是电脑的事：只有它手里有最新一帧的设备尺寸。

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

const TEXT_MAX = 2000;
// 滚轮按行、按页报的，折成像素再发：电脑那头只认像素。
const LINE_PX = 40;
const PAGE_PX = 800;
const WHEEL_MAX = 5000;
// 连点：上一下按下之后这么久之内、离得这么近，算同一串。系统设置读不到，取常见的默认值。
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;

type Ratio = { x: number; y: number };
type ClientPlatform = "mac" | "other";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const ratioIn = (event: MouseEvent, canvas: HTMLCanvasElement): Ratio => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
};

export const clientPlatform = (): ClientPlatform =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";

/** 用户这边的主修饰键（Mac 的 ⌘、其他系统的 Ctrl）映射成远端的：本机电脑就是 Mac，用 Meta；远程是 Linux，用 Ctrl。 */
export const primaryModifier = (target: ComputerKind): number => (target === "local" ? META : CTRL);

// 用户这边的主修饰键换成远端的，另一个照原样：Mac 上 ⌘C 到了 Linux 是 Ctrl+C，Windows 上 Ctrl+C 到了 Mac 是 ⌘C。
const modifiersOf = (
  event: Pick<MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  target: ComputerKind,
  client: ClientPlatform,
): number => {
  const primary = client === "mac" ? event.metaKey : event.ctrlKey;
  const secondary = client === "mac" ? event.ctrlKey : event.metaKey;
  return (
    (event.altKey ? ALT : 0) |
    (event.shiftKey ? SHIFT : 0) |
    (primary ? primaryModifier(target) : 0) |
    (secondary ? (client === "mac" ? CTRL : META) : 0)
  );
};

const BUTTONS = ["left", "middle", "right"] as const;

// move 时按住的是哪个键，从 buttons 位里读：1 左、2 右、4 中。
const heldButton = (buttons: number): "none" | "left" | "middle" | "right" =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

/**
 * clicks 是这一下在连点里排第几，down、up 才有。不传就读 event.detail：
 * Chrome 的 pointer 事件 detail 恒为 0，面板用 createClickCounter 自己数。
 */
export const pointerInput = (
  phase: "move" | "down" | "up",
  event: MouseEvent,
  canvas: HTMLCanvasElement,
  target: ComputerKind,
  clicks: number = event.detail,
  client: ClientPlatform = clientPlatform(),
): Extract<LiveInput, { kind: "mouse" }> => ({
  kind: "mouse",
  phase,
  ...ratioIn(event, canvas),
  button: phase === "move" ? heldButton(event.buttons) : (BUTTONS[event.button] ?? "left"),
  clicks: phase === "move" ? 0 : clamp(Math.trunc(clicks), 1, 3),
  modifiers: modifiersOf(event, target, client),
});

export const wheelInput = (
  event: WheelEvent,
  canvas: HTMLCanvasElement,
  target: ComputerKind,
  client: ClientPlatform = clientPlatform(),
): LiveInput => {
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
  return {
    kind: "wheel",
    ...ratioIn(event, canvas),
    dx: clamp(event.deltaX * scale, -WHEEL_MAX, WHEEL_MAX),
    dy: clamp(event.deltaY * scale, -WHEEL_MAX, WHEEL_MAX),
    modifiers: modifiersOf(event, target, client),
  };
};

// 这个键上屏的字：一个字符的键名就是它，回车上屏的是 \r；按着 Ctrl、⌘ 时是快捷键，不上屏。
const typed = (event: KeyboardEvent): string | null => {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === "Enter") return "\r";
  return [...event.key].length === 1 ? event.key : null;
};

/**
 * 输入法组字中（isComposing 或 keyCode 229）回 null，留给 compositionend 发 text。
 * 主修饰键加 V 也回 null：粘贴要贴的是用户这边的剪贴板，留给 paste 事件整段发 text。
 */
export const keyInput = (
  phase: "down" | "up",
  event: KeyboardEvent,
  target: ComputerKind,
  client: ClientPlatform = clientPlatform(),
): LiveInput | null => {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key.length === 0 || event.key.length > 32) return null;
  const primary = client === "mac" ? event.metaKey : event.ctrlKey;
  if (primary && event.code === "KeyV") return null;
  return {
    kind: "key",
    phase,
    key: event.key,
    code: event.code.slice(0, 32),
    keyCode: clamp(event.keyCode, 0, 255),
    text: phase === "down" ? typed(event) : null,
    modifiers: modifiersOf(event, target, client),
  };
};

/** 整段上屏的字按协议上限切开，不切开代理对。 */
export const textInputs = (text: string): LiveInput[] => {
  const chunks: LiveInput[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > TEXT_MAX) {
      chunks.push({ kind: "text", text: chunk });
      chunk = "";
    }
    chunk += char;
  }
  if (chunk.length > 0) chunks.push({ kind: "text", text: chunk });
  return chunks;
};

export interface MoveCoalescer {
  move(input: LiveInput): void;
  flush(): void;
}

/** move 合并到每个动画帧一条。按下、抬起、滚轮、按键发之前先 flush，先后不乱。 */
export const createMoveCoalescer = (
  send: (input: LiveInput) => void,
  schedule: (run: () => void) => void = (run) => void requestAnimationFrame(run),
): MoveCoalescer => {
  let pending: LiveInput | null = null;
  let scheduled = false;
  const flush = () => {
    const input = pending;
    pending = null;
    if (input !== null) send(input);
  };
  return {
    move(input) {
      pending = input;
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        flush();
      });
    },
    flush,
  };
};

/** 数连点：同一个键、离上一下够近够快，就是第二下、第三下。 */
export const createClickCounter = (
  now: () => number = () => performance.now(),
): ((event: Pick<MouseEvent, "button" | "clientX" | "clientY">) => number) => {
  let last: { at: number; x: number; y: number; button: number; count: number } | null = null;
  return (event) => {
    const at = now();
    const near =
      last !== null &&
      last.button === event.button &&
      at - last.at <= MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= MULTI_CLICK_PX;
    const count = near && last !== null ? (last.count % 3) + 1 : 1;
    last = { at, x: event.clientX, y: event.clientY, button: event.button, count };
    return count;
  };
};
