import type { MenuItemConstructorOptions } from "electron";
import type { AgentState } from "./agent-state.js";

export type MenuDeps = {
  readonly packaged: boolean;
  readonly version: string;
  readonly openAtLogin: () => boolean;
  readonly setOpenAtLogin: (value: boolean) => void;
  readonly checkForUpdates: () => void;
  readonly openSettings: () => void;
  readonly agentStatus: AgentState["status"];
  readonly reconnect: () => void;
};

export function menuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const connectionLabels: Record<AgentState["status"], string> = {
    none: "这台 Mac 没有连上",
    starting: "这台 Mac 正在连接",
    online: "这台 Mac 已连接",
    stopping: "这台 Mac 正在停止连接",
  };
  const loginItem: MenuItemConstructorOptions[] = deps.packaged
    ? [
        {
          label: "开机时启动白泽",
          type: "checkbox",
          checked: deps.openAtLogin(),
          click: (item) => deps.setOpenAtLogin(item.checked),
        },
      ]
    : [];
  return [
    {
      label: "白泽",
      submenu: [
        { role: "about", label: "关于白泽" },
        { label: `版本 ${deps.version}`, enabled: false },
        { label: "检查更新…", click: deps.checkForUpdates },
        { type: "separator" },
        { label: connectionLabels[deps.agentStatus], enabled: false },
        { label: "在这台 Mac 上连接…", enabled: deps.agentStatus === "none", click: deps.reconnect },
        { label: "控制面设置…", click: deps.openSettings },
        ...loginItem,
        { type: "separator" },
        { role: "quit", label: "退出白泽" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}
