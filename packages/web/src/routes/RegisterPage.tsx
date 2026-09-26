import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "../state/app.js";

export const RegisterPage = () => {
  const { state, actions } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const register = state.status === "anonymous" ? state.register : { kind: "idle" as const };
  const error = register.kind === "failed" ? register.message : null;
  const busy = register.kind === "submitting";

  return (
    <main className="login" data-testid="register">
      <div className="login-form">
        <p className="wordmark">
          <span className="wordmark-badge" aria-hidden="true">
            白
          </span>
          白泽
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void actions.register(email.trim(), password, name.trim());
          }}
        >
          <h1>创建账号</h1>
          <p className="lede">注册后直接进入白泽，开始配置你的个人助理。</p>
          <label className="field">
            <span>邮箱</span>
            <input
              data-testid="register-email"
              type="email"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              data-testid="register-password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>姓名</span>
            <input
              data-testid="register-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error ? (
            <p className="error" role="alert" data-testid="register-error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="primary-button" data-testid="register-submit" disabled={busy}>
            注册 <ArrowRight size={16} aria-hidden="true" />
          </button>
          <p className="fine">
            <Link
              to="/login"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              <ArrowLeft size={14} aria-hidden="true" /> 返回登录
            </Link>
          </p>
        </form>
      </div>
      <aside className="login-aside">
        <h2>从一个账号开始，组建你的个人助理队伍</h2>
      </aside>
    </main>
  );
};
