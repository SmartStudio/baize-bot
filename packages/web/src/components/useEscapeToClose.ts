import { useEffect } from "react";

export const useEscapeToClose = (onClose: (() => void) | null) =>
  useEffect(() => {
    if (onClose === null) return;
    // 弹窗里的下拉菜单先收 Esc 并 preventDefault，那一下只收菜单，不连弹窗一起关。
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
