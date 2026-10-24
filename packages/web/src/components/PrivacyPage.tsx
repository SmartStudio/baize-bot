import { useState, type FormEvent } from "react";
import { Download } from "lucide-react";
import type { User } from "@baize/shared";
import { exportDataUrl } from "../api/client.js";
import { useApp } from "../state/app.js";

type Deletion =
  | { status: "closed" }
  | { status: "confirming"; email: string; error: string | null }
  | { status: "deleting"; email: string };

const STORAGE: ReadonlyArray<{ readonly what: string; readonly where: string; readonly keep: string }> = [
  {
    what: "对话和工作记录",
    where: "控制面数据库。工作记录上传前，截图换成一行占位，超过 16 KB 的输出只留头尾各 2 KB。",
    keep: "不自动清理。删 Bot 时它自己那个群的对话和它的工作记录一起删；解散的群只是收起来，对话还在。",
  },
  {
    what: "会话文件",
    where: "干活那台电脑的数据目录，每个 Bot 一个文件夹，sessions 里按群存原样的会话，截图原图和完整输出都在。",
    keep: "不自动清理。删 Bot 时电脑在线，就把这个 Bot 的文件夹整个删掉。",
  },
  {
    what: "记忆和偏好",
    where: "控制面数据库，每个 Bot 一份，随配置发到电脑上。",
    keep: "不自动清理。可以在 Bot 页一条条删，删 Bot 时一起删。",
  },
  {
    what: "skill",
    where: "控制面数据库是正本，电脑上 Bot 文件夹的 skills 里有一份副本。",
    keep: "不自动清理。删掉一个 skill 或删 Bot，电脑在线时副本跟着删。",
  },
  {
    what: "浏览器登录态",
    where: "电脑数据目录里的 chrome-profile，这台电脑上的 Bot 共用。",
    keep: "不自动清理，删 Bot、删账号都不动它。",
  },
  {
    what: "图片、草稿和品牌手册",
    where: "控制面数据库。起草用到的配图在 Bot 文件夹的 drafts 里也有一份，品牌手册写成 brand.md。",
    keep: "不自动清理，删账号时数据库里的一起删。",
  },
  {
    what: "用量和例行记录",
    where: "控制面数据库，每次派活记一笔。",
    keep: "删 Bot、删群后用量照样留着当账，删账号才删。每个例行只留最近 20 次运行记录。",
  },
  {
    what: "网页登录",
    where: "控制面数据库。",
    keep: "30 天过期，过期的每小时清一次。",
  },
];

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

      <section className="privacy-storage" data-testid="privacy-storage">
        <p className="group-label">存在哪、留多久</p>
        <p className="tools-intro">
          东西放在两处：控制面数据库，和干活那台电脑上的数据目录。Mac 上的白泽 App 在 ~/Library/Application
          Support/白泽/bots，远程电脑在 /home/node/.baize/bots。
        </p>
        {STORAGE.map((item) => (
          <div className="row-card" key={item.what} data-testid="privacy-storage-item">
            <span>
              <b>{item.what}</b>
              <small>存在：{item.where}</small>
              <small>留多久：{item.keep}</small>
            </span>
          </div>
        ))}
      </section>

      {deletion.status === "closed" ? (
        <div className="row-card">
          <span>
            <b>删除账号</b>
            <small>
              Bot、项目、对话、例行、授权一起删掉，连着的电脑会断开。删了找不回来。电脑上的数据目录和 App
              存的连接凭据不会跟着删，要清干净就自己删掉上面那个目录。
            </small>
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
