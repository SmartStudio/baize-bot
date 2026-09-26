import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { LoginPage } from "./routes/LoginPage.js";
import { MainWindow } from "./routes/MainWindow.js";
import { MenubarPage } from "./routes/MenubarPage.js";
import { RegisterPage } from "./routes/RegisterPage.js";
import { useApp } from "./state/app.js";

export const App = () => {
  const { state, actions } = useApp();
  const location = useLocation();
  const next = new URLSearchParams(location.search).get("next") === "/menubar" ? "/menubar" : "/";
  if (state.status === "loading") return <div className="splash" data-testid="splash" />;
  return (
    <Routes>
      <Route path="/login" element={state.status === "anonymous" ? <LoginPage /> : <Navigate to={next} replace />} />
      <Route path="/register" element={state.status === "anonymous" ? <RegisterPage /> : <Navigate to="/" replace />} />
      <Route
        path="/menubar"
        element={
          state.status === "ready" ? (
            <MenubarPage onSend={actions.sendMessage} onDecide={actions.decideApproval} />
          ) : (
            <Navigate to="/login?next=/menubar" replace />
          )
        }
      />
      {/* 主窗口的几个入口共用这一条路由，换入口时 MainWindow 不重挂，开着的浮层和今天的清单都留着。 */}
      <Route path="/*" element={state.status === "ready" ? <MainWindow /> : <Navigate to="/login" replace />} />
    </Routes>
  );
};
