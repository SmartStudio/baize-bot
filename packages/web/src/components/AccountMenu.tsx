import { useEffect, useRef } from "react";
import { Gauge, LifeBuoy, LogOut, Settings as SettingsIcon } from "lucide-react";
import type { User } from "@baize/shared";

type Props = { user: User; onOpenSettings: () => void; onLogout: () => void; onClose: () => void };

export const AccountMenu = ({ user, onOpenSettings, onLogout, onClose }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      // 账户按钮自己要能再按一下关掉菜单。不放过它的话 mousedown 先关、click 再开，菜单永远关不掉。
      if (event.target instanceof Element && event.target.closest("[data-testid=account-button]")) return;
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  return (
    <div className="account-menu" data-testid="account-menu" role="menu" ref={ref}>
      <div className="account-menu-head">
        <span className="avatar avatar-md avatar-user" aria-hidden="true">
          {[...user.name][0]}
        </span>
        <span>
          <b>{user.name}</b>
          <small>{user.email}</small>
        </span>
      </div>
      <button type="button" className="menu-row" role="menuitem">
        <Gauge size={16} aria-hidden="true" />
        本周花费
        <span className="menu-trail">¥38.2 / ¥200</span>
      </button>
      <button type="button" className="menu-row" role="menuitem">
        <LifeBuoy size={16} aria-hidden="true" />
        帮助
      </button>
      <button type="button" className="menu-row" role="menuitem" data-testid="open-settings" onClick={onOpenSettings}>
        <SettingsIcon size={16} aria-hidden="true" />
        设置
        <span className="menu-trail">⌘ ,</span>
      </button>
      <hr />
      <button type="button" className="menu-row" role="menuitem" data-testid="logout" onClick={onLogout}>
        <LogOut size={16} aria-hidden="true" />
        退出登录
      </button>
    </div>
  );
};
