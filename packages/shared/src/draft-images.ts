import type { AttachmentMime, Platform, PublishVia } from "./domain.js";

export type DraftImageRules = {
  readonly maxImages: number;
  /** null 是这一格不另设上限，只受 ATTACHMENT_MAX_BYTES 管。 */
  readonly maxBytes: number | null;
  readonly gifAlone: boolean;
};

const MB = 1000 * 1000;

/**
 * 走接口的 X 照 X 媒体上传接口的限制：一条最多 4 张图或 1 张 GIF，单张图 5 MB
 * （https://docs.x.com/x-api/media/quickstart/best-practices）。文档没说 MB 是不是 1000 进位，按小的算；
 * GIF X 收到 15 MB，一次性上传这里也按 5 MB 卡。PNG、JPEG、WebP、GIF 四种附件格式 X 都收。
 * 走接口的 GitHub 不带图：GitHub 没有给 issue、discussion、评论正文传图的公开接口，网页上拖图走的是未公开的上传通道。
 */
export const DRAFT_IMAGE_RULES: { readonly [P in Platform]: Partial<Record<PublishVia, DraftImageRules>> } = {
  github: { api: { maxImages: 0, maxBytes: null, gifAlone: false } },
  x: {
    api: { maxImages: 4, maxBytes: 5 * MB, gifAlone: true },
    computer: { maxImages: 4, maxBytes: null, gifAlone: false },
  },
  xiaohongshu: { computer: { maxImages: 9, maxBytes: null, gifAlone: false } },
};

export function draftImageRules(platform: Platform, via: PublishVia): DraftImageRules {
  const rules = DRAFT_IMAGE_RULES[platform][via];
  if (rules === undefined) throw new Error(`${platform} 没有 ${via} 的配图规则`);
  return rules;
}

export type DraftImageFacts = { readonly mime: AttachmentMime; readonly size: number };

export function draftImageRefusal(rules: DraftImageRules, image: DraftImageFacts): string | null {
  if (rules.maxBytes === null || image.size <= rules.maxBytes) return null;
  return `超过 ${rules.maxBytes / MB} MB`;
}

export function draftImageCountRefusal(rules: DraftImageRules, count: number): string | null {
  if (count <= rules.maxImages) return null;
  return rules.maxImages === 0 ? "不能带图" : `一条最多带 ${rules.maxImages} 张图`;
}

export function draftImagesRefusal(rules: DraftImageRules, images: readonly DraftImageFacts[]): string | null {
  const counted = draftImageCountRefusal(rules, images.length);
  if (counted !== null) return counted;
  for (const [index, image] of images.entries()) {
    const refusal = draftImageRefusal(rules, image);
    if (refusal !== null) return `第 ${index + 1} 张图${refusal}`;
  }
  if (rules.gifAlone && images.length > 1 && images.some((image) => image.mime === "image/gif")) {
    return "GIF 只能单独发一张，不能和别的图放在一条里";
  }
  return null;
}
