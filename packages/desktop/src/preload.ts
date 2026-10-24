import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  OPEN_AT_LOGIN_CHANGED,
  OPEN_AT_LOGIN_GET,
  OPEN_AT_LOGIN_SET,
  type DesktopBridge,
  type OpenAtLogin,
} from "@baize/shared/desktop-bridge";

const bridge: DesktopBridge = {
  openAtLogin: {
    get: () => ipcRenderer.invoke(OPEN_AT_LOGIN_GET),
    set: (value) => ipcRenderer.invoke(OPEN_AT_LOGIN_SET, value),
    subscribe: (listener) => {
      const forward = (_event: IpcRendererEvent, value: OpenAtLogin) => listener(value);
      ipcRenderer.on(OPEN_AT_LOGIN_CHANGED, forward);
      return () => ipcRenderer.off(OPEN_AT_LOGIN_CHANGED, forward);
    },
  },
};

contextBridge.exposeInMainWorld("baizeDesktop", bridge);
