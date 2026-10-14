import type { LiveId, LivePurpose, LiveUserEnd } from "@baize/shared";

// 运行器要的「把一页摆到人眼前」的端口，由电脑代理的屏实现。运行器拿不到画面：结果里没有图像，帧进不了工作记录。

export interface LiveRequest {
  readonly liveId: LiveId;
  readonly targetId: string;
  readonly purpose: LivePurpose;
}

/** 怎么结束的。时限由调用方经 signal 表达，屏只知道「调用方不要了」，是到点还是撤回由调用方自己分。 */
export type LiveEnd =
  | { readonly kind: "user"; readonly action: LiveUserEnd }
  | { readonly kind: "caller" }
  /** 这一页被关了或崩了。 */
  | { readonly kind: "page_gone" }
  /** 根本没展示出来：Chrome 起不来、attach 失败。 */
  | { readonly kind: "broken" };

export interface LiveOutcome {
  readonly end: LiveEnd;
  /** 结束时主 frame 的网址。没展示出来或一直没导航完是 null。 */
  readonly url: string | null;
}

/** 只 resolve，不 reject。 */
export type PresentPage = (request: LiveRequest, signal: AbortSignal) => Promise<LiveOutcome>;
