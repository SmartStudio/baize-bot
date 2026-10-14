import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { menuTemplate, type MenuDeps } from "../src/menu.js";

function build(overrides: Partial<MenuDeps> = {}) {
  const deps: MenuDeps = {
    packaged: true,
    version: "0.1.0",
    openAtLogin: () => false,
    setOpenAtLogin: vi.fn(),
    checkForUpdates: vi.fn(),
    openSettings: vi.fn(),
    agentStatus: "none",
    reconnect: vi.fn(),
    ...overrides,
  };
  const submenu = menuTemplate(deps)[0]?.submenu as MenuItemConstructorOptions[];
  const item = (label: string) => submenu.find((entry) => entry.label === label);
  return { deps, item };
}

describe("应用菜单", () => {
  it("开机启动勾选项反映系统当前值，切换时写回 setLoginItemSettings", () => {
    const setOpenAtLogin = vi.fn();
    const { item } = build({ openAtLogin: () => true, setOpenAtLogin });
    const login = item("开机时启动白泽");
    expect(login?.type).toBe("checkbox");
    expect(login?.checked).toBe(true);

    login?.click?.({ checked: false } as never, undefined, {} as never);
    expect(setOpenAtLogin).toHaveBeenCalledWith(false);
    login?.click?.({ checked: true } as never, undefined, {} as never);
    expect(setOpenAtLogin).toHaveBeenLastCalledWith(true);
  });

  it("未打包的运行里没有开机启动项", () => {
    expect(build({ packaged: false }).item("开机时启动白泽")).toBeUndefined();
  });

  it("显示版本号，检查更新项触发手动检查", () => {
    const checkForUpdates = vi.fn();
    const { item } = build({ version: "1.2.3", checkForUpdates });
    expect(item("版本 1.2.3")?.enabled).toBe(false);
    item("检查更新…")?.click?.({} as never, undefined, {} as never);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "starting", "online", "stopping"] as const)("连接状态 %s 决定菜单提示和再次连接入口", (status) => {
    const reconnect = vi.fn();
    const labels = {
      none: "这台 Mac 没有连上",
      starting: "这台 Mac 正在连接",
      online: "这台 Mac 已连接",
      stopping: "这台 Mac 正在停止连接",
    };
    const { item } = build({ agentStatus: status, reconnect });
    expect(item(labels[status])?.enabled).toBe(false);
    expect(item("在这台 Mac 上连接…")?.enabled).toBe(status === "none");
    if (status === "none") {
      item("在这台 Mac 上连接…")?.click?.({} as never, undefined, {} as never);
      expect(reconnect).toHaveBeenCalledTimes(1);
    }
  });
});
