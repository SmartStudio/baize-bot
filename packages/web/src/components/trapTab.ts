import type { KeyboardEvent } from "react";

const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), button:not([disabled])";

// 弹窗是 aria-modal，Tab 走到头要绕回来，不能落到背后的页面上。
// 忙着的按钮用 aria-disabled 而不是 disabled：真禁用会把它手上的焦点扔回 body，按键就不经过弹窗了。
// 焦点落在弹窗容器（tabIndex=-1）或别的不在集合里的地方时，Tab 进第一个，Shift+Tab 进最后一个。
export const trapTab = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  const at = focusable.indexOf(document.activeElement as HTMLElement);
  const edge = event.shiftKey ? first : last;
  if (at !== -1 && document.activeElement !== edge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
};
