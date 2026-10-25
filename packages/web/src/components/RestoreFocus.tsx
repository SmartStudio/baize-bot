import { useEffect, useState, type ReactNode } from "react";

// 包住一层浮层，整层收起时把焦点还给打开之前的地方。层里换了内容（快速切换换成快捷键表）不算收起：
// 记在各自组件里的话，后挂上的那个记下的是先前那个正要卸掉的框，关掉时焦点就落到 body。
// 在首次渲染时记下：autoFocus 在提交阶段就把焦点挪进框里，effect 里再读拿到的是框自己。
export const RestoreFocus = ({ children }: { children: ReactNode }) => {
  const [before] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    },
    [before],
  );
  return children;
};
