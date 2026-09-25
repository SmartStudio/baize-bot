# 登录

用户先填企业域名，再填邮箱和密码进主窗口。密码错了留在登录页并说明原因，退出后刷新也回不到主窗口。

## Sub-features

- `login-ok` 两步登录进主窗口，侧栏列出 Bot。
- `login-wrong-password` 密码错误时留在 `/login`，提示「邮箱或密码不对」。
- `logout` 从账户菜单退出，服务端会话作废。

## How to get to it (user POV)

- 打开 `<web>`，没登录会被带到 `/login`。
- 已登录时点左下角账户，菜单里点退出。

## Driving it with Playwright MCP

Preconditions:

- `stack.sh <入口> doctor` 全是 `✓`。
- 入口一已 reset。入口二开发账号已存在（seed 跑过一次）。

- **打开登录页。** `browser_navigate` 到 `<web>`，`browser_wait_for` 文字「欢迎回来」。URL 是 `/login`，`[data-testid=workspace-input]` 里是 `acme`。
- **填企业域名。** `browser_click` `[data-testid=workspace-continue]`。出现 `[data-testid=email-input]`。
- **填账号。** `browser_type` 往 `[data-testid=email-input]` 填 `chen@baize.dev`，往 `[data-testid=password-input]` 填 `baize-dev`，再 `browser_click` `[data-testid=login-submit]`。
- **进主窗口。** `browser_wait_for` 文字「小服」（入口一）或库里某个 Bot 的名字（入口二）。`[data-testid=main-window]` 在，入口一的侧栏 `[data-testid=bot-item]` 恰好三个。
- **等稳定再截。** `browser_wait_for` 等侧栏最后一个 Bot 名（入口一是「小采」）。入口一每次登录都会弹「你下线的时候，活没停」的昨夜进展卡，挡住对话区，截别的东西前点 `[data-testid=overnight-card] button:has-text("知道了")` 关掉。
- **密码错误。** 同样两步，密码填 `wrong-password`。`[data-testid=login-error]` 文字是「邮箱或密码不对」，URL 仍是 `/login`。
- **退出。** 点 `[data-testid=account-button]` 再点 `[data-testid=logout]`。`[data-testid=login]` 出现。`browser_navigate` 再开一次 `<web>`，仍落在 `/login`。
- **证明。** 登录前后各截一张。旁证：入口一 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3317/api/me` 不带 cookie 是 401，说明主窗口不是靠缓存进的。

## Gotchas

- 昨夜进展卡每次登录都拉一次，关了只管到这次登录结束，退出再登还会弹。
- 账户区企业名跟着数据走：mock 的 `teamName` 现在是空串，别拿「Acme」当等待标志。
- 登录页一加载就打 `/api/me`，控制台里那条 401 是正常的，不算错误。
- 企业域名这一步不校验，只是界面上的第一屏。不点「继续」就找不到邮箱框。
- P0-6 合入后入口二改在注册页建新账号，本文件跟着改。
