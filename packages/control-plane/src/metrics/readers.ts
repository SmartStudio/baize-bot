import type { MetricSource, OAuthPlatform } from "@baize/shared";
import { z } from "zod";
import type { ApiBases } from "../publish/platforms.js";

export type PolledMetricSource = Exclude<MetricSource, { kind: "reported" }>;
export type PolledMetricKind = PolledMetricSource["kind"];

type SourceOf<K extends PolledMetricKind> = Extract<PolledMetricSource, { kind: K }>;

export type MetricReader<K extends PolledMetricKind> = {
  readonly platform: OAuthPlatform;
  readonly site: string;
  readonly what: (source: SourceOf<K>) => string;
  readonly baseUrl: (bases: ApiBases) => string;
  readonly path: (source: SourceOf<K>) => string | { readonly invalid: string };
  readonly value: (body: unknown) => number | null;
  readonly missing: string;
};

const RepoStars = z.object({ stargazers_count: z.number().int().nonnegative() });
const XMe = z.object({
  data: z.object({ public_metrics: z.object({ followers_count: z.number().int().nonnegative() }) }),
});

export const READERS: { readonly [K in PolledMetricKind]: MetricReader<K> } = {
  github_stars: {
    platform: "github",
    site: "GitHub",
    what: (source) => `${source.repo} 的星数`,
    baseUrl: (bases) => bases.githubApiBaseUrl,
    // 仓库名的格式在 MetricSource 上校过，但 . 和 .. 也合格式，拼进路径会跳出 /repos。
    path: (source) =>
      source.repo.split("/").some((part) => part === "." || part === "..")
        ? { invalid: "仓库名不对" }
        : `/repos/${source.repo}`,
    value: (body) => RepoStars.safeParse(body).data?.stargazers_count ?? null,
    missing: "回包里没有 stargazers_count",
  },
  x_followers: {
    platform: "x",
    site: "X",
    what: () => "X 粉丝数",
    baseUrl: (bases) => bases.xApiBaseUrl,
    path: () => "/2/users/me?user.fields=public_metrics",
    value: (body) => XMe.safeParse(body).data?.data.public_metrics.followers_count ?? null,
    missing: "回包里没有 public_metrics.followers_count",
  },
};

export const readerOf = <K extends PolledMetricKind>(source: SourceOf<K>): MetricReader<K> =>
  READERS[source.kind] as MetricReader<K>;

export const isPolled = (source: MetricSource): source is PolledMetricSource => source.kind !== "reported";

export const platformOfPolled = (source: PolledMetricSource): OAuthPlatform => READERS[source.kind].platform;
