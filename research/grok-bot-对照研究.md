# Grok Bot 研究与白泽 Bot 对照

整理日期：2026-09-18。来源：x.ai/bot、x.ai/bot/guides 下 7 篇指南、x.ai/news 两篇发布文、x.ai/bot/marketplace、x.ai/bot/use-cases、x.ai/pricing、docs.x.ai/grok-bot 全部 20 页（由 docs.x.ai/llms.txt 枚举）、cursor.com/docs/grok-bot、cursor.com/help/grok-bot/plans、cursor.com/docs/account/teams/admin-api 与 cursor.com/docs/cloud-agent。引号内均为官方原文。

## 1. 一句话定位

官方 tagline 有三个版本，指向同一件事。

- 落地页：「AI teammates you can give real work to. Bots can sign in to your tools, use them just like you do, and come back with finished work.」
- 发布文（2026-08-11）：「Grok Bot is your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7.」
- Grok Bot 101 指南：「Grok Bot is an agent with a computer.」

目标用户是非工程岗为主的白领。企业版发布文（2026-09-03）明说「the heaviest use is outside engineering」，客户有 Legora、Supermicro、ServiceTitan。

时间线：08-11 首发 beta，08-26 扩到 SuperGrok 和 Cursor 全套餐，09-03 企业版正式发布，新增「access, network, and audit controls」。

## 2. 关键背景，Grok Bot 寄生在 Cursor 上

这一点决定了白泽 Bot 的很多设计空间。

- 下载走 api2.cursor.sh，onboarding 走 cursor.com/bot/onboarding。
- 登录用 Cursor 账号，SSO 走 Cursor 的 SSO app，SCIM 走 Cursor。
- 计费完全通过 Cursor。「No separate Grok Bot spend cap」。SuperGrok 和 X Premium+ 只是授权来源，link 后「不能解绑也不能转移」。
- 企业管理台是 cursor.com/dashboard/bot，只有管理员可见。
- 合规主体是 Anysphere，ISO 27001 和 ISO 42001 由 Schellman 颁发。
- docs.x.ai/grok-bot 和 cursor.com/docs/grok-bot 是同一套文档的两个镜像。

## 3. 对象模型

| 对象 | 官方定义与字段 | 生命周期与限制 |
|---|---|---|
| Bot | 「a durable AI teammate with a name, a job, its own conversation, and working context that develops over time.」字段：Name、Label、Description（「Rules and boundaries that should remain true」）、Avatar、通知 | 侧栏 New 或 Cmd+N 即建。Pin、Hide、Duplicate（复制 profile、settings、skills、routines，不复制 conversation、memory、attachments）、Delete。官方原则「Focused Bots build more useful context than one catch-all Bot.」 |
| Computer | 持久云电脑，带 browser、filesystem、terminal | 每用户一台，见第 4 节 |
| Conversation | 每个 Bot 一条会话。Group chat 2 到 6 个 Bot，用 @ 指派，支持 @everyone、threads、reactions | 「Stop now」立即停止但不回滚已完成动作。用户消息优先于后台工作 |
| Skill | 「A reusable set of instructions for how to do a task.」含 steps、decision rules、expected output、safety boundaries | 账号级 Private skills 库，对该账号全部 Bot 可见。聊天中用 / 引用。四步投产法：手动跑一次、存成 skill、安全样例测试、用 routine 上线 |
| Teach a task | 在 computer view 录一段浏览器操作，Bot 转成 draft skill 供 review 和 test | 录制上限 10 分钟。灰度中。移动端不支持 |
| Routine | 归属某个 Bot。字段：Schedule and timezone、Input source、Approval boundary、Failure handling | 每 Bot 最多 50 个，每个保留最近 20 条运行记录。test run 会执行真实外部动作。移动端只能看，不能改 |
| Trigger | 事件触发的 routine，文档只点名 Slack 消息和 GitHub 更新 | 走 Cursor 账号级 integration，与 plugin 是两套 |
| Connector / Plugin | 来自 Marketplace，账号级而非 Bot 级，同一服务可连多账号 | Token 只留在 Cursor 后端，「永不下发到 computer」。支持 MCP server |
| Memory | 「stable working preferences, important facts, and summaries from its work」 | 官方明确「Memory is not authoritative」。Duplicate 和 Template 都不带 memory |
| Files | 共享目录 /workspace | 附件单个 25 MB，视频 200 MB，一次最多 6 个 |
| Template | 「Templates share a bot as a recipe, not a clone.」含 instructions、脱敏 memories、first-party plugins、routine triggers。不含 secrets、custom MCP、敏感脚本 | Share as Template，选 team-only 或 public，Publish。企业版默认关闭 public 分享 |

Marketplace 上一个 Bot 详情页固定四块：Memories（Facts it already knows）、Skills（Playbooks it can run）、Routines（Jobs that run on their own）、Integrations（Apps it can use）。几乎每个 Bot 描述都带一句「never sends without you」。

## 4. 执行环境与隔离

官方文案有一处冲突，以文档为准。

- 落地页 FAQ 与文档：「Every Grok Bot shares one persistent cloud computer. Your Bots share that machine (files, browser, logins), so they can hand work off and keep context. Isolation is per user, not per Grok Bot.」
- 企业版发布文：「Each Bot runs on its own computer in the cloud.」这是营销措辞。

事实如下。

- 每用户一个 Firecracker microVM，「with its own kernel, memory, and virtual devices」，底层是 Debian 系 Linux。
- 同一用户的所有 Bot 共享 cookie、文件、命令行凭据。每个 Bot 有独立 screen 用于并行，但「screens are not security boundaries」。文档另有两句更直接的话，「Bots isolate personalities and workspaces, not compute.」和「Do not use separate Bots as a security boundary.」官方给的替代方案是再开一个用户账号。
- 单个 Bot 同一时刻只能跑一个 computer-use 任务。
- 空闲自动 hibernate，「hibernation is not deletion」。故障恢复顺序：Retry、Restart app、Recover computer、Update、Reset。
- 本地执行是另一条路径。Settings 里有 Execution on Local Computer，默认逐条命令审批。管理员可设 Always allow、Ask every time、Never allow。
- 出网走 Cursor 共享静态 IP 段，「Dedicated per-customer IPs are not available.」
- 进内网两条路。一是 Route egress through this desktop，把 Bot 流量走成员本机。二是 Team Setup manifest，管理员用 shell 脚本在全队 computer 装 Tailscale 或 cloudflared。官方定性「a pattern you operate, not a Cursor-managed network mode.」
- 接管入口叫 Agent Computer。Bot 会在五种情况请人接管：「A password or passkey, Two-factor authentication, A CAPTCHA, A payment or identity check, A site that explicitly requires a human.」另有 secure secret request，输入值掩码，不进 transcript，不进模型。YubiKey 在 macOS 和 Windows 默认开启。
- 明确不支持：「on-premises deployment, deployment inside your own perimeter, and bring-your-own-image deployment」。computer 默认跑在美国，Cursor 的 data residency 计划默认不适用于 Grok Bot。

## 5. 审批与 Auto Review

三层结构。

1. 硬清单。七类动作永远需要确认：发消息或邀请、发布内容、购买与转账、删除或覆盖数据、修改权限、生产变更、接受法律条款。
2. Auto Review。一个独立的审查模型，评估 shell commands、plugin calls、computer use、automation writes、delegation，结果是 permit、require approval 或 deny。官方承认「but not all side effects」。
3. 规则。两类，「Ask first」匹配即拦，「Allow automatically」仅当审查模型没有其他 stop reason 时放行。「Ask first wins when rules conflict.」规则存在账号上跨设备生效。团队规则在成员设置里是 locked rows，个人规则只能比团队规则更严。团队规则依赖 Enforce Auto-review 开着，「If admins turn enforcement off, the team rules stop applying」。

Auto Review 不审 memory 写入和大部分设置变更。删除 Bot 时「Shared computer files and sign-ins are not isolated by Bot and may remain on the computer」。

审批 UI 桌面端是 Allow once、Deny、Always allow。移动端可审批也可配 Auto Review。关键语义「Approvals control the specific action proposed, not work already completed.」

权限归属原则：「a Bot can never hold more access than the person it belongs to.」「every action stays attributable to a named member.」唯一例外是团队托管的 connector 可用 service account。

## 6. 企业管理台（cursor.com/dashboard/bot）

| 分区 | 控制项 | 默认 |
|---|---|---|
| Access & Identity | Enable Grok Bot 总开关、Manage Group Access、SCIM 2.0、SAML SSO（Okta、Entra、Google、OneLogin） | Enterprise 需手动开，Teams 默认开 |
| Agent Capabilities | Cloud Agents 委派、Public Template Sharing、Connector Policy、MCP Allowlist、Execution on Local Computer、Allow Local Egress | Cloud Agents 开，公开模板关，本地执行 Always allow，本地出网开 |
| Rules & Approvals | Team Rules（成员不能关）、Enforce Auto-review、团队级 Auto-review Rules | Enforce 默认关 |
| Computers & Network | Network Controls 四模式（No Policy、Allow All、Defaults + Team Allowlist、Team Allowlist Only）、Team Setup manifest、批量 Recreate 和 Terminate | 仅 org admin 可见 computer 管理 |
| Logging & Audit | Action Recording（shell、browser、tool calls，脱敏）、Audit Logs（可流向 SIEM）、OpenTelemetry Export（事件打标 cursor.surface=grok_bot） | Action Recording 默认关 |
| Group Settings | 按目录组覆盖 capabilities、网络策略、规则、脚本 | |

Recreate 的语义值得抄：「A Bot that is mid-turn is asked to pause at a safe point and resumes on the new computer.」保留已同步的 Bot、文件、登录态。

Admin API 在 cursor.com/docs/account/teams/admin-api 的 grok-bot 段，覆盖 enable/disable、capabilities、auto-review、access、network、team-rules、setup-manifests 七组端点。硬上限如下。

| 项 | 上限 |
|---|---|
| Auto-review 规则 | allow 和 block 各 20 条，每条 1000 字符 |
| 访问组 | limited 模式下 1 到 100 个 group |
| 网络白名单 | 500 个目的地 |
| Team Rules | 每团队 50 条，每条 30000 字符 |
| Setup manifest | 每团队 100 个 |
| Teams 套餐 | disable 返回 403，「There is no switch to turn it off」 |

身份对接有一个已知冲突。云电脑是未纳管 MDM 的 Linux，「Okta FastPass does not run on Linux」。任何要求托管设备或 FastPass 的条件访问策略在云电脑浏览器里会失败。官方解法是在 Okta 加一条 Device platform 为 Other Desktop、Device state 为 Any 的规则，或在 Entra 加一条只对 Linux 生效、仅要求 MFA 的 CA 策略。

管理员做不到的事：「Admins cannot push connectors to members.」模型白名单只是「honored by default」，onboarding 弹窗承认「Grok Bot may not follow it」。没有客户可见的模型选择器。没有按组织的留存策略，没有单台 computer 的时点恢复。

## 7. 计费

- Grok Bot 没有独立定价。包含在 Cursor Pro、Pro+、Ultra、Teams、Enterprise，以及 SuperGrok 30 美元、Plus 100 美元、Heavy 和 X Premium+ 里。
- 用量按「agent steps and tokens rather than the number of messages you send」计。
- 两层。Weekly usage 每周重置，档位随套餐。用完后 on-demand 继续，通过 Cursor 计费，受 monthly limit 约束。「A limit is not a hard stop in the middle of a run. A bot already working can finish past the monthly limit.」on-demand 关闭时 Bot 直接停。
- Teams 用量从团队额度扣。Cursor Teams 加的三样：「Centralized team billing and settings」「Team marketplace for skills and plugins」「Shared usage analytics」。
- 「billing follows the serving model」，含 failover。
- 用量在 Settings 的 Usage & Billing 显示，没有按任务或按 Bot 的成本。

## 8. 数据、留存与可见边界

- 隔离是用户级 Firecracker microVM。控制面「daily encrypted backups, replicated to a separate recovery facility」。文档没有加密算法、KMS 或 BYOK 说明。
- Action Recording 内部保留 90 天，且主动剔除 screenshots、clicks、typed text、query strings。「A per-organization retention policy and customer-managed point-in-time restore of an individual computer are not available.」
- 服务结束后「data is deleted or returned within 30 days of written direction」。
- Privacy Mode 开启时不用于训练，「when the setting cannot be verified, the system defaults to not training」。但「Grok Bot requires data storage and does not support Legacy Privacy Mode」，用旧隐私模式的团队必须先切换。
- ZDR 层面「Grok Bot adds no separate control」，模型供应商可跑滥用分类器并留存被标记的数据。
- 管理员能看到的只有控制面事件的 Audit Logs、脱敏后经 OpenTelemetry 出口的动作事件、Usage 页的花费、Conversation Insights 的聚合分类。管理员看不到会话原文、截图、按键、Bot 的 memory 内容和 /workspace 文件。文档没有任何管理员查看成员会话内容的能力。
- Prompt injection 防御是 Auto Review 加网络策略加逐动作审批加按用户隔离，外部内容「is marked as untrusted data」。官方定性「reduce, but do not eliminate」。
- DLP 明确不提供，「Dedicated data loss prevention hooks are not available.」也没有客户可见的 EDR 或端点遥测。Team Setup 脚本的执行结果「No fleet view of script results today.」
- 认证只有 Anysphere 的 ISO 27001 和 ISO 42001，Grok Bot 页面范围内未提 SOC 2。

## 9. 平台

macOS、Windows、Linux 桌面端。iOS 18+、iPadOS 18+、Android 9+。没有 Web 客户端、没有 CLI、没有面向客户的 API，只有 teams 文档引用的 Admin API。移动端能「start work, answer questions, approve steps, and review results」，不能编辑 routine 的 schedule 和 instruction，不能 teach-by-demonstration。

## 10. 多 Bot 协作

产品内置的机制。

- Bot 之间可异步发消息、共享上下文、「pass ownership of a task」。
- Group chat 2 到 6 个 Bot 围绕「one shared outcome and visible handoffs」。
- 共享上下文的载体是那台共享的 computer 和 workspace 级 skill。
- Bot 可以把编码任务委派给 Cursor Cloud Agents，在独立 VM 上跑，产出走 branch 和 PR。委派有一个漏洞，「those agents run under Cloud Agent network settings, not your computer's network client」，也就是委派出去的工作不受你给云电脑配的私网客户端约束。
- Bot 到群聊的交接消息「currently text-only」。

官方指南里的用户实践，产品里没有对应对象。

- 「How I run multiple teams of Grok Bots」：Notion 里建 Projects 和 Tasks 数据库，「One project equals one channel in the sidebar」，每个 channel 一个 roster，最多 6 个 Bot，1 个 PM 加 5 个专家。任务状态 Active、Blocked、completed。「The bench」是可复用 Bot 储备池。派工规则：先复用，每项目最多 5 个，新建专精 Bot 需显式批准。
- 「Grok Bot for PMs」：Chief of Staff 在顶层，委派给工程、数据、招聘等 Bot。「For the first time, a PM can have a team that reports to them.」
- 「Grok Bot for Engineering」：每天 5 点 1:1，每 30 分钟扫 PR 和 CI，每晚 3 点代码审计，postmortem 后更新全队 playbook。

## 11. 已对齐的产品决定（2026-09-18）

| 问题 | 决定 | 对原型和设计的后果 |
|---|---|---|
| 产品性质 | 先对内给白泽明理的 AI Operation 用，后对外 | 第一版砍管理台、计费、多租户，但对象模型按对外设计 |
| 部署形态 | 控制面 SaaS，Bot 的云电脑可部署到客户内网或指定国内云 | 需要「电脑池」抽象，控制面通过出站连接管理电脑 |
| Bot 归属与电脑 | Bot 属个人，一人多 Bot。每人一台云电脑，该用户所有 Bot 共享，每个 Bot 一个桌面。同 Grok 的 computer 加 screen | 设置页「每个 Bot 一台，占 5 台」改为「一台电脑，5 个桌面」 |
| 权限 | 不做权限链。Bot 的权限就是用户给它开的 MCP 和云电脑浏览器里的登录态 | 所有权链去掉「权限：CRM 只读」那一行，只留谁在什么时候接手。「交接不转移对方没有的系统权限」这句删掉 |
| Bot 间交接 | 同一个人的 Bot 团队内部的行为 | 任务在归属人的 Bot 之间流转，交接报文保留 |
| 审批 | 归属人本人。Bot 在对话窗口里直接问，归属人回复消息或点确认按钮即完成审批 | 不做审批流、不做指派。审批就是对话里的一条消息 |
| 执行环境 | Pi 作为 agent runtime 和 harness。云电脑用 Firecracker microVM，一台给同一用户的所有 Bot | 我们做 Bot、任务、群聊、审批、桌面这层，不自研 agent loop |
| 模型 | 模型层抽象，第一版不限来源 | 对外时按客户要求切国产模型 |
| 首个场景 | 一个 Bot 对话群能通过持续对话跟踪一个主题任务 | 第一版的核心对象是群聊和主题任务，不是某个具体业务系统的集成 |
| 身份入口 | 自建账号加标准 SSO | 企微等只是可选 IdP 和通知渠道 |
| 移动端 | 第一版不做 | 原型里「手机上也能点头」的文案去掉 |
| 时间与人手 | 未定，先出规格 | 下一步是产品规格与技术方案 |

## 12. 白泽原型逐项对照

原型指 baize-bot/bot-application-prototype/白泽 Bot.dc.html。

| 原型里的设计 | Grok Bot 实际 | 判断 |
|---|---|---|
| 「每个 Bot 有自己的电脑」，设置页「5 台在线」 | 每用户一台，Bot 共享登录态和文件，「screens are not security boundaries」 | 原型的模型比 Grok 更严。这是真差异化，但成本是每 Bot 一个 VM，且 Bot 间交接不能再靠共享文件系统 |
| 登录态过期时 Bot 停下请人接管，交回后从断点继续 | Agent Computer 接管，五类触发场景，secure secret request | 不是差异化，是基线。原型可直接补上五类场景和掩码输入 |
| Bot 间交接带报文、所有权链、超时退回或升级 | 有 bot-to-bot 消息和 ownership 传递，没有交接报文、所有权链、超时策略，任务不是对象 | 真差异化。它就是「How I run multiple teams」那套 Notion 实践的产品化 |
| 点头清单硬编码三项，三处措辞还不一致 | 七类硬清单，加独立审查模型，加 Ask first 和 Allow automatically 规则，团队规则锁定，个人只能收紧 | 原型太薄。建议照搬三层结构，硬清单用 Grok 的七类，团队规则由管理员下发 |
| 每次任务结束显示「约 ¥4.6 / 19 分 / 27 步」，团队周预算 200 元，到 80% 提醒到 100% 停 | 只有账号级 weekly 和 on-demand 用量，「No separate Grok Bot spend cap」，无按任务或按 Bot 成本 | 真差异化。Grok 的 step 和 token 计量可以直接映射到原型的「步」 |
| 例行任务编辑器只有名称、做什么、何时运行 | Routine 有 Approval boundary 和 Failure handling 两个一等字段 | 原型缺这两个字段，建议补 |
| skill 只在一句台词里出现 | workspace 级共享对象，/ 引用，teach-by-demonstration 生成 draft skill | 原型应把 skill 升为可见对象，teach a task 对业务员是最强的差异化入口 |
| 「从团队模板开始」 | Template 是 recipe 不是 clone，团队内或公开两档，企业默认关公开 | 一致。企业版只留团队内即可 |
| 「可用系统还没连，派活时它会问你要」，但所有权链里权限按 Bot 分 | 「a Bot can never hold more access than the person it belongs to」，动作归因到具名成员，例外是团队托管 connector 用 service account | 原型两套模型冲突，Grok 选的是前者。要做按 Bot 分权，就必须引入 service account 和独立 Bot 身份 |
| 只画了业务员，管理员和负责人只在文案里 | 管理台六个分区，全部 Enterprise only | 必须决定管理面做不做，做在哪 |
| 「手机上也能点头」，零移动屏 | iOS 和 Android 可审批、可配 Auto Review，不能改 routine | 一致。移动端审批是刚需 |
| 「业务数据不出企业边界，不用于训练」 | 不支持私有化，computer 在美国，data residency 不适用，无 DLP，无 SOC 2 | 对中国企业客户这是最大的空白，也是白泽最硬的卖点 |
| 「审批留痕」「所有权链」暗示可回溯 | 管理员看不到会话原文和截图，Action Recording 默认关且只保 90 天 | Grok 的管控面厚、观测面薄。国内采购通常反过来要求可回溯留痕，白泽要在可审计和隐私之间给出明确的分层 |
| 审批只画了本人点头 | 审批只对 Bot 所属成员本人弹出，三个按钮，无会签、无指派、无超时升级 | 原型的交接已有超时退回或升级，可以把同一套机制复用到审批上 |
| 免打扰期间「攒到早上一起来」 | 没有对应功能 | 真差异化，小但顺手 |

## 13. 官方明确不支持的清单

私有化和自带镜像部署；专属出口 IP；按组织的留存策略；单台 computer 时点恢复；数据驻留；模型白名单强制；模型选择器；管理员下发 connector；独立支出上限；Bot 独立身份；Bot 级隔离；审批回滚；DLP 钩子；客户可见 EDR；Team Setup 结果看板；Legacy Privacy Mode；Teams 套餐关闭 Grok Bot；管理员进入成员电脑；群聊超过 6 个 Bot。

文档从未提及的：按任务成本；组织共有的 Bot；审批工单化；memory 的配额、导出与管理员可见性；subagent 的定义与配额；SLA 与容量保障；BYOK；中国 IM 与 ERP 集成；等保等中国合规资质。

## 14. 未取得的内容

x.ai/bot/guides 下「Grok Bot for mobile app development」和「Designing Grok Bot with Grok Bot」两篇未抓。docs.x.ai/grok-bot/plugins 和 changelog 返回 404，llms.txt 列出的 .md 版本也全部 404。Admin API 端点未展开。SuperGrok Heavy 价格未从官方页面确认。
