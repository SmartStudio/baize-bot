import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Link2, Lock, X } from "lucide-react";
import {
  BotTemplate,
  type Bot,
  type Preference,
  type PreferenceId,
  type Skill,
  type ToolConnection,
} from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import { SHARE_LINK_MAX, shareLinkOf, shareSummary } from "./shareLink.js";
import { trapTab } from "./trapTab.js";
import { useApp } from "../state/app.js";

type Props = {
  bot: Bot;
  skills: Skill[];
  plugins: ToolConnection[];
  preferences: Preference[];
  onClose: () => void;
};

type Copy =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "failed" }
  | { kind: "too_long" }
  | { kind: "ready"; link: string; copied: boolean; preferences: number };

// 分享包里偏好的条数上限，跟着契约走。超出的不默认带，到顶后没勾的勾不上，免得撞上「没打包成」。
const PREFERENCE_MAX = BotTemplate.shape.preferences._def.maxLength?.value ?? 50;

export const ShareDialog = ({ bot, skills, plugins, preferences, onClose }: Props) => {
  const [more, setMore] = useState(false);
  const [withSkills, setWithSkills] = useState(true);
  const [withPlugins, setWithPlugins] = useState(true);
  // 只记用户改过默认的那几条。默认跟着隐私走：一条偏好改成私人，没人动过它就自动不带；用户自己勾上的私人偏好照带。
  const [overrides, setOverrides] = useState<ReadonlyMap<PreferenceId, boolean>>(new Map());
  const [copy, setCopy] = useState<Copy>({ kind: "idle" });
  // 每次改勾选或再点复制都换号，号对不上的回包按旧勾选打的，直接丢。
  const copyTurn = useRef(0);
  const copyButton = useRef<HTMLButtonElement>(null);
  const { actions } = useApp();
  // 默认带的是前 PREFERENCE_MAX 条公开偏好，按列表里的位置定，不随用户勾掉别的而顺延补上。
  const byDefault = new Set(
    preferences
      .filter((preference) => !preference.private)
      .slice(0, PREFERENCE_MAX)
      .map((preference) => preference.id),
  );
  const picked = (preference: Preference) => overrides.get(preference.id) ?? byDefault.has(preference.id);
  // 偏好在弹窗开着时还会被删、改私人、新增，合起来可能超上限，超出的截掉，勾选框也按这里显示。
  const chosen = preferences.filter(picked).slice(0, PREFERENCE_MAX);
  const inPack = new Set(chosen.map((preference) => preference.id));
  const full = chosen.length >= PREFERENCE_MAX;

  // 包里的偏好变了（删了、改了私人、改了字），按旧内容打出来的链接和在途导出都不作数。
  const contents = JSON.stringify(chosen.map((preference) => preference.text));
  const seenContents = useRef(contents);
  useEffect(() => {
    if (seenContents.current === contents) return;
    seenContents.current = contents;
    copyTurn.current += 1;
    setCopy({ kind: "idle" });
  }, [contents]);

  useEffect(() => copyButton.current?.focus(), []);

  // 关掉弹窗后旧导出还会回来，换号让它作废，不再碰剪贴板。
  useEffect(
    () => () => {
      copyTurn.current += 1;
    },
    [],
  );
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const summary = shareSummary({
    botName: bot.name,
    hasTags: bot.tags.length > 0,
    skills: withSkills ? skills.length : 0,
    plugins: withPlugins ? plugins.length : 0,
    preferences: chosen.length,
    keptPrivate: preferences.filter((preference) => preference.private && !inPack.has(preference.id)).length,
  });

  const choose =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      copyTurn.current += 1;
      setCopy({ kind: "idle" });
    };
  const togglePreference = choose((preference: Preference) => {
    const next = new Map(overrides);
    const want = !inPack.has(preference.id);
    if (want === byDefault.has(preference.id)) next.delete(preference.id);
    else next.set(preference.id, want);
    setOverrides(next);
  });

  const copyLink = async () => {
    if (copy.kind === "busy") return;
    const turn = (copyTurn.current += 1);
    const current = () => copyTurn.current === turn;
    setCopy({ kind: "busy" });
    let link: string;
    let packed: number;
    try {
      const exported = await actions.exportTemplate(bot.id, {
        skills: withSkills,
        plugins: withPlugins,
        preferences: false,
      });
      if (exported === undefined || !current()) return;
      // 契约里偏好只有一个总开关，逐条挑在这里：私人那条用户自己勾上了也照带。
      const template = BotTemplate.parse({ ...exported, preferences: chosen.map(({ text }) => ({ text })) });
      packed = template.preferences.length;
      link = shareLinkOf(template, window.location.origin);
    } catch {
      if (current()) setCopy({ kind: "failed" });
      return;
    }
    if (link.length > SHARE_LINK_MAX) {
      setCopy({ kind: "too_long" });
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      if (current()) setCopy({ kind: "ready", link, copied: true, preferences: packed });
    } catch {
      if (current()) setCopy({ kind: "ready", link, copied: false, preferences: packed });
    }
  };

  return (
    <div className="scrim" data-testid="share-dialog">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`分享 ${bot.name}`}
        aria-busy={copy.kind === "busy"}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <header className="dialog-head">
          <BotAvatar shape={bot.shape} hue={bot.hue} size="sm" />
          <span>
            <b>分享 {bot.name}</b>
          </span>
          <button
            type="button"
            className="icon-button edit-bot-close"
            data-testid="share-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p data-testid="share-summary">{summary}</p>
        <button
          type="button"
          className="link-button"
          data-testid="share-more"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          自己挑带什么
        </button>
        {more ? (
          <div className="field">
            <label className="tool-bot-option">
              <input
                type="checkbox"
                data-testid="share-skills"
                checked={withSkills}
                onChange={(event) => choose(setWithSkills)(event.target.checked)}
              />
              技能 {skills.length} 个{skills.length > 0 ? `：${skills.map((skill) => skill.name).join("、")}` : ""}
            </label>
            <label className="tool-bot-option">
              <input
                type="checkbox"
                data-testid="share-plugins"
                checked={withPlugins}
                onChange={(event) => choose(setWithPlugins)(event.target.checked)}
              />
              插件 {plugins.length} 个{plugins.length > 0 ? `：${plugins.map((plugin) => plugin.name).join("、")}` : ""}
              。只带配置
            </label>
            <span>记住的偏好</span>
            {preferences.length > PREFERENCE_MAX ? (
              <small className="dialog-note" data-testid="share-pref-limit">
                最多带 {PREFERENCE_MAX} 条偏好，到了上限先勾掉一条再换
              </small>
            ) : null}
            {preferences.length === 0 ? <small className="dialog-note">还没有。</small> : null}
            {preferences.map((preference) => (
              <label className="tool-bot-option" data-testid="share-pref" key={preference.id}>
                <input
                  type="checkbox"
                  checked={inPack.has(preference.id)}
                  disabled={full && !inPack.has(preference.id)}
                  onChange={() => togglePreference(preference)}
                />
                {preference.text}
                {preference.private ? (
                  <small className="dialog-note">
                    <Lock size={12} aria-hidden="true" />
                    只和你的号有关，默认不带
                  </small>
                ) : null}
              </label>
            ))}
          </div>
        ) : null}
        <p className="dialog-note" role="status" aria-live="polite">
          {copy.kind === "busy" ? "正在打包…" : ""}
        </p>
        {copy.kind === "ready" ? (
          <label className="field">
            <span>
              {copy.copied
                ? `链接已复制，带 ${copy.preferences} 条偏好。对方导入的是独立副本`
                : "没复制上，选中下面这段自己复制"}
            </span>
            <input
              readOnly
              data-testid="share-link"
              value={copy.link}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        ) : null}
        {copy.kind === "too_long" ? (
          <p className="edit-bot-error" role="alert">
            这个 Bot 内容太多，分享链接放不下，精简技能后再试
          </p>
        ) : null}
        {copy.kind === "failed" ? (
          <p className="edit-bot-error" role="alert">
            没打包成，再试一次
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button
            ref={copyButton}
            type="button"
            className="primary-button"
            data-testid="share-copy"
            aria-disabled={copy.kind === "busy"}
            onClick={() => void copyLink()}
          >
            <Link2 size={14} aria-hidden="true" />
            复制链接
          </button>
        </div>
      </div>
    </div>
  );
};
