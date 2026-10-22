import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEscapeToClose } from "./useEscapeToClose.js";
import { UpdateBrandRequest, type BrandBook, type BrandEdit } from "@baize/shared";
import { RequestFailed } from "../api/client.js";
import { useApp } from "../state/app.js";
import type { SessionId } from "../state/types.js";

// 控制面 repo/brand.ts 的 BRAND_MAX_CHARS。shared 没导出这个数，超了控制面照样回 400，这里只为提前说清楚。
export const BRAND_MAX_CHARS = 8000;
const ASSETS_DIR = UpdateBrandRequest.shape.assetsDir;
const ASSETS_DIR_MAX = ASSETS_DIR.unwrap().maxLength ?? 1024;

const SECTIONS = [
  { key: "facts", label: "品牌事实", hint: "公司、产品、数字，写文案时不能说错的", rows: 3 },
  { key: "voice", label: "口吻", hint: "说话像谁、句子多长、用不用感叹号", rows: 2 },
  { key: "taboo", label: "禁忌", hint: "不能说的词、不能碰的话题", rows: 2 },
] as const;

export type BrandTexts = { facts: string; voice: string; taboo: string; assetsDir: string };

export const textsOf = (book: BrandBook | null): BrandTexts => ({
  facts: book?.facts ?? "",
  voice: book?.voice ?? "",
  taboo: book?.taboo ?? "",
  assetsDir: book?.assetsDir ?? "",
});

const assetsDirOf = (texts: BrandTexts): string | null => {
  const trimmed = texts.assetsDir.trim();
  return trimmed === "" ? null : trimmed;
};

/** 和控制面同一个算法：四段（事实、口吻、禁忌、素材文件夹）合计字数，「改过的地方」不算。 */
export const lengthOf = (texts: BrandTexts): number =>
  texts.facts.length + texts.voice.length + texts.taboo.length + (assetsDirOf(texts)?.length ?? 0);

// 控制面去重也是这三样：同一条草稿的同一处改动算一条。
export const editKey = (edit: BrandEdit): string => JSON.stringify([edit.draftId, edit.before, edit.after]);

const sameTexts = (left: BrandTexts, right: BrandTexts): boolean =>
  left.facts === right.facts &&
  left.voice === right.voice &&
  left.taboo === right.taboo &&
  left.assetsDir === right.assetsDir;

/**
 * base 是打开时读到的那本，latest 是推送跟到的最新一本。开着弹窗时批一条草稿只会往 latest 追加改动，
 * 所以改动列表和版本跟 latest 走；四段在别处被改过就仍按 base 的版本存，让控制面回 409，不悄悄盖掉别人的字。
 */
export const requestOf = (
  base: BrandBook | null,
  latest: BrandBook | null,
  texts: BrandTexts,
  removed: ReadonlySet<string>,
): UpdateBrandRequest => ({
  facts: texts.facts,
  voice: texts.voice,
  taboo: texts.taboo,
  assetsDir: assetsDirOf(texts),
  edits: (latest?.edits ?? []).filter((edit) => !removed.has(editKey(edit))),
  version: (sameTexts(textsOf(base), textsOf(latest)) ? latest : base)?.version ?? 0,
});

const newer = (left: BrandBook | null, right: BrandBook | null): BrandBook | null =>
  (right?.version ?? 0) > (left?.version ?? 0) ? right : left;

type Phase = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; base: BrandBook | null };
type Request = "idle" | "busy" | "stale" | "failed";

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

const timeText = (at: string): string => {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const EditRow = ({ edit, onRemove }: { edit: BrandEdit; onRemove: () => void }) => (
  <li className="brand-edit" data-testid="brand-edit">
    <span className="brand-edit-pair">
      <del data-testid="brand-edit-before">{edit.before}</del>
      <ins data-testid="brand-edit-after">{edit.after}</ins>
    </span>
    <small>{timeText(edit.at)}</small>
    <button
      type="button"
      className="icon-button"
      data-testid="brand-edit-remove"
      aria-label="这条不算，删掉"
      onClick={onRemove}
    >
      <X size={14} aria-hidden="true" />
    </button>
  </li>
);

export const BrandBookDialog = ({ onClose }: { onClose: () => void }) => {
  const { state, actions } = useApp();
  const latest = state.status === "ready" ? state.brand : null;
  // 开窗那次读回来时，推送可能已经送到更新的一本；读回的比手上旧就用手上的填表。
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  }, [latest]);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [texts, setTexts] = useState<BrandTexts>(textsOf(null));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [request, setRequest] = useState<Request>("idle");
  const firstField = useRef<HTMLTextAreaElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    actions.loadBrand().then(
      (book) => {
        if (!live || book === undefined) return;
        const base = newer(book, latestRef.current);
        setTexts(textsOf(base));
        setPhase({ kind: "ready", base });
      },
      () => live && setPhase({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [actions]);

  useEffect(() => {
    (phase.kind === "ready" ? firstField : closeButton).current?.focus();
  }, [phase.kind]);

  useEscapeToClose(onClose);

  const length = lengthOf(texts);
  const tooLong = length > BRAND_MAX_CHARS;
  const badAssetsDir = !ASSETS_DIR.safeParse(assetsDirOf(texts)).success;
  const edits = (latest?.edits ?? []).filter((edit) => !removed.has(editKey(edit))).reverse();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase.kind !== "ready" || tooLong || badAssetsDir) return;
    setRequest("busy");
    try {
      await actions.updateBrand(requestOf(phase.base, latest, texts, removed));
      onClose();
    } catch (error) {
      setRequest(error instanceof RequestFailed && error.status === 409 ? "stale" : "failed");
    }
  };

  return (
    <div className="scrim" data-testid="brand-dialog" data-state={phase.kind}>
      <form
        className="dialog brand-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="品牌手册"
        onSubmit={submit}
        onKeyDown={trapTab}
      >
        <header className="dialog-head">
          <span>
            <b>品牌手册</b>
            <small>全队写东西前都先读它。Bot 改不了，你批过的草稿改动会自动记进来。</small>
          </span>
          <button
            type="button"
            className="icon-button edit-bot-close"
            data-testid="brand-close"
            aria-label="关闭"
            ref={closeButton}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {phase.kind === "loading" ? <p className="dialog-note">正在读手册…</p> : null}
        {phase.kind === "failed" ? (
          <p className="edit-bot-error" role="alert" data-testid="brand-load-error">
            没读到手册，关掉再开一次
          </p>
        ) : null}
        {phase.kind === "ready" ? (
          <>
            {SECTIONS.map((section, index) => (
              <label className="field" key={section.key}>
                <span>{section.label}</span>
                <textarea
                  ref={index === 0 ? firstField : undefined}
                  data-testid={`brand-${section.key}`}
                  rows={section.rows}
                  placeholder={section.hint}
                  value={texts[section.key]}
                  onChange={(event) => setTexts({ ...texts, [section.key]: event.target.value })}
                />
              </label>
            ))}
            <label className="field">
              <span>素材文件夹</span>
              <input
                data-testid="brand-assets-dir"
                placeholder="/Users/你/Pictures/品牌素材"
                value={texts.assetsDir}
                onChange={(event) => setTexts({ ...texts, assetsDir: event.target.value })}
              />
              <small>本机的一个文件夹，设好就允许 Bot 读它</small>
            </label>
            <small className="edit-bot-count" data-testid="brand-count">
              {length}/{BRAND_MAX_CHARS}
            </small>
            <section className="brand-edits" aria-label="改过的地方">
              <span className="brand-edits-h">改过的地方 · 你批草稿时改的字</span>
              {edits.length === 0 ? (
                <p className="dialog-note" data-testid="brand-edits-empty">
                  还没有。在草稿卡上改了字再批，这里会记一条。
                </p>
              ) : (
                <ul className="brand-edit-list">
                  {edits.map((edit) => (
                    <EditRow
                      key={editKey(edit)}
                      edit={edit}
                      onRemove={() => setRemoved(new Set([...removed, editKey(edit)]))}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
        {tooLong ? (
          <p className="edit-bot-error" role="alert" data-testid="brand-too-long">
            四段加起来最多 {BRAND_MAX_CHARS} 字，现在 {length} 字，删短一些再存
          </p>
        ) : null}
        {badAssetsDir ? (
          <p className="edit-bot-error" role="alert" data-testid="brand-bad-assets-dir">
            素材文件夹要写以 / 开头的本机路径，最长 {ASSETS_DIR_MAX} 字
          </p>
        ) : null}
        {request === "stale" ? (
          <p className="edit-bot-error" role="alert" data-testid="brand-stale">
            手册刚在别处改过，关掉重开再改
          </p>
        ) : null}
        {request === "failed" ? (
          <p className="edit-bot-error" role="alert" data-testid="brand-save-error">
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
            data-testid="brand-save"
            disabled={phase.kind !== "ready" || request === "busy" || tooLong || badAssetsDir}
          >
            保存
          </button>
        </div>
      </form>
    </div>
  );
};

const BrandBookContext = createContext<(() => void) | null>(null);

/**
 * 弹窗挂在应用根上，不挂在入口上：草稿卡那行提示会随推送消失，手册不能跟着关、丢掉没存的字。
 * 开着的手册只属于点开它的那次登录，登录掉了就不再显示。关掉时焦点回到点开它的入口，入口已经不在就算了。
 */
export const BrandBookProvider = ({ children }: { children: ReactNode }) => {
  const { state } = useApp();
  const session = state.status === "ready" ? state.session : null;
  const [openIn, setOpenIn] = useState<SessionId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenIn(session);
  }, [session]);
  const close = useCallback(() => {
    setOpenIn(null);
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, []);
  return (
    <BrandBookContext.Provider value={show}>
      {children}
      {session !== null && openIn === session ? createPortal(<BrandBookDialog onClose={close} />, document.body) : null}
    </BrandBookContext.Provider>
  );
};

/** 团队页和草稿卡上的入口。 */
export const BrandBookOpener = ({
  className,
  testId,
  children,
}: {
  className: string;
  testId?: string;
  children: ReactNode;
}) => {
  const show = useContext(BrandBookContext);
  if (show === null) throw new Error("BrandBookOpener 必须在 BrandBookProvider 里用");
  return (
    <button type="button" className={className} data-testid={testId} onClick={show}>
      {children}
    </button>
  );
};
