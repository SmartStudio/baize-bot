import { useState, type FormEvent } from "react";
import type { Bot, BotId, CreateToolRequest, ToolConnection, ToolConnectionId, UpdateToolRequest } from "@baize/shared";

type Props = {
  tools: ToolConnection[];
  bots: Record<BotId, Bot>;
  onCreate: (draft: CreateToolRequest) => Promise<void>;
  onUpdate: (id: ToolConnectionId, patch: UpdateToolRequest) => Promise<void>;
  onDelete: (id: ToolConnectionId) => Promise<void>;
};

const assignmentSummary = (tool: ToolConnection, bots: Bot[]): string => {
  const assigned = bots.filter((bot) => tool.assignedBotIds.includes(bot.id));
  if (assigned.length === 0) return "还没勾";
  if (assigned.length === bots.length) return `全部 ${bots.length} 个 Bot`;
  return assigned.map((bot) => bot.name).join(" · ");
};

const ToolCard = ({
  tool,
  bots,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
}: {
  tool: ToolConnection;
  bots: Bot[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: Props["onUpdate"];
  onDelete: Props["onDelete"];
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = async (patch: UpdateToolRequest) => {
    setBusy(true);
    setError("");
    try {
      await onUpdate(tool.id, patch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("断开后所有 Bot 都用不了它")) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(tool.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "断开失败，请重试");
      setBusy(false);
    }
  };

  return (
    <div className="tool-connection" data-testid="tool-card" data-tool-name={tool.name}>
      <div className="row-card tool-connection-head">
        <span>
          <b>{tool.name}</b>
          <small>{new URL(tool.url).host} · MCP</small>
        </span>
        <div className="tool-connection-actions">
          <span data-testid="tool-assignment">{assignmentSummary(tool, bots)}</span>
          <button
            type="button"
            className="ghost-button"
            data-testid="tool-edit-assignment"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            改分配
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="tool-connection-detail" data-testid="tool-details">
          <p className="tool-section-label">哪些 Bot 能用</p>
          <div className="tool-bot-list">
            {bots.map((bot) => (
              <label key={bot.id} className="tool-bot-option">
                <input
                  type="checkbox"
                  data-testid="tool-bot-checkbox"
                  data-bot-name={bot.name}
                  checked={tool.assignedBotIds.includes(bot.id)}
                  disabled={busy}
                  onChange={(event) => {
                    const assignedBotIds = event.target.checked
                      ? [...tool.assignedBotIds, bot.id]
                      : tool.assignedBotIds.filter((id) => id !== bot.id);
                    void update({ assignedBotIds });
                  }}
                />
                {bot.name}
              </label>
            ))}
          </div>
          <p className="tool-section-label">操作</p>
          <div className="tool-operation-list">
            {tool.operations.map((operation) => (
              <div className="tool-operation" key={operation.name}>
                <span>
                  <b>{operation.name}</b>
                  <small>{operation.description}</small>
                </span>
                <span className="tool-operation-approval">
                  需要点头
                  <button
                    type="button"
                    role="switch"
                    aria-checked={operation.needsApproval}
                    aria-label={`${operation.name} 需要点头`}
                    className={`switch${operation.needsApproval ? " is-on" : ""}`}
                    data-testid="tool-operation-switch"
                    data-operation-name={operation.name}
                    disabled={busy}
                    onClick={() =>
                      void update({
                        operations: tool.operations.map((item) => ({
                          name: item.name,
                          needsApproval: item.name === operation.name ? !item.needsApproval : item.needsApproval,
                        })),
                      })
                    }
                  />
                </span>
              </div>
            ))}
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="ghost-button tool-disconnect"
            data-testid="tool-disconnect"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            断开
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const ToolsPage = ({ tools, bots, onCreate, onUpdate, onDelete }: Props) => {
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const botList = Object.values(bots);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft: CreateToolRequest = {
      name: name.trim(),
      url: url.trim(),
      ...(authorization.trim() === "" ? {} : { authorization: authorization.trim() }),
    };
    setBusy(true);
    setError("");
    try {
      await onCreate(draft);
      setExpandedName(draft.name);
      setName("");
      setUrl("");
      setAuthorization("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tools-page" data-testid="tools-page">
      <p className="tools-intro">已连接的工具（MCP）· 你连一次，勾给哪些 Bot 用</p>
      <div className="tools-list" data-testid="tools-list">
        {tools.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            bots={botList}
            expanded={expandedName === tool.name}
            onToggle={() => setExpandedName(expandedName === tool.name ? null : tool.name)}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        ))}
      </div>

      <section className="tools-create">
        <h3>连接新工具</h3>
        <form className="tools-create-form" data-testid="tool-create-form" onSubmit={(event) => void create(event)}>
          <label className="field">
            <span>名字</span>
            <input
              data-testid="tool-name-input"
              required
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>MCP 地址</span>
            <input
              data-testid="tool-url-input"
              required
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="field">
            <span>授权头（可选）</span>
            <input
              data-testid="tool-authorization-input"
              value={authorization}
              placeholder="Bearer …，没有就留空"
              onChange={(event) => setAuthorization(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" data-testid="tool-connect" disabled={busy}>
            连接
          </button>
          {error ? (
            <p className="error" role="alert" data-testid="tool-create-error">
              {error}
            </p>
          ) : null}
        </form>
      </section>

      <section className="tools-sites">
        <h3>电脑里已登录的站点 · 所有 Bot 的桌面共用</h3>
        <p>后续</p>
      </section>
      <p className="tools-foot">
        Bot 设置里的「可用工具」「已登录站点」点进来也是这一页。登录态在你的电脑上，过期了 Bot
        不会猜密码，会停下请你接管登录。没有别的权限设置。
      </p>
    </div>
  );
};
