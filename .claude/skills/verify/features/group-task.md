# 建群与任务卡

用户从加号建一个多 Bot 群，写主题、选 2 到 6 个 Bot、写说明。群顶部钉着一张带 `T-` 编号的任务卡，有清单、截止和当前经手。在群里 @ 一个 Bot，只有它回话，它成为当前经手并勾清单。

## Sub-features

- `group-new` 建群，侧栏多一个群并选中。
- `task-card` 任务卡编号由服务端发，清单和当前经手可见。
- `group-mention` 打 `@` 弹成员名单，被 @ 的 Bot 接活。
- `checklist-toggle` 勾清单项，刷新后还在。

## How to get to it (user POV)

- 点侧栏顶部的加号，选「建群」。
- 点侧栏「群」段里的群。

## Driving it with Playwright MCP

Preconditions:

- 已按 [登录](./login.md) 进主窗口。入口一已 reset，预置群「Globex X3 × 200 订单」的清单是 0 / 5。

- **开建群弹层。** `browser_click` `[data-testid=new-menu]` 再点 `[data-testid=new-group]`。`[data-testid=new-group-dialog]` 出现，`[data-testid=group-submit]` 不可点。
- **填表。** `[data-testid=group-title]` 填 `Globex X3 × 200 补货`；点 `[data-testid=group-member][data-bot-name="小服"]` 和 `[data-testid=group-member][data-bot-name="小采"]`；`[data-testid=group-summary]` 填 `X3 现货不够 200 台，先补货再答复客户。`；点 `[data-testid=group-submit]`。
- **看任务卡。** 弹层消失，`[data-testid=chat-title]` 是群名，`[data-testid=chat-subtitle]` 含「你 + 2 个 Bot」，`[data-testid=task-number]` 是 `T-2482`（入口一），`[data-testid=task-current]` 是「当前 还没人接手」。
- **@ 派活。** 打开预置群 `[data-testid=group-item][data-group-title="Globex X3 × 200 订单"]`，等 `[data-testid=task-card]`。`browser_type` 往 `[data-testid=composer-input]` 填 `@小`（`slowly: true`），`[data-testid=mention-menu]` 出现，点 `[data-testid=mention-option][data-bot-name="小销"]`，再把输入改成 `@小销 查一下 X3 的现货还有多少` 发送。
- **看结果。** 等 `[data-testid=cost-card]` 出现。`[data-testid=task-current]` 是「当前 小销」，`[data-testid=task-progress]` 是「清单 1 / 5」，列表里只有 `[data-testid=bot-source][data-bot-name="小销"]`。
- **证明。** 建群后、派活后各截一张。旁证：`curl` `/api/groups`（入口二带 cookie），新群和它的任务编号都在。

## Gotchas

- 编号由服务端发，入口一 reset 后从 `T-2482` 起，入口二取决于库里已有多少张卡，别断言固定值。
- 没选成员时提交按钮是灰的，不是坏了。
- `@名` 要从名单里选中才会进 `mentions`，手打全名不一定算派活。
