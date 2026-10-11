import { useRef, useState } from "react";
import { ArrowRight, Play, ShieldCheck, Sparkles } from "lucide-react";
import type {
  Account,
  AccountId,
  DecideProjectOfferRequest,
  GroupId,
  MessageBody,
  MessageId,
  ProjectOfferPlatform,
} from "@baize/shared";
import { PLATFORM } from "./content.js";

export type ProjectOfferActions = {
  decide: (messageId: MessageId, request: DecideProjectOfferRequest) => Promise<void>;
  revise: () => void;
  open: (groupId: GroupId) => void;
};

type Body = Extract<MessageBody, { kind: "project_offer" }>;

const NAME_MAX = 40;

const platformText = (platform: ProjectOfferPlatform, accounts: Account[]): string => {
  if (platform.kind === "unsupported") return `${platform.name}暂不支持`;
  const handles = accounts.flatMap((account) =>
    account.platform === platform.platform && account.login === "valid" ? [account.handle ?? "账号未命名"] : [],
  );
  const where = handles.length > 0 ? handles.join("、") : "第一条内容写好时请你登录";
  return `${PLATFORM[platform.platform]} · ${where}`;
};

const OfferName = ({ name, onName, locked }: { name: string; onName: (name: string) => void; locked: boolean }) => {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        className="offer-name"
        data-testid="project-offer-name"
        disabled={locked}
        onClick={() => setEditing(true)}
      >
        {name}
      </button>
    );
  }
  return (
    <input
      className="offer-name-input"
      data-testid="project-offer-name-input"
      aria-label="项目名"
      autoFocus
      maxLength={NAME_MAX}
      defaultValue={name}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next.length > 0) onName(next);
        setEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.value = name;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
    />
  );
};

// 卡的状态只跟着消息走：点开始后等接口回来、消息换成 started 才收起，这里不先改样子。
export const ProjectOfferCard = ({
  body,
  messageId,
  accounts,
  actions,
}: {
  body: Body;
  messageId: MessageId;
  accounts: Record<AccountId, Account>;
  actions: ProjectOfferActions;
}) => {
  const [name, setName] = useState(body.name);
  const [sent, setSent] = useState(false);
  // 同一个事件循环里连点两下时 sent 还没来得及渲染成 disabled，靠这个同步的闩挡住第二下。
  const latch = useRef(false);

  if (body.status === "started") {
    const groupId = body.groupId;
    return (
      <div className="card project-offer is-folded" data-testid="project-offer" data-status={body.status}>
        <span>项目「{body.name}」已开始</span>
        {groupId === null ? null : (
          <button
            type="button"
            className="ghost-button"
            data-testid="project-offer-open"
            onClick={() => actions.open(groupId)}
          >
            去看看
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
  if (body.status === "dismissed") {
    return (
      <div className="card project-offer is-folded is-muted" data-testid="project-offer" data-status={body.status}>
        方案「{body.name}」没有开始
      </div>
    );
  }

  const start = () => {
    if (latch.current) return;
    latch.current = true;
    setSent(true);
    const request: DecideProjectOfferRequest = name === body.name ? { decision: "start" } : { decision: "start", name };
    void actions.decide(messageId, request).catch(() => {
      latch.current = false;
      setSent(false);
    });
  };

  const accountList = Object.values(accounts);
  return (
    <div className="card project-offer" data-testid="project-offer" data-status={body.status}>
      <div className="card-title">
        <Sparkles size={16} aria-hidden="true" />
        新项目 · <OfferName name={name} onName={setName} locked={sent} />
      </div>
      <p className="offer-hint">主助理的方案 · 名字点一下就能改</p>
      <dl className="offer-kv">
        <dt>目标</dt>
        <dd data-testid="project-offer-goal">{body.goal}</dd>
        <dt>队伍</dt>
        <dd>
          <ul className="offer-team">
            {body.team.map((member) => (
              <li key={member.name} data-testid="project-offer-member">
                <b>{member.name}</b>
                <span>{member.description}</span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>平台</dt>
        <dd>
          {body.platforms.length === 0 ? (
            "不碰任何账号"
          ) : (
            <ul className="offer-platforms">
              {body.platforms.map((platform) => (
                <li
                  key={platform.kind === "supported" ? platform.platform : platform.name}
                  data-testid="project-offer-platform"
                  data-supported={platform.kind === "supported"}
                  className={platform.kind === "supported" ? undefined : "is-unsupported"}
                >
                  {platformText(platform, accountList)}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>节奏</dt>
        <dd data-testid="project-offer-cadence">{body.cadence}</dd>
        <dt>第一步</dt>
        <dd data-testid="project-offer-first-step">{body.firstStep}</dd>
      </dl>
      <div className="approval-actions">
        <span className="offer-note">
          <ShieldCheck size={14} aria-hidden="true" />
          对外发的每一条照样先给你看。
        </span>
        <button
          type="button"
          className="ghost-button"
          data-testid="project-offer-revise"
          disabled={sent}
          onClick={actions.revise}
        >
          改一下
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="project-offer-start"
          disabled={sent}
          onClick={start}
        >
          <Play size={14} aria-hidden="true" />
          开始
        </button>
      </div>
    </div>
  );
};
