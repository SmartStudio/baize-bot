import type { BotHue } from "@baize/shared";

type Size = "sm" | "md" | "lg";

// 原型里 小服 的头像是「服」：中文名取首段汉字的最后一个字，去掉「小」这类前缀。
export const initialOf = (name: string): string => {
  const cjk = /[一-鿿]+/.exec(name);
  if (cjk) return cjk[0].slice(-1);
  return [...name.trim()][0]?.toUpperCase() ?? "?";
};

export const BotAvatar = ({ name, hue, size = "md" }: { name: string; hue: BotHue; size?: Size }) => (
  <span className={`avatar avatar-${size}`} style={{ background: `var(--bot-${hue})` }} aria-hidden="true">
    {initialOf(name)}
  </span>
);
