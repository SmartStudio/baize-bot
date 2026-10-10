import { useState, type FormEvent } from "react";
import { Download } from "lucide-react";
import type { User } from "@baize/shared";
import { exportDataUrl } from "../api/client.js";
import { useApp } from "../state/app.js";

type Deletion =
  | { status: "closed" }
  | { status: "confirming"; email: string; error: string | null }
  | { status: "deleting"; email: string };

// D14：导出 JSON 和删账号。对话保留期、收回分享链接不做。
export const PrivacyPage = ({ user }: { user: User }) => {
  const { actions } = useApp();
  const [deletion, setDeletion] = useState<Deletion>({ status: "closed" });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (deletion.status !== "confirming") return;
    const { email } = deletion;
    setDeletion({ status: "deleting", email });
    actions
      .deleteAccount(email.trim())
      .catch((cause: unknown) =>
        setDeletion({ status: "confirming", email, error: cause instanceof Error ? cause.message : "没删成，请重试" }),
      );
  };

  return (
    <div className="privacy-page" data-testid="privacy-page">
      <p className="tools-intro">你的东西，你能拿走，也能让它全忘掉。</p>
      <div className="row-card">
        <span>
          <b>导出全部数据</b>
          <small>
            项目、草稿、例行、每个 Bot 的资料、技能和记住的偏好、品牌手册，打成一个 JSON。不含任何登录凭据。
          </small>
        </span>
        <a className="ghost-button" href={exportDataUrl} download data-testid="privacy-export">
          <Download size={14} aria-hidden="true" />
          导出
        </a>
      </div>

      {deletion.status === "closed" ? (
        <div className="row-card">
          <span>
            <b>删除账号</b>
            <small>Bot、项目、对话、例行、授权一起删掉，连着的电脑会断开。删了找不回来。</small>
          </span>
          <button
            type="button"
            className="ghost-button"
            data-testid="privacy-delete"
            onClick={() => setDeletion({ status: "confirming", email: "", error: null })}
          >
            删除账号
          </button>
        </div>
      ) : (
        <form className="row-card privacy-delete-form" data-testid="privacy-delete-form" onSubmit={submit}>
          <label className="field">
            <span>输入你的邮箱 {user.email} 确认删除</span>
            <input
              type="email"
              autoComplete="off"
              data-testid="privacy-delete-email"
              value={deletion.email}
              disabled={deletion.status === "deleting"}
              onChange={(event) => setDeletion({ status: "confirming", email: event.target.value, error: null })}
            />
            {deletion.status === "confirming" && deletion.error !== null ? (
              <small className="error" role="alert" data-testid="privacy-delete-error">
                {deletion.error}
              </small>
            ) : null}
          </label>
          <span className="budget-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={deletion.status === "deleting"}
              onClick={() => setDeletion({ status: "closed" })}
            >
              取消
            </button>
            <button
              type="submit"
              className="primary-button is-danger"
              data-testid="privacy-delete-confirm"
              disabled={deletion.status === "deleting" || deletion.email.trim() !== user.email}
            >
              永久删除
            </button>
          </span>
        </form>
      )}
    </div>
  );
};
