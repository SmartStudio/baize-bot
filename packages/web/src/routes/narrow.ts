import { useSyncExternalStore } from "react";

// @media 读不到 CSS 变量也读不到这里的常量，宽度断点只能定在这一处，样式表靠 is-narrow 跟它走，不写宽度 @media。
// 平板竖屏最宽 834，横屏最窄 1024，断点落在两者之间。
const NARROW_BELOW = 900;

let query: MediaQueryList | null = null;
const media = () => (query ??= window.matchMedia(`(width < ${NARROW_BELOW}px)`));

export const watchNarrow = (onChange: () => void) => {
  media().addEventListener("change", onChange);
  return () => media().removeEventListener("change", onChange);
};

export const useNarrow = () => useSyncExternalStore(watchNarrow, () => media().matches);
