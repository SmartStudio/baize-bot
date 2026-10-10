import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BotTags, UpdateBotRequest, type Bot } from "@baize/shared";
import type { BotDraft } from "../api/client.js";
import { BotAvatar } from "./BotAvatar.js";

type Props = {
  bot: Bot;
  onSave: (draft: BotDraft) => Promise<void>;
  onClose: () => void;
};

// 上限都从 shared 的写入 schema 读，形状改了这里跟着走，不在界面上另记一份数。
const TAG_LIMIT = BotTags._def.maxLength?.value ?? 5;
const TAG_MAX_LENGTH = BotTags.element.maxLength ?? undefined;
const DESCRIPTION_MAX = UpdateBotRequest.shape.description.unwrap().maxLength ?? 80;
const NAME_MAX = UpdateBotRequest.shape.name.unwrap().maxLength ?? undefined;

// 只送动过的字段：旧描述可能比现在的写入上限长，没动它就不能拿截短的值去覆盖。
// 名字空着也不送，PATCH 不收空名字，省掉 name 就是不改名（D16 的「系统起名」见报告）。
const changesOf = (bot: Bot, name: string, tags: string[], description: string): BotDraft => {
  const trimmed = name.trim();
  const sameTags = tags.length === bot.tags.length && tags.every((tag, at) => tag === bot.tags[at]);
  return {
    ...(trimmed.length > 0 && trimmed !== bot.name ? { name: trimmed } : {}),
    ...(sameTags ? {} : { tags }),
    ...(description === bot.description ? {} : { description }),
  };
};

const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), button:not([disabled])";

// 弹窗是 aria-modal，Tab 走到头要绕回来，不能落到背后的页面上。
const trapTab = (event: React.KeyboardEvent<HTMLFormElement>) => {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  const edge = event.shiftKey ? first : last;
  if (document.activeElement !== edge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
};

export const EditBotDialog = ({ bot, onSave, onClose }: Props) => {
  const [name, setName] = useState(bot.name);
  const [tags, setTags] = useState<string[]>(bot.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [description, setDescription] = useState(bot.description);
  const [request, setRequest] = useState<"idle" | "busy" | "failed">("idle");
  const nameInput = useRef<HTMLInputElement>(null);
  const tooLong = description !== bot.description && description.length > DESCRIPTION_MAX;

  useEffect(() => nameInput.current?.focus(), []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const addTag = () => {
    const tag = tagDraft.trim();
    setTagDraft("");
    if (tag.length === 0 || tags.includes(tag) || tags.length >= TAG_LIMIT) return;
    setTags([...tags, tag]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (tooLong) return;
    setRequest("busy");
    try {
      await onSave(changesOf(bot, name, tags, description));
      onClose();
    } catch {
      setRequest("failed");
    }
  };

  return (
    <div className="scrim" data-testid="edit-bot-dialog">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`编辑 ${bot.name}`}
        onSubmit={submit}
        onKeyDown={trapTab}
      >
        <header className="dialog-head">
          <BotAvatar name={bot.name} hue={bot.hue} size="sm" />
          <span>
            <b>编辑 {bot.name}</b>
            <small>都可以不填，它干活时自己会记</small>
          </span>
          <button type="button" className="icon-button edit-bot-close" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <label className="field">
          <span>名字</span>
          <input
            ref={nameInput}
            data-testid="edit-bot-name"
            value={name}
            maxLength={NAME_MAX}
            placeholder="空着就由系统起名"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>一句话说它是谁、守什么规矩</span>
          <textarea
            data-testid="edit-bot-description"
            rows={3}
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
          <small className="edit-bot-count">
            {description.length}/{DESCRIPTION_MAX}
          </small>
        </label>
        <div className="field">
          <span>标签 · 团队页上显示</span>
          <div className="edit-bot-tags">
            {tags.map((tag) => (
              <em className="tag edit-bot-tag" data-testid="edit-bot-tag" key={tag}>
                {tag}
                <button
                  type="button"
                  className="edit-bot-tag-remove"
                  data-testid="edit-bot-tag-remove"
                  aria-label={`删掉标签 ${tag}`}
                  onClick={() => setTags(tags.filter((item) => item !== tag))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </em>
            ))}
            {tags.length < TAG_LIMIT ? (
              <input
                className="edit-bot-tag-input"
                data-testid="edit-bot-tag-input"
                aria-label="加标签"
                placeholder="+ 加标签，回车"
                value={tagDraft}
                maxLength={TAG_MAX_LENGTH}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  // 拼音输入法选字时的回车不算加标签。
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  addTag();
                }}
              />
            ) : null}
          </div>
        </div>
        {tooLong ? (
          <p className="edit-bot-error" role="alert" data-testid="edit-bot-description-too-long">
            描述最多 {DESCRIPTION_MAX} 个字，删短一些再存
          </p>
        ) : null}
        {request === "failed" ? (
          <p className="edit-bot-error" role="alert" data-testid="bot-edit-error">
            没存上，再试一次
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            data-testid="edit-bot-save"
            disabled={request === "busy" || tooLong}
          >
            保存
          </button>
        </div>
      </form>
    </div>
  );
};
