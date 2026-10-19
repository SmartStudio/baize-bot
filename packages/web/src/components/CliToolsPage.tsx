import { useEffect, useState, type FormEvent } from "react";
import {
  CliInstall,
  CreateCliToolRequest,
  UpdateCliToolRequest,
  type Bot,
  type BotId,
  type CliTool,
  type ComputerKind,
  type GroupId,
} from "@baize/shared";
import { useApp } from "../state/app.js";

type Manager = "none" | CliInstall["manager"];

// stored 是库里已有的变量：名字不能改，值空着就是不改。新加的行名字值都要填。
type EnvRow = { key: number; name: string; value: string; stored: boolean; last4: string };

type Draft = {
  command: string;
  manager: Manager;
  pkg: string;
  env: EnvRow[];
  removed: string[];
  computers: ComputerKind[];
  bots: BotId[] | null;
};

const COMPUTER_LABEL: Record<ComputerKind, string> = { local: "本机", remote: "云电脑" };
const COMPUTERS: ComputerKind[] = ["local", "remote"];

let rowKey = 0;
const nextKey = () => (rowKey += 1);

const emptyDraft = (): Draft => ({
  command: "",
  manager: "npm",
  pkg: "",
  env: [{ key: nextKey(), name: "", value: "", stored: false, last4: "" }],
  removed: [],
  computers: ["remote"],
  bots: null,
});

const draftOf = (tool: CliTool): Draft => ({
  command: tool.command,
  manager: tool.install?.manager ?? "none",
  pkg: tool.install?.package ?? "",
  env: tool.env.map((one) => ({ key: nextKey(), name: one.name, value: "", stored: true, last4: one.last4 })),
  removed: [],
  computers: tool.computers,
  bots: tool.bots,
});

const installText = (install: CliTool["install"]): string =>
  install === null ? "不用装" : `${install.manager} ${install.package}`;

const masked = (last4: string): string => (last4 === "" ? "已设" : `····${last4}`);

const botsText = (bots: CliTool["bots"], all: Record<BotId, Bot>): string =>
  bots === null ? "全部 Bot" : bots.map((id) => all[id]?.name ?? "已删除的 Bot").join("、");

// 运行器只在云电脑上对登记过的装包命令免问，本机上装还是要人批，所以只给云电脑上的工具发这句话。
const installAsk = (tool: CliTool, soloGroups: Record<BotId, GroupId>, all: Record<BotId, Bot>) => {
  if (tool.install === null || !tool.computers.includes("remote")) return null;
  const line =
    tool.install.manager === "npm" ? `npm install -g ${tool.install.package}` : `pip install ${tool.install.package}`;
  const targets = (tool.bots ?? (Object.keys(all) as BotId[])).flatMap((botId) => {
    const groupId = soloGroups[botId];
    return groupId === undefined ? [] : [{ botId, groupId }];
  });
  if (targets.length === 0) return null;
  return {
    targets,
    text: `请在云电脑上装命令行工具 ${tool.command}：${line}。装好后跑一次 \`${tool.command} --help\` 确认。`,
  };
};

const messageOf = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/** 表单拼出来的请求；不合规就给一句话，服务端还会再按 schema 判一遍。 */
function installOf(draft: Draft): CliInstall | null | string {
  if (draft.manager === "none") return null;
  const parsed = CliInstall.safeParse({ manager: draft.manager, package: draft.pkg.trim() });
  return parsed.success ? parsed.data : "装包名不对，只填包名，比如 @vibe-kit/grok-cli";
}

function checkDraft(draft: Draft): string | null {
  if (draft.computers.length === 0) return "至少选一种电脑";
  if (draft.bots !== null && draft.bots.length === 0) return "至少勾一个 Bot，或者给全部 Bot";
  if (draft.env.some((row) => !row.stored && row.name.trim() === "")) return "变量名没填";
  if (draft.env.some((row) => !row.stored && row.value === "")) return "新加的变量要填值";
  return null;
}

const CliToolForm = ({
  tool,
  bots,
  onSubmit,
  onCancel,
}: {
  tool: CliTool | null;
  bots: Bot[];
  onSubmit: (draft: Draft, install: CliInstall | null) => Promise<void>;
  onCancel: (() => void) | null;
}) => {
  const [draft, setDraft] = useState<Draft>(() => (tool === null ? emptyDraft() : draftOf(tool)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = tool !== null;

  const patchRow = (key: number, patch: Partial<EnvRow>) =>
    setDraft({ ...draft, env: draft.env.map((row) => (row.key === key ? { ...row, ...patch } : row)) });

  const removeRow = (row: EnvRow) => {
    if (row.stored && !window.confirm(`删掉 ${row.name}？存着的值也一起删，保存后生效`)) return;
    setDraft({
      ...draft,
      env: draft.env.filter((one) => one.key !== row.key),
      removed: row.stored ? [...draft.removed, row.name] : draft.removed,
    });
  };

  const toggleComputer = (kind: ComputerKind, on: boolean) =>
    setDraft({
      ...draft,
      computers: on
        ? COMPUTERS.filter((one) => one === kind || draft.computers.includes(one))
        : draft.computers.filter((one) => one !== kind),
    });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const install = installOf(draft);
    if (typeof install === "string") return setError(install);
    const problem = checkDraft(draft);
    if (problem !== null) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await onSubmit(draft, install);
      if (!editing) setDraft(emptyDraft());
    } catch (cause) {
      setError(messageOf(cause, "没存上，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="tools-create-form cli-tool-form"
      data-testid="cli-tool-form"
      onSubmit={(event) => void submit(event)}
    >
      <label className="field">
        <span>命令</span>
        <input
          data-testid="cli-command-input"
          required
          maxLength={40}
          placeholder="grok"
          value={draft.command}
          disabled={busy || editing}
          onChange={(event) => setDraft({ ...draft, command: event.target.value })}
        />
        {editing ? <small>命令名登记后不能改，要换就删了重建</small> : null}
      </label>
      <div className="cli-install">
        <label className="field">
          <span>怎么装</span>
          <select
            data-testid="cli-install-manager"
            value={draft.manager}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, manager: event.target.value as Manager })}
          >
            <option value="npm">npm</option>
            <option value="pip">pip</option>
            <option value="none">不用装</option>
          </select>
        </label>
        {draft.manager === "none" ? null : (
          <label className="field">
            <span>包名</span>
            <input
              data-testid="cli-install-package"
              required
              placeholder="@vibe-kit/grok-cli"
              value={draft.pkg}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, pkg: event.target.value })}
            />
          </label>
        )}
      </div>

      <p className="tool-section-label">它要的环境变量</p>
      <small className="tools-intro">值只存不回显。只有整条命令就是这个工具时才拿得到，别的命令看不见。</small>
      <div className="cli-env-list">
        {draft.env.map((row) => (
          <div className="cli-env-row" key={row.key} data-testid="cli-env-row" data-env-name={row.name}>
            <input
              aria-label="变量名"
              data-testid="cli-env-name"
              placeholder="GROK_API_KEY"
              value={row.name}
              disabled={busy || row.stored}
              onChange={(event) => patchRow(row.key, { name: event.target.value.toUpperCase() })}
            />
            <input
              aria-label={`${row.name || "变量"} 的值`}
              data-testid="cli-env-value"
              type="password"
              autoComplete="off"
              placeholder={row.stored ? `${masked(row.last4)}，空着不改` : "值"}
              value={row.value}
              disabled={busy}
              onChange={(event) => patchRow(row.key, { value: event.target.value })}
            />
            <button
              type="button"
              className="ghost-button"
              data-testid="cli-env-remove"
              disabled={busy}
              onClick={() => removeRow(row)}
            >
              删
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="ghost-button cli-env-add"
        data-testid="cli-env-add"
        disabled={busy || draft.env.length >= 10}
        onClick={() =>
          setDraft({ ...draft, env: [...draft.env, { key: nextKey(), name: "", value: "", stored: false, last4: "" }] })
        }
      >
        加一个变量
      </button>

      <p className="tool-section-label">在哪种电脑上</p>
      <div className="tool-bot-list">
        {COMPUTERS.map((kind) => (
          <label key={kind} className="tool-bot-option">
            <input
              type="checkbox"
              data-testid={`cli-computer-${kind}`}
              checked={draft.computers.includes(kind)}
              disabled={busy}
              onChange={(event) => toggleComputer(kind, event.target.checked)}
            />
            {COMPUTER_LABEL[kind]}
          </label>
        ))}
      </div>

      <p className="tool-section-label">给哪些 Bot</p>
      <div className="tool-bot-list">
        <label className="tool-bot-option">
          <input
            type="checkbox"
            data-testid="cli-bots-all"
            checked={draft.bots === null}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, bots: event.target.checked ? null : [] })}
          />
          全部 Bot
        </label>
        {draft.bots === null
          ? null
          : bots.map((bot) => (
              <label key={bot.id} className="tool-bot-option">
                <input
                  type="checkbox"
                  data-testid="cli-bot-checkbox"
                  data-bot-name={bot.name}
                  checked={draft.bots?.includes(bot.id) ?? false}
                  disabled={busy}
                  onChange={(event) => {
                    const chosen = draft.bots ?? [];
                    setDraft({
                      ...draft,
                      bots: event.target.checked ? [...chosen, bot.id] : chosen.filter((id) => id !== bot.id),
                    });
                  }}
                />
                {bot.name}
              </label>
            ))}
      </div>

      <span className="budget-actions">
        {onCancel === null ? null : (
          <button type="button" className="ghost-button" data-testid="cli-cancel" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        <button type="submit" className="primary-button" data-testid="cli-save" disabled={busy}>
          {editing ? "存" : "登记"}
        </button>
      </span>
      {error ? (
        <p className="error" role="alert" data-testid="cli-error">
          {error}
        </p>
      ) : null}
    </form>
  );
};

// 拼好的请求在边界按 schema 判一遍，变量名、命令名的规矩和服务端是同一份。不过就抛出去，表单显示原因。
const parsedOrThrow = <T,>(
  parsed: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } },
): T => {
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "填得不对");
  return parsed.data;
};

const toCreate = (draft: Draft, install: CliInstall | null): CreateCliToolRequest =>
  parsedOrThrow(
    CreateCliToolRequest.safeParse({
      command: draft.command.trim(),
      install,
      env: draft.env.map((row) => ({ name: row.name.trim(), value: row.value })),
      computers: draft.computers,
      bots: draft.bots,
    }),
  );

const toUpdate = (draft: Draft, install: CliInstall | null): UpdateCliToolRequest =>
  parsedOrThrow(
    UpdateCliToolRequest.safeParse({
      install,
      set: draft.env.filter((row) => row.value !== "").map((row) => ({ name: row.name.trim(), value: row.value })),
      remove: draft.removed,
      computers: draft.computers,
      bots: draft.bots,
    }),
  );

type Load = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; tools: CliTool[] };

export const CliToolsPage = ({
  bots,
  soloGroups,
  onAskBot,
}: {
  bots: Record<BotId, Bot>;
  soloGroups: Record<BotId, GroupId>;
  onAskBot: (groupId: GroupId, text: string) => Promise<void>;
}) => {
  const { actions } = useApp();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [editing, setEditing] = useState<CliTool["id"] | null>(null);
  const [picking, setPicking] = useState<CliTool["id"] | null>(null);
  const [actionError, setActionError] = useState("");
  const botList = Object.values(bots);

  const reload = async () => {
    try {
      const tools = await actions.loadCliTools();
      if (tools !== undefined) setLoad({ status: "ready", tools });
    } catch (cause) {
      setLoad({ status: "failed", error: messageOf(cause, "没拉到，请重试") });
    }
  };

  // 只在打开这一页时拉一次：actions 随会话变，跟着它会反复重拉；之后的增删改都拿回包就地换。
  useEffect(() => {
    void reload();
  }, []);

  const replace = (tool: CliTool) =>
    setLoad((current) =>
      current.status !== "ready"
        ? current
        : {
            status: "ready",
            tools: current.tools.some((one) => one.id === tool.id)
              ? current.tools.map((one) => (one.id === tool.id ? tool : one))
              : [...current.tools, tool],
          },
    );

  const remove = async (tool: CliTool) => {
    if (!window.confirm(`删掉 ${tool.command}？存着的变量一起删，Bot 就用不了它了`)) return;
    setActionError("");
    try {
      await actions.deleteCliTool(tool.id);
      setLoad((current) =>
        current.status !== "ready"
          ? current
          : { status: "ready", tools: current.tools.filter((one) => one.id !== tool.id) },
      );
    } catch (cause) {
      setActionError(messageOf(cause, "没删成，请重试"));
    }
  };

  const ask = async (groupId: GroupId, text: string) => {
    setActionError("");
    try {
      await onAskBot(groupId, text);
    } catch (cause) {
      setActionError(messageOf(cause, "没发出去，请重试"));
    }
  };

  return (
    <div className="tools-page" data-testid="cli-tools-page">
      <p className="tools-intro">
        给 Bot 用的第三方命令行工具，比如 grok。密钥绑在命令上：只有跑这个命令时才带上，别的命令拿不到。
      </p>
      {load.status === "loading" ? <p className="tools-intro">正在拉…</p> : null}
      {load.status === "failed" ? (
        <p className="error" role="alert">
          {load.error}
          <button type="button" className="ghost-button" onClick={() => void reload()}>
            重试
          </button>
        </p>
      ) : null}
      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}
      {load.status === "ready" ? (
        <div className="tools-list" data-testid="cli-tools-list">
          {load.tools.map((tool) => {
            const install = installAsk(tool, soloGroups, bots);
            return (
              <div className="tool-connection" key={tool.id} data-testid="cli-tool-card" data-command={tool.command}>
                <div className="row-card tool-connection-head">
                  <span>
                    <b>{tool.command}</b>
                    <small data-testid="cli-tool-install">{installText(tool.install)}</small>
                    <small data-testid="cli-tool-env">
                      {tool.env.length === 0
                        ? "没有变量"
                        : tool.env.map((one) => `${one.name} ${masked(one.last4)}`).join("，")}
                    </small>
                    <small data-testid="cli-tool-where">
                      {tool.computers.map((kind) => COMPUTER_LABEL[kind]).join("、")} · {botsText(tool.bots, bots)}
                    </small>
                  </span>
                  <div className="tool-connection-actions">
                    {install === null ? null : (
                      <button
                        type="button"
                        className="ghost-button"
                        data-testid="cli-tool-install-ask"
                        aria-expanded={install.targets.length > 1 ? picking === tool.id : undefined}
                        onClick={() => {
                          const [only, ...more] = install.targets;
                          if (only !== undefined && more.length === 0) void ask(only.groupId, install.text);
                          else setPicking(picking === tool.id ? null : tool.id);
                        }}
                      >
                        让 Bot 装上
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-button"
                      data-testid="cli-tool-edit"
                      aria-expanded={editing === tool.id}
                      onClick={() => setEditing(editing === tool.id ? null : tool.id)}
                    >
                      改
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      data-testid="cli-tool-delete"
                      onClick={() => void remove(tool)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {install !== null && install.targets.length > 1 && picking === tool.id ? (
                  <div className="tool-connection-detail" data-testid="cli-ask-picker">
                    <p className="tool-section-label">让谁装</p>
                    <div className="tool-bot-list">
                      {install.targets.map(({ botId, groupId }) => (
                        <button
                          key={botId}
                          type="button"
                          className="ghost-button"
                          data-testid="cli-ask-bot"
                          data-bot-name={bots[botId]?.name}
                          onClick={() => void ask(groupId, install.text)}
                        >
                          {bots[botId]?.name ?? botId}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {editing === tool.id ? (
                  <div className="tool-connection-detail">
                    <CliToolForm
                      tool={tool}
                      bots={botList}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (draft, install) => {
                        const saved = await actions.updateCliTool(tool.id, toUpdate(draft, install));
                        if (saved === undefined) return;
                        replace(saved);
                        setEditing(null);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <section className="tools-create">
        <h3>登记一个命令行工具</h3>
        <CliToolForm
          tool={null}
          bots={botList}
          onCancel={null}
          onSubmit={async (draft, install) => {
            const saved = await actions.createCliTool(toCreate(draft, install));
            if (saved !== undefined) replace(saved);
          }}
        />
      </section>
    </div>
  );
};
