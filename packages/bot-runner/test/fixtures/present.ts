import type { PresentPage } from "../../src/live-port.js";

/** 不接屏的用例给 BrowserConfig 的占位：Bot 真调 browser_ask_user 会拿到「助理浏览器出了问题」。 */
export const NO_PRESENT: PresentPage = async () => ({ end: { kind: "broken" }, url: null });
