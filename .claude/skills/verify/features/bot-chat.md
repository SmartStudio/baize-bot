# 和 Bot 对话

每个 Bot 是一个单 Bot 群。用户在输入框发一句话，消息先落进列表，Bot 的回复经 WebSocket 分段推回来拼成一个气泡，跑完出一张花费卡，侧栏摘要跟着换。加号菜单能新建 Bot 并直接进它的对话。

## Sub-features

- `chat-send` 发消息，用户气泡出现。
- `chat-reply` Bot 回复流式推回，同一个气泡拼完整。
- `chat-tool-cost` 工具调用卡从运行中变完成，最后出花费卡。
- `bot-new` 加号菜单「新建 Bot」，侧栏多一个并选中。

## How to get to it (user POV)

- 登录后点侧栏里的 Bot。
- 点侧栏顶部的加号，选「新建 Bot」。

## Driving it with Playwright MCP

Preconditions:

- 已按 [登录](./login.md) 进主窗口。
- 入口二：电脑代理在线（`stack.sh entry2 up --agent`），`.env` 的上游可用。每发一条都花钱，调用方要求了才发。

- **打开 Bot。** `browser_click` `[data-testid=bot-item][data-bot-name="小销"]`。`[data-testid=chat-title]` 是「小销」，入口一的预置历史出现在 `[data-testid=message-list]`。
- **发消息。** `browser_type` 往 `[data-testid=composer-input]` 填 `把 Globex 的报价单再核一遍`，`browser_click` `[data-testid=composer-send]`。列表里多一条 `[data-kind=user]`，文字就是这句。
- **等回复跑完。** `browser_wait_for` 文字「本次花费」。侧栏 `[data-testid=bot-item][data-bot-name="小销"]` 里出现「本次花费」，列表里多一条 `[data-kind=bot]`。
- **新建 Bot。** `browser_click` `[data-testid=new-menu]` 再点 `[data-testid=new-bot]`。`[data-testid=chat-title]` 以「新 Bot」开头，侧栏对应项带 `is-selected`，`[data-testid=bot-name-input]` 里是同一个名字。
- **证明。** 发送前、花费卡出现后各截一张。旁证：入口一 `curl -s http://127.0.0.1:3317/api/bots`，入口二带登录 cookie `curl` `/api/groups/<群 id>/messages`，里面有这句话和 Bot 的回复。

## Gotchas

- 打开 Bot 后历史是异步拉的，先等消息出现再数条数，否则数到空列表。
- 运行中、流式光标、「干活中」只活几百毫秒，截不到就别硬截，看最终的工具卡 `data-status` 和花费卡。
- 入口一的 Bot 回复是 mock 写死的剧本，内容不代表真模型。
