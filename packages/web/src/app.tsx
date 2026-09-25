import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./routes/LoginPage.js";
import { MainWindow } from "./routes/MainWindow.js";
import { RegisterPage } from "./routes/RegisterPage.js";
import { useApp } from "./state/app.js";

export const App = () => {
  const { state } = useApp();
  if (state.status === "loading") return <div className="splash" data-testid="splash" />;
  return (
    <Routes>
      <Route path="/login" element={state.status === "anonymous" ? <LoginPage /> : <Navigate to="/" replace />} />
      <Route path="/register" element={state.status === "anonymous" ? <RegisterPage /> : <Navigate to="/" replace />} />
      <Route path="/" element={state.status === "ready" ? <MainWindow /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};
