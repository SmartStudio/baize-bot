import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "../state/app.js";

export const LoginPage = () => {
  const { state, actions } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = state.status === "anonymous" ? state.login : { kind: "idle" as const };
  const error = login.kind === "failed" ? login.message : null;
  const busy = login.kind === "submitting";

  return (
    <main className="login" data-testid="login">
      <div className="login-form">
        <p className="wordmark">
          <span className="wordmark-badge" aria-hidden="true">
            白
          </span>
          白泽
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void actions.login(email.trim(), password);
          }}
        >
          <h1>欢迎回来</h1>
          <p className="lede">登录后继续处理你的 Bot 和任务。</p>
          <label className="field">
            <span>邮箱</span>
            <input
              data-testid="email-input"
              type="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              data-testid="password-input"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error ? (
            <p className="error" role="alert" data-testid="login-error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="primary-button" data-testid="login-submit" disabled={busy}>
            登录 <ArrowRight size={16} aria-hidden="true" />
          </button>
          <p className="fine">
            还没有账号？{" "}
            <Link to="/register" data-testid="register-link">
              注册
            </Link>
          </p>
        </form>
      </div>
      <aside className="login-aside">
        <h2>让个人助理在你的电脑上把事情做完</h2>
      </aside>
    </main>
  );
};
