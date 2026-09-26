import type { BrowserPlatform, DraftContent, Platform, PublishFailureReason } from "@baize/shared";

/** externalId 为 null：电脑那边发出去了，但没读到平台上的 id。走接口的一定有。 */
export type Published = { readonly url: string; readonly externalId: string | null };

/** 平台接口没走通。原因按状态码分：401、403 是令牌不认了，别的都记出错。detail 只给人看，不带令牌。 */
export class PublishError extends Error {
  constructor(
    readonly reason: PublishFailureReason,
    detail: string,
  ) {
    super(detail);
  }
}

export type ApiPublishInput = {
  readonly content: DraftContent;
  readonly handle: string | null;
  readonly token: string;
  readonly baseUrl: string;
};

/**
 * 每个平台怎么发。走接口的在控制面里拿令牌直接发；走电脑的下发 publish_draft 给账号所在的电脑，
 * 等电脑报 publish_result 回来。发布循环只按这张表分派，加一个平台就是加一行。
 */
export type PlatformPublisher =
  | {
      readonly via: "api";
      readonly baseUrl: (bases: ApiBases) => string;
      publish(input: ApiPublishInput): Promise<Published>;
    }
  | {
      readonly via: "computer";
      readonly platform: BrowserPlatform;
      /** 电脑报上来的链接只认这个域名和它的子域。 */
      readonly host: string;
      /** 报上来的链接不可信时落账用这个页面，用户去那里找刚发的那条。 */
      readonly manageUrl: string;
    };

export type ApiBases = { readonly githubApiBaseUrl: string; readonly xApiBaseUrl: string };

const TIMEOUT_MS = 60_000;

async function call(
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new PublishError("error", `请求没发出去：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PublishError("login_expired", `平台回 ${response.status}，令牌不认了`);
  }
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

async function publishX({ content, handle, token, baseUrl }: ApiPublishInput): Promise<Published> {
  let reply: { in_reply_to_tweet_id: string } | undefined;
  if (content.kind === "reply") {
    const target = TWEET.exec(content.replyTo.url);
    if (target?.[1] === undefined) throw new PublishError("error", "X 只能回复帖子的链接");
    reply = { in_reply_to_tweet_id: target[1] };
  }
  const json = await call(
    `${baseUrl}/2/tweets`,
    token,
    reply === undefined ? { text: content.text } : { text: content.text, reply },
  );
  const id = stringAt(json, "data", "id");
  return { url: `https://x.com/${handle ?? "i/web"}/status/${id}`, externalId: id };
}

export const PUBLISHERS: Record<Platform, PlatformPublisher> = {
  github: { via: "api", baseUrl: (bases) => bases.githubApiBaseUrl, publish: publishGithub },
  x: { via: "api", baseUrl: (bases) => bases.xApiBaseUrl, publish: publishX },
  xiaohongshu: {
    via: "computer",
    platform: "xiaohongshu",
    host: "xiaohongshu.com",
    manageUrl: "https://creator.xiaohongshu.com/new/note-manager",
  },
};

/**
 * 电脑报上来的链接是发布器从页面上读的，页面说什么它就报什么。只认 https、默认端口、平台自己的域名或子域，
 * 别的照样算发出去了，链接换成平台的管理页：结果本身可信（认领标识对得上），只是这个链接不能直接给用户点。
 * 放行的落 WHATWG 规范化后的串：判定用的是这套解析，原串换一个解析器（比如 `\@` 这种写法）可能解析出别的主机。
 */
export function trustedPageUrl(platform: Platform, reported: string): string {
  const publisher = PUBLISHERS[platform];
  if (publisher.via !== "computer") return reported;
  const url = URL.parse(reported);
  const trusted =
    url !== null &&
    url.protocol === "https:" &&
    url.port === "" &&
    (url.hostname === publisher.host || url.hostname.endsWith(`.${publisher.host}`));
  return trusted ? url.href : publisher.manageUrl;
}

export const COMPUTER_PLATFORMS: readonly Platform[] = (Object.keys(PUBLISHERS) as Platform[]).filter(
  (platform) => PUBLISHERS[platform].via === "computer",
);
