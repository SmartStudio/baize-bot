import type { MenuItemConstructorOptions } from "electron";

export type MenuDeps = {
  readonly packaged: boolean;
  readonly version: string;
  readonly openAtLogin: () => boolean;
  readonly setOpenAtLogin: (value: boolean) => void;
  readonly checkForUpdates: () => void;
  readonly openSettings: () => void;
};

export function menuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
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
