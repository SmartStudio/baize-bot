import { useState } from "react";
import { ArrowRight, KeyRound } from "lucide-react";
import { useApp } from "../state/app.js";

type Step = { kind: "workspace" } | { kind: "credentials"; workspace: string };

export const LoginPage = () => {
  const { state, actions } = useApp();
  const [step, setStep] = useState<Step>({ kind: "workspace" });
  const [workspace, setWorkspace] = useState("acme");
  const [email, setEmail] = useState("chen@baize.dev");
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
        {step.kind === "workspace" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (workspace.trim()) setStep({ kind: "credentials", workspace: workspace.trim() });
            }}
          >
            <h1>欢迎回来</h1>
            <p className="lede">你的 Bot 一直在线。登录看看他们干了什么。</p>
            <label className="field">
              <span>企业域名 · Workspace</span>
              <input
                data-testid="workspace-input"
                value={workspace}
                autoFocus
                onChange={(e) => setWorkspace(e.target.value)}
              />
              <small>{workspace.trim() || "your-team"}.baize.app</small>
            </label>
            <button type="submit" className="primary-button" data-testid="workspace-continue">
              继续 <ArrowRight size={16} aria-hidden="true" />
            </button>
            <p className="or">或</p>
            <button type="button" className="ghost-button wide" disabled>
              <KeyRound size={16} aria-hidden="true" /> 使用 SSO 登录 · 后续
            </button>
            <p className="fine">登录即同意企业使用条款 · Bot 在你自己的电脑上干活，数据不用于训练</p>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void actions.login(email.trim(), password);
            }}
          >
            <p className="workspace-line">
              {step.workspace}.baize.app{" "}
              <button type="button" className="link-button" onClick={() => setStep({ kind: "workspace" })}>
                换企业
              </button>
            </p>
            <h1>登录 {step.workspace}</h1>
            <label className="field">
              <span>工作邮箱</span>
              <input data-testid="email-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                data-testid="password-input"
                type="password"
                autoFocus
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
            <p className="fine">账号由管理员开通，没有账号找你的团队负责人</p>
          </form>
        )}
      </div>
      <aside className="login-aside">
        <h2>能把真活交出去的数字同事</h2>
        <p>每个 Bot 在你的电脑上把活干完。要你点头的时候才来找你。</p>
      </aside>
    </main>
  );
};
