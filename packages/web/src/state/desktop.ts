import type { DesktopBridge } from "@baize/shared";

declare global {
  interface Window {
    baizeDesktop?: DesktopBridge;
  }
}

export const desktopBridge = (): DesktopBridge | null =>
  typeof window === "undefined" ? null : (window.baizeDesktop ?? null);
