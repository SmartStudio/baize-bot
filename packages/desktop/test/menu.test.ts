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
});
