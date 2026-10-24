import { clientPlatform } from "../live/input.js";

export type Shortcut = "switch" | "shortcuts";

type ClientPlatform = ReturnType<typeof clientPlatform>;

type KeyPress = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "defaultPrevented"
>;

// 「/」在部分键盘布局上要按 Shift 才打得出，所以不看 Shift。K 以 key 为准，只在俄文这类布局下 key 不是拉丁字母时才认物理键位。
export const shortcutOf = (event: KeyPress, client: ClientPlatform = clientPlatform()): Shortcut | null => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  const primary = client === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey) return null;
  if (!event.shiftKey && (event.key.toLowerCase() === "k" || (event.code === "KeyK" && !/^[a-z]$/i.test(event.key))))
    return "switch";
  if (event.key === "/" || event.code === "Slash") return "shortcuts";
  return null;
};

export const modLabel = (client: ClientPlatform = clientPlatform()): string => (client === "mac" ? "⌘" : "Ctrl");

export type ShortcutRow = { keys: readonly string[]; what: string };
export type ShortcutSection = { title: string; rows: readonly ShortcutRow[] };

export const shortcutSections = (client: ClientPlatform = clientPlatform()): ShortcutSection[] => {
  const mod = modLabel(client);
  return [
    {
      title: "哪里都能用",
      rows: [
        { keys: [mod, "K"], what: "快速切换 Bot、群、项目" },
        { keys: [mod, "/"], what: "看快捷键" },
        { keys: ["Esc"], what: "关掉最上面一层：弹窗、检查器、抽屉" },
      ],
    },
    {
      title: "快速切换里",
      rows: [
        { keys: ["↑", "↓"], what: "上下挑" },
        { keys: ["Enter"], what: "跳过去" },
        { keys: ["Esc"], what: "关掉，后面开着的不动" },
      ],
    },
    {
      title: "发消息的框里",
      rows: [
        { keys: ["Enter"], what: "发出去" },
        { keys: ["Shift", "Enter"], what: "换行" },
        { keys: ["Esc"], what: "收起 @ 和技能的候选" },
      ],
    },
    {
      title: "画面接管和终端",
      rows: [
        { keys: ["任意键"], what: `直接发到电脑上，这时 ${mod} K、${mod} / 不在这边打开` },
        { keys: [mod, "V"], what: "贴的是你这边剪贴板里的字" },
        { keys: [mod, "…"], what: "画面接管里，到云电脑上是 Ctrl，到 Mac 上是 ⌘" },
      ],
    },
  ];
};
