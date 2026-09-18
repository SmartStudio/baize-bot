#!/usr/bin/env python3
"""把 v1 原型改写成 2026-09-18 对齐后的 v2。

输入固定读 research/prototype-v1/白泽 Bot.v1.dc.html，输出覆盖 bot-application-prototype/白泽 Bot.dc.html，
所以可以反复重跑。每条替换都断言原文只出现预期次数，原文一变脚本就会失败而不是静默漏改。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "research/prototype-v1/白泽 Bot.v1.dc.html"
DST = ROOT / "bot-application-prototype/白泽 Bot.dc.html"

s = SRC.read_text(encoding="utf-8")

APPROVAL = "对外发送、改生产数据、付钱"
DS = 'component-from-global-scope="BaizeDesignSystem_7d7772.'


def rep(old: str, new: str, count: int = 1):
    global s
    n = s.count(old)
    assert n == count, f"expected {count} of {old!r}, found {n}"
    s = s.replace(old, new)


def rep_re(pattern: str, new: str, count: int = 1, flags=0):
    global s
    found = re.findall(pattern, s, flags)
    assert len(found) == count, f"expected {count} of /{pattern}/, found {len(found)}"
    s = re.sub(pattern, new, s, flags=flags)


# ── 一、贯穿全部屏幕 ───────────────────────────────────────────────

# 1. 电脑 → 桌面
rep("每个 Bot 有自己的电脑，用你的系统把活干完。要你点头的时候才来找你。",
    "每个 Bot 有自己的桌面，在你的云电脑里把活干完。要你点头的时候才来找你。")
rep("登录即同意企业使用条款 · 业务数据不出企业边界，不用于训练",
    "登录即同意企业使用条款 · 云电脑可部署在企业内网，数据不用于训练")
rep("建好了，电脑也开好了", "建好了，桌面也开好了")
rep("你接管了小销的电脑 · 09:15", "你接管了小销的桌面 · 09:15")
rep("接管后 Bot 暂停，你操作完点「交回」它接着干。", "接管的是它的桌面。接管后 Bot 暂停，你操作完点「交回」它接着干。")
rep(">Bot 的电脑</div>", ">云电脑</div>")
rep("每个 Bot 一台，在企业云里", "一台电脑，5 个桌面")
rep("你的 5 个 Bot 现在占 5 台。闲置 7 天自动休眠，文件保留。",
    "你的 5 个 Bot 共用这台电脑，每个 Bot 一个桌面，登录态和文件共用。闲置 7 天自动休眠，文件保留。")
rep(">5 台在线</x-import>", ">5 个桌面在线</x-import>")
rep("{ value: 'computer', label: '电脑', icon: 'monitor' }", "{ value: 'computer', label: '桌面', icon: 'monitor' }", 2)
rep("中途你可接管电脑再交回", "中途你可接管它的桌面再交回")
rep('icon="monitor" label="它的电脑"', 'icon="monitor" label="它的桌面"')
rep('ComputerCard" title="小销的电脑"', 'ComputerCard" title="小销的桌面"')
rep('data-screen-label="02 主窗口：对话 + 电脑面板"', 'data-screen-label="02 主窗口：对话 + 桌面面板"')

# 电脑面板：桌面切换 + 标签区分桌面与整台电脑
SUBTABS_OLD = (
    '        <div style="display:flex;align-items:center;gap:4px;font:var(--type-ui);font-size:13px">\n'
    '          <span style="padding:5px 10px;border-radius:999px;background:var(--bg-inset);color:var(--fg-1);font-weight:600">屏幕</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">终端</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">文件</span>\n'
)
SUBTABS_NEW = (
    '        <div style="display:flex;align-items:center;gap:6px;font:var(--type-ui);font-size:12px;color:var(--fg-4)"><x-import ' + DS + 'Icon" name="monitor" size="{{ 14 }}" hint-size="14px,14px"></x-import>桌面<span style="flex:1"></span>'
    '<span style="display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 6px;border-radius:999px;background:var(--bg-inset);box-shadow:var(--inset-hairline);color:var(--fg-1);cursor:pointer" style-hover="background:var(--bg-hover)"><x-import ' + DS + 'BotAvatar" name="小销" hue="tangerine" size="{{ 18 }}" hint-size="18px,18px"></x-import>小销的桌面<x-import ' + DS + 'Icon" name="chevron-down" size="{{ 14 }}" color="var(--fg-4)" hint-size="14px,14px"></x-import></span></div>\n'
    '        <div style="display:flex;align-items:center;gap:4px;font:var(--type-ui);font-size:13px">\n'
    '          <span style="padding:5px 10px;border-radius:999px;background:var(--bg-inset);color:var(--fg-1);font-weight:600">桌面</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">电脑终端</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">电脑文件</span>\n'
)
rep(SUBTABS_OLD, SUBTABS_NEW)
rep(">电脑空着</div>", ">桌面空着</div>")
rep("接管时它会停下等你；交回后从断点继续。", "接管时它会停下等你；交回后从断点继续。终端和文件是整台电脑的，5 个桌面共用。")

# 2. 去掉权限模型，可用系统拆成可用工具 + 已登录站点
ROW = '<div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;background:var(--bg-inset)"><span style="flex:1;min-width:0"><div style="font:var(--type-ui);font-size:14px;font-weight:600">{t}</div><div style="font:var(--type-caption);font-size:13px;color:var(--fg-3);margin-top:2px">{d}</div></span><x-import ' + DS + 'Icon" name="chevron-right" size="{{{{ 16 }}}}" color="var(--fg-4)" hint-size="16px,16px"></x-import></div>'
rep(ROW.format(t="可用系统", d="还没连。派活时它会问你要"),
    ROW.format(t="可用工具", d="还没勾。去「设置 · 工具」连 MCP 再勾给它，派活时它也会问你要") + "\n        " +
    ROW.format(t="已登录站点", d="在电脑里登录一次，所有 Bot 共用 · 已登录 3 个") + "\n        " +
    ROW.format(t="会做的活", d="还没有。干过的活它会存成 skill"))
rep(ROW.format(t="可用系统", d="工单 · CRM · ERP 只读 · 邮箱"),
    ROW.format(t="可用工具", d="工单 · CRM · 邮箱 · 改勾选去「设置 · 工具」") + "\n        " +
    ROW.format(t="已登录站点", d="电脑共用 · ERP、CRM、工单系统 · 工单系统已过期") + "\n        " +
    ROW.format(t="会做的活", d="夜间工单分流 · 退款话术 · 2 个 skill"))
rep("Bot 间交接 · 对话、确认、交接报文，所有权和权限可追溯", "Bot 间交接 · 对话、确认、交接报文，谁经手过一目了然")
rep('            <div style="padding:10px 14px;border-top:1px solid var(--border-1);font:var(--type-caption);color:var(--fg-4)">只移交任务所有权与清单指针，不移交额外系统权限。</div>\n', "")
rep("昨天 16:20 – 17:42 · 权限：工单、CRM 只读", "昨天 16:20 – 17:42")
rep("17:42 起 · 权限：CRM、ERP、邮箱", "17:42 起")
rep("等待接手 · 权限：供应商系统、邮箱", "等待接手")
rep('          <div style="font:var(--type-caption);color:var(--fg-4)">交接不转移对方没有的系统权限。</div>\n', "")
rep(">所有权链</div>", ">经手</div>")

# 3. 点头清单和角标统一
rep("对外发送、改生产数据、付钱、删除。系统通知 + 手机推送。", APPROVAL + "。系统通知。")
rep("对外发送、改生产、动钱仍需你点头", APPROVAL + "仍需你点头")
rep("</x-import>待我审批 2</span>", "</x-import>等你点头 2</span>", 2)
rep("</x-import>Bot 间交接 1</span>", "</x-import>等 Bot 确认 1</span>")
rep("</x-import>待 Bot 确认 1</span>", "</x-import>等 Bot 确认 1</span>", 2)
rep(">等待 Bot 确认</x-import>", ">等 Bot 确认</x-import>")
rep("04 待 Bot 确认", "05 Bot 间交接", 2)

# ── 二、逐屏 ─────────────────────────────────────────────────────

# 02 新建 Bot：去掉团队模板
rep_re(r'        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:560px">\n          <span[^\n]*或从团队模板开始</span>\n(?:          <x-import[^\n]*</x-import>\n){5}        </div>\n',
       '        <div style="font:var(--type-caption);font-size:13px;color:var(--fg-4)">它能用的工具和登录态在右边设置。没有岗位模板，描述写清楚就够了。</div>\n')

# 03 对话：一对一就是单 Bot 的群
rep("派活 · 在对话里说一句就行，Bot 回结论和选项，其他 Bot 插话有标注 · 右侧是 Bot 设置",
    "派活 · 在对话里说一句就行，Bot 回结论和选项 · 一对一就是只有一个 Bot 的群，其他 Bot 被 @ 进来插话有标注 · 右侧是 Bot 设置")

# 05 交接：SLA 只提醒，子任务降级为清单项，主题任务钉在群顶
rep("09-14 12:00 · SLA 18h", "09-14 12:00", 2)
rep("超时未确认：退回小销，或升级给你", "超时没确认只提醒你，不自动退回也不升级")
rep("T-2481-A · 供货确认", "T-2481 · 清单项「供货确认」")
rep("任务 T-2481 · 你 + 3 个 Bot", "主题任务 T-2481 · 你 + 3 个 Bot")
PIN = (
    '      <div style="display:flex;align-items:center;gap:10px;padding:8px 20px;border-bottom:1px solid var(--border-1);background:var(--bg-sidebar);font:var(--type-ui);font-size:13px">'
    '<x-import ' + DS + 'Icon" name="pin" size="{{ 14 }}" color="var(--fg-3)" hint-size="14px,14px"></x-import>'
    '<span style="font:var(--type-mono);font-size:12px;color:var(--fg-3)">T-2481</span><span style="font-weight:600">Globex X3 × 200</span>'
    '<span style="color:var(--fg-4)">清单 3 / 5</span><span style="color:var(--fg-4)">截止 09-14 12:00</span><span style="color:var(--fg-4)">当前 小销 → 小采</span>'
    '<span style="flex:1"></span><span style="font:var(--type-caption);color:var(--fg-4)">一个群跟一个主题任务，卡片钉在这里</span></div>\n'
)
rep('label="任务详情" active="{{ true }}" hint-size="32px,32px"></x-import>\n      </header>\n',
    'label="任务详情" active="{{ true }}" hint-size="32px,32px"></x-import>\n      </header>\n' + PIN)

# 06 例行任务：加「失败时」
FAIL = (
    '        <div style="display:flex;flex-direction:column;gap:6px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-2)">失败时</div>\n'
    '          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border-2);border-radius:12px;background:var(--bg-surface)"><span style="flex:1;font:var(--type-caption);font-size:13px;color:var(--fg-3)">比如工单系统登录过期</span><x-import ' + DS + 'Select" size="sm" value="stop" options="{{ failOptions }}" style="width:180px" hint-size="180px,30px"></x-import></div>\n'
    '        </div>\n'
)
rep('        <div style="display:flex;flex-direction:column;gap:8px;margin-top:240px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-2)">运行记录</div>',
    FAIL + '        <div style="display:flex;flex-direction:column;gap:8px;margin-top:170px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-2)">运行记录</div>')
rep("      budgetOptions: [", "      failOptions: [{ value: 'stop', label: '停下告诉我' }, { value: 'retry', label: '下次再试' }],\n      budgetOptions: [")

# 07 设置：去手机，预算标为后续
rep_re(r'        <div style="display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:10px;cursor:pointer" style-hover="background:var\(--bg-hover\)"><x-import [^\n]*name="smartphone"[^\n]*手机上也能点头[^\n]*</div>\n', "")
rep("/ ¥200 团队给你的周预算 · 周一 00:00 重置", "/ ¥200 周预算 · 周一 00:00 重置 · 团队预算是后续")
rep("到 80% 提醒你；到 100% Bot 停下，新任务等你或负责人加额。", "到 80% 提醒你；到 100% Bot 停下，等你加额。负责人加额是后续。")
rep("账单由团队统一结算，你这里只看用量。", "对内第一版只看用量，团队统一结算是后续。")

# ── 三、流程条 ───────────────────────────────────────────────────
LINK = '<a href="#{id}" style="padding:6px 12px;border-radius:999px;background:var(--bg-surface);box-shadow:var(--inset-hairline);color:var(--fg-1)">{t}</a>'
ARROW = '<span style="color:var(--fg-4)">→</span>'
rep(LINK.format(id="3a", t="07 账户菜单 · 设置") + "\n",
    LINK.format(id="3a", t="07 账户菜单 · 设置") + ARROW + LINK.format(id="4a", t="08 建群 · 主题任务") + ARROW +
    LINK.format(id="4b", t="09 工具连接") + ARROW + LINK.format(id="4c", t="10 skill") + ARROW + LINK.format(id="4d", t="11 桌面切换") + "\n")
rep("没有单独的「新建任务」和「岗位模板」页：派活就是发消息，建 Bot 就是点 +。",
    "一个群就是一个主题任务，派活就是发消息，建 Bot 就是点 +。没有岗位模板页。08 到 11 是这次按对齐结论补的屏。")

# ── 四、新增四张屏 ───────────────────────────────────────────────
m = re.search(r'<div id="2b" data-screen-label="2b 新建 Bot".*?\n(    <aside style="width:272px.*?</aside>\n)', s, re.S)
assert m, "sidebar of 2b not found"
SIDEBAR = m.group(1).replace('active="{{ true }}" ', "")


def sidebar(list_name: str) -> str:
    return SIDEBAR.replace("{{ botsNew }}", "{{ %s }}" % list_name)


TRAFFIC = '    <div style="position:absolute;top:16px;left:16px;display:flex;gap:8px;z-index:10"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span></div>\n'


def window(sid: str, label: str, num: str, caption: str, list_name: str, body: str) -> str:
    return (
        f'\n<!-- ═══════════ {label} ═══════════ -->\n'
        f'<section id="{sid}" data-screen-label="{label}" style="display:flex;flex-direction:column;gap:14px">\n'
        f'  <div style="display:flex;align-items:center;gap:10px;font:var(--type-ui);font-size:13px;color:var(--fg-3)"><span style="padding:3px 8px;border-radius:999px;background:var(--gray-1);color:var(--white);font:600 11px/1 var(--font-mono)">{num}</span>{caption}</div>\n'
        f'  <div style="width:1440px;height:900px;border-radius:14px;overflow:hidden;box-shadow:var(--shadow-window);display:flex;position:relative;background:var(--bg-app);flex-shrink:0">\n'
        + TRAFFIC + sidebar(list_name) + body +
        '  </div>\n</section>\n'
    )


def icon(name, size=16, color="var(--fg-3)"):
    return f'<x-import {DS}Icon" name="{name}" size="{{{{ {size} }}}}" color="{color}" hint-size="{size}px,{size}px"></x-import>'


def avatar(name, hue, size=20, extra=""):
    return f'<x-import {DS}BotAvatar" name="{name}" hue="{hue}" size="{{{{ {size} }}}}"{extra} hint-size="{size}px,{size}px"></x-import>'


def button(text, variant="secondary", ic=None, size="sm"):
    ic_attr = f' icon="{ic}"' if ic else ""
    return f'<x-import {DS}Button" size="{size}" variant="{variant}"{ic_attr} hint-size="auto,30px">{text}</x-import>'


def badge(text, tone="success", dot=True):
    d = ' dot="{{ true }}"' if dot else ""
    return f'<x-import {DS}Badge" tone="{tone}"{d} hint-size="auto,20px">{text}</x-import>'


def header(title_html: str, right_html: str = "") -> str:
    return ('      <header style="height:44px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--border-1)">'
            + title_html + '<span style="flex:1"></span>' + right_html + '</header>\n')


CARD = '<div style="border-radius:16px;background:var(--bg-surface);box-shadow:var(--inset-hairline);display:flex;flex-direction:column">'
ROW_OPEN = '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border-1)">'
ROW_LAST = '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px">'


def row(title, desc, right, last=False):
    return ((ROW_LAST if last else ROW_OPEN) + f'<span style="flex:1;min-width:0"><div style="font:var(--type-ui);font-size:14px">{title}</div><div style="font:var(--type-caption);font-size:13px;color:var(--fg-3)">{desc}</div></span>' + right + '</div>')


def stack(*names):
    parts = []
    for i, (n, h) in enumerate(names):
        extra = ' style="margin-left:-6px;box-shadow:0 0 0 2px var(--bg-surface);border-radius:6px"' if i else ""
        parts.append(avatar(n, h, 20, extra))
    return '<span style="display:flex">' + "".join(parts) + '</span>'


BOTS = [("小服", "sky"), ("小销", "tangerine"), ("小采", "mint"), ("小品", "violet"), ("小设", "pink")]

# 08 建群 · 主题任务
chips = []
for n, h in BOTS:
    on = n in ("小服", "小销", "小采")
    ring = "box-shadow:0 0 0 2px var(--bg-surface),0 0 0 4px var(--fg-1);" if on else "box-shadow:var(--inset-hairline);"
    chips.append(f'<span style="display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px 0 6px;border-radius:999px;background:var(--bg-surface);{ring}font:var(--type-ui);font-size:14px;cursor:pointer">{avatar(n, h, 24)}{n}{icon("check", 14, "var(--success)") if on else ""}</span>')
NEWGROUP_BODY = (
    '    <section style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg-app)">\n'
    + header(icon("users", 20) + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">新建群</span>')
    + '      <div style="flex:1;overflow-y:auto;display:flex;justify-content:center;padding:32px 40px">\n'
    '        <div style="width:640px;display:flex;flex-direction:column;gap:20px">\n'
    '          <div style="display:flex;flex-direction:column;gap:6px"><div style="font:var(--type-title);font-size:24px">一个群，跟一个主题任务</div><div style="font:var(--type-body);font-size:15px;color:var(--fg-3);text-wrap:pretty">Bot 在群里对话、交接，你在群里点头。任务卡钉在群顶部，清单由 Bot 维护。</div></div>\n'
    f'          <x-import {DS}Input" label="主题任务" default-value="Globex X3 × 200 订单" hint="编号由系统给，建好就是 T-2482" hint-size="100%,84px"></x-import>\n'
    '          <div style="display:flex;flex-direction:column;gap:8px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-2)">拉谁进来</div><div style="display:flex;gap:8px;flex-wrap:wrap">' + "".join(chips) + '</div><div style="font:var(--type-caption);font-size:12px;color:var(--fg-4)">2 到 6 个 Bot，都是你自己的。谁先接手，在群里 @它就行。</div></div>\n'
    '          <div style="display:flex;flex-direction:column;gap:6px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-2)">一句话说明</div>\n'
    '            <div style="border:1px solid var(--border-2);border-radius:12px;background:var(--bg-surface);padding:10px 12px;min-height:96px;font:var(--type-body);font-size:14px;color:var(--fg-1);box-sizing:border-box;text-wrap:pretty">Lisa 确认要 200 台 X3，交期 10 月 30 日前。报价归小销，供货归小采，小服跟客户沟通。改交期、对外发邮件先找我点头。</div>\n'
    '          </div>\n'
    f'          <x-import {DS}Input" label="截止（可选）" default-value="09-14 12:00" hint-size="100%,64px"></x-import>\n'
    '          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;background:var(--bg-inset)"><span style="flex:1;min-width:0"><div style="font:var(--type-ui);font-size:14px;font-weight:600">清单由 Bot 维护</div><div style="font:var(--type-caption);font-size:13px;color:var(--fg-3);margin-top:2px">交接时 Bot 自己更新已完成、未完成和清单。你随时在群里改。</div></span>'
    f'<x-import {DS}Switch" checked="{{{{ true }}}}" hint-size="36px,20px"></x-import></div>\n'
    '          <div style="display:flex;gap:8px;justify-content:flex-end">' + button("取消", "ghost") + button("建群并派活", "primary", "arrow-right") + '</div>\n'
    '        </div>\n'
    '      </div>\n'
    '    </section>\n'
    '    <aside style="width:400px;flex-shrink:0;border-left:1px solid var(--border-1);background:var(--bg-sidebar);display:flex;flex-direction:column;box-sizing:border-box">\n'
    '      <div style="height:44px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--border-1);font:var(--type-ui);font-size:15px;font-weight:600">建好后群顶部长这样</div>\n'
    '      <div style="padding:16px;display:flex;flex-direction:column;gap:16px">\n'
    '        <div style="border:1px solid var(--border-1);border-radius:16px;background:var(--bg-surface);overflow:hidden">\n'
    '          <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-1)">' + icon("pin", 14) + '<span style="font:var(--type-mono);font-size:12px;color:var(--fg-3)">T-2482</span><span style="font:var(--type-ui);font-weight:600">Globex X3 × 200 订单</span><span style="flex:1"></span>' + badge("刚建好", "neutral") + '</div>\n'
    '          <div style="padding:12px 14px;display:grid;grid-template-columns:64px 1fr;gap:8px 12px;font:var(--type-caption);font-size:13px;color:var(--fg-2)">'
    '<span style="color:var(--fg-4)">成员</span>' + stack(*BOTS[:3]) +
    '<span style="color:var(--fg-4)">清单</span><span>0 / 0 · Bot 接手后自己列</span>'
    '<span style="color:var(--fg-4)">截止</span><span style="font-variant-numeric:tabular-nums">09-14 12:00</span>'
    '<span style="color:var(--fg-4)">当前</span><span>还没人接手</span></div>\n'
    '        </div>\n'
    '        <div style="font:var(--type-caption);font-size:12px;color:var(--fg-4);text-wrap:pretty">建好就是一个群。一对一对话也是群，只是里面只有一个 Bot。交接就是群里一条报文，谁经手过在右侧「任务」页能看到。</div>\n'
    '      </div>\n'
    '    </aside>\n'
)

# 09 工具连接
TOOLS = [
    ("工单系统", "tickets.acme.internal · MCP", stack(BOTS[0], BOTS[1]) + button("改分配", "ghost")),
    ("CRM", "crm.acme.internal · MCP", stack(BOTS[0], BOTS[1]) + button("改分配", "ghost")),
    ("ERP", "erp.acme.internal · MCP", stack(BOTS[1], BOTS[2]) + button("改分配", "ghost")),
    ("邮箱", "mail.acme.com · MCP", '<span style="font:var(--type-caption);color:var(--fg-3)">全部 5 个 Bot</span>' + button("改分配", "ghost")),
    ("供应商门户", "还没连", button("连接", "secondary", "plug")),
]
tool_rows = "".join(row(t, d, r) for t, d, r in TOOLS)
tool_rows += ROW_LAST + button("连接新工具", "ghost", "plus") + '<span style="font:var(--type-caption);color:var(--fg-4)">MCP 地址或从公司目录选</span></div>'
SITES = [
    ("erp.acme.internal", "今天 09:16 · 你接管小销的桌面登录的", badge("有效")),
    ("crm.acme.internal", "昨天 · 小服登录的", badge("有效")),
    ("tickets.acme.internal", "09-12 过期 · 小服的例行任务停在这里等你", badge("过期", "accent") + button("接管登录", "secondary", "hand")),
]
site_rows = "".join(row(t, d, r, last=(i == len(SITES) - 1)) for i, (t, d, r) in enumerate(SITES))
TOOLS_CARDS = (
    '          <div style="display:flex;flex-direction:column;gap:8px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-4)">已连接的工具（MCP）· 你连一次，勾给哪些 Bot 用</div>' + CARD + tool_rows + '</div></div>\n'
    '          <div style="display:flex;flex-direction:column;gap:8px"><div style="font:var(--type-ui);font-size:13px;color:var(--fg-4)">电脑里已登录的站点 · 所有 Bot 的桌面共用</div>' + CARD + site_rows + '</div>'
    '<div style="font:var(--type-caption);font-size:12px;color:var(--fg-4)">Bot 设置里的「可用工具」「已登录站点」点进来也是这一页。登录态在云电脑里，过期了 Bot 不会猜密码，会停下请你接管登录。没有别的权限设置。</div></div>\n'
)

# 07 设置：加「工具」页。四个设置窗的导航都多一项，再复制「电脑」窗做成「工具」窗
NAV_ON = '<div style="display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:12px;background:var(--bg-selected);font:var(--type-ui);font-size:14px;color:var(--fg-1)"><x-import ' + DS + 'Icon" name="{i}" size="{{{{ 16 }}}}" hint-size="16px,16px"></x-import>{t}</div>'
NAV_OFF = '<div style="display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:12px;font:var(--type-ui);font-size:14px;color:var(--fg-2)"><x-import ' + DS + 'Icon" name="{i}" size="{{{{ 16 }}}}" color="var(--fg-3)" hint-size="16px,16px"></x-import>{t}</div>'
NAV_PC_ON, NAV_PC_OFF = NAV_ON.format(i="monitor", t="电脑"), NAV_OFF.format(i="monitor", t="电脑")
NAV_TOOLS_ON, NAV_TOOLS_OFF = NAV_ON.format(i="plug", t="工具"), NAV_OFF.format(i="plug", t="工具")
rep(NAV_PC_ON + "\n", NAV_PC_ON + "\n        " + NAV_TOOLS_OFF + "\n", 1)
rep_re(r'( *)(<div style="[^"]*color:var\(--fg-2\)[^\n]*name=")monitor(" size="\{\{ 16 \}\}" color="var\(--fg-3\)"[^\n]*>)电脑(</div>\n)',
       r'\1\2monitor\3电脑\4\1\2plug\3工具\4', 3)

PC_WINDOW = re.search(r"    <!-- 电脑 -->\n(.*?)(?=    <!-- 用量与账单 -->\n)", s, re.S).group(1)
NAV_TOOLS_PAGE = re.search(r"<nav .*?</nav>", PC_WINDOW, re.S).group(0).replace(NAV_PC_ON, NAV_PC_OFF).replace(NAV_TOOLS_OFF, NAV_TOOLS_ON)
assert NAV_TOOLS_PAGE.count(NAV_TOOLS_ON) == 1 and NAV_PC_ON not in NAV_TOOLS_PAGE
TOOLS_WINDOW = (
    '<div style="width:1040px;height:720px;border-radius:20px;background:var(--bg-elevated);box-shadow:var(--shadow-lg);display:flex;overflow:hidden;flex-shrink:0">\n'
    '      ' + NAV_TOOLS_PAGE + '\n'
    '      <div style="flex:1;min-width:0;display:flex;flex-direction:column">\n'
    '        <div style="display:flex;align-items:center;padding:20px 24px 0"><span style="font:var(--type-heading);font-size:20px">工具</span><span style="flex:1"></span><x-import ' + DS + 'IconButton" icon="x" label="关闭" hint-size="32px,32px"></x-import></div>\n'
    '        <div style="flex:1;overflow-y:auto;padding:12px 24px 24px;display:flex;flex-direction:column;gap:22px">\n'
    + TOOLS_CARDS +
    '        </div>\n'
    '      </div>\n'
    '    </div>\n'
)
rep("    <!-- 用量与账单 -->\n", "    <!-- 工具 -->\n    " + TOOLS_WINDOW + "    <!-- 用量与账单 -->\n")
rep("设置 · 四页：通用、电脑、用量与账单、更新", "设置 · 五页：通用、电脑、工具、用量与账单、更新")
rep("电脑 · 用量与账单 · 更新（只画窗内容，1040×720）", "电脑 · 工具 · 用量与账单 · 更新（只画窗内容，1040×720）")

# 09：从 Bot 设置的「可用工具」点进来，设置窗停在「工具」页
TOOLS_BODY = (
    '    <section style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg-app)">\n'
    + header(avatar("小服", "sky", 24) + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">小服</span><span style="font:var(--type-caption);color:var(--fg-3)">客服</span>')
    + '      <div style="flex:1;display:flex;align-items:center;justify-content:center;font:var(--type-caption);color:var(--fg-4)">你在小服的设置里点了「可用工具」</div>\n'
    '    </section>\n'
    '    <div style="position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center">\n'
    '    ' + TOOLS_WINDOW +
    '    </div>\n'
)

# 10 skill · 会做的活
SKILLS = [
    ("Globex 报价", "来自对话 · 09-13 存的 · 用过 3 次", True),
    ("线索跟进早报", "来自例行任务 · 用过 21 次", False),
    ("合同条款比对", "你教的 · 用过 1 次", False),
]
skill_rows = ""
for i, (n, d, on) in enumerate(SKILLS):
    bg = "background:var(--bg-inset);" if on else ""
    border = "" if i == len(SKILLS) - 1 else "border-bottom:1px solid var(--border-1);"
    skill_rows += f'<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;{border}{bg}cursor:pointer" style-hover="background:var(--bg-hover)">' + icon("sparkles", 16) + f'<span style="flex:1;min-width:0"><div style="font:var(--type-ui)">{n}</div><div style="font:var(--type-caption);color:var(--fg-4)">{d}</div></span>' + icon("chevron-right", 14, "var(--fg-4)") + '</div>'
STEPS = ["在 ERP 按客户建报价单", "折扣沿用上季度口径，不确定时问你", "生成 PDF，附上保修条款", "发邮件前停下等你点头"]
step_html = "".join(f'<div style="display:flex;gap:10px;align-items:flex-start"><span style="width:20px;height:20px;border-radius:50%;background:var(--bg-inset);font:600 11px/20px var(--font-mono);text-align:center;flex-shrink:0">{i + 1}</span><span style="font:var(--type-body);font-size:14px;color:var(--fg-1)">{t}</span></div>' for i, t in enumerate(STEPS))
SKILL_BODY = (
    '    <section style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg-app)">\n'
    + header(avatar("小销", "tangerine") + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">小销</span>' + badge("空闲"),
             f'<x-import {DS}IconButton" icon="panel-right" label="Bot 设置" active="{{{{ true }}}}" hint-size="32px,32px"></x-import>')
    + '      <div ref="{{ threadRef }}" style="flex:1;overflow-y:auto;display:flex;flex-direction:column">\n'
    '        <div style="width:100%;max-width:760px;margin:auto auto 0;padding:20px 20px 12px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px">\n'
    f'          <x-import {DS}Message" role="time" hint-size="100%,20px">今天 10:20</x-import>\n'
    f'          <x-import {DS}Message" role="user" hint-size="100%,44px">Initech 也要 X3，150 台，按 Globex 那套出报价。</x-import>\n'
    f'          <x-import {DS}Message" time="10:20" hint-size="100%,44px">好，用 skill「Globex 报价」跑，两分钟。发邮件前还是找你点头。</x-import>\n'
    f'          <x-import {DS}ToolCall" kind="browse" title="skill" command="Globex 报价 · 第 1 步 · ERP 建报价单 Q-2611" status="running" style="max-width:88%" hint-size="88%,44px"></x-import>\n'
    '        </div>\n'
    '      </div>\n'
    f'      <div style="padding:6px 20px 16px;display:flex;justify-content:center"><div style="width:100%;max-width:760px"><x-import {DS}Composer" placeholder="给小销发消息" hint-size="100%,52px"></x-import></div></div>\n'
    '    </section>\n'
    '    <aside style="width:400px;flex-shrink:0;border-left:1px solid var(--border-1);background:var(--bg-sidebar);display:flex;flex-direction:column;box-sizing:border-box">\n'
    '      <div style="height:44px;display:flex;align-items:center;gap:8px;padding:0 8px 0 14px;border-bottom:1px solid var(--border-1)">' + avatar("小销", "tangerine") + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">小销</span>' + badge("在干活", "accent") + '<span style="flex:1"></span>' + f'<x-import {DS}IconButton" icon="x" label="收起面板" hint-size="32px,32px"></x-import></div>\n'
    '      <div style="padding:12px 16px 16px;display:flex;flex-direction:column;gap:18px;flex:1;overflow-y:auto">\n'
    f'        <x-import {DS}Tabs" variant="segmented" size="sm" value="settings" items="{{{{ botTabs }}}}" hint-size="100%,32px"></x-import>\n'
    '        <div style="display:flex;align-items:center;gap:4px;margin:-6px 0 -8px -8px;font:var(--type-ui);font-size:13px">' + f'<x-import {DS}IconButton" icon="chevron-left" label="返回设置" size="sm" hint-size="28px,28px"></x-import>' + '<span style="color:var(--fg-3)">设置</span><span style="color:var(--fg-4)">/</span><span style="font-weight:600;color:var(--fg-1)">会做的活 · 3</span></div>\n'
    '        <div style="display:flex;flex-direction:column;border:1px solid var(--border-1);border-radius:16px;overflow:hidden">' + skill_rows + '</div>\n'
    '        <div style="display:flex;flex-direction:column;gap:12px;padding:14px 16px;border-radius:16px;background:var(--bg-surface);box-shadow:var(--inset-hairline)">\n'
    '          <div style="display:flex;align-items:center;gap:8px"><span style="font:var(--type-ui);font-size:14px;font-weight:600">Globex 报价</span>' + badge("在用", "accent") + '<span style="flex:1"></span>' + button("改一改", "ghost", "pencil") + button("删掉", "ghost", "trash-2") + '</div>\n'
    '          ' + step_html + '\n'
    '          <div style="font:var(--type-caption);font-size:12px;color:var(--fg-4)">小销自己存的，你能改。第 4 步是 Bot 描述里定的边界，删不掉。</div>\n'
    '        </div>\n'
    '        <div style="display:flex;gap:8px">' + button("教它一个", "secondary", "plus") + button("复制给别的 Bot", "ghost", "copy") + '</div>\n'
    '        <div style="font:var(--type-caption);font-size:12px;color:var(--fg-4);text-align:center;margin-top:auto">skill 属于这个 Bot。干过的活它会问你要不要存下来。</div>\n'
    '      </div>\n'
    '    </aside>\n'
)

# 11 桌面切换
DESKTOPS = [
    ("小销", "tangerine", "空闲", "success", "erp.acme.internal · 报价单 Q-2611", True),
    ("小服", "sky", "在干活", "accent", "tickets.acme.internal · 分流夜间工单", False),
    ("小采", "mint", "在干活", "accent", "supplier.foo.com · 询价", False),
    ("小品", "violet", "空闲", "success", "docs · 需求评审纪要", False),
    ("小设", "pink", "离线", "neutral", "桌面已休眠", False),
]
dd_rows = ""
for n, h, st, tone, on_what, cur in DESKTOPS:
    bg = "background:var(--bg-selected);" if cur else ""
    dd_rows += f'<div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 10px;border-radius:12px;{bg}cursor:pointer" style-hover="background:var(--bg-hover)">' + avatar(n, h, 28) + f'<span style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;font:var(--type-ui);font-size:14px">{n}的桌面' + badge(st, tone) + f'</div><div style="font:var(--type-caption);font-size:12px;color:var(--fg-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{on_what}</div></span>' + (icon("check", 14, "var(--fg-1)") if cur else "") + '</div>'
DESKTOP_BODY = (
    '    <section style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg-app)">\n'
    + header(avatar("小销", "tangerine") + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">小销</span>' + badge("空闲"),
             f'<x-import {DS}IconButton" icon="panel-right" label="桌面" active="{{{{ true }}}}" hint-size="32px,32px"></x-import>')
    + '      <div ref="{{ threadRef }}" style="flex:1;overflow-y:auto;display:flex;flex-direction:column">\n'
    '        <div style="width:100%;max-width:760px;margin:auto auto 0;padding:20px 20px 12px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px">\n'
    f'          <x-import {DS}Message" role="time" hint-size="100%,20px">今天 10:24</x-import>\n'
    f'          <x-import {DS}Message" time="10:24" hint-size="100%,44px">Initech 的报价单建好了，在 ERP 里。要看的话切到我的桌面。</x-import>\n'
    f'          <x-import {DS}Message" role="user" hint-size="100%,44px">我先看看小服那边工单分流得怎么样。</x-import>\n'
    f'          <x-import {DS}Message" role="system" hint-size="100%,20px">你切到了小服的桌面 · 10:25 · 小销继续干活</x-import>\n'
    '        </div>\n'
    '      </div>\n'
    f'      <div style="padding:6px 20px 16px;display:flex;justify-content:center"><div style="width:100%;max-width:760px"><x-import {DS}Composer" placeholder="给小销发消息" hint-size="100%,52px"></x-import></div></div>\n'
    '    </section>\n'
    '    <aside style="width:400px;flex-shrink:0;border-left:1px solid var(--border-1);background:var(--bg-sidebar);display:flex;flex-direction:column;box-sizing:border-box;position:relative">\n'
    '      <div style="height:44px;display:flex;align-items:center;gap:8px;padding:0 8px 0 14px;border-bottom:1px solid var(--border-1)">' + icon("monitor", 18) + '<span style="font:var(--type-ui);font-size:15px;font-weight:600">你的电脑</span>' + badge("5 个桌面", "neutral", False) + '<span style="flex:1"></span>' + f'<x-import {DS}IconButton" icon="x" label="收起面板" hint-size="32px,32px"></x-import></div>\n'
    '      <div style="padding:12px 16px 16px;display:flex;flex-direction:column;gap:12px;flex:1;min-height:0">\n'
    f'        <x-import {DS}Tabs" variant="segmented" size="sm" value="computer" items="{{{{ botTabs }}}}" hint-size="100%,32px"></x-import>\n'
    '        <div style="display:flex;align-items:center;gap:6px;font:var(--type-ui);font-size:12px;color:var(--fg-4)">' + icon("monitor", 14) + '桌面<span style="flex:1"></span><span style="display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 6px;border-radius:999px;background:var(--bg-inset);box-shadow:var(--ring-focus);color:var(--fg-1);cursor:pointer">' + avatar("小销", "tangerine", 18) + '小销的桌面' + icon("chevron-up", 14, "var(--fg-4)") + '</span></div>\n'
    '        <div style="position:absolute;right:16px;top:100px;width:300px;border-radius:16px;background:var(--bg-elevated);box-shadow:var(--shadow-lg);border:1px solid var(--border-1);padding:6px;display:flex;flex-direction:column;gap:2px;z-index:5">' + dd_rows + '<div style="padding:8px 10px 4px;font:var(--type-caption);font-size:12px;color:var(--fg-4)">切换只是换你看哪个桌面，Bot 都在各自桌面上继续干。</div></div>\n'
    '        <div style="display:flex;align-items:center;gap:4px;font:var(--type-ui);font-size:13px">\n'
    '          <span style="padding:5px 10px;border-radius:999px;background:var(--bg-inset);color:var(--fg-1);font-weight:600">桌面</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">电脑终端</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">电脑文件</span>\n'
    '          <span style="padding:5px 10px;border-radius:999px;color:var(--fg-3);cursor:pointer" style-hover="background:var(--bg-hover)">成果</span>\n'
    '          <span style="flex:1"></span><span style="font:var(--type-mono);font-size:11px;color:var(--fg-4)">c7e2a1</span>\n'
    '        </div>\n'
    '        <div style="flex:1;border-radius:16px;background:var(--bg-surface);box-shadow:var(--inset-hairline);overflow:hidden;display:flex;flex-direction:column">\n'
    '          <div style="height:30px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--border-1);color:var(--fg-3)">' + icon("globe", 12) + '<span style="flex:1;height:18px;border-radius:999px;background:var(--bg-inset);display:flex;align-items:center;padding:0 8px;font:var(--type-mono);font-size:10px">erp.acme.internal/quotes/Q-2611</span></div>\n'
    '          <div style="flex:1;padding:16px;display:flex;flex-direction:column;gap:12px"><div style="display:flex;align-items:center;gap:8px"><span style="font:var(--type-ui);font-size:14px">报价单 Q-2611 · Initech</span>' + badge("草稿", "neutral", False) + '</div><div style="height:8px;border-radius:4px;background:var(--bg-inset);width:70%"></div><div style="height:8px;border-radius:4px;background:var(--bg-inset);width:55%"></div><div style="height:8px;border-radius:4px;background:var(--bg-inset);width:80%"></div></div>\n'
    '        </div>\n'
    '        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;background:var(--bg-inset)"><span style="flex:1;min-width:0"><div style="font:var(--type-ui);font-size:14px;font-weight:600">这台电脑</div><div style="font:var(--type-caption);font-size:13px;color:var(--fg-3);margin-top:2px">ubuntu · c7e2a1 · 登录态和文件 5 个桌面共用 · 闲置 7 天休眠</div></span>' + button("接管", "secondary", "hand") + '</div>\n'
    '      </div>\n'
    '    </aside>\n'
)

NEW_SCREENS = (
    window("4a", "08 建群 · 主题任务", "08", "建群 · 一个群就是一个主题任务，选几个自己的 Bot、写清主题，任务卡钉在群顶部", "botsGroup", NEWGROUP_BODY)
    + window("4b", "09 工具连接", "09", "工具 · 从 Bot 设置的「可用工具」或账户菜单的「设置」进来都是这一页；连一次 MCP 勾给哪些 Bot 用；登录态所有桌面共用", "botsGroup", TOOLS_BODY)
    + window("4c", "10 skill · 会做的活", "10", "skill · Bot 设置里能看到它会做的活，改一改或删掉；干过的活它会问你存不存", "botsMain", SKILL_BODY)
    + window("4d", "11 桌面切换", "11", "桌面切换 · 一台电脑 5 个桌面，面板里挑看哪个；终端和文件是整台电脑的", "botsMain", DESKTOP_BODY)
)
rep("\n\n</div>\n</x-dc>\n", NEW_SCREENS + "\n</div>\n</x-dc>\n")

# ── 收尾检查：旧措辞不得残留 ───────────────────────────────────
for banned in ["权限：", "SLA 18h", "手机推送", "iOS · Android", "待我审批", "Bot 间交接 1", "待 Bot 确认", "T-2481-A",
               "团队模板", "所有权链", "每个 Bot 一台", "5 台在线", "Bot 的电脑", "小销的电脑", "电脑空着", "可用系统",
               "改生产、动钱", "付钱、删除"]:
    assert banned not in s, f"leftover: {banned!r}"

DST.write_text(s, encoding="utf-8")
print(f"wrote {DST} ({len(s.encode('utf-8'))} bytes, {s.count(chr(10)) + 1} lines)")
