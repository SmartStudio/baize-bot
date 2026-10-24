export const OPEN_AT_LOGIN_GET = "baize:open-at-login:get";
export const OPEN_AT_LOGIN_SET = "baize:open-at-login:set";
export const OPEN_AT_LOGIN_CHANGED = "baize:open-at-login:changed";

export type OpenAtLogin = "on" | "off" | "unsupported";

export type DesktopBridge = {
  readonly openAtLogin: {
    readonly get: () => Promise<OpenAtLogin>;
    readonly set: (value: "on" | "off") => Promise<OpenAtLogin>;
    readonly subscribe: (listener: (value: OpenAtLogin) => void) => () => void;
  };
};
