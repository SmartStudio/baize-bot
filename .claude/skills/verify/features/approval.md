# 审批卡

Bot 走到要点头的工具（比如对外发邮件）时，群里出一张审批卡，工具卡停在运行中，侧栏记一笔「等你点头 1」。点批准这一步接着跑；点拒绝这一步被拦下，卡上留结论，角标归零，运行照样结账。

## Sub-features

- `approval-request` 出卡，状态 `pending`，侧栏角标。
- `approval-approve` 批准后工具卡变完成。
- `approval-reject` 拒绝后卡变 `rejected`，工具卡 `blocked`，角标消失。
- `approval-reply` 在群里回「批准」「拒绝」和点按钮等价。

## How to get to it (user POV)

- 在 Bot 的对话里让它做一件对外的事，卡自己出现。
- 侧栏看到「等你点头」时点进那个 Bot。

## Driving it with Playwright MCP

Preconditions:

- 已按 [登录](./login.md) 进主窗口。入口一已 reset。
- 入口二：电脑代理在线，Bot 有一个标了要审批的工具连接，上游真会调用它。只在调用方要求时走。

- **触发审批。** 打开 `[data-testid=bot-item][data-bot-name="小销"]`，`[data-testid=composer-input]` 填 `把报价单发给 Lisa` 发送。入口一的 mock 见到「发」「付」「退款」就出卡，「发」是对外发送，其余是付钱。
- **看卡。** `browser_wait_for` 文字「对外发送」。`[data-testid=approval-card]` 的 `data-status` 是 `pending`，卡上有 `[data-testid=approval-approve]` 和 `[data-testid=approval-reject]`，`[data-testid=tool-call-card]` 的 `data-status` 是 `running`，侧栏小销那一项的 `[data-testid=bot-pending]` 是「等你点头 1」。
- **拒绝。** 点 `[data-testid=approval-reject]`。卡的 `data-status` 变 `rejected`，`[data-testid=approval-decided]` 是「不同意」，`[data-testid=bot-pending]` 消失，工具卡 `data-status` 是 `blocked`，出现 `[data-testid=cost-card]`。
- **批准。** reset 后重来一遍，点 `[data-testid=approval-approve]`。卡的 `data-status` 变 `approved`，工具卡变 `ok`。
- **证明。** 出卡、点完各截一张。`data-status` 用 `browser_evaluate` 读出来写进报告。旁证：`curl` `/api/groups/<群 id>/messages`，`approvals` 里那一条的 `status` 和卡上一致。

## Gotchas

- 入口一里任何带「发」「付」「退款」的消息都会出审批卡，驱动别的功能时避开这几个字。
- 刷新后审批卡从历史里回来，角标不能变成 2。验刷新时先等卡出现再数角标。
- 按钮点过就锁，一次只发得出一个结论。连点不算 bug。
- 审批卡正文只有 id，状态在 `approvals` 行上，只随 `approval_updated` 推。看卡的 `data-status`，不看正文文字。
