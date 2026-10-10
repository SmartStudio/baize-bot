import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, type AppActions } from "../../src/state/app.js";

export type ProviderProbe = { status: () => string; actions: () => AppActions | null; unmount: () => void };

// 整个应用卸不掉：用例要的是 AppProvider 自己被 React 真卸载，所以页面上只挂它和一个读状态的探针。
export const mountProvider = (): ProviderProbe => {
  const latest: { status: string; actions: AppActions | null } = { status: "loading", actions: null };
  const Probe = () => {
    const { state, actions } = useApp();
    useEffect(() => {
      latest.status = state.status;
      latest.actions = actions;
    });
    return null;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  );
  return { status: () => latest.status, actions: () => latest.actions, unmount: () => root.unmount() };
};
