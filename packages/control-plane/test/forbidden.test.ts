import { describe, expect, it } from "vitest";
import { classifyForbidden } from "../src/publish/forbidden.js";

const FULL = "tweet.read users.read tweet.write media.write offline.access";
const NO_MEDIA = "tweet.read users.read tweet.write offline.access";
const MISSING_BODY = JSON.stringify({
  title: "Forbidden",
  type: "https://api.twitter.com/2/problems/client-forbidden",
  status: 403,
  detail: "Forbidden: Missing permission media.write",
});
const DUPLICATE_BODY = JSON.stringify({
  title: "Forbidden",
  type: "about:blank",
  status: 403,
  detail: "You are not allowed to create a Tweet with duplicate content.",
});

describe("平台回 403 是缺权限还是拒了这一条", () => {
  it.each([
    {
      name: "存下的 scope 缺发图权限，回包说什么都算缺",
      needs: "media.write",
      granted: NO_MEDIA,
      body: "",
      scope: "media.write",
    },
    {
      name: "存下的 scope 不知道，回包点名缺 media.write",
      needs: "media.write",
      granted: "",
      body: MISSING_BODY,
      scope: "media.write",
    },
    {
      name: "存下的 scope 有，平台回包仍点名缺它，以平台为准",
      needs: "media.write",
      granted: FULL,
      body: MISSING_BODY,
      scope: "media.write",
    },
    {
      name: "存下的 scope 不知道，回包说内容重复",
      needs: "media.write",
      granted: "",
      body: DUPLICATE_BODY,
      scope: null,
    },
    { name: "存下的 scope 有，回包是空的", needs: "media.write", granted: FULL, body: "", scope: null },
    {
      name: "不带图的帖子用不着发图权限，scope 缺它也不算",
      needs: null,
      granted: NO_MEDIA,
      body: DUPLICATE_BODY,
      scope: null,
    },
    { name: "不带图的帖子回包里提到 media.write 也不算", needs: null, granted: "", body: MISSING_BODY, scope: null },
    {
      name: "GitHub 回包说没有这个仓库的权限",
      needs: null,
      granted: "",
      body: '{"message":"Resource not accessible by integration"}',
      scope: null,
    },
    {
      name: "scope 里只是有个更长的近似名字，不当作有",
      needs: "media.write",
      granted: "tweet.read media.writes",
      body: "",
      scope: "media.write",
    },
  ] as const)("$name", ({ needs, granted, body, scope }) => {
    expect(classifyForbidden({ needs, granted, body })).toEqual(
      scope === null ? { kind: "forbidden" } : { kind: "missing_scope", scope },
    );
  });
});
