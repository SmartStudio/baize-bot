# Grok Bot 官方文档提取报告（为白泽 Bot 企业版设计用）

> **重要前提**：`docs.x.ai/grok-bot/*` 与 `cursor.com/docs/grok-bot/*` 是同一套内容的镜像（docs.x.ai 标题为 "SpaceXAI Docs"）。正文中所有账号、计费、后台、SSO、合规主体全部指向 **Cursor / Anysphere**：登录用 Cursor account、后台是 `cursor.com/dashboard/bot`、计费是 Cursor 套餐、认证是 Anysphere 持有的 ISO 27001 / ISO 42001。即 Grok Bot 在文档层面是一个**挂在 Cursor 账号体系上的 computer-use agent 产品**。设计白泽时，这意味着"身份/计费/审计平面"与"Bot 运行平面"是两套东西。
>
> 另注：`cursor.com/docs/grok-bot/settings`、`/security`、`/teams`、`/identity`、`cursor.com/help/grok-bot/getting-started` 这几个种子 URL 在实际站点上**不存在**（真实路径见下表）。`.md` 后缀（如 `/grok-bot/security.md`）全部 404，尽管 `llms.txt` 以 `.md` 形式列出。

---

## 1. 文档地图

`/grok-bot/` 命名空间共 20 页，由 `https://docs.x.ai/llms.txt` 完整枚举（`cursor.com` 同名路径等价）。

| URL | Title | 一句话摘要 | 状态 |
|---|---|---|---|
| https://docs.x.ai/grok-bot/overview | Grok Bot | 产品总览：Bot = 有名字/职责/长期上下文的 AI 同事，每人一台持久云电脑 | fetched OK |
| https://docs.x.ai/grok-bot/get-started | Get started | 安装桌面端、登录、建第一个 Bot、接管登录、复盘结果 | fetched OK |
| https://docs.x.ai/grok-bot/use-cases | Use cases | 8 个角色模板（Sales Outbound、Talent Scout、Expense Manager 等）+ 起手 prompt | fetched OK |
| https://docs.x.ai/grok-bot/mobile | Mobile | iOS/Android 端能力清单与**不支持**项 | fetched OK |
| https://docs.x.ai/grok-bot/bots | Create and manage Bots | Bot 的创建/编辑/置顶/隐藏/复制/分享模板/删除/记忆 | fetched OK |
| https://docs.x.ai/grok-bot/chat-and-collaboration | Message and collaborate | 单聊、group chat（2–6 Bot）、Bot 间交接、线程、搜索 | fetched OK |
| https://docs.x.ai/grok-bot/files-and-results | Files and results | 附件类型与大小上限、`/workspace`、可复核交付物、证据留存 | fetched OK |
| https://docs.x.ai/grok-bot/computer-and-apps | Use the computer and apps | 云电脑模型：一人一机、全 Bot 共享、接管、连接器、恢复/重置 | fetched OK |
| https://docs.x.ai/grok-bot/skills-routines-and-automations | Skills and routines | skill（怎么做）/ routine（何时做）、录制教学、事件触发、配额 | fetched OK |
| https://docs.x.ai/grok-bot/settings-and-notifications | Settings and notifications | 全部设置面板路径、Route egress through this desktop、用量展示、通知 | fetched OK |
| https://docs.x.ai/grok-bot/approvals-security-and-privacy | Approvals, security, and privacy | 面向成员的审批/Auto-review 规则/本地执行/共享电脑边界/最小权限 | fetched OK |
| https://docs.x.ai/grok-bot/teams-and-enterprises | Grok Bot for teams and enterprises | 管理员主页：可用性矩阵、架构、**全部 admin controls 清单**、推荐基线、Admin API | fetched OK |
| https://docs.x.ai/grok-bot/identity-and-access | Configure identity and access | Okta / Entra ID 的 app assignment 与 Linux 云电脑浏览器登录策略 | fetched OK |
| https://docs.x.ai/grok-bot/private-networks | Connect to private networks | 桌面出口路由 vs Team Setup 装网络客户端（Tailscale / Cloudflare Tunnel） | fetched OK |
| https://docs.x.ai/grok-bot/proxies | Configure TLS-inspecting proxies | Zscaler 等网关需放行的域名清单与免 TLS 解密要求 | fetched OK |
| https://docs.x.ai/grok-bot/computers | Manage Grok Bot computers | 组织管理员批量 Recreate / Terminate 成员云电脑 | fetched OK |
| https://docs.x.ai/grok-bot/security | Grok Bot security | 安全总纲：网络策略、静态出口 IP、Auto Review、身份、日志、留存、托管、注入、认证 | fetched OK |
| https://docs.x.ai/grok-bot/security-faq | Grok Bot security FAQ | 安全评审常见问答（隔离、出口、审批、日志、数据） | fetched OK |
| https://docs.x.ai/grok-bot/troubleshooting | Troubleshooting | 12 类故障与**最小破坏性恢复顺序** | fetched OK |
| https://docs.x.ai/grok-bot/faq | Frequently asked questions | 16 条通用 FAQ | fetched OK |
| https://cursor.com/docs/grok-bot | Grok Bot（镜像） | 与 overview 同内容 | fetched OK |
| https://cursor.com/help/grok-bot/plans | Plans and billing | 计费与用量的**权威矩阵** | fetched OK |
| https://cursor.com/docs/account/teams/admin-api | Admin API（#grok-bot 段） | Grok Bot 管控的 REST 接口与**硬性数值上限** | fetched OK |
| https://cursor.com/docs/cloud-agent | Cloud Agent | 被委派的编码 agent，独立 VM | fetched OK |
| https://docs.x.ai/grok-bot/*.md（全部） | — | `llms.txt` 列的 `.md` 形式 | **404** |
| https://cursor.com/docs/grok-bot/{get-started,settings,security,teams,identity} | — | 种子 URL 中的路径不存在（真实路径无 `/docs/` 下的这些名字） | **404 / 不存在** |
| https://cursor.com/help/grok-bot | — | help 索引页 | **404** |

---

## 2. 对象模型

### Bot
- **定义**："A Bot is a durable AI teammate with a name, a job, its own conversation, and working context that develops over time."
- **字段**：name、label（可选）、description、avatar、notifications 开关。入口 **Bot actions → Edit Profile**；或 **View conversation details → Bot settings**。
- **description vs message 的分工**（文档明确）：description 放**长期为真的规则**（"Never send external messages without approval."），conversation 放一次性任务指令（"Draft follow-ups for these twelve accounts."）。
- **建 Bot 的判据**：当工作有独立的 Goal or area of ownership / Set of tools and sources / Working style / **Approval boundary** / Recurring schedule 时才新建。文档反对 "General Helper" 式的万能 Bot。
- **生命周期**：Create（`Cmd/Ctrl+N` → New chat → Create new Bot，默认名 **New Bot**）→ Edit → **Pin** / **Hide from sidebar**（`Hidden Bots` 区可 Unhide；"Hiding does not pause the Bot or its routines."）→ **Duplicate** → **Share as template** → **Delete**。
- **Duplicate 的语义**：副本名为 "`<name>` copy"，**继承** profile、settings、enabled skills、routines、avatar；**不继承** conversation history、learned memory、chat attachments。
- **Delete 的语义**："Deleting a Bot removes its active profile, conversation, and routines from Grok Bot. Shared computer files and sign-ins are not isolated by Bot and may remain on the computer."
- **存放位置**：Bot 配置同步在账号云端；工作产物在云电脑。
- **关键约束**：Bot **没有自己的身份**。"Bots act as the signed-in member. A Bot can never hold more access than the person it belongs to, every action stays attributable to a named member, and there is no separate machine identity outside your identity provider to provision, rotate, or audit." 唯一例外："Team-managed connectors are the one exception: they may use team or service-account credentials."

### Bot template（分享）
- **Share as template** → 生成模板 → 选 **Public link** 或 **Team-only**。"Accounts on an Enterprise plan default to **Team-only**; other accounts default to a public link."
- 接收方在 x.ai 预览后 **Add to Grok Bot**，得到一份 copy。"It does not give them your computer, logins, or conversation history."
- 管理员开关：**Public template sharing**，关闭后 "Cursor enforces the policy on its servers, including for templates that are already public."
- 分享模板**不是安全边界**：模板含 identity、description、skills、routines，需手工剔除密钥/内网 URL/客户数据。
- 添加他人模板即接受 third-party bot terms（`x.ai/legal/bot-sharing-terms`）。

### computer（云电脑）
- **定义**：每个**用户**一台持久 Firecracker microVM。"Each user's work runs in a dedicated Firecracker microVM, a micro virtual machine with hardware-level separation from other users."
- **归属**："The computer is assigned to your user account, not an individual Bot."
- **共享面**：browser cookies 与登录态、文件、命令行凭据，全部 Bot 可见。
- **screen 概念**："Each Bot gets its own screen on the shared computer... although one Bot can run only one computer-use task on its screen at a time. **The screens are separate work surfaces, not separate security boundaries.**"
- 详见第 3 节。

### conversation / thread / group chat
- 每个 Bot 一条主 conversation；支持 reply in threads、reactions、草稿（移动端 "Drafts are saved per conversation when you navigate away"）。
- transcript 记录：tool activity、computer use、生成的文件、提问、审批请求、消息。
- **Group chat**：New chat 中选 **"two to six Bots"**（即 **2–6 个 Bot 的硬上限**）。移动端 `+ → New Group Chat`。建组后可改名、改成员。
- 群内定向：自然语言由 Bot 自行认领；`@` 指定单一 owner；`@everyone` 慎用。
- **限制**："Bot-to-group handoff messages are currently text-only."
- 输入语法：`/` 引用 skill，`@` 提及 Bot / group / routine / connector。

### task / turn
- 没有独立的 "task" 对象。执行单位是 turn（后台 turn 可在关机后继续）。
- **打断**：新用户消息优先于后台任务；发 "Stop now" 立即停止，但 "does not reverse completed actions"。
- **并发**：同一 Bot 的 screen 上同时只能跑一个 computer-use task；多个 Bot 可并行。

### routine（定时/事件任务）
- **定义**：routine "tells one Bot when to run a workflow—on a schedule or, where supported, after an event."
- **归属**：绑定单个 owning Bot。配置项：owning Bot、schedule + **time zone**（时区在 Settings → General → Bot → Timezone）、input source、expected result、approval boundary、缺数据时的处理。
- **配额（硬数字）**：每个 Bot **最多 50 个 routine**；每个 routine 保留 **"the 20 most recent run records"**。
- **删除**："Immediate and has no undo."
- **管理入口**：Bot → **View conversation details** → **Routines**：enable/pause、Test run、编辑 schedule/instructions、查看 run history、删除。
- **自动暂停**：长时间不活跃后可能被暂停，需用户确认才继续。
- **Test run 的风险**："Use **Test run** only with safe input; testing can perform real external actions."
- **后台性**："Background routines can run while your laptop is closed."

### trigger（事件触发）
- 事件源来自 **Cursor account integrations**，与 Slack / GitHub 的 plugin **是两套**，可能需要单独连接流程。
- 例：带特定短语或链接的 Slack 消息、GitHub 通知。
- 设计要求：匹配规则要窄，禁止 "every new message" 式的宽监听。
- **写 routine 和 trigger 的动作被 Auto Review 归类为 "automation writes"**，属于受审对象。

### skill
- **定义**："A reusable set of instructions for how to do a task."
- **内容六要素**：何时用、需要哪些输入与访问权、工作步骤、如何验证结果、返回什么、**哪些动作需要审批**。
- **存放**：**Marketplace → Your plugins → Manage plugins and skills**；**Private skills** 是账号级共享库，**对该账号全部 Bot 可见**（不是 per-Bot）。
- **引用**：聊天里打 `/`。
- **录制教学（Teach a task）**：一对一会话中开启，录一遍浏览器流程生成 skill。**"Recording is limited to ten minutes"**，不录麦克风音频；产物状态为 **Draft**，需补决策规则/失败处理/审批边界；凭证要走 secure handoff。
- **推荐顺序**："Start with a one-time task. Make it reliable, save the method as a skill, and only then automate it."

### memory
- **内容**："Stable preferences, role context, and summaries of prior work."
- **隔离粒度**：per-Bot。"Conversations and learned context stay separate per Bot, while shared files, browser sessions, and direct handoffs move context between them."
- **文档明确的可靠性免责**：memory 不是权威源；重要决策要让 Bot 回查当前数据源。
- **未被 Auto Review 覆盖**："It does not review every side effect; memory writes and most settings changes are examples."
- 无任何关于 memory 条数上限、保留期、导出、管理员可见性的说明。

### integration / plugin / connector / MCP
- 术语映射：**connector = plugin**，来源是 **Marketplace**，底层策略是团队的 **Cursor MCP policy**。"There is no separate Grok Bot connector list, and connectors appear as plugins in the app."
- **安装范围**："Installed connectors are account-wide. Their availability is not isolated to one Bot."
- **令牌**："OAuth tokens stay on Cursor's connector backend, and Bots invoke tools without receiving them"；"tokens are never stored on the computer."
- **管控位置**：Team Marketplace（`cursor.com/dashboard/plugins`），**不在** Grok Bot 页。MCP allowlist 为 **Enterprise only**。被禁的显示 **Disabled by team admin**。
- **明确不支持**："Pushing connectors to members, whether mandatory or default-on, is not available."

### subagent
- 仅在 security 页作为 Auto Review 的审查对象出现："delegation such as Cloud Agent and subagent launches."
- **文档中无 subagent 的定义、配额、生命周期或管理界面**。

### Cloud Agent（委派）
- Grok Bot 可把**编码任务**委派给 Cursor Cloud Agent，"Delegated work runs on separate computers under your existing Cloud Agent controls."
- Cloud Agent 本身："run in isolated VMs in the cloud with full development environments"；"You can run as many agents as you want in parallel"；VM 的 provisioning / isolation / snapshots / capacity 由 Cursor 管理；产出走 branch + PR。
- **管理员开关**：Grok Bot 页的 **Cloud Agents** 开关，**默认开启**，全团队生效。
- **网络例外（重要）**："If Grok Bot delegates work to Cloud Agents, those agents run under Cloud Agent network settings, not your computer's network client." → 即**委派会绕过你给云电脑配的私网客户端**。

### delegation / handoff（交接）
- **Bot→Bot**：异步消息，"Receiving Bot activates, processes, replies later"。建议每个阶段只有一个 owner，避免并行重复。
- **Bot→用户**：遇到 password / 2FA / CAPTCHA / 付款 / 站点强制人工时，Bot 把电脑控制权交还用户。
- **交接的上下文载体**：共享文件（`/workspace`）、共享浏览器会话、direct message、group chat。
- **无**显式的"任务所有权链"对象——交接是会话消息，不是带状态的工单。

---

## 3. 电脑与执行环境

### 云电脑是什么
- 一台 **Firecracker microVM**，"with its own kernel, memory, and virtual devices"，运行 **Linux**（identity 页明确："The computer runs Linux and is not enrolled in mobile device management (MDM)"；Team Setup 脚本要求 "Debian-based Linux"）。
- 内含：**browser**、**filesystem**、**terminal / 命令行**、桌面环境（可 computer use 点击输入）。
- 位置："Grok Bot computers run in the United States today."

### 隔离（原文引用）
- 用户间（强）："Each user gets a dedicated computer with hardware-level separation, and one user cannot reach another user's computer. Every computer is a Firecracker microVM with its own kernel, memory, and virtual devices."
- 用户内（弱，**这是白泽最该注意的一条**）："Within one user, the boundary is different: all of that user's Bots share one computer, and **Bots isolate personalities and workspaces, not compute.** Treat a login or file on the computer as available to every Bot that user runs..."
- "**The screens are separate work surfaces, not separate security boundaries.**"
- "**Do not use separate Bots as a security boundary.**"
- 官方给出的唯一 workaround："When a workload needs its own computer and credential set, **give it its own Cursor user.**"

### 持久化与休眠
- 持久盘保存 local files、browser sessions、浏览器内保存的内容。
- "**Idle computers hibernate automatically; hibernation is not deletion.**"（文档未给出 idle 阈值时长）
- "Image updates preserve files: computers on a stale system image are recreated on the fresh image with member files preserved."
- 什么会丢："Treat temporary directories, manually installed packages, and uncommitted application state as replaceable."
- Recreate/Terminate 均保留 durable disk；"Both actions remove apps and packages that members installed themselves."
- 恢复动作语义：**Update** 装新软件、保留文件；**Reset** "rebuilds the computer from your last saved snapshot; very recent changes may be lost"；**Recover computer**（对话框名 **Recover Grok Bot's Computer**）仅在报错态出现，不在 Settings。
- 故障恢复的**最小破坏顺序**：Retry → 重启 App → Recover computer → Settings → Updates → Update → 等替换机 → **Reset 只作最后手段**。
- 初次建机/镜像更新 "can take several minutes"。

### 文件系统
- 共享工作区路径 **`/workspace`**。跨 Bot 交接靠它，建议用清晰项目目录。
- 会话附件上限：桌面 composer **一次最多 6 个附件**；文档/图片/音频 **每个 ≤ 25 MB**；视频 **≤ 200 MB**。
- 支持类型：图片、音频、视频、PDF、纯文本、Word/Excel/PowerPoint、CSV/JSON/YAML/源码、HTML、邮件文件、Jupyter notebook。

### 本地执行（用户自己的机器）
- 能力："Bots can act on a member's own machine through the desktop app: run commands, read files, and **move files between the cloud computer and the local machine**."
- "This is separate from work in the hosted computer, with its own control, and it is distinct from Auto Review, which governs work inside the hosted computer."
- 成员设置：**Settings → General → Bot → Execution on Local Computer**，选项 **Ask every time** / **Always allow** / **Never allow**；**"The default is Ask every time."** 每台桌面单独生效（也可在 **Settings → Computer → Computers** 按机器设）。
- 审批卡片显示**确切命令**。
- 管理员上限：Grok Bot 页的 **Execution on Local Computer**，团队默认 **Always allow**（= 把选择权交给成员）；"A member's own setting still applies when it is stricter than the team's."
- 官方建议："Pick **Never allow** unless Bots have a specific reason to work on member machines."
- 这些设置**不影响**云电脑："These settings do not prevent the Bot from using its cloud computer."

### 出网与隧道
- 默认："Hosted computers reach the internet through **shared static egress IP addresses** by default. The ranges are **shared across Grok Bot customers**, and **dedicated per-customer IPs are not available**, so treat the ranges as identifying Grok Bot traffic rather than your team alone."
- 当前 IP 段需向 account team 索取；产品侧只提供目的地 allowlist，**没有源 IP 编辑器**。
- **路径 A —— Route egress through this desktop**（成员级）：Settings → Computer → "Route egress through this desktop"。"Destinations see your desktop's IP address, and the Bot can reach networks available from that device." 作用于单台桌面。管理员可用 **Allow Local Egress**（Enterprise only，**默认开**）关掉；关掉后 "Any active route stops within five minutes"，重开则恢复成员之前的选择。
- **路径 B —— Team Setup 装网络客户端**（Enterprise only）：在每台团队电脑上跑安装脚本，支持 Tailscale（exit node）、Cloudflare Tunnel（`cloudflared`，HTTP 走路由主机名、TCP 走 `cloudflared access tcp` 本地 listener），或任何能在 Debian Linux 上用 shell 装的客户端。
  - 脚本机制：以 computer user 身份运行（特权装用 `sudo`），**开机时 + 周期刷新（"roughly daily"）**执行，**每个脚本 30 分钟超时**，失败不阻塞开机、下次刷新重试，因此脚本必须可重入。有 **Check Script** 且退出码 0 则跳过 Setup Script。多条目按顺序**逐个**执行。
  - **禁止放密钥**："Do not embed auth keys, tokens, or other credentials." 认证走交互式浏览器登录。
  - 局限："This is a pattern you operate, not a Cursor-managed network mode. Cursor does not install, operate, or monitor your networking client."；"No fleet view of script results today."；重建电脑后网络客户端登录态会掉。
- **企业网关（Zscaler 等）必须放行且免 TLS 解密的域名**：`*.cursor.sh`、`*.cursor-cdn.com`、`*.cursorapi.com`、`*.cursorvm.com`、**`*.*.cursorvm.com`（必需）**、`cursor.com`、`downloads.cursor.com`。原文警告："A gateway configured with `*.cursorvm.com` alone looks correct and still leaves the computer unreachable." 还须**关闭响应缓冲**（SSE 直通、HTTP/2 或 HTTP/1.1 fallback、长连接不强制超时），并对**所有 profile 包括离网/漫游**生效。

### 看屏与接管
- **Agent Computer**：会话内打开即可看共享桌面，"The preview shows clicks, typing, navigation, and current status."；离开预览不影响后台运行。
- **接管**：为 password / passkey / 2FA / CAPTCHA / 付款或身份校验 / 站点强制人工步骤而交还控制权。流程：打开电脑 → take control → 只完成被卡住那一步 → 告诉 Bot 继续。
- **secure secret request**：受支持的连接会弹出掩码输入框，"The value is masked and is not added to the conversation"，且不进入模型上下文。
- 硬件密钥：**Settings → General → Security Key → Use hardware security keys**，"The setting is on by default on macOS and Windows and is not yet supported on Linux."
- 移动端也能看屏、接管、归还控制权。
- **禁止**："Do not paste a password or verification code into ordinary chat."

### 终端
- 云电脑有命令行，Bot 可执行 shell；shell 命令是 Auto Review 的受审对象之一，Action Recording 会记录（脱敏）。文档未提供面向用户的独立终端 UI。

---

## 4. Auto Review 与审批

### 机制定义
- "Auto Review is the review layer behind those prompts: **an independent review model that evaluates risky Bot actions before they run**."

### 审查范围（原文清单，逐项引用）
覆盖："shell commands, plugin calls, computer use, **automation writes (changes to routines and event triggers)**, and delegation such as **Cloud Agent and subagent launches**."

### 三种结局
- "**It can let an action proceed, require approval, or deny it.**"

### 明确**不**覆盖的
- "It does not review every side effect; **memory writes and most settings changes are examples.** Treat it as a complement to explicit boundaries and least privilege, working alongside controls that do not depend on a model's judgment: per-action approvals, the network policy, and per-user isolation."

### 审批 UI
- 桌面：审批卡展示 proposed operation 及其输入，按钮 **Allow once** / **Always allow**（可存成规则）/ **Deny**。
- **移动端**："on iPhone and Android, the Auto-review sheet offers **Allow**, **Deny**, and, when a rule is proposed, **Always allow**"；本地命令卡片是 **Allow once** / **Deny**。移动端还通过 push 通知 + in-app attention state 提醒（"Push delivery is still rolling out"）。
- 语义边界："An approval controls the proposed action. **It does not reverse work already completed.**" 且 "nobody should approve an action whose target or effect they cannot identify."

### 规则格式与优先级
- 两类规则：**Ask first**（"always stop matching actions"）与 **Allow automatically**（"let matching actions proceed **only when the reviewer finds no other reason to stop**"）。
- **优先级（多处重复的硬规则）**："**Ask first** wins when rules conflict."
- 规则是**自然语言、窄范围**的，例：`ask first before sending any external email`、`allow automatically when running git status in /workspace/reports`；反例："avoid broad rules like 'allow everything in the browser'."
- **叠加方向**："Personal rules sit on top of team rules but **only make behavior stricter**."

### 存储位置
- 个人规则：**Settings → General → Bot → Auto-review**，"saved to the member's account and applied on every desktop they sign in to"。
- 团队规则：Grok Bot 后台页，**Configure Rules**，改动自动保存；在成员设置表里显示为锁定行，提示 "Required by your admin. You can't edit or delete this rule"。
- Admin API：`GET/PUT /grok-bot/auto-review`，字段 `enforced`(bool) + `rules.allow[]` / `rules.block[]`，**每个数组最多 20 条，每条最多 1,000 字符**。

### Enforce Auto-review（Enterprise only）
- "Prevents members from turning Auto-review off." 开关在 Grok Bot 页，**默认关闭**。
- "Turn it on before you rely on team Auto-review rules."
- **关键耦合**："If admins turn enforcement off, the team rules stop applying and members go back to their own rules only." → 团队规则的生效**依赖** enforcement 开着。

### 不可关闭的内建检查
- 文档**没有**列出"不可关闭的内建检查"清单。它给出的是另一组"不依赖模型判断"的底层控制：**per-action approvals、network policy、per-user isolation**，并称这是防 prompt injection 的下层。外部内容 "is marked as untrusted data when presented to the model"。
- 反向明示：Auto Review 本身默认**可以被成员关掉**，除非 Enterprise 开了 Enforce Auto-review。

### 显式边界优先于 Auto Review
- 文档反复强调最强边界是请求本身："The strongest boundary is the one in the request itself." 推荐在 Bot description 里写死安全边界，并对以下类别显式设界：Sending messages or invitations、Publishing content、Purchases and financial transfers、Deleting or overwriting data、Changing permissions、Production changes、Accepting legal terms。

---

## 5. 身份、团队与企业管理

### 可用性矩阵（原文表）
| Plan | Access |
|---|---|
| Individuals | Included with every paid Cursor plan, or through an individual SuperGrok link |
| Teams | Included; every member has access, and usage follows the seat's allowance |
| Enterprise | Enable Grok Bot for your team from your dashboard |

- Teams 上 **默认开启、无法关闭**："On the Teams plan, Grok Bot is enabled by default... **There is no switch to turn it off.**" 但对 Privacy Mode (Legacy) 团队和 legacy request-based plan 团队则始终关闭。

### 管理后台
- 主页面：**Grok Bot page of the Cursor dashboard**（`cursor.com/dashboard/bot`），"which only admins see"、"Members never see this page."
- 其他散落位置：**Team Settings**（OpenTelemetry Export、privacy setting）、**Team Marketplace / Plugins page**（`cursor.com/dashboard/plugins`，连接器策略）、**Audit Log page**（`cursor.com/dashboard/audit-log`）、**Usage page**（`cursor.com/dashboard/usage`）、**Analytics → Conversation Insights**、身份提供商本身。

### 控制项全表（★ = Enterprise only）

**Access and identity**
| 控制 | 说明 | 默认 | 企业专属 |
|---|---|---|---|
| **Enable Grok Bot** + **Manage Group Access** | 组织级总开关；未配置时显示 **Set Up Grok Bot**；关闭弹 **Disable Grok Bot** 确认，"blocks every member without deleting their computers"。Teams 上只是状态行 "Grok Bot is enabled for your team" | Enterprise 需手动开 | ★ |
| **SSO** | SAML 2.0，支持 Okta / Microsoft Entra / Google Workspace / OneLogin；可强制 SSO（阻断密码登录） | — | 否（SSO 本身） |
| **SCIM** | SCIM 2.0 provisioning + **自动 deprovisioning**（IdP 移除 = Cursor 移除） | — | ★ |
| **Invite Team** | 邀请成员；"Teams that manage membership through SCIM see only the existing-users option" | — | 否 |

**Agent capabilities**
| 控制 | 说明 | 默认 | 企业专属 |
|---|---|---|---|
| **Cloud Agents** | 允许/禁止 Bot 委派编码任务给 Cloud Agent | **on** | 否 |
| **Public template sharing** | 能否对外发布 Bot 模板；服务端强制，含已公开的模板 | Enterprise **off**，其他 **allowed** | 否 |
| **Connector policy** | 继承 Cursor MCP 策略，在 Plugins 页管；**MCP allowlist 本身 ★** | — | 部分 ★ |
| **Execution on Local Computer** | Always allow / Ask every time / Never allow；成员更严者优先 | **Always allow**（成员端默认 Ask） | 否 |
| **Allow Local Egress** | 成员能否把出网走自己桌面；关闭后 "Turning it off stops active routes within five minutes" | **on** | ★ |

**Rules and approvals**
| 控制 | 说明 | 默认 | 企业专属 |
|---|---|---|---|
| **Team Rules** | 全员 Bot 遵循的规则，可 scope 到 Cursor / Grok Bot / both；"Rules applied to Grok Bot are always required, so members cannot turn them off"。API 上限 **每团队 50 条，每条 content ≤ 30,000 字符，name ≤ 255** | — | 否 |
| **Enforce Auto-review** | 禁止成员关 Auto-review | **off** | ★ |
| **Auto-review rules** | 团队级 Ask first / Allow automatically，成员只读锁定；API 上限 allow/block 各 **20 条 × 1,000 字符** | — | ★ |

**Computers and network**
| 控制 | 说明 | 默认 | 企业专属 |
|---|---|---|---|
| **Network Controls**（后台名 **Grok Bot Network Access**） | 四档：**No Policy (Allow All)** / **Allow All Network Access** / **Defaults + Team Allowlist** / **Team Allowlist Only**；支持域名与 **IP 段+端口**，"with **no cap on the number of entries**"（Admin API 侧 `allowlist` 为 **max 500 destinations**）；目录组可有 **Group Network Access**，**Lock for all groups** 可强制团队策略 | **allow-all** | ★ |
| **Team Setup** | 安装脚本 manifest，全团队电脑执行；**每团队最多 100 个 manifest**（Admin API）；每脚本 30 分钟超时；每日刷新 | — | ★ |
| **Grok Bot Computers** | 批量 **Recreate** / **Terminate**；**仅组织管理员**可见，"Team admin rights are not enough, because one computer spans every team the member belongs to" | — | ★ |

**Logging and audit**
| 控制 | 说明 | 默认 | 企业专属 |
|---|---|---|---|
| **Action Recording** | 记录 connector (MCP) tool calls、shell commands、browser navigations、computer use sessions | **off** | ★ |
| **Audit logs** | 管理/安全/认证事件 + Grok Bot 控制面事件：Bot creation、member access changes、Team Setup manifests、MCP authentication、Slack account links、routines；可按 application 过滤、可流到 SIEM | — | ★ |
| **OpenTelemetry Export** | Team Settings → OpenTelemetry Export；是 Action Recording 事件的**唯一客户侧出口**，事件带 `cursor.surface=grok_bot` | — | ★ |
| **Conversation Insights** | Analytics 面板的 Grok Bot 源，按 **Type of Work** 与 **Level of Automation** 聚合会话 | — | ★（"on Enterprise teams where it has rolled out"） |

### Action Recording 的脱敏规则（原文）
"Events are sanitized before they are stored or exported. Shell commands are secret-scrubbed; browser navigations keep each page as `scheme://host/path` with the title but **strip query strings and credentials**; computer use sessions record **action and screenshot counts and the session duration, without the screenshots, clicks, or typed text**."
- 留存："Cursor records Bot actions... in an internal store with a **90-day retention**."
- "Action Recording events do not appear on the Audit Log page."
- "Privacy Mode (Legacy) forces recording off."

### Recreate / Terminate 语义（原文表要点）
- **Recreate**：在最新镜像上建替换机并跑 Team Setup，旧机在替换机 ready 前保持可用再切换；保留 synced Bots/files/logins；"A Bot that is mid-turn is asked to pause at a safe point and resumes on the new computer. If it cannot pause in time, the recreate for that member is not started and shows as failed."
- **Terminate**：删除当前机（运行中或休眠中都删），不自动重启，"the member's next session starts a fresh computer on the same durable disk"；"Running work stops"；"a turn that was running is lost"。
- **两者都不移除访问权**。移除访问 = 移出团队 / 用 Manage Group Access 关掉组 + 在 IdP 吊销会话。
- 运行机制：服务端执行、关浏览器不中断；分批处理；**同一团队同时只能跑一个操作**；Retry Start 幂等。
- 结果状态：Skipped(No VM / Action could not be completed)、Failed(Another recreation is in progress / VM scan incomplete / Action could not be completed)。
- 成员侧显示 **Updating Grok Bot's Computer**；重建后云电脑内的应用登录态可能掉。

### 身份细节
- **不需要**在 Okta/Entra 里新建 Grok Bot 应用；沿用已有的 Cursor SSO app，只需扩大 assignment。未 assign 会报 **User is not assigned to this application**。
- 云电脑内登录企业应用走客户自己的 IdP，"Your session policies govern those sessions, and revoking the user in your identity provider ends them."
- **已知冲突（重要）**：云电脑是 **Linux + 未纳管 MDM**，"Okta FastPass does not run on Linux"。任何要求 FastPass / registered / managed / compliant device / 仅 FastPass 可满足的抗钓鱼因子的策略，在云电脑浏览器内**会失败**。
  - Okta 解法：在 FastPass/托管设备/deny 兜底规则**之上**加规则，**Device platform = Other Desktop**（Okta IE 没有 Linux 选项）、**Device state = Any**、**Password + Another factor**。
  - Entra 解法：新增更高优先级 CA 策略，Device platforms **include Linux / exclude Windows & macOS**，grant 仅 **Require multifactor authentication**，先 report-only 再启用。Entra 组分配需 **P1/P2**，**不含嵌套组**。
  - 云电脑内可用的登录方式：密码 + 远程浏览器可用的第二因子（Okta Verify push / authenticator app）；或装在云电脑上的密码管理器里的 passkey（需 Team Setup 脚本安装，★）。
  - 该改动**不影响** Grok Bot 自身登录，也**不影响** plugin 登录（"plugin authentication does not go through the computer"）。

### Admin API（`cursor.com/docs/account/teams/admin-api#grok-bot`）
- `POST /grok-bot/enable`、`POST /grok-bot/disable`（Teams 计划返回 **403**）
- `GET|PATCH /grok-bot/capabilities` — `enabled`、`cloudAgents`、`templateSharing`、`actionRecording`、`localExecution`、`localEgressAllowed`
- `GET|PUT /grok-bot/auto-review` — `enforced`、`rules.allow[]`/`rules.block[]`（各 ≤20 条 × ≤1,000 字符）
- `GET|PUT /grok-bot/access` — `mode`(all|limited)、`groupIds`（limited 时必填，**1–100 项**）
- `GET|PUT /grok-bot/network` — `egressMode`、`allowlist`（**≤500 destinations**）、`locked`
- `GET|POST /grok-bot/team-rules`、`PATCH|DELETE /grok-bot/team-rules/:id` — `name`(1–255)、`content`(1–30,000)、`enabled`；**每团队 50 条**；分页 `limit` 默认 50 / 最大 100
- `GET /grok-bot/setup-manifests`、`PUT|DELETE /grok-bot/setup-manifests/:manifestId` — `manifestId`(1–128)、`scripts[]{id,setup,check?}`；**每团队 100 个 manifest**

### 推荐企业基线（原文 8 条，管理员侧）
1. 配 Network Controls（★，无策略默认 allow-all）；2. 启用前先审 Teams Marketplace 连接器策略；3. 先开 Enforce Auto-review 再依赖团队规则（★）；4. Execution on Local Computer 设 **Never allow**；5. 不需要委派就关掉 Cloud Agent spawning；6. 保持 public template sharing 关闭；7. 加团队 Auto-review 规则（★），把 production deployments / external email / payments / accepting legal terms 列为 **Ask first**，自动放行规则要窄；8. 在 IdP 层用设备感知策略把登录限制在受管设备（"This gates sign-in, not the hosted computer itself."）。

---

## 6. 用量与计费

- **计量对象**："Grok Bot usage is metered on your **Cursor account**, not on Grok or X."
- **计量单位**："The credit is drawn down by how much work your agents do, **measured by agent steps and tokens rather than the number of messages you send.**"
- **粒度：per-user（按账号），不是 per-Bot。** 文档从未提供任何 per-Bot 或 per-task 的用量/成本视图。
- **周期**："Paid Grok Bot access includes **Weekly usage**. That included grant **resets weekly**."
- **跨端共享**："macOS and iOS share a single usage bucket tied to your signed-in Cursor account."
- **超额**：周额度用尽后可继续，计为 **On-demand usage**，"billed through Cursor and counts toward the **On-demand monthly limit**"（需先启用 on-demand）。
- **触限行为（原文）**：月度上限 "is **not a hard stop in the middle of a run**. A bot already working can finish past the monthly limit. After that, on-demand stops until you raise the limit or the billing cycle resets."
- **不叠加**："A Cursor plan and a SuperGrok or X Premium+ link do not stack."（Pro+ 再链 SuperGrok Plus 不增加额度）；FAQ 表述为 "Grok Bot uses whichever has more usage"。
- **套餐矩阵**（原文表，**全部为定性描述，文档未给任何具体数字/token 数/金额**）：Cursor Ultra = Highest weekly usage；Pro+ = Generous, below Ultra；Pro = below Pro+；Teams（self-serve）= Follows Teams plan allowance；Enterprise = Managed by admin；SuperGrok Heavy > SuperGrok Plus > SuperGrok > X Premium+；**SuperGrok Team/Enterprise = Not supported**；**SuperGrok Lite = Not included**。
- **试用**："a usage credit rather than a set number of days, though a **7-day window** also applies"；已消耗的试用额度不退。
- **退款**：on-demand 消耗 **not refundable**；周期中降级已用部分 **no prorated refund**。
- **展示位置**：桌面端 **Settings → Usage and Billing**（"weekly included usage and on-demand usage for eligible accounts"）；账号菜单显示 **Weekly usage** 概览；Cursor 账号页；管理员看 `cursor.com/dashboard/usage`（含 per-product split）。移动端可在 Settings 查看用量并管理 App Store / Google Play 订阅。
- **企业花费控制（明确缺失，原文）**："**A separate Grok Bot spend cap is not available today.** Account-level on-demand controls apply, and the per-product split is on the dashboard usage page."
- 触限的成员侧症状：Troubleshooting 页把 "Usage exhaustion" 和 "On-demand spending limits" 列为 Bot 卡住的原因之一。

---

## 7. 数据与安全承诺

### 隔离与加密
- 用户级 Firecracker microVM 硬件隔离（见第 3 节引文）。
- 备份："Cursor's production control plane is covered by **daily encrypted backups, replicated to a separate recovery facility**."
- 文档**未**给出静态/传输加密的具体算法或 KMS/BYOK 说明。

### 留存
- 云电脑持久盘跨会话保留文件、浏览器会话；**connector tokens 从不落到电脑上**。
- 休眠 ≠ 删除。
- Action Recording：内部存储 **90-day retention**。
- 删除承诺："Under the Data Processing Agreement, data is deleted or returned **within 30 days** of written direction after the service ends."
- **明确不可用**："**A per-organization retention policy and customer-managed point-in-time restore of an individual computer are not available.**"

### 训练与隐私模式
- "With Privacy Mode enabled, customer data is not used for training; **Cursor enforces this on its servers, and when the setting cannot be verified, the system defaults to not training.**"
- "While a member is on your team, the team's privacy mode governs them."
- **Privacy Mode (Legacy) 与 Grok Bot 不兼容**："Grok Bot requires data storage and does not support Legacy Privacy Mode."（该模式团队必须先切换才能启用；也会强制 Action Recording 关闭）
- ZDR："Model providers do not keep prompts or outputs, and **Grok Bot adds no separate control**. Providers may run abuse and safety classifiers, and flagged data may be stored for investigation."

### 模型
- "Cursor manages model selection. **There is no customer-facing model picker**, and the serving mix can change over time with **no fixed vendor set guaranteed**."
- 团队模型白名单为 ★，且 "**enforcement is not guaranteed**... onboarding presents an acknowledgement that Grok Bot may not follow it, so treat enforcement as configuration dependent."
- 用量分析会显示每次请求实际服务的模型（含 failover），计费按实际服务模型。

### 数据驻留
- "Grok Bot computers run in the United States today. That is not the same as Cursor's US-only data residency program, **which does not apply to Grok Bot by default.**" 需书面承诺要找 account team。

### 托管形态（明确排除）
- "**Grok Bot runs only on Cursor-hosted cloud computers. On-premises deployment, deployment inside your own perimeter, and bring-your-own-image deployment are not supported today.**"

### 端点工具 / DLP
- "Grok Bot does not ship a built-in customer-facing telemetry or EDR feed."（Cursor 自身的运维遥测 "deliberately excludes customer data"）Enterprise 可用 Team Setup 自装工具。
- "Restricting egress limits where data can be sent. **Dedicated data loss prevention hooks are not available.**"

### Prompt injection
- 分层防御：Auto Review（enforcement 开时）+ 不依赖模型判断的 network policy / per-action approvals / per-user isolation；外部内容 "is marked as untrusted data when presented to the model"。
- 坦白限度："These controls **reduce, but do not eliminate**, risk from malicious content."

### 管理员能看到什么（重要边界）
- **能看**：Audit logs（控制面事件：Bot creation、member access changes、Team Setup manifests、MCP authentication、Slack account links、routines）；Action Recording 的**脱敏**事件（仅经 OTel 出口，不在 Audit Log 页）；Usage page 的花费与用量；Conversation Insights 的**聚合分类**（Type of Work / Level of Automation）。
- **看不到**：会话原文、截图、点击、键入内容、浏览器 query string、Bot 的 memory 内容、`/workspace` 文件。文档没有任何"管理员查看成员会话内容"的能力。

### 认证
- "Anysphere, the company behind Cursor, holds **ISO/IEC 27001 and ISO/IEC 42001** certifications, issued by **Schellman**, and Grok Bot is included in the current ISO scope." 证书在 `trust.cursor.com`。**文档未提及 SOC 2**（在 Grok Bot 页面范围内）。

---

## 8. 白泽 Bot 企业版的对照清单

### (a) OBSERVED —— Grok Bot 已交付的企业能力

| 能力 | 形态 / 关键约束 | 文档 |
|---|---|---|
| 组织级总开关 + 按目录组授权 | Enable Grok Bot + Manage Group Access；关闭不删电脑；★ | /grok-bot/teams-and-enterprises#enable-grok-bot |
| SSO（SAML 2.0，可强制） | Okta / Entra / Google Workspace / OneLogin | /grok-bot/security#identity-and-sign-ins |
| SCIM 2.0 自动 provisioning + deprovisioning | ★ | /grok-bot/identity-and-access |
| 独立管理后台，成员不可见 | `cursor.com/dashboard/bot` | /grok-bot/teams-and-enterprises#admin-controls |
| Admin API 全量管控 | enable/capabilities/auto-review/access/network/team-rules/setup-manifests | cursor.com/docs/account/teams/admin-api#grok-bot |
| 出网目的地策略（四档 + 目录组级 + lock） | ★；改动 ~1 分钟生效，休眠机唤醒生效，无需重建 | /grok-bot/security#network-policy |
| 共享静态出口 IP 段（可给对方 allowlist） | 段是跨客户共享的 | /grok-bot/security#static-egress-ips |
| 私网接入两条路径 | 成员桌面出口路由；Team Setup 装 Tailscale / Cloudflare Tunnel（★） | /grok-bot/private-networks |
| 团队统一环境初始化脚本 | Team Setup manifest，开机 + 每日刷新，每脚本 30 分钟超时，≤100 manifest；★ | /grok-bot/private-networks、admin-api |
| 独立审查模型 Auto Review + 可强制 | 覆盖 shell / plugin / computer use / automation writes / delegation；Enforce ★ | /grok-bot/security#approvals-and-auto-review |
| 团队级审批规则（Ask first / Allow automatically），成员只读、只能更严 | ★；Ask first 优先 | /grok-bot/teams-and-enterprises#auto-review-rules |
| Team Rules（Bot 行为规则，成员不可关） | 非 ★；≤50 条 × 30,000 字符 | /grok-bot/teams-and-enterprises#team-rules |
| 本地执行三档管控（团队上限 + 成员更严优先） | 非 ★ | /grok-bot/security#local-execution |
| Action Recording（脱敏行为日志，90 天） | ★，默认关；只能经 OTel 出口 | /grok-bot/security#logging-and-audit |
| Audit logs（控制面事件，可流 SIEM） | ★ | /grok-bot/teams-and-enterprises#audit-logs |
| OpenTelemetry Export（事件带 `cursor.surface=grok_bot`） | ★ | /grok-bot/teams-and-enterprises#opentelemetry-export |
| 批量电脑运维（Recreate / Terminate） | ★，仅组织管理员；mid-turn 安全暂停 | /grok-bot/computers |
| 连接器/MCP 策略继承 + MCP allowlist | allowlist ★；被禁显示 Disabled by team admin | /grok-bot/teams-and-enterprises#connector-policy |
| 模板分享的对外发布管控（服务端强制，含已公开模板） | 非 ★；Enterprise 默认关 | /grok-bot/teams-and-enterprises#public-template-sharing |
| Cloud Agent 委派开关 | 非 ★，默认开 | /grok-bot/teams-and-enterprises#cloud-agents |
| 用量聚合洞察（Type of Work / Level of Automation） | ★ | /grok-bot/teams-and-enterprises#faq |
| 凭证不落地：OAuth token 留后端、secure secret request 掩码不入会话不入模型 | — | /grok-bot/security#identity-and-sign-ins |
| 用户级硬件隔离（Firecracker microVM） | — | /grok-bot/teams-and-enterprises#how-users-are-isolated |
| ISO 27001 + ISO 42001（Grok Bot 在范围内） | — | /grok-bot/security#certifications |
| 企业网关兼容说明（域名/TLS/SSE 直通） | — | /grok-bot/proxies |

### (b) GAP —— 企业买家需要、而文档明说不支持或从未提及

**标注 "docs say unsupported" = 文档有明确否定句；"not mentioned" = 全站 20 页均未出现。**

| 缺口 | 判定 | 依据 / 原文 |
|---|---|---|
| **per-Bot 隔离**（每个 Bot 独立环境与凭据） | **docs say unsupported** | "Bots isolate personalities and workspaces, not compute."；"Do not use separate Bots as a security boundary."；官方 workaround 是"给它一个独立的用户账号" |
| **per-Bot 预算 / Grok Bot 专属花费上限** | **docs say unsupported** | "A separate Grok Bot spend cap is not available today." |
| **per-task 成本展示** | **not mentioned** | 计量只有账号级 weekly / on-demand，无任务级或 Bot 级成本视图 |
| **Bot 间任务交接的所有权链 / 工单状态机** | **not mentioned** | 交接只是异步消息；文档建议"每阶段一个 owner"是人工约定，无对象化的 ownership chain、无状态、无 SLA、无审计串联；且 "Bot-to-group handoff messages are currently text-only" |
| **管理员/他人接管某个 Bot 的电脑**（human takeover by someone other than the owner） | **docs say unsupported**（间接） | 接管只在成员自己的会话内；管理员对电脑只有 Recreate / Terminate 两个粗粒度动作；"Members never see this page" 与之对称，管理员也没有进入成员电脑的路径 |
| **私有化 / 本地化部署、自带镜像** | **docs say unsupported** | "On-premises deployment, deployment inside your own perimeter, and bring-your-own-image deployment are not supported today." |
| **专属出口 IP** | **docs say unsupported** | "dedicated per-customer IPs are not available" |
| **DLP 钩子 / 内容侧数据防泄漏** | **docs say unsupported** | "Dedicated data loss prevention hooks are not available." |
| **按组织自定义留存期；单台电脑的时间点恢复** | **docs say unsupported** | "A per-organization retention policy and customer-managed point-in-time restore of an individual computer are not available." |
| **强制模型白名单** | **docs say unsupported**（弱保证） | "The team model allowlist is Enterprise only, and **enforcement is not guaranteed**" |
| **管理员下发/预置连接器给成员** | **docs say unsupported** | "Pushing connectors to members, whether mandatory or default-on, is not available." |
| **内建 EDR / 客户可见端点遥测** | **docs say unsupported** | "Grok Bot does not ship a built-in customer-facing telemetry or EDR feed." |
| **Team Setup 脚本的执行结果看板** | **docs say unsupported** | "No fleet view of script results today." |
| **数据驻留（非美国 / 中国境内）** | **docs say unsupported** | "Grok Bot computers run in the United States today."；US-only residency 项目 "does not apply to Grok Bot by default" |
| **组织持有 / 共享的 Bot（org-owned bot）** | **not mentioned** | Bot 永远属于某个 member；分享只能产生 copy；无"团队共同拥有一个 Bot"的概念 |
| **Bot 服务账号身份 / 机器身份** | **docs say unsupported** | "there is no separate machine identity outside your identity provider to provision, rotate, or audit"（仅 team-managed connectors 例外） |
| **Auto Review 的不可关闭内建检查清单** | **not mentioned** | 文档只承诺"独立审查模型"+ 可强制开关，从未列出任何 hard-coded、不可绕过的检查项 |
| **memory 的管理员可见性 / 导出 / 保留期 / 配额** | **not mentioned** | 全站对 memory 只有定性描述 |
| **subagent 的定义、配额、管控** | **not mentioned** | 仅作为 Auto Review 的受审对象出现一次 |
| **委派链的网络策略继承** | **docs say unsupported**（反向明示） | "those agents run under Cloud Agent network settings, not your computer's network client" —— 委派会逃逸私网配置 |
| **中国 IM / ERP 集成**（企业微信、钉钉、飞书、金蝶、用友等） | **not mentioned** | 全站集成只提到 Slack、GitHub、Marketplace plugin / MCP |
| **中国合规资质**（等保、密评、信创） | **not mentioned** | 仅 ISO 27001 / ISO 42001；连 SOC 2 在 Grok Bot 范围内都未提 |
| **会话内容级审计 / 留痕回放** | **docs say unsupported** | Action Recording 明确剔除 screenshots、clicks、typed text、query strings；管理员拿不到会话原文 |
| **审批工单化**（多人会签、审批人指派、超时升级、审批留痕导出） | **not mentioned** | 审批只有 Allow once / Always allow / Deny 三按钮，只对 Bot 所属成员本人弹出 |
| **group chat 规模超过 6 个 Bot** | **docs say unsupported** | "two to six Bots" |
| **BYOK / 客户自管密钥、静态加密细节** | **not mentioned** | 仅提 daily encrypted backups |
| **SLA、容量保障、优先级队列** | **not mentioned** | — |
| **Legacy Privacy Mode 团队可用** | **docs say unsupported** | "Grok Bot requires data storage and does not support Legacy Privacy Mode." |
| **Teams 计划关闭 Grok Bot** | **docs say unsupported** | "There is no switch to turn it off."（Admin API 的 disable 在 Teams 上返回 403） |
| **云电脑 MDM 纳管 / 设备信任** | **docs say unsupported** | "The computer is not enrolled in MDM by default."；"Okta FastPass does not run on Linux" |

### 给白泽的三条结构性结论

1. **Grok Bot 的隔离单位是"人"，不是"Bot"。** 这是它最大的产品债：一台电脑上的所有 Bot 共享登录态、文件与命令行凭据，官方唯一解法是"再买一个席位"。白泽若把隔离单位下沉到 Bot（每 Bot 独立沙箱 + 独立凭据集 + 独立预算），就直接吃掉它文档里连续三处自认的弱点。
2. **它的管控面很厚，观测面很薄。** 管理员能"设限"（网络、审批、脚本、本地执行）但几乎不能"看见"——会话内容、截图、按键、query string 全被主动剔除，Action Recording 还默认关、90 天、只能走 OTel。中国企业采购通常反过来要求可回溯留痕。白泽需要在"可审计"和"隐私"之间给出比它更明确的分层策略。
3. **计费与责任无法落到任务/Bot 上。** 按账号、按周、按 agent steps + tokens 计量，无 per-Bot 预算、无 per-task 成本、无 Grok Bot 专项 spend cap，超限还允许"跑完当前 run"。企业要的是成本中心归属与预算闸门；这是一个完整的空白象限。
