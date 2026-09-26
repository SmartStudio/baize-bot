# 登录与注册

用户在一页里填邮箱和密码进主窗口，没有账号就从登录页去注册页，注册成功不刷新直接进主窗口。密码错了留在登录页并说明原因，邮箱被占用时注册表单里显示服务器原话，退出后刷新也回不到主窗口。

## Sub-features

- `login-ok` 邮箱加密码一步登录进主窗口，侧栏列出 Bot，账户区显示邮箱。
- `login-wrong-password` 密码错误时留在 `/login`，提示「邮箱或密码不对」。
- `logout` 从账户菜单退出，服务端会话作废。
- `register-ok` 注册页新建账号，不刷新页面进主窗口，账户区是新账号的姓名和邮箱。
- `register-duplicate` 已注册的邮箱再注册，留在 `/register`，`[data-testid=register-error]` 显示服务器原话。

## How to get to it (user POV)

- 打开 `<web>`，没登录会被带到 `/login`。
- 登录页表单下面「还没有账号？注册」进 `/register`，注册页底下「返回登录」回来。
- 已登录时点左下角账户，菜单里点退出。

## Driving it with Playwright MCP

Preconditions:

- `stack.sh <入口> doctor` 全是 `✓`。
- 入口一已 reset，mock 只认 `chen@baize.dev` / `baize-dev` 登录。入口二用 `SKILL.md` 账号一节里的账号。

- **打开登录页。** `browser_navigate` 到 `<web>`，`browser_wait_for` 文字「欢迎回来」。URL 是 `/login`，`[data-testid=email-input]` 是空的，`[data-testid=register-link]` 的 href 是 `/register`。
- **登录。** `browser_type` 往 `[data-testid=email-input]` 填邮箱，往 `[data-testid=password-input]` 填密码，再 `browser_click` `[data-testid=login-submit]`。
- **进主窗口。** `browser_wait_for` 文字「小服」（入口一）或库里某个 Bot 的名字（入口二）。`[data-testid=main-window]` 在，入口一的侧栏 `[data-testid=bot-item]` 恰好三个，`[data-testid=account-button]` 里是「陈默」和 `chen@baize.dev`。
- **等稳定再截。** 入口一等侧栏的 `[data-testid=assistant-nav]`「主助理」出现再截，它要等 Bot 列表拉回来才画。
- **退出。** 点 `[data-testid=account-button]` 再点 `[data-testid=logout]`。`[data-testid=login]` 出现。`browser_navigate` 再开一次 `<web>`，仍落在 `/login`。
- **密码错误。** 邮箱照填，密码填 `wrong-password`。`[data-testid=login-error]` 文字是「邮箱或密码不对」，URL 仍是 `/login`。
- **重复邮箱。** 在登录页点 `[data-testid=register-link]`，`browser_wait_for` 文字「创建账号」。`browser_fill_form` 填 `[data-testid=register-email]`（入口一填 `chen@baize.dev`，入口二填库里已有的邮箱）、`[data-testid=register-password]`、`[data-testid=register-name]`，点 `[data-testid=register-submit]`。`[data-testid=register-error]` 文字是「这个邮箱已经注册过了」，URL 仍是 `/register`，填过的邮箱还在框里。
- **注册进主窗口。** 同一页把邮箱改成没用过的（入口一如 `lin@baize.dev`，入口二带时间戳），先 `browser_evaluate` 跑 `() => { window.__registerPage = true }`，再点 `[data-testid=register-submit]`。`browser_wait_for` 等新邮箱出现在账户区。URL 是 `/`，`[data-testid=main-window]` 在，`browser_evaluate` 读 `window.__registerPage` 仍是 `true`，证明没有整页刷新。
- **证明。** 每个动作前后各截一张。旁证：入口一 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3317/api/me` 不带 cookie 是 401，说明主窗口不是靠缓存进的。重复邮箱用 `curl -s -w ' %{http_code}' -H 'content-type: application/json' -d '{"email":"<刚注册的邮箱>","password":"x","name":"x"}' <web>/api/register`，回 409 和 `{"error":"这个邮箱已经注册过了"}`，两个入口都一样。

## Gotchas

- mock 的注册只记邮箱，不记密码，也不给会话绑人。注册完 `/api/me` 回的仍是陈默，所以在入口一注册后刷新页面，账户区会变回 `chen@baize.dev`，侧栏还是那三个预置 Bot。刚注册的账号在 mock 上也登录不了。要看新账号真实的空侧栏，走入口二。
- 入口二新注册的账号没有任何 Bot，侧栏是空的，「进主窗口」那步别等 Bot 名，等账户区的邮箱。
- 注册占用的邮箱只有 `api/test/reset` 能清掉。入口二的注册写的是开发库，删不掉，邮箱每次换新的。
- 登录页一加载就打 `/api/me`，控制台里那条 401 和 `favicon.ico` 404 是正常的。密码错误再加一条 `/api/auth/login` 401，重复邮箱再加一条 `/api/register` 409，都不算错误。
