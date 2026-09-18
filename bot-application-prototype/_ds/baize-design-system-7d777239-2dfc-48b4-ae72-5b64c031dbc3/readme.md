# 白泽-Bot (Baize) Design System

企业版桌面 AI 队友客户端的设计系统。产品定位：**白泽是一支 AI 队友团队（Bots）**——每个队友有名字、岗位、颜色和「自己的电脑」（pi 运行时上的 Docker sandbox）。你像给同事发消息一样派活，队友在自己的电脑上登录你的工具、干完带成果回来，需要你点头时才打扰你。用户是企业内的工程师、运营、销售与管理员。

产品概念与主界面范式（桌面 messenger：左侧队友对话列表，右侧气泡对话 + 内嵌电脑卡片）参考了 x.ai/bot 的「AI teammates」叙事与主界面截图（每个 Bot 有自己的电脑、多 Bot 并行、给每个 Bot 一份工作、需要批准时回来找你）；视觉与界面为原创，未复刻其品牌或界面。

命名：白泽（Bǎizé）是中国神话中通晓万物的神兽。英文/代码中使用 **Baize**。

## Sources
- 用户口头简报（2026-09-11）：参考 https://x.ai/bot 的产品概念，做一套**年轻化**的原创设计系统，深浅双主题，中英双语文案，覆盖 Mac 主窗口、队友的电脑（Sandbox/终端/文件）、设置与企业管理、登录/SSO、营销官网。
- 未提供代码库、Figma、Logo 或字体文件。**本系统没有 Logo**：所有需要品牌标识的位置以纯文字「白泽」或「Baize」呈现。
- 未复刻任何第三方界面或商标；视觉方向为独立设计。

## Products / surfaces
1. **Baize Desktop (macOS)** — 主窗口：队友与对话侧栏 + 对话流 + 右侧「队友的电脑」面板（屏幕 / 终端 / 文件 / 成果）；招募队友（岗位市场）；设置与企业管理；登录/SSO。
2. **Baize Web** — 营销官网（企业版落地页）。

## Content fundamentals
- **叙事**：Bot = 队友，不是工具。用「队友」「入职」「派活」「自己的电脑」「点头」这类办公室词汇；避免「容器」「会话」「执行」出现在一级界面（留给设置页与终端）。
- **双语**：中文为主，英文作副标题或术语（`队友 · Bots`）。代码、命令、路径、模型名永远英文等宽。
- **语气**：像靠谱的年轻同事在聊天：直接、轻快、有人味。短句，可以口语（「推上去了」「绿了我叫你」）。不用感叹号，不用 emoji，不官腔，不用「您」。
- **人称**：对用户「你」。Bot 自称「我」，有名字（小修、小研…）。系统文案无人称。
- **大小写**：英文 Sentence case；产品名 `Baize`；缩写保持 `SSO` `API`。
- **数字与时间**：等宽数字；相对时间「12 分钟前」，超一天 `09-10 14:32`。
- 示例：
  - 空状态：「今天把什么活交出去？」
  - 运行中：「小修正在自己的电脑上干活…」
  - 批准条：「需要你点头 · Needs your approval」
  - 错误：「命令超时（120s）。看看日志或重试。」
  - 按钮：「入职」「批准」「拒绝」「接管」「招募」
  - 官网标题：「认识白泽 — 可以把真活交给的 AI 队友」

## Visual foundations
- **调色**：暖纸色中性灰（`#0f0e0c` → `#faf7f2`），**浅色为默认**，`[data-theme="dark"]` 切深色。**橘色 tangerine**（`--accent` oklch 0.75 0.18 55）是品牌色：主按钮填充、字标胶囊、运行状态、焦点环。`--accent-strong` 用于浅底上的文字链接。
- **队友色相**：7 个 `--bot-*`（coral / tangerine / lime / mint / sky / violet / pink）+ 对应 `-soft` 固定浅色底。每个 Bot 固定一个色相，用于头像、对话强调、岗位卡片底色。这是界面里唯一的多色来源；系统 UI 本身保持中性。
- **色彩规则**：界面外壳全部中性（冷灰底 `#F4F6F8`、白卡面、`#E8EBF0` 描边、选中态灰底 `--bg-selected`、主按钮深灰）。彩色只来自两处：队友色相（头像）与语义状态。语义色六组：蓝=当前/进行中（`--accent`，也用于时间指针与链接）、绿=健康/完成、紫=编排/工作流、黄=行动优先级、橙=等待确认、红=异常；各带 `-soft` 浅底。颜色必须与文字或图标同时出现。
- **字体**：单一无衬线族——Inter / PingFang SC / Noto Sans SC（`--font-sans`，`--font-display` 指向同一族），Geist Mono 用于 ID、Trace、代码。Display 500 字重、-0.02em；标题 600；正文 400/1.5；标签 500–600；指标 `--type-metric` 600/1.1。Display 72px，标题 26–48px，正文 14/1.65，UI 13/500。
- **间距**：2/4/6/8/12/16/20/24/32/40/56/80。控件高度 30/36/44。侧栏 272，右面板 400，输入框最大 760。
- **圆角**：大而软。按钮与输入胶囊 999，卡片 16，面板/弹窗 20，Composer 与 hero 容器 28，窗口 14。
- **边框与阴影**：1px hairline 分隔；卡片默认 hairline 无阴影，hover 抬起 1px + `--shadow-md`；浮层 `--shadow-lg`。
- **背景**：纯色平面。官网 hero 允许一处极淡橘色径向光晕；队友卡片使用 `-soft` 色相底。无图片、纹理、网格。
- **头像**：圆角方形（32% 圆角）、实色色相底、首字 600、可叠放（负 margin + app 底色描边）。状态点：橘=干活中（脉冲）、绿=在线、红=卡住、灰=离线。
- **透明与模糊**：仅官网导航与弹窗遮罩使用毛玻璃。
- **动效**：进入 fade + 6px + scale .98，200ms ease-out；头像与徽章可用 spring（`--ease-spring`）弹入；运行状态 1.2s 脉冲；按下 scale .98。无打字机光标。
- **Hover**：`--bg-hover` 叠加；卡片抬起。**Press**：`--bg-active` + scale .98。**Focus**：橘色 2px 环。**Disabled**：opacity .4。
- **布局**：三栏（队友与对话 / 对话流 / 队友的电脑），左右可折叠。标题栏 44px，红绿灯留 80px。
- **消息（messenger 范式）**：两栏，左侧每个队友一个对话（头像 + 名字 + 最后一句 + 时间），右侧对话流。Bot 消息 = 浅灰气泡左对齐（`--bg-inset`，16px 圆角，15px 字号）；用户消息 = 黑色气泡右对齐；时间与系统事件（「已改名为 …」）居中小字；「电脑」卡片内嵌在对话里（标题 + 状态 badge + 一句话 + 屏幕预览）；工具调用与批准条同宽 72%。1:1 对话不显示头像，群聊显示。输入框为胶囊：左 +，右麦克风（有文字时变橘色发送箭头）。
- **终端**：近黑底，提示符橘色，12px Geist Mono / 1.6。

## Iconography
- 图标集：**Lucide**（CDN，`https://unpkg.com/lucide@latest`），1.5px 描边，16px 为 UI 默认、20px 用于侧栏/空状态、14px 用于 badge 内。颜色继承 `currentColor`，默认 `--fg-3`，hover/选中 `--fg-1`。
- 这是替代方案：品牌未提供自有图标。若日后有自有图标集，替换 `components/core/Icon.jsx` 的实现即可。
- 无图标字体、无 PNG 图标、无 emoji。少数 Unicode 字符作为排版符号：`·` 分隔中英文，`→` 表示进入/跳转，`⌘` `⇧` `⏎` 表示快捷键。
- 品牌标识：无 Logo。字标为 `白泽`（Inter 600, -0.02em）或 `Baize`；官网、登录页与控制台使用深灰圆角方块「白」+ 白泽。

## Intentional additions
标准组件集之外，为 Agent 产品增加：
- `Icon` — Lucide 包装器，统一尺寸与描边。
- `BotAvatar` — 队友头像（色相 + 首字 + 状态点）。
- `Message` — 对话消息（Bot 灰气泡 / 用户黑气泡 / 居中时间与系统事件）。
- `ComputerCard` — 对话内嵌的「电脑」卡片（状态 + 屏幕预览）。
- `ToolCall` — Agent 工具调用卡片（命令、状态、可展开输出、批准/拒绝）。
- `Composer` — 底部输入框（附件、模型选择、发送/停止）。
- `Terminal` — Sandbox 终端输出块。
- `StatusDot` — 运行/空闲/错误状态点。

## Index
- `styles.css` — 全局入口（只含 @import）。
- `tokens/` — `fonts.css` `colors.css` `typography.css` `spacing.css` `effects.css` `base.css`
- `guidelines/` — 基础规范卡片（Colors / Type / Spacing / Effects / Brand）。
- `components/core/` — Button, IconButton, Icon, BotAvatar, Badge, Tag, StatusDot, Tooltip
- `components/forms/` — Input, Select, Checkbox, Radio, Switch
- `components/layout/` — Card, Tabs, Dialog, Toast
- `components/agent/` — Message, ComputerCard, ToolCall, Composer, Terminal
- `ui_kits/desktop/` — macOS 主窗口（对话 + Sandbox + 文件）、设置与企业管理、登录/SSO。`index.html` + `DesktopApp.jsx` `Sidebar.jsx` `ThreadView.jsx` `BotPanel.jsx` `HireView.jsx` `SettingsView.jsx` `LoginView.jsx` `data.js`
- `ui_kits/website/` — 营销官网。`index.html` + `SiteApp.jsx` `Nav.jsx` `Hero.jsx` `Sections.jsx`
- 组件运行时命名空间：`window.BaizeDesignSystem_7d7772`；卡片与 UI kit 需先加载 `https://unpkg.com/lucide@latest` 再加载 `_ds_bundle.js`。

## Caveats
- 字体来自 Google Fonts（`@import`），未打包 woff2；离线环境需自行下载并改为 `@font-face`。
- 无 Logo，无自有图标集（Lucide 为替代）。
- 产品概念参考 x.ai/bot 的文字叙事；未读取其源码或设计稿，视觉为原创。
- `thumbnail.html` — 项目缩略图
- `SKILL.md` — Agent Skill 入口
