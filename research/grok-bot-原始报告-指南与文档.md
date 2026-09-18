# Grok Bot 官方资料研究报告

> 资料来源：x.ai/bot/guides/*、x.ai/news/*、x.ai/bot/marketplace、docs.x.ai/grok-bot/*、cursor.com/docs/grok-bot/*、cursor.com/help/grok-bot/plans。
> 关键背景事实：Grok Bot 虽以 xAI（站内自称 "SpaceXAI"）品牌发布，但**运行在 Cursor / Anysphere 的基础设施上**，账号体系、计费、Dashboard、合规主体全部是 Cursor/Anysphere。docs.x.ai/grok-bot/* 与 cursor.com/docs/grok-bot/* 是同一套文档的两个镜像。这一点对"企业版"设计影响极大。

---

## 1. 产品定位

**官方 tagline（x.ai/news/introducing-grok-bot）：**
> "Grok Bot is your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7."

**文档版定义（docs.x.ai/grok-bot/overview）：**
> "AI teammates with names, jobs, and context that compounds over time."

**指南版定义（Grok Bot 101，2026-09-11）：**
> "Grok Bot is an agent with a computer."

**企业版公告（x.ai/news/grok-bot-for-enterprise，2026-09-03）：**
> "Grok Bot is your team of helpful AI teammates. You delegate real tasks to them and they carry the job through end to end, working autonomously around the clock inside the same tools you use."

**与 chat 的对比框架（官方反复强调的四点差异）：**
- **不是聊天草稿，是在真实工具里完成**：每个 Bot 有一台持久云电脑，带 browser / filesystem / terminal，"tasks finish in your real tools instead of as chat drafts"。
- **不需要 API**：Bot 像人一样登录你已在用的工具（sign into the tools you already use），跨 app 工作。
- **常驻、异步**：关掉笔记本/手机不影响后台 turn 或 routine 继续跑。
- **上下文复利**：有名字的 Bot 跨会话保留 "memory, files, browser sessions, and preferences"。

**目标用户：** 明确是**非工程岗为主的全职能白领**——文档里的 use cases 是 Sales、Recruiting、Paid Media、Finance/Expense、Support、Product、Chief of Staff、Engineering。Identity 文档甚至专门讲"如何把 Cursor SSO app 分配给工程以外的团队，让非工程师也能通过 Cursor team membership 用上 Grok Bot"。

**时间线：**
- 2026-08-11 首发（early beta），最早是内部原型，xAI 内部 sales/marketing/ops/engineering 在用。
- 2026-08-26 扩展到 SuperGrok、Cursor Pro、Cursor Teams。
- 2026-09-03 Enterprise 版发布（此前是 waitlist）。

---

## 2. 核心概念与对象模型

### 2.1 Bot
- **定义（docs/bots）**："a durable AI teammate with a name, a job, its own conversation, and working context that develops over time."
- **配置字段**：Name、Label、Description（"Rules and boundaries that should remain true"）、Avatar、通知偏好。入口：**Bot actions → Edit Profile**；Bot 级设置也在 **View conversation details**。
- **生命周期**：
  - 创建：侧边栏 **New** 或 `Cmd/Ctrl+N` → "Create new Bot"，或直接输入名字确认；默认名 "New Bot"。
  - 编辑：随时改 name/description/settings。官方建议"发现稳定的偏好或边界时就写进 description"。
  - 可见性：**Pin**（固定在侧边栏）/ **Hide from sidebar**（隐藏但不删除，在 **Hidden Bots** 区恢复）。
  - **Duplicate**：复制 profile、settings、skills、routines、avatar；**不复制** conversation history、learned memory、attachments。
  - **Delete**：删除 profile、conversation、routines；后端留存遵循 Cursor 条款。
- **设计原则**："Focused Bots build more useful context than one catch-all Bot."（宁可多个专精 Bot，不要一个万能 Bot）

### 2.2 Computer（计算机）
- 见第 3 节。核心事实：**一个用户一台 computer，账号下所有 Bot 共享**；每个 Bot 有自己的 **screen**，但"screens are not security boundaries"。

### 2.3 Conversation / Group Chat（会话与群聊）
- 每个 Bot 有自己的 conversation。
- **Group chat**：2–6 个 Bot 共同完成 "one shared outcome and visible handoffs"。用 `@` mention 指派，支持 `@everyone`。
- 支持 threads（对具体结果给反馈）、reactions（轻量确认）、粘贴文本/链接/图片、附加本地文件。
- **搜索**：跨历史会话搜索，可"find files, links, and routines"。移动端搜索范围：Messages、Bots、Group Chats、Files、Routines。
- **打断**：直接发消息会 "takes priority over background work"；发 **"Stop now"** 立即停止，但**不回滚已完成的动作**。

### 2.4 Skill（技能）
- **定义**："A reusable set of instructions for how to do a task."
- 内容包含：steps、decision rules、expected output、safety boundaries。
- **作用域：workspace 级，所有 Bot 共享**（但执行时该 Bot 需要有对应 connector 或登录态）。
- 引用方式：聊天中用 `/` 引用已保存的 skill。
- **生命周期（官方四步）**：1) 手动跑一次 → 2) 把方法保存为 skill → 3) 在安全样例上测试 → 4) 用 routine 投产。
- **Teach a task（示范教学）**：在 computer view 里录制一段 browser workflow，Bot 把演示转成 **draft skill** 供 review + test。**录制上限 10 分钟**，灰度发布中（"The rollout is gradual"）。**移动端不支持 teach-by-demonstration**。

### 2.5 Routine（例程 / 定时任务）
- **定义**：按 schedule 或事件触发 Bot 的工作流。**Routine 归属于具体某个 Bot**。
- **字段/设置**：Schedule and timezone、Input source（数据来源）、**Approval boundary**（哪些动作需要人工放行）、Failure handling（源数据缺失时的行为）。
- **管理入口**：Bot → **View conversation details** → **Routines**。可 enable/pause、run test、编辑 schedule 或 instruction、查看 run history。
- **限制**：**每个 Bot 最多 50 个 routine；每个 routine 保留最近 20 条 run 记录**。
- **警告**：test run 会执行真实外部动作。
- 移动端只能查看 routine 和 run history，**编辑 schedule/instruction 与 test 必须在桌面端**。

### 2.6 Trigger / Automation（触发器）
- Event-based routine 由外部通知启动，例如 Slack 消息、GitHub 更新，**通过 Cursor 账号级 integrations 接入，与普通 plugin 是两套东西**。

### 2.7 Connector / Plugin（连接器 / 插件）
- 来自 **Marketplace** 的 plugin，给受支持服务提供结构化访问。
- 聊天中用 `@` 挂载 connector。
- **Connector 是账号级（account-wide）**，不是 Bot 级。
- 支持同一服务的**多账号**连接。
- Token 只留在 Cursor 后端，**永不下发到 computer**，Bot 调用工具但拿不到 OAuth token。
- 管理入口：**Marketplace → Your plugins**；部分 connector 需要组织提供的变量。

### 2.8 Memory（记忆）
- "A Bot can retain stable working preferences, important facts, and summaries from its work."
- **明确声明 memory 不是权威数据源**（"Memory is not authoritative"）：重要决策需另行核对最新数据，过期假设需要直接纠正。
- Duplicate Bot 不带 memory；Template 分享时排除 personal/internal memory。

### 2.9 Files（文件）
- 共享工作区 **`/workspace`** 存放持久项目文件。
- 系统升级（image update）会保留文件和 browser state；**临时目录和未提交的应用状态视为可替换**。
- 附件限制：**单个 25 MB（视频 200 MB），一次最多 6 个附件**；不能处理加密/带密码的文件。

### 2.10 Approvals / Auto-review Rules
- 见第 4 节。

### 2.11 Template（模板）
- **定义（Templates for Grok Bot 指南）**："Templates share a bot as a recipe, not a clone." / "If I give you a recipe, you will use it to create your own version of that meal." / "Templates are an anonymized, private version of the bot that you're sharing."
- **包含**：bot instructions/context、memories（排除个人/内部的）、first-party plugins and integrations、routine triggers。
- **不包含**：个人隐私信息、敏感代码与脚本、custom MCP servers（除非单独配置）、API keys and secrets。
- **发布流程**：Bot settings → **Share as Template** → 选 team-only 或 public → **Publish** → 复制链接。
- **安装流程**：模板页点 **Add to Grok Bot** → 查看包含的 integrations 和 context → **Add Bot**。
- 适用 **Third-party bot terms**（https://x.ai/legal/bot-sharing-terms）。
- 官方提醒：分享前剔除 API keys、URLs、customer data。

### 2.12 Teams / Groups
- 见第 9 节。

---

## 3. 执行环境

### 3.1 云电脑，不是本机
> "Grok Bot works from a persistent cloud computer. It can use a browser, command line, files, and connected tools."

- 云端托管，**关笔记本/关 App/关手机都不会停掉 background turn 或 routine**。
- **每个用户一台 computer（per-user，不是 per-Bot）**；该用户所有 Bot 共享：
  - persistent browser cookies and sessions
  - shared file access
  - shared command-line credentials
  - **各自独立的 screen 用于并行工作，但明确声明"screens are not security boundaries"**
- 并行度：多个 Bot 可同时推理、用 connector、处理文件、协作；**但一个 Bot 同一时刻只能在自己的 screen 上跑一个 computer-use 任务**。

### 3.2 隔离模型
- **每用户一个 Firecracker microVM**，"with its own kernel, memory, and virtual devices"，与其他用户**硬件级隔离**。
- 但同一用户内部：凭证与文件在该用户所有 Bot/会话间互通。

### 3.3 本机执行（local execution）
- 成员可通过桌面 App 让 Bot **在本地机器上执行**，这条路径有**独立的控制项**（文件操作、命令执行），**与云端的 Auto Review 是两套权限模型**。
- 设置位置：**Settings → General → Bot → Execution on Local Computer**，默认**逐条命令审批**。
- 管理端可设三档：**Always allow（默认）/ Ask every time / Never allow**。

### 3.4 网络与隧道
- 出网走 **Cursor 的 shared static egress IP ranges**；**不提供 per-customer 专属 IP**；需要具体 IP 段要找 account team 要。
- **两种进内网的方式**：
  1. **Route egress through this desktop**（Settings → Computer）：把 Bot 的 web 流量走成员本机桌面，用本机 IP 与本机可达网络。企业侧有 **Allow Local Egress** 开关（Enterprise only，默认开）。
  2. **Team Setup manifest**（Enterprise only）：管理员用 shell 脚本在全队 computer 上装网络客户端。
- **官方验证过的方案**：**Tailscale**（每台 computer 跑 Tailscale，经内网 exit node）、**Cloudflare Tunnel**（内网跑 `cloudflared` connector，经 Cloudflare edge + Access 保护，按服务粒度）。其他："Any client your team can install and run on Debian-based Linux from a shell script."（→ 底层是 Debian 系 Linux）
- 官方定性："a pattern you operate, not a Cursor-managed network mode."
- Team Setup 脚本：30 分钟超时、失败重试；运行中的 computer **约每天刷新一次 manifest**；新 computer 启动时应用；可配 check script 避免重复安装。
- **严重警告**："Do not include secrets. Setup scripts run as the computer user on every team computer, and manifests are plain text applied to your whole fleet."
- **TLS 拦截网关问题**：网关如果对 `*.cursorvm.com` 做 TLS inspection 会导致 setup 卡死，必须在所有 profile 中放行并豁免检查。

### 3.5 Takeover / 接管
- 入口叫 **Agent Computer**：可以看 Bot 在做什么，并**接管控制权**。
- Bot 会在以下情况请求你接管：
  > "A password or passkey, Two-factor authentication, A CAPTCHA, A payment or identity check, A site that explicitly requires a human."
- 流程：在 Agent Computer 里 take control → 自己完成敏感步骤 → 归还控制权。
- 另有 **secure secret request**：Bot 弹出表单，输入值被 **mask**，**不进 transcript、不进模型**。
- 需要手动输入的登录，Bot 可以呈现表单并自动回填你的回答。
- **硬件安全密钥（YubiKey）**：**Settings → General → Security Key → "Use hardware security keys"**，**macOS/Windows 默认开启**。

### 3.6 Computer 生命周期
- 空闲会**自动 hibernate**，"hibernation is not deletion"。
- image 更新时在新系统镜像上重建，保留文件。
- 故障恢复顺序（成员侧）：**Retry → Restart app → Recover computer → Update → Reset（最后手段）**。"Recover computer" 和 "Update" 保留文件与登录态；**"Reset" 可能丢失最近工作**。
- 成员会看到 "Starting your computer" / "Updating your computer" / "Updating Grok Bot's Computer" 状态。
- 管理员侧（见第 9 节）有 **Recreate / Terminate**。

### 3.7 明确不支持的部署形态
> "on-premises deployment, deployment inside your own perimeter, and bring-your-own-image deployment" —— 全部不支持。

---

## 4. 审批与安全

### 4.1 审批 UI
- **桌面端**：**Allow once** / **Deny** / **Always allow**（保存为一条规则）。
- **移动端**：Auto-review sheet 上是 **Allow** / **Deny** / **Always allow**（当有规则被提议时）；本地命令卡片只有 **Allow once** / **Deny**。
- 关键语义：**"Approvals control the specific action proposed, not work already completed."**（审批只管这一个待执行动作，不能撤回已发生的）
- 官方提醒："never confirm actions whose target you cannot identify."

### 4.2 Auto Review（自动审查层）
- 一个**独立的审查模型**，评估高风险动作，可以 **permit / require approval / deny**。
- **覆盖范围**：shell commands、plugin calls、computer use、automation writes、delegation。
- **明确不覆盖全部副作用**（"but not all side effects"）。

### 4.3 Auto-review Rules（规则）
- 位置：**Settings → General → Bot → Auto-review**。
- 两类规则：
  - **"Ask first"**：匹配即**永远**拦下来要人确认。
  - **"Allow automatically"**：**仅当 reviewer 判断没有其他 stop reason 时**才放行。
- **冲突时 "Ask first" 优先**（"Ask first wins when rules conflict"）。
- 规则**存在账号上，跨所有已登录桌面生效**。
- **个人规则叠加在团队规则之上，但只能更严，不能放宽**。
- 团队规则在成员设置里显示为 **locked rows**。
- 写规则建议：要窄，例 "Ask first before sending external email"，而不是 "allow everything in the browser"。
- 规则也可以用**自然语言**表达权限边界（Grok Bot 101：Permission rules defined in natural language + allow/block lists to guide reviewer decisions）。

### 4.4 永远需要确认的动作（官方清单）
- Sending messages or invitations（发消息/发邀请）
- Publishing content（发布内容）
- Purchases and financial transfers（购买与转账）
- Deleting or overwriting data（删除或覆盖数据）
- Changing permissions（修改权限）
- Production changes（生产变更）
- Accepting legal terms（接受法律条款）

### 4.5 凭证与身份
- **"a Bot can never hold more access than the person it belongs to."**（Bot 权限不超过其所属成员）
- **Bot 没有独立身份**："every action stays attributable to a named member."（所有动作可归因到具名成员）
  - **唯一例外**：团队托管的 connector，可能用团队或 service-account 凭证。
- Connector token 只在 Cursor 后端，**不下发到 computer**。
- 密码/2FA/支付等敏感步骤**必须由人完成**。

### 4.6 网络与模型管控（均为 Enterprise only）
- **Network Policy 四种模式**：
  1. **No Policy (Allow All)** —— 未配策略的团队默认
  2. **Allow All Network Access** —— 显式放开
  3. **Defaults + Team Allowlist** —— Cursor 默认清单 + 自定义
  4. **Team Allowlist Only** —— 仅自定义清单 + 系统必需目的地
- 目的地可以是 **web domains，也可以是带端口的 IP ranges（raw connections）**，**条目数无上限**。
- **Directory groups 可设独立网络策略覆盖团队设置；lock 可强制全组织统一。**
- **Model Allowlist**：团队模型白名单"honored by default"，但 **onboarding 会弹出一个确认，声明 Grok Bot 可能不遵守它**（"Grok Bot may not follow it"）——即**无强制保证**。
- **Connector Policy 与 Network Policy 是两层**：**屏蔽一个 plugin 不等于屏蔽它的网站**，要两层都关才真正断路。
- **MCP Allowlist**：Enterprise only，管理可信 MCP server。

### 4.7 数据处理与隐私
- **必须开启云端数据存储**；**Legacy Privacy Mode 不支持**，账号必须先迁到受支持的 Cursor data setting，Grok Bot 才能启动。
- **Privacy Mode**：开启后 "customer data is not used for training"，对团队成员在队期间生效。训练退出跟随 Cursor 账号偏好。
- **Zero Data Retention**：模型供应商不保留 prompt/output；但供应商可能跑 "abuse and safety classifiers, and flagged data may be stored for investigation"。
- **模型选择由 Cursor 管理，无客户可见的 model picker**。"Usage analytics show the model that served each request, including failovers, and billing follows the serving model."
- **本地存储**：成员 computer 的文件、browser session、保存内容持久化在 durable disk 上，跨会话保留。**Connector token 从不落盘到 computer**。
- **删除时限**：按 DPA，"deleted or returned within 30 days of written direction after the service ends."
- **备份**：每日加密备份复制到独立恢复设施。
- **不支持**：per-organization retention policy、单台 computer 的 point-in-time restore。
- **数据驻留**：computer **默认跑在美国**；**Cursor 的 data residency 计划默认不适用于 Grok Bot**；要书面承诺需找 account team。
- **合规认证**：Anysphere 持有 **ISO/IEC 27001** 与 **ISO/IEC 42001**（AI 管理体系），由 **Schellman** 颁发，**两者均覆盖 Grok Bot 当前范围**。证书与报告在 **trust.cursor.com**。
- **subprocessor 限制**：如果合同限制数据处理方，rollout 前需联系 account team。

---

## 5. 集成与触发器

### 5.1 触发方式（Grok Bot 101 明确的三种交互方式）
1. **Chat messaging**（直接聊天）
2. **Routines and triggers**（定时任务 或 来自 Slack / GitHub 等的事件监听）
3. **Inter-bot communication**（Bot 之间互相调用）

### 5.2 事件触发
- Event-based routine 由外部通知启动：**Slack messages、GitHub updates**，**通过 Cursor 账号级 integrations 接入，区别于普通 plugin**。
- 文档只点名了 Slack 和 GitHub 两类事件源；**未见 webhook / email inbound / Sentry / PagerDuty / Linear 的原生 trigger 文档**（这些只在 use cases 里以泛称形式出现，如 "issue tracker"、"incident tooling"、"observability"）。

### 5.3 文档与指南中点名的集成（按来源归类）

**docs.x.ai/grok-bot/use-cases（8 个官方 use case，工具多为泛称）：**
| Use case | 官方描述 | 工具 |
|---|---|---|
| Sales Outbound | "account research, contact prioritization, and review-ready outreach" | CRM、product-intent sources、company websites、email、professional networks |
| Talent Scout | "sourcing, candidate research, outreach drafts, and scheduling preparation" | ATS、approved sourcing tools、email、calendar |
| Paid Media | "campaign monitoring and budget recommendations" | 广告平台、analytics、budget spreadsheet、Slack |
| Expense Manager | "weekly expense reconciliation and missing-information follow-up" | expense system、email、shared drive、finance spreadsheets |
| Product Performance | "targeted performance investigations with evidence" | observability、analytics、incident tooling、source-control links |
| Bug Reproduction | "turning reports into reliable reproduction packs" | issue tracker、staging environment、browser、network tools |
| Account Health | "risk and expansion signals across a customer portfolio" | CRM、product usage、support、billing、CS notes |
| Chief of Staff | "a source-linked digest of what changed and what needs attention" | Slack、email、calendar、meeting notes、planning documents |

**Grok Bot 101：** Gmail、Google Calendar、Google Drive；支持 **MCP servers、plugins、skills**；单服务可连**多账号**。

**Grok Bot for Engineering：** Slack、Notion、**Cursor Cloud（cloud agents + private worker machines）**、GitHub（PR review / merge / CI）、**Chrome DevTools**（驱动端到端栈）、**Apple Accessibility**（iOS 自动化）、**SpaceXAI Voice API**（听写测试）。

**Grok Bot for Support：** Stripe、ticketing platform、email、内外部 knowledge base。

**Grok Bot for GTM：** Salesforce、Gmail、Calendar、Sheets、Drive、Slack、Notion、**Granola**（会议转录）、Figma、X、LinkedIn、data warehouse、**Gong**、**Glean**、Grokipedia。

**Grok Bot for PMs：** Slack、Gmail、Granola、Gong、**Databricks**、Notion、**Plain**、**Intercom**、Cloud Agents、Raspberry Pi、Amazon。

### 5.4 MCP
- **Grok Bot 支持 MCP servers**（Grok Bot 101 明确提到 "Supports MCP servers, plugins, and skills"）。
- **MCP Allowlist 是 Enterprise only** 的管理项，用于管理可信 server。
- Template **不包含 custom MCP servers**（需接收方单独配置）。
- 注：`docs.x.ai/grok-bot/plugins` 返回 **404**，Grok Bot 专属的 plugin/MCP 详细文档页未公开；Marketplace 与 connector policy 由 Cursor Dashboard 的 **Plugins 页 / Team Marketplace** 管控，**不在 Grok Bot 页**。

### 5.5 Marketplace（x.ai/bot/marketplace）
- 这是一个 **Bot 模板市场**（不是纯 plugin 市场），分类：**All / From Grok Bot Team / Engineering / Sales / Marketing / Design / Personal / Recruiting & People / Product / Operations**。
- 每个条目有作者署名和 **Add** 动作。
- 精选示例：dr eggbot（Lauren Tan）、Overheard（Lenny Rachitsky）、Tradbot（Claire Vo）、Projects Manager（Eric Zakariasson）。
- 官方队伍出品：Outbound Prospecting、SEO & AEO Desk、Haggle Bot、Recruiting Coordinator。
- 其他示例：Nightly Audit Engineer、Sales Call Coach、Meeting Recap Deck、Clip Bot、Copy Humanizer、figma bro、Critiquito、Credit Card Max、The Morning Newspaper、Talent Discovery、Competitor Watch、Product Idea Stress Test、Office Ops Desk、Event Request Desk、Executive Assistant、Alfred 等。

---

## 6. 计费与套餐

### 6.1 接入路径（cursor.com/help/grok-bot/plans）
Grok Bot **本身没有独立定价**，而是作为功能包含在订阅里：
- **Cursor 付费个人版**：Pro / Pro+ / Ultra（weekly usage 分档）
- **Cursor Teams**：全员包含，**不需要 premium seat**
- **Cursor Enterprise**：管理员在 dashboard 开启
- **个人 SuperGrok 订阅**：SuperGrok / SuperGrok Plus / SuperGrok Heavy（与 Cursor 账号 link）
- **X Premium+**：也可 link

### 6.2 用量模型（两层）
1. **Weekly Usage**：包含在套餐里的额度，**每周重置**，额度随套餐档位不同。
2. **On-demand Usage**：周额度耗尽后可继续用，**由 Cursor 计费，受月度支出上限（monthly spending cap）约束**。
   > "When it runs out, extra Grok Bot usage can continue as **On-demand usage** if on-demand is enabled."

### 6.3 计费规则要点
- **不叠加（No stacking）**：Cursor 套餐 与 SuperGrok / X Premium+ link **不累加额度**。
- **升级有效**：Pro+ → Ultra 会提升 weekly usage 档位。
- **link 不可逆**：SuperGrok 或 X Premium+ 的 link **不能解绑也不能转移**。
- **Teams**：每个成员在自己的 Cursor 账号上拿到 Grok Bot，用量从**团队额度**中扣。
- **计费跟随实际服务模型**："billing follows the serving model"（含 failover）。
- **发布时**：Grok Bot 用量是**与既有套餐分开的额度池**（"Separate usage allocation from existing plans"）。

### 6.4 试用
- 试用是 **"a usage credit rather than a set number of days, though a 7-day window also applies."**（额度制 + 7 天窗口双重约束）
- 官方提醒：大型 agent 任务会很快烧完额度。

### 6.5 退款
- Grok Bot 的费用走 Cursor 套餐的标准退款政策；**已消耗的 on-demand usage 和周期中途降级不予退款**。

### 6.6 企业计费
- **没有独立的 Grok Bot 支出上限（"No separate Grok Bot spend cap"）**，只能用账号级控制。
- Enterprise 定价不公开，需 **cursor.com/contact-sales?product=grok-bot** 或 sales@x.ai。
- 促销：2026-09-03 起 "Grok and Cursor Enterprise customers have free usage for the next two weeks, and can invite their whole organization, including people without an existing seat."

### 6.7 用量展示
- **Settings → Usage & Billing** 显示 "weekly included usage and on-demand usage for eligible accounts"。
- Usage analytics 会展示每个请求由哪个模型服务（含 failover）。
- 用量耗尽或触及支出上限会**阻止 Bot 执行**（troubleshooting 页明确列为一种故障原因）。

### 6.8 第三方计费
**确认：Grok Bot 的计费完全通过 Cursor（Anysphere）走**，这是文档反复出现的事实，不是猜测。SuperGrok / X Premium+ 只是"授权来源"，实际 on-demand 扣费和 spending cap 在 Cursor 侧。

---

## 7. 平台与客户端

| 平台 | 支持情况 |
|---|---|
| **macOS** | Apple silicon / Intel，`.dmg` 拖进 Applications |
| **Windows** | x64 / Arm64 安装器 |
| **Linux** | `.deb` / `.rpm` / AppImage（x64 / Arm64） |
| **iOS** | iPhone iOS 18+，iPad iPadOS 18+ |
| **Android** | Android 9+ |
| **Web** | **文档中未见独立 Web 客户端**；管理端是 Cursor Dashboard 网页（cursor.com/dashboard/bot） |
| **CLI** | **文档中未见 Grok Bot CLI**（Cursor 侧另有 Grok Build / 终端产品，属不同产品） |
| **API** | **文档中未见 Grok Bot 面向客户的 API**；有 **Admin API reference**（teams 文档引用） |
| **MCP** | 支持接入 MCP servers；Enterprise 有 MCP Allowlist |

**下载链接（官方公告中出现）：**
- macOS: `https://api2.cursor.sh/updates/download/stable/darwin-arm64/grok-bot-bd824e1890d8b96f`
- iOS: `https://apps.apple.com/app/id6794501026`（企业公告页另列 `id6670324846`）
- Android: `https://play.google.com/store/apps/details?id=ai.x.grok.bot`

**移动端能力**（docs/mobile）：
> "start work, answer questions, approve steps, and review results away from your desk."
- 支持：文字与语音听写、拍照与附件、`@` mention 与 `@everyone` 群聊、threads、reactions、查看共享云电脑、跨 Messages/Bots/Group Chats/Files/Routines 搜索、routine 管理与 run history 查看、**Auto Review 配置**。
- **不支持**："Some advanced desktop controls and teach-by-demonstration workflows are not available on mobile."；编辑 routine 的 schedule/instruction 和 test routine **必须用桌面端**。

**登录**：通过 **Cursor 账号**登录；启用 SSO 的组织走标准组织登录流程。

---

## 8. 多 Bot 协作

### 8.1 官方机制
- **并行**：多个 Bot 可同时 reason / 用 connector / 处理文件 / 协作；每个 Bot 有自己的 screen；**单个 Bot 同时只能跑一个 computer-use 任务**。
- **Group chat**：2–6 个 Bot 围绕 "one shared outcome and visible handoffs"。`@` 指派角色，推荐开场白式分工："Research this, Writer drafts that, Reviewer checks quality."
- **Bot-to-bot handoff**：Bot 之间可**异步发消息**，工作继续推进 "without you coordinating every step"。典型场景："one Bot owns a source system and another owns the deliverable."
- **共享上下文的载体**：**共享的那台 computer**——文件、browser session、登录态在所有 Bot 间互通，"so they can hand work off"（FAQ 原文）。**Skills 也是 workspace 级共享**。
- **Ownership 转移**：overview 明确说 Bot 可以 "pass ownership of a task"。
- **Cloud Agents 委派**：Bot 可以把编码任务委派给 Cursor **Cloud Agents**（团队开关默认开）。这是"Bot → 另一类 agent"的跨产品委派。

### 8.2 社区/作者实践（x.ai 官方指南里的模式，非产品内置功能）
**"How I run multiple teams of Grok Bots"（2026-08-27）：**
- 结构：**Projects database** + **Tasks database** + **一个项目一个 channel** + **Project Manager bot** 做 meta 层协调。
- **"One project equals one channel in the sidebar"**，每个 channel 配一个 **roster**。
- **Roster 最多 6 个 bot**（典型是 1 PM + 5 specialists）。
- **Task states**：Active / **Blocked（需人工介入）** / completed。
- **"The bench"**：可复用 bot 的储备池。
- 派工规则：1) 先复用现有 bot；2) 每项目最多 5 个 bot（PM 另算）；3) 只有显式批准后才新建专精 bot。
- 核心洞见：**"a board, a manager, specialists claiming tasks, a blocked column, a channel."** —— 直接照搬人类团队协作结构。
- **"often the bots can accomplish a lot on their own"**，卡住时在 channel 里 ping 人类。

**"Grok Bot for PMs"：** Chief of Staff / Eng Manager (Emily) → 委派给 5 个 Engineering Agents（经 Cloud Agents 执行）/ Data Analyst (Ashley) / PM Pete / Recruiter。名言 **"It's agents all the way down."** 与 **"For the first time, a PM can have a team that reports to them."**

**"Grok Bot for Engineering"：** 每天 5am 由 Jenny 与所有 bot 做 1:1；每 30 分钟扫 Notion 数据库看 PR / CI failure / merge conflict；每晚 3am 自动代码质量审计；手动宣告 P0 后开启 5 分钟级 transcript 监控；**postmortem 流程——Jenny 分析失误并更新全队 playbook**。引用：**"I built Grok Bot iOS v0 in three weeks, with strong performance and design polish, using only Grok Bot." — Lingxi Li**；**"The goal of a complete engineering system in Grok Bot is to minimize repetition."**

---

## 9. 企业相关

### 9.1 Enterprise 管理控制台（cursor.com/dashboard/bot）
**Access & Identity**
| 控制项 | 说明 | 可用性/默认 |
|---|---|---|
| **Enable Grok Bot** | 组织级总开关；关闭"blocks every member without deleting their computers" | Enterprise only；Enterprise 需管理员手动开启，**Teams 默认开** |
| **Manage Group Access** | 限定到特定 group | Enterprise |
| **SCIM** | SCIM 2.0 自动 provisioning / deprovisioning | Enterprise only |
| **SSO** | SAML 2.0，支持 **Okta / Microsoft Entra ID / Google Workspace / OneLogin** | 走 Cursor SSO app |

**Agent Capabilities**
| 控制项 | 说明 | 默认 |
|---|---|---|
| **Cloud Agents** | 允许 Bot 委派编码任务给 Cloud Agents | **on** |
| **Public Template Sharing** | 是否允许成员对外发布 Bot 模板 | **Enterprise 默认 off** |
| **Connector Policy** | 继承 Team Marketplace 的 connector 策略 | 继承 |
| **MCP Allowlist** | 可信 MCP server 管理 | Enterprise only |
| **Execution on Local Computer** | Always allow / Ask every time / Never allow | 默认 **Always allow** |
| **Allow Local Egress** | 允许 Bot web 流量走成员本机 | Enterprise only，**默认 on** |

**Rules & Approvals**
- **Team Rules**：所有 Bot 必须遵守的行为指引，**成员不能关闭**。
- **Enforce Auto-review**：阻止成员关掉 Auto-review（Enterprise only，**默认 off**）。
- **Auto-review Rules**：团队级 Ask first / Allow automatically 规则，下发到所有成员 Bot，在成员设置里显示为 locked row（Enterprise only）。

**Computers & Network**
- **Network Controls**：四种模式（见 4.6），Enterprise only。
- **Team Setup**：manifest 安装脚本，在每台团队 computer 上运行（Enterprise only）。
- **Grok Bot Computers**：批量 **Recreate** / **Terminate**。
  - **Recreate**：在最新 image 上重建，跑 Team Setup，**保留已同步的 Bot、文件、登录态**；"A Bot that is mid-turn is asked to pause at a safe point and resumes on the new computer."
  - **Terminate**：删除该成员 computer，**不自动重启**；"the member's next session starts a fresh computer on the same durable disk."
  - 两者都会**清掉用户自装的 app 和 package**，但会重装 Team Setup manifest 里的内容。
  - **仅组织管理员可见（org admin，team admin 不够，因为一台 computer 横跨该成员所属的所有 team）**；**"Members never see this control."**
  - 服务端执行，关浏览器不中断；大批量分批处理；**同一 team 同时只能跑一个操作**。

**Logging & Audit（全部 Enterprise only）**
- **Action Recording**：记录 Bot 动作（shell commands、browser navigations、tool calls），带脱敏，**默认 off**。
- **Audit Logs**：admin / security / authentication 事件，加上 Grok Bot control-plane 事件（**Bot creation、access changes、Team Setup、routines**），可按 application 过滤，可流向 SIEM。
- **OpenTelemetry Export**：把用量指标和记录的动作推送到客户的 collector，事件打标 **`cursor.surface=grok_bot`**。

**Group Settings（Enterprise，按目录组覆盖）**
- Agent Capabilities（Cloud Agents、local execution、local egress、Auto-review enforcement）
- Network policies
- Group Rules
- Setup Scripts

**Admin API**：teams 文档引用了 "Admin API reference"（具体端点未在本次抓取范围内展开）。

### 9.2 身份接入细节（docs/identity-and-access）
- **两件事**：
  1. **App Assignment** —— 把 Cursor 应用访问权扩展到工程以外的团队，让非工程师能通过 Cursor team membership 用上 Grok Bot。
  2. **Authentication Rules** —— 为 Bot 的 **Linux 托管环境**开例外，因为它**跑不了 device-trust agent（如 Okta FastPass）**。
- **Okta**：把 group 分配给**已有的 Cursor SSO app**（不是单独的 Grok Bot app）；若用 SCIM 2.0，同一批 group 要同时分配给 SSO app 和 provisioning app；加一条针对 **"Other Desktop"** device platform 的 authentication rule，优先级高于 FastPass 规则。
- **Microsoft Entra ID**：group-based assignment 需 **P1 或 P2** license；**嵌套 group 不自动包含**；需建条件访问策略把 **Linux 设备**排除在 compliant-device 要求之外。
- **限制**："Okta FastPass does not run on Linux"；device-trust 变更不影响 plugin 认证；取消分配用户会阻断 SSO，且（开了 SCIM 时）会自动从 Cursor 移除。

### 9.3 官方明确"不支持 / 有缺口"的清单（重要）
| 缺口 | 原文依据 |
|---|---|
| **不支持本地/私有部署** | "on-premises deployment, deployment inside your own perimeter, and bring-your-own-image deployment" 均不支持 |
| **无专属出口 IP** | "Dedicated per-customer IPs are not available."，只给共享静态段 |
| **无按组织的留存策略** | "Per-organization retention policies ... are unavailable." |
| **无单台 computer 的时点恢复** | "point-in-time restore for individual computers are unavailable" |
| **数据驻留默认美国** | computer 跑在美国；**Cursor 的 data residency 计划默认不适用于 Grok Bot** |
| **模型白名单无强制保证** | onboarding 明确声明 "Grok Bot may not follow it" |
| **无客户可见的模型选择器** | "Cursor manages model selection with no customer-facing picker" |
| **管理员不能给成员推送 connector** | "Admins cannot push connectors to members."（No Connector Provisioning） |
| **没有独立的 Grok Bot 支出上限** | "No separate Grok Bot spend cap available" |
| **Auto Review 不覆盖全部副作用** | "but not all side effects" |
| **Bot 无独立身份** | 除团队托管 connector 外，所有动作归因到具名成员 |
| **Legacy Privacy Mode 不可用** | 必须迁到支持云存储的 data setting |
| **审批不可回滚** | "Approvals control the specific action proposed, not work already completed."；"Stop now" 也不撤销已完成动作 |
| **Bot 之间不是安全边界** | "Individual screens ... not security boundaries"；同用户所有 Bot 共享文件与登录态 |
| **Enterprise 才有的能力** | Network Controls、Team Setup、Action Recording、Audit Logs、OpenTelemetry Export、MCP Allowlist、SCIM、组级策略、Computers 管理、Enforce Auto-review、Allow Local Egress、Terminate |

### 9.4 官方推荐的企业安全基线（原文顺序）
1. 配置 Network Controls（Enterprise）
2. 启用前审计 connector policy
3. 开启 Auto-review 强制（Enterprise）
4. 非必要则限制本地执行
5. 不需要就关掉 Cloud Agent spawning
6. 保持 public template sharing 关闭
7. 对敏感动作设置团队 Auto-review 规则
8. 用 device-aware identity policy 把关登录

---

## 10. 页面清单

| URL | 页面标题 | 一句话摘要 |
|---|---|---|
| https://x.ai/bot | Grok Bot 落地页 | **抓取失败：HTTP 403 Forbidden**（含 `https://x.ai/bot/` 同样 403），营销主页文案未取得 |
| https://x.ai/pricing | Pricing: Compare Grok Plans | **抓取失败：HTTP 403 Forbidden** |
| https://docs.x.ai/grok-bot/plugins | — | **HTTP 404，页面不存在** |
| https://docs.x.ai/grok-bot/changelog | — | **HTTP 404，页面不存在** |
| https://x.ai/bot/guides | Grok Bot Guides | 9 篇官方指南的索引页 |
| https://x.ai/bot/guides/grok-bot-101 | Grok Bot 101（2026-09-11） | "Grok Bot is an agent with a computer"；三种交互方式、Bot 字段、安全机制、多 Bot 链 |
| https://x.ai/bot/guides/grok-bot-for-engineering | Grok Bot for Engineering（09-10） | 工程系统全貌：Slack/Notion/GitHub/Cursor Cloud、定时触发、夜间审计、postmortem |
| https://x.ai/bot/guides/grok-bot-for-support | Grok Bot for Support（09-09） | 每天数千工单：发版跟踪、bug 复现、流失分析、退款、自定义报表 |
| https://x.ai/bot/guides/templates-for-grok-bot | Templates for Grok Bot（09-08） | Template 是"recipe 而非 clone"，包含/排除清单、Share as Template → Publish → Add to Grok Bot |
| https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots | How I run multiple teams of Grok Bots（08-27） | 项目=channel、roster≤6、PM bot、Active/Blocked 看板、"the bench" |
| https://x.ai/bot/guides/grok-bot-for-gtm | Grok Bot for GTM（08-16） | 企业 GTM：Chief of Staff、prospecting、Salesforce/Gong/Granola/Figma 全家桶 |
| https://x.ai/bot/guides/grok-bot-for-pms | Grok Bot for PMs（08-15） | "PM 第一次有了向自己汇报的团队"；6 类角色 bot，"It's agents all the way down" |
| https://x.ai/bot/guides/grok-bot-for-mobile-app-development | Grok Bot for mobile app development（08-25） | 未抓取（索引页描述："Six bots, one mobile game studio."） |
| https://x.ai/bot/guides/designing-grok-bot-with-grok-bot | Designing Grok Bot with Grok Bot（08-24） | 未抓取（索引页描述：设计师用常驻 agent 探索更多想法、使用真实生产素材） |
| https://x.ai/bot/marketplace | Bot Marketplace | Bot 模板市场，9 个分类，署名作者，逐条 "Add" |
| https://x.ai/news/introducing-grok-bot | Introducing Grok Bot | 首发公告，tagline、能力列表、可用性与下载 |
| https://x.ai/news/grok-bot-for-enterprise | Grok Bot for Enterprise（09-03） | 企业版发布：access / network / audit controls，两周免费，全组织可邀请 |
| https://docs.x.ai/grok-bot/overview | Grok Bot（Overview） | 产品定义、五大差异点、平台支持、文档导航 |
| https://docs.x.ai/grok-bot/get-started | Get started | 前置条件、三平台安装、登录、建 Bot、写好请求、Agent Computer 过登录墙 |
| https://docs.x.ai/grok-bot/bots | Bots | Bot 定义、字段、创建/编辑/pin/hide/duplicate/delete、memory、share as template |
| https://docs.x.ai/grok-bot/computer-and-apps | Computer and apps | 持久云电脑、共享资源、/workspace、terminal、browser、connector、takeover |
| https://docs.x.ai/grok-bot/skills-routines-and-automations | Skills, routines, and automations | Skill/Routine/Trigger 定义、字段、生命周期、50 routine & 20 run 上限 |
| https://docs.x.ai/grok-bot/chat-and-collaboration | Chat and collaboration | 群聊 2–6 Bot、@mention、bot-to-bot handoff、threads/reactions、Stop now |
| https://docs.x.ai/grok-bot/use-cases | Use cases | 8 个官方用例及各自工具面 |
| https://docs.x.ai/grok-bot/mobile | Mobile app | iOS 18+/iPadOS 18+/Android 9+，移动端能力与限制 |
| https://docs.x.ai/grok-bot/settings-and-notifications | Settings and notifications | General/Computer/Auto-review/Notifications/Usage & Billing/Bot 级设置 |
| https://docs.x.ai/grok-bot/troubleshooting | Troubleshooting | 登录、启动、连不上、卡住、插件、附件上限、routine、权限模型差异 |
| https://docs.x.ai/grok-bot/faq | Frequently asked questions | Teach a task、共享一台电脑、关机继续跑、并行度、限制 |
| https://docs.x.ai/grok-bot/security | Grok Bot security | 沙箱、Auto Review、网络策略四模式、模型白名单、留存、隐私、ISO 认证 |
| https://docs.x.ai/grok-bot/security-faq | Grok Bot security FAQ | Firecracker microVM、共享 IP、审计、数据驻留、明确不支持项 |
| https://docs.x.ai/grok-bot/teams-and-enterprises | Grok Bot for teams and enterprises | 全部管理控制项、per-user 隔离、8 条安全基线 |
| https://docs.x.ai/grok-bot/identity-and-access | Configure identity and access | SAML 2.0 四家 IdP、SCIM、Okta/Entra 具体配置、FastPass on Linux 限制 |
| https://docs.x.ai/grok-bot/private-networks | Connect to private networks | 桌面出网路由、Team Setup、Tailscale、Cloudflare Tunnel、TLS 拦截问题 |
| https://docs.x.ai/grok-bot/computers | Manage Grok Bot computers | 仅 org admin 可见；批量 Recreate / Terminate 语义 |
| https://docs.x.ai/grok-bot/approvals-security-and-privacy | Approvals, security, and privacy | 审批 UI、Auto-review 规则语义、必确认动作清单、secret 处理、YubiKey |
| https://cursor.com/help/grok-bot/plans | Plans and billing | 接入路径、weekly + on-demand 两层用量、不叠加、link 不可逆、试用、退款 |
| https://cursor.com/docs/grok-bot/teams | Grok Bot for Teams and Enterprise（Cursor 镜像） | 管理项的精确标签与默认值、group 级覆盖、无独立支出上限 |

---

## 11. 对「企业版 Grok Bot」（白泽 Bot）的启示

### 11.1 可以原样保留的能力（Grok Bot 已具备）

| 能力 | 状态 | 说明 |
|---|---|---|
| 具名 Bot 对象模型（Name/Label/Description/Avatar） | **OBSERVED** | 字段极简，是产品成功的关键之一 |
| "一个 Bot 一个 conversation" + pin/hide/duplicate/delete 的完整生命周期 | **OBSERVED** | duplicate 不带 memory/history 的语义值得照抄 |
| 持久云电脑（browser + filesystem + terminal），关机继续跑 | **OBSERVED** | 这是与 chat 产品的根本分界线 |
| per-user 一台 computer，Bot 间共享文件/登录/cookie 以便交接 | **OBSERVED** | 简化模型，但也是最大的安全折衷（见 11.2） |
| 每 Bot 独立 screen，支持并行；单 Bot 同时 1 个 computer-use 任务 | **OBSERVED** | |
| Agent Computer 观看 + 接管（密码/2FA/CAPTCHA/支付/身份核验） | **OBSERVED** | 5 类必须人类接管的场景清单可直接复用 |
| Secure secret request（掩码输入、不入 transcript、不入模型） | **OBSERVED** | |
| 硬件安全密钥（YubiKey）支持，macOS/Windows 默认开 | **OBSERVED** | |
| Skill（workspace 级共享的可复用指令集）+ `/` 引用 | **OBSERVED** | |
| Teach a task（录屏 ≤10 分钟 → draft skill → review → test） | **OBSERVED** | 面向非技术用户的最强差异化 |
| Routine（Bot 归属、schedule+timezone、input source、**approval boundary**、failure handling） | **OBSERVED** | approval boundary 作为 routine 的一等字段，非常值得抄 |
| Skill 投产四步法（跑一次 → 存 skill → 安全样例测试 → routine 上线） | **OBSERVED** | 可做成产品内置的引导流 |
| 事件触发（Slack / GitHub） | **OBSERVED** | 覆盖面窄，企业版需扩（见 11.2） |
| Connector 账号级、单服务多账号、token 不落盘到 computer | **OBSERVED** | |
| MCP server 接入 | **OBSERVED** | |
| Group chat（2–6 Bot）+ `@` 指派 + `@everyone` + threads + reactions | **OBSERVED** | |
| Bot-to-bot 异步消息与 ownership 传递 | **OBSERVED** | |
| "Stop now" 打断 + 用户消息优先于后台工作 | **OBSERVED** | |
| Auto Review 独立审查模型（permit / require approval / deny） | **OBSERVED** | 覆盖 shell、plugin、computer use、automation writes、delegation |
| Ask first / Allow automatically 双规则 + **冲突时 Ask first 胜** | **OBSERVED** | 语义干净，直接可用 |
| 个人规则只能比团队规则更严（单向收紧） | **OBSERVED** | 权限叠加模型的正确做法 |
| 7 类"永远需确认"动作硬清单 | **OBSERVED** | 发消息/发布/付款/删数据/改权限/改生产/签法律条款 |
| Template（recipe 而非 clone）+ 包含/排除清单 + 团队内/公开两档 | **OBSERVED** | 企业版可只保留"团队内" |
| Bot 模板 Marketplace，按职能分类 | **OBSERVED** | |
| 桌面（mac/Win/Linux）+ iOS/iPadOS + Android 全端，移动端可审批 | **OBSERVED** | 移动端做审批入口是刚需设计 |
| OS 级完成/待输入通知 | **OBSERVED** | |
| 附件限制（25MB / 视频 200MB / 一次 6 个） | **OBSERVED** | 可作为初版参数参考 |
| Firecracker microVM per-user 硬件级隔离 | **OBSERVED** | 隔离粒度选型的现成答案 |
| Recreate / Terminate 的语义（mid-turn 安全点暂停后在新机恢复；durable disk 保留） | **OBSERVED** | 非常细致，值得原样实现 |
| Tailscale / Cloudflare Tunnel 打通内网的两条既定路径 | **OBSERVED** | |
| Team Setup manifest（shell 脚本 + 30 分钟超时 + 重试 + 每日刷新 + check script） | **OBSERVED** | |

### 11.2 企业版必须补的缺口

| 缺口 | 标记 | 依据 / 为什么必须补 |
|---|---|---|
| **私有化 / VPC / 自带镜像部署** | **OBSERVED gap** | 文档明确三种都不支持。中国企业客户几乎必须要 |
| **数据驻留与本地化** | **OBSERVED gap** | computer 默认在美国，data residency 计划默认不适用 |
| **按组织的数据留存策略** | **OBSERVED gap** | "Per-organization retention policies unavailable" |
| **单台 computer 的时点恢复（PITR）** | **OBSERVED gap** | 明确不可用；企业版应提供快照/回滚 |
| **专属出口 IP** | **OBSERVED gap** | "Dedicated per-customer IPs are not available"；企业防火墙白名单刚需 |
| **独立的 Bot 预算与支出上限** | **OBSERVED gap** | "No separate Grok Bot spend cap"；企业版需要**部门/项目/Bot 级预算、配额、超额告警与硬熔断** |
| **模型白名单的强制力** | **OBSERVED gap** | 现状只是"honored by default"且承认"may not follow it"。企业版必须做成硬约束（网关层拦截而非提示） |
| **客户可见的模型选择** | **OBSERVED gap** | 现状无 picker。企业版应允许按 Bot / 按场景指定模型与降级策略 |
| **管理员向成员下发 connector** | **OBSERVED gap** | "Admins cannot push connectors to members"。企业版应支持**集中 provisioning + service account 托管** |
| **Bot 的独立身份与最小权限** | **OBSERVED gap** | 现状 Bot 无独立身份，权限完全等同所属成员，且同用户所有 Bot 共享登录态、"screens are not security boundaries"。企业版应做 **per-Bot 身份 / per-Bot 凭证作用域 / 每 Bot 独立沙箱**，这是最大的架构差异化点 |
| **共享 Bot / 组织级 Bot** | **INFERRED** | 现状 Bot 属于个人，Template 是"复制一份"而非共享同一个实例。企业版需要**组织拥有的 Bot、多人共同操作、成员离职后 Bot 与其上下文不丢失** |
| **Bot 的交接与所有权转移（人 → 人）** | **INFERRED** | 文档只有 bot→bot 的任务交接，没有"Bot 换主人"。离职/转岗场景必需 |
| **可回滚 / 可撤销** | **OBSERVED gap** | "Approvals control the specific action proposed, not work already completed"；"Stop now" 不撤销。企业版应有**动作日志 + 补偿撤销 + dry-run 预演** |
| **Auto Review 的覆盖完整性** | **OBSERVED gap** | 承认"not all side effects"。企业版需把审查点下沉到工具调用网关，做到无旁路 |
| **审批工作流（多级、代理人、SLA、升级）** | **INFERRED** | 现状只有本人 Allow/Deny。企业版需要**指定审批人、按金额/风险分级、超时升级、审批委托** |
| **审计与日志** | 部分 **OBSERVED** | Audit Logs / Action Recording / OTel Export 已有但**均为 Enterprise only 且 Action Recording 默认关**。企业版应**默认开启、不可被成员关闭、含完整动作回放与截图证据链** |
| **SSO / SCIM** | 部分 **OBSERVED** | 已支持 SAML 2.0（Okta/Entra/Google/OneLogin）+ SCIM 2.0，但**寄生在 Cursor 的 SSO app 上**，且托管环境是 Linux 导致跑不了 device-trust agent（Okta FastPass）。企业版应有**自有 IdP 集成**，并解决托管环境的设备信任问题 |
| **国产化 IdP / 目录** | **INFERRED** | 官方只列四家海外 IdP。白泽需要支持企业微信、飞书、钉钉、LDAP/AD |
| **国产化合规** | **INFERRED** | 现状是 ISO 27001 / 42001（Schellman）。中国企业版需等保、信创、数据出境评估 |
| **计费解耦** | **OBSERVED gap** | Grok Bot 无独立定价，完全寄生在 Cursor 订阅上；SuperGrok link **不可解绑不可转移**；**Cursor 套餐与 SuperGrok 额度不叠加**。白泽应做**独立计价、可转移的席位、部门成本分摊、可解绑** |
| **触发器生态** | **OBSERVED gap** | 原生事件触发只文档化了 Slack 与 GitHub；Sentry / PagerDuty / Linear / webhook / inbound email 均未见原生 trigger。企业版应提供**通用 webhook + 邮件收件 + 常见 ITSM/告警系统触发** |
| **移动端能力对齐** | **OBSERVED gap** | 移动端不能编辑/测试 routine，不能 teach-by-demonstration |
| **Routine 规模上限** | **OBSERVED gap** | 每 Bot 50 routine、每 routine 仅留 20 条 run 记录。企业版需要更高上限与**长期可查询的运行历史** |
| **多 Bot 编排是"约定"而非产品** | **OBSERVED gap** | 官方最佳实践（项目=channel、roster≤6、PM bot、Active/Blocked 看板、"the bench"）全部靠用户手工搭 Notion 数据库实现。**企业版应把它产品化：内置项目/任务对象、角色 roster、blocked 队列、SLA、看板视图** —— 这是最明显、最高价值的空白 |
| **成本与效果可观测** | **INFERRED** | 现状只有 weekly/on-demand 用量展示。企业版需要**按 Bot / 按项目 / 按部门的成本归因、成功率、人工介入率、节省工时**等经营指标 |
| **Bot 质量与回归测试** | **INFERRED** | 现状"test run 会执行真实外部动作"，无沙箱演练。企业版需要 **dry-run 环境 + skill 回归测试集** |
| **知识库 / 企业上下文层** | **INFERRED** | 现状 memory 明确"not authoritative"，且没有企业知识库对象。企业版应引入**受治理的组织知识库 + 权限感知检索**，替代不可靠的隐式 memory |

### 11.3 三条最高优先级判断

1. **安全模型是 Grok Bot 最薄弱的地方，也是企业版最大的机会。** 官方自己白纸黑字写着：Bot 之间不是安全边界、同一用户所有 Bot 共享登录态、Bot 无独立身份、Auto Review 不覆盖全部副作用、模型白名单无强制力、审批不可回滚。企业版把「**per-Bot 身份 + per-Bot 凭证作用域 + 网关层无旁路审查 + 可撤销动作**」做扎实，就是实质性的架构升级，而不是功能堆砌。（OBSERVED 依据充分）

2. **多 Bot 编排目前完全是"用户自己用 Notion 拼出来的最佳实践"。** 官方指南把它写得很详细（项目=channel、roster≤6、PM bot、Active/Blocked、the bench），但产品里没有对应对象。把这套东西变成**一等公民的数据模型**（Project / Task / Roster / Blocked queue / Handoff），是可以直接落地且用户已被教育好的产品空白。（OBSERVED 实践 + INFERRED 产品化机会）

3. **计费与归属的"寄生结构"必须从一开始就避开。** Grok Bot 没有独立定价、link 不可解绑、无独立支出上限、Bot 属于个人而非组织——这四条组合起来，对任何有采购流程和成本中心的企业都是硬伤。白泽 Bot 应从第一天就把**组织拥有 Bot、席位可转移、部门预算硬约束、成本可归因**做进对象模型，而不是后期补。（OBSERVED 缺口）

---

### 附：未能获取的内容
- `https://x.ai/bot` 与 `https://x.ai/bot/` 两次均返回 **HTTP 403 Forbidden**，营销主页的完整 hero 文案、功能分区文案、下载区未能取得（tagline 与定位已从 `x.ai/news/introducing-grok-bot`、`docs.x.ai/grok-bot/overview`、企业公告页补齐）。
- `https://x.ai/pricing` 返回 **HTTP 403 Forbidden**，SuperGrok 各档具体价格未能从官方页面直接确认（第三方来源称 SuperGrok Heavy $300/月，未经官方页面验证，已在正文中标注来源）。
- `https://docs.x.ai/grok-bot/plugins`、`https://docs.x.ai/grok-bot/changelog` 均返回 **HTTP 404**，不存在。
- 未抓取（时间/配额权衡，索引页已确认存在）：`x.ai/bot/guides/grok-bot-for-mobile-app-development`、`x.ai/bot/guides/designing-grok-bot-with-grok-bot`。
- Admin API 的具体端点未展开（teams 文档仅以 "Admin API reference" 形式引用）。
