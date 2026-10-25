import type {
  AttachmentMime,
  BrowserPlatform,
  DraftContent,
  Platform,
  PublishFailureReason,
  PublishVia,
} from "@baize/shared";
import type { PublishStep } from "./forbidden.js";

/** externalId 为 null：电脑那边发出去了，但没读到平台上的 id。走接口的一定有。 */
export type Published = { readonly url: string; readonly externalId: string | null };

/** 平台接口没走通。原因按状态码分：401 是令牌不认了，403 见 PlatformForbidden，别的都记出错。detail 只给人看，不带令牌。 */
export class PublishError extends Error {
  constructor(
    readonly reason: PublishFailureReason,
    detail: string,
  ) {
    super(detail);
  }
}

/** 平台回 401：不认这次带的令牌，请求没被接受。发布循环拿它换一次令牌重试，重试还是它才记过期。 */
export class TokenRejected extends PublishError {
  constructor(detail: string) {
    super("login_expired", detail);
  }
}

/** 平台回 403：令牌是认的，只是不让做这件事。 */
export class PlatformForbidden extends PublishError {
  constructor(
    readonly body: string,
    readonly step: PublishStep,
  ) {
    super("forbidden", `平台在${step === "upload" ? "传图" : "发帖"}那一步回 403：${body.slice(0, 500)}`);
  }
}

export type PublishImage = { readonly bytes: Buffer; readonly mime: AttachmentMime };

export type ApiPublishInput = {
  readonly content: DraftContent;
  readonly images: readonly PublishImage[];
  readonly handle: string | null;
  readonly token: string;
  readonly baseUrl: string;
  /** 等平台处理上传的图。测试注进来不真等。 */
  readonly sleep: (ms: number) => Promise<void>;
};

export type ApiPublisher = {
  readonly via: "api";
  readonly baseUrl: (bases: ApiBases) => string;
  publish(input: ApiPublishInput): Promise<Published>;
};

export type ComputerPublisher = {
  readonly via: "computer";
  readonly platform: BrowserPlatform;
  /** 电脑报上来的链接只认这个域名和它的子域。 */
  readonly host: string;
  /** 报上来的链接不可信时落账用这个页面，用户去那里找刚发的那条。 */
  readonly manageUrl: string;
};

/**
 * 一个账号怎么发由（平台，连接方式）定。走接口的在控制面里拿令牌直接发；走电脑的下发 publish_draft 给账号所在的电脑，
 * 等电脑报 publish_result 回来。发布循环只按这张表分派，加一个平台或一种连接方式就是加一格。
 */
export type PlatformPublisher = ApiPublisher | ComputerPublisher;

export type ApiBases = { readonly githubApiBaseUrl: string; readonly xApiBaseUrl: string };

const TIMEOUT_MS = 60_000;

function call(
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return send(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function send(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // 超时只说明没等到回应，平台可能已经收下、已经发出去了。
    throw new PublishError("error", `没等到平台的回应：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401) throw new TokenRejected("平台回 401，令牌不认了");
  if (response.status === 403) throw new PlatformForbidden(await response.text().catch(() => ""), "post");
  if (!response.ok) throw new PublishError("error", `平台回 ${response.status}`);
  const json: unknown = await response.json().catch(() => null);
  if (typeof json !== "object" || json === null) throw new PublishError("error", "平台的回应不是 JSON 对象");
  return json as Record<string, unknown>;
}

function stringAt(value: unknown, ...path: string[]): string {
  let current = value;
  for (const key of path) {
    current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  }
  if (typeof current === "string" && current !== "") return current;
  if (typeof current === "number") return String(current);
  throw new PublishError("error", `平台的回应里没有 ${path.join(".")}`);
}

const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "baize-bot",
  "x-github-api-version": "2022-11-28",
};

// GitHub issue 必须有标题。草稿没写标题就拿正文第一行顶上。
const issueTitle = (content: Extract<DraftContent, { kind: "post" }>): string =>
  content.title ?? [...(content.text.split("\n")[0] ?? content.text)].slice(0, 80).join("");

const REPO_ITEM = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/;

async function publishGithub({ content, token, baseUrl }: ApiPublishInput): Promise<Published> {
  if (content.kind === "reply") {
    const target = REPO_ITEM.exec(content.replyTo.url);
    if (target === null) throw new PublishError("error", "GitHub 只能回复 issue 或 pull request 的链接");
    const [, owner, repo, number] = target;
    const json = await call(
      `${baseUrl}/repos/${owner}/${repo}/issues/${number}/comments`,
      token,
      { body: content.text },
      GITHUB_HEADERS,
    );
    return { url: stringAt(json, "html_url"), externalId: stringAt(json, "id") };
  }
  if (content.github === null) throw new PublishError("error", "草稿没写发到哪个 GitHub 仓库");
  const [owner, name] = content.github.repo.split("/");
  if (content.github.as === "issue") {
    const json = await call(
      `${baseUrl}/repos/${owner}/${name}/issues`,
      token,
      { title: issueTitle(content), body: content.text },
      GITHUB_HEADERS,
    );
    return { url: stringAt(json, "html_url"), externalId: stringAt(json, "number") };
  }
  // discussion 只有 GraphQL 能建：先查仓库 id 和分类，优先 General，没有就用第一个。
  const repository = await graphql(baseUrl, token, DISCUSSION_TARGET, { owner, name });
  const repositoryId = stringAt(repository, "data", "repository", "id");
  const categories = categoriesOf(repository);
  const category = categories.find((one) => one.name === "General") ?? categories[0];
  if (category === undefined) throw new PublishError("error", "这个仓库没有开 Discussions 分类");
  const created = await graphql(baseUrl, token, CREATE_DISCUSSION, {
    repositoryId,
    categoryId: category.id,
    title: issueTitle(content),
    body: content.text,
  });
  return {
    url: stringAt(created, "data", "createDiscussion", "discussion", "url"),
    externalId: stringAt(created, "data", "createDiscussion", "discussion", "id"),
  };
}

const DISCUSSION_TARGET = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id discussionCategories(first: 25) { nodes { id name } } }
}`;
const CREATE_DISCUSSION = `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { id url }
  }
}`;

async function graphql(
  baseUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const json = await call(`${baseUrl}/graphql`, token, { query, variables }, GITHUB_HEADERS);
  // GraphQL 出错也回 200，错误在 errors 里。
  if (Array.isArray(json["errors"]) && json["errors"].length > 0) {
    throw new PublishError("error", `GitHub GraphQL 报错：${JSON.stringify(json["errors"]).slice(0, 500)}`);
  }
  return json;
}

function categoriesOf(json: unknown): { id: string; name: string }[] {
  const nodes = (json as { data?: { repository?: { discussionCategories?: { nodes?: unknown } } } }).data?.repository
    ?.discussionCategories?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node: unknown) => {
    const { id, name } = (node ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

const TWEET = /^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/;

const MEDIA_PROCESSING_LIMIT_MS = 5 * 60_000;

// 一次性上传，正文 JSON 里 media 放 base64：https://docs.x.com/x-api/media/upload-media 。
// 回包带 processing_info 的（动图）要按 check_after_secs 去查处理状态，到 succeeded 才能挂到帖子上。
async function uploadXMedia(input: ApiPublishInput, image: PublishImage): Promise<string> {
  const { baseUrl, token } = input;
  const json = await call(`${baseUrl}/2/media/upload`, token, {
    media: image.bytes.toString("base64"),
    media_category: image.mime === "image/gif" ? "tweet_gif" : "tweet_image",
  });
  const id = stringAt(json, "data", "id");
  let processing = processingOf(json);
  let waited = 0;
  while (processing !== null && processing.state !== "succeeded") {
    if (processing.state === "failed") throw new PublishError("media_failed", `X 处理图失败：${processing.detail}`);
    const wait = Math.max(1, processing.checkAfterSecs) * 1000;
    if (waited + wait > MEDIA_PROCESSING_LIMIT_MS) {
      throw new PublishError("media_failed", `X 处理图等了 ${waited / 1000} 秒还没好`);
    }
    await input.sleep(wait);
    waited += wait;
    const status = new URL(`${baseUrl}/2/media/upload`);
    status.search = new URLSearchParams({ command: "STATUS", media_id: id }).toString();
    processing = processingOf(await send(status.href, { headers: { authorization: `Bearer ${token}` } }));
  }
  return id;
}

type Processing = { readonly state: string; readonly checkAfterSecs: number; readonly detail: string };

/** 不带 processing_info 就是不用等：静图传完即可用，查状态的回包不带它也是处理完了。 */
function processingOf(json: Record<string, unknown>): Processing | null {
  const data = json["data"];
  const info = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["processing_info"] : null;
  if (typeof info !== "object" || info === null) return null;
  const { state, check_after_secs: after, error } = info as Record<string, unknown>;
  if (typeof state !== "string") throw new PublishError("error", "X 回的 processing_info 没有 state");
  return {
    state,
    checkAfterSecs: typeof after === "number" && Number.isFinite(after) ? after : 1,
    detail: JSON.stringify(error ?? null).slice(0, 300),
  };
}

async function publishX(input: ApiPublishInput): Promise<Published> {
  const { content, images, handle, token, baseUrl } = input;
  let reply: { in_reply_to_tweet_id: string } | undefined;
  if (content.kind === "reply") {
    const target = TWEET.exec(content.replyTo.url);
    if (target?.[1] === undefined) throw new PublishError("error", "X 只能回复帖子的链接");
    reply = { in_reply_to_tweet_id: target[1] };
  }
  const mediaIds: string[] = [];
  try {
    for (const image of images) mediaIds.push(await uploadXMedia(input, image));
  } catch (error) {
    if (error instanceof PlatformForbidden) throw new PlatformForbidden(error.body, "upload");
    throw error;
  }
  const json = await call(`${baseUrl}/2/tweets`, token, {
    text: content.text,
    ...(reply === undefined ? {} : { reply }),
    ...(mediaIds.length === 0 ? {} : { media: { media_ids: mediaIds } }),
  });
  const id = stringAt(json, "data", "id");
  return { url: `https://x.com/${handle ?? "i/web"}/status/${id}`, externalId: id };
}

type Publishers = {
  readonly [P in Platform]: { readonly api?: ApiPublisher; readonly computer?: ComputerPublisher & { platform: P } };
};

const PUBLISHERS: Publishers = {
  github: { api: { via: "api", baseUrl: (bases) => bases.githubApiBaseUrl, publish: publishGithub } },
  x: {
    api: { via: "api", baseUrl: (bases) => bases.xApiBaseUrl, publish: publishX },
    // 只认 x.com：发布器开的就是 x.com 的发帖页，发完读的也是这个页面上的链接；twitter.com 早已整站跳到 x.com，
    // 页面上读到 twitter.com 的链接说明页面不是发布器以为的那一页，按不可信处理落管理页。
    computer: { via: "computer", platform: "x", host: "x.com", manageUrl: "https://x.com/home" },
  },
  xiaohongshu: {
    computer: {
      via: "computer",
      platform: "xiaohongshu",
      host: "xiaohongshu.com",
      manageUrl: "https://creator.xiaohongshu.com/new/note-manager",
    },
  },
};

/** 库约束（accounts_via_ck、accounts_via_api_ck）保证账号行上的组合在表里有一格；查不到是代码和库对不上。 */
export function publisherFor<V extends PublishVia>(platform: Platform, via: V): Extract<PlatformPublisher, { via: V }> {
  const publisher: PlatformPublisher | undefined = PUBLISHERS[platform][via];
  if (publisher === undefined) throw new Error(`${platform} 没有 ${via} 的发布器`);
  return publisher as Extract<PlatformPublisher, { via: V }>;
}

/**
 * 电脑报上来的链接是发布器从页面上读的，页面说什么它就报什么。只认 https、默认端口、平台自己的域名或子域，
 * 别的照样算发出去了，链接换成平台的管理页：结果本身可信（认领标识对得上），只是这个链接不能直接给用户点。
 * 放行的落 WHATWG 规范化后的串：判定用的是这套解析，原串换一个解析器（比如 `\@` 这种写法）可能解析出别的主机。
 * 电脑报上来的只结算走电脑的账号（SettleScope.computer），所以这里只查电脑那一格。
 */
export function trustedPageUrl(platform: Platform, reported: string): string {
  const publisher = publisherFor(platform, "computer");
  const url = URL.parse(reported);
  const trusted =
    url !== null &&
    url.protocol === "https:" &&
    url.port === "" &&
    (url.hostname === publisher.host || url.hostname.endsWith(`.${publisher.host}`));
  return trusted ? url.href : publisher.manageUrl;
}
