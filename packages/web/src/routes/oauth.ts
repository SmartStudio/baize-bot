import { OAuthPlatform, OAuthResult } from "@baize/shared";
import { PLATFORM } from "../components/messages/content.js";

export type OAuthReturn = { platform: OAuthPlatform; result: OAuthResult };

// 控制面的授权回调 302 回首页，结果只在查询串里：?oauth=<平台>&result=<结果>。认不出的一律当没带。
export const oauthReturnOf = (params: URLSearchParams): OAuthReturn | null => {
  const platform = OAuthPlatform.safeParse(params.get("oauth"));
  const result = OAuthResult.safeParse(params.get("result"));
  return platform.success && result.success ? { platform: platform.data, result: result.data } : null;
};

export const oauthNoticeText = ({ platform, result }: OAuthReturn): string => {
  const name = PLATFORM[platform];
  switch (result) {
    case "connected":
      return `${name} 账号接好了`;
    case "denied":
      return `你在 ${name} 那边没有同意授权，账号没接上`;
    case "invalid_state":
      return `这次 ${name} 授权过期了或不是从这里发起的，再点一次接入`;
    case "failed":
      return `${name} 授权没成，账号没接上，稍后再试一次`;
  }
};
