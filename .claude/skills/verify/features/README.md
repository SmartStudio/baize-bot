# 白泽 Bot 验证地图

这里是验证白泽 Bot 用户可见行为的清单。先读这页，再按功能文件点。

## 基线前提

- 用 `../scripts/stack.sh entry1 up` 或 `entry2 up` 起环境，`doctor` 全是 `✓` 才开始。
- 入口一的网址是 `http://localhost:5377`，入口二是 `http://localhost:5173`。下文写 `<web>`。
- 入口一每次从预置状态开始：`curl -X POST http://127.0.0.1:3317/api/test/reset` 回 204。预置是三个 Bot（小服、小销、小采）和一个多 Bot 群「Globex X3 × 200 订单」。
- 入口二的数据是开发库里现有的，没有预置可倒回。会写库的步骤（发消息、建群、点审批）只在调用方明确要的时候做。
- 不驱动不是自己起的实例。

## 驱动约定

- 用 Playwright MCP，`target` 写 `[data-testid=...]`，列表项加 `data-bot-name`、`data-group-title` 这类属性。
- 等状态用 `browser_wait_for` 等页面上的中文，不等固定秒数。
- 卡片状态看 `data-status`，用 `browser_evaluate` 读。
- 现成剧本在 `packages/web/e2e/app.spec.ts`，这里的步骤都能在里面找到对应用例。

## 证明与跳过

- 截动作前和动作后两张，存调用方给的 `.audit/v1/<单元>/<名>.png`，截完 Read 看图。
- 写操作要有不靠截图的旁证：入口一 `curl` mock 接口，入口二带 cookie `curl` 真控制面。
- 走不通的入口写清试了什么命令、缺哪个前提。不拿另一条路冒充。

## 功能文件格式

每个文件一个 H1、一段话说用户看得见的行为，然后四个 H2，顺序固定：`Sub-features`、`How to get to it (user POV)`、`Driving it with Playwright MCP`（以 `Preconditions:` 开头）、`Gotchas`。

## 功能

- [登录与注册](./login.md) 邮箱加密码一步登录、密码错误、退出、注册进主窗口、重复邮箱。
- [和 Bot 对话](./bot-chat.md) 单 Bot 群发消息、流式回复、工具卡和花费卡、新建 Bot。
- [建群与任务卡](./group-task.md) 建多 Bot 群、任务卡编号、@ 派活、清单勾选。
- [审批卡](./approval.md) 要点头的工具出卡、批准、拒绝、侧栏角标。
