import { BotTemplate } from "@baize/shared";

// D11：整包放在链接的 # 后面，不经服务器。导入方在自己的 App 里粘贴，Web 解出来再交给控制面。

const toBase64Url = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (payload: string): string => {
  const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export const shareLinkOf = (template: BotTemplate, origin: string): string =>
  `${origin}/share#${toBase64Url(JSON.stringify(template))}`;

// 链接是粘进 App 用的，不进地址栏，所以能放这么宽。分享端超了不出链接，导入端超了不解码。
export const SHARE_LINK_MAX = 131072;

export type LinkReading = { kind: "template"; template: BotTemplate } | { kind: "too_long" } | { kind: "unrecognized" };

// 整条链接或只有 # 后面那段都认。超长的不解码，免得一条粘错的大文本先在浏览器里 base64、JSON 走一遍。
export const templateFromLink = (link: string): LinkReading => {
  const trimmed = link.trim();
  if (trimmed.length > SHARE_LINK_MAX) return { kind: "too_long" };
  const payload = trimmed.slice(trimmed.indexOf("#") + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return { kind: "unrecognized" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(payload));
  } catch {
    return { kind: "unrecognized" };
  }
  const parsed = BotTemplate.safeParse(decoded);
  return parsed.success ? { kind: "template", template: parsed.data } : { kind: "unrecognized" };
};

export type ShareCounts = {
  botName: string;
  hasTags: boolean;
  skills: number;
  plugins: number;
  preferences: number;
  keptPrivate: number;
};

// 拼法照原型 shareModal：带什么随勾选变，不带的四样永远写明。
export const shareSummary = (counts: ShareCounts): string => {
  const parts = [
    counts.hasTags ? "名字、标签、描述" : "名字、描述",
    counts.skills > 0 ? `${counts.skills} 个技能` : null,
    counts.plugins > 0 ? `${counts.plugins} 个插件的配置` : null,
    counts.preferences > 0 ? `${counts.preferences} 条偏好` : null,
  ].filter((part) => part !== null);
  const kept = counts.keptPrivate > 0 ? `有 ${counts.keptPrivate} 条只和你的号有关，自动留下。` : "";
  return `对方拿到一个新的${counts.botName}，带着${parts.join("、")}。${kept}你的登录、对话、文件和项目不带。导入后两边各走各的，你以后改不会同步过去。`;
};
