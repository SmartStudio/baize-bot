import type { Settings } from "@baize/shared";

const DARK = "(prefers-color-scheme: dark)";

// tokens/colors.css 的浅色是 :root 默认，深色靠 [data-theme="dark"]，所以浅色要把属性删掉而不是写 light。
const paint = (resolved: "light" | "dark") => {
  if (resolved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
};

export const applyTheme = (theme: Settings["theme"]): (() => void) => {
  if (theme !== "system") {
    paint(theme);
    return () => {};
  }
  const query = window.matchMedia(DARK);
  const sync = () => paint(query.matches ? "dark" : "light");
  sync();
  query.addEventListener("change", sync);
  return () => query.removeEventListener("change", sync);
};
