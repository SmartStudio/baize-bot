/* @ds-bundle: {"format":4,"namespace":"BaizeDesignSystem_7d7772","components":[{"name":"Composer","sourcePath":"components/agent/Composer.jsx"},{"name":"ComputerCard","sourcePath":"components/agent/ComputerCard.jsx"},{"name":"Message","sourcePath":"components/agent/Message.jsx"},{"name":"Terminal","sourcePath":"components/agent/Terminal.jsx"},{"name":"ToolCall","sourcePath":"components/agent/ToolCall.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"BOT_HUES","sourcePath":"components/core/BotAvatar.jsx"},{"name":"BotAvatar","sourcePath":"components/core/BotAvatar.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"StatusDot","sourcePath":"components/core/StatusDot.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Tooltip","sourcePath":"components/core/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Card","sourcePath":"components/layout/Card.jsx"},{"name":"Dialog","sourcePath":"components/layout/Dialog.jsx"},{"name":"Tabs","sourcePath":"components/layout/Tabs.jsx"},{"name":"Toast","sourcePath":"components/layout/Toast.jsx"}],"sourceHashes":{"components/agent/Composer.jsx":"59150fcb6cfb","components/agent/ComputerCard.jsx":"b195bf55296a","components/agent/Message.jsx":"db3e626eeddd","components/agent/Terminal.jsx":"56111348ac1e","components/agent/ToolCall.jsx":"a7382c8a444c","components/core/Badge.jsx":"8bbefb345c2c","components/core/BotAvatar.jsx":"0c37cf31856e","components/core/Button.jsx":"2411453fc1c9","components/core/Icon.jsx":"1288862d5c57","components/core/IconButton.jsx":"0182aee50059","components/core/StatusDot.jsx":"25ed073a0903","components/core/Tag.jsx":"416eba355481","components/core/Tooltip.jsx":"099ca4c26822","components/forms/Checkbox.jsx":"190414367745","components/forms/Input.jsx":"67de4ad06ab8","components/forms/Radio.jsx":"1d19a6e2f855","components/forms/Select.jsx":"210d512e1789","components/forms/Switch.jsx":"bd18c907e296","components/layout/Card.jsx":"53bcb4ff09ec","components/layout/Dialog.jsx":"1eb0dfce624d","components/layout/Tabs.jsx":"85930cd4102e","components/layout/Toast.jsx":"4c40585a9745","ui_kits/console/ConsoleApp.jsx":"b2d04e356d6e","ui_kits/desktop/BotPanel.jsx":"1b6f64340723","ui_kits/desktop/DesktopApp.jsx":"6de343a359e4","ui_kits/desktop/HireView.jsx":"b0b661a2d269","ui_kits/desktop/LoginView.jsx":"0247aef56a76","ui_kits/desktop/SettingsView.jsx":"47eb2468965f","ui_kits/desktop/Sidebar.jsx":"c9d272c4dcbd","ui_kits/desktop/ThreadView.jsx":"0cd0591e219e","ui_kits/desktop/data.js":"6bb660005997","ui_kits/website/Hero.jsx":"54382eb20c02","ui_kits/website/Nav.jsx":"960f92f63921","ui_kits/website/Sections.jsx":"02180cf99011","ui_kits/website/SiteApp.jsx":"07b16c1b373c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.BaizeDesignSystem_7d7772 = window.BaizeDesignSystem_7d7772 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
const T = {
  neutral: ['var(--bg-elevated)', 'var(--fg-2)'],
  accent: ['var(--accent-soft)', 'var(--accent)'],
  success: ['var(--success-soft)', 'var(--success)'],
  danger: ['var(--danger-soft)', 'var(--danger)'],
  info: ['var(--info-soft)', 'var(--info)']
};
function Badge({
  tone = 'neutral',
  dot,
  children,
  style
}) {
  const [bg, fg] = T[tone];
  return React.createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 22,
      padding: '0 8px',
      borderRadius: 'var(--radius-full)',
      background: bg,
      color: fg,
      font: 'var(--type-label)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 500,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      ...style
    }
  }, dot ? React.createElement('span', {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: 'currentColor'
    }
  }) : null, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/BotAvatar.jsx
try { (() => {
const BOT_HUES = ['coral', 'tangerine', 'lime', 'mint', 'sky', 'violet', 'pink'];
function BotAvatar({
  name = '白',
  hue = 'tangerine',
  size = 32,
  status,
  ring,
  style
}) {
  const dark = ['lime', 'tangerine'].includes(hue);
  const cs = [...String(name)];
  const ch = cs.length > 1 && /^[小阿老]$/.test(cs[0]) ? cs[1] : cs[0];
  return React.createElement('span', {
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0,
      width: size,
      height: size,
      ...style
    }
  }, React.createElement('span', {
    style: {
      width: '100%',
      height: '100%',
      borderRadius: Math.round(size * 0.32),
      background: 'var(--bot-' + hue + ')',
      color: dark ? 'var(--gray-0)' : '#fff',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '600 ' + Math.round(size * 0.42) + 'px/1 var(--font-sans)',
      boxShadow: ring ? '0 0 0 2px var(--bg-app), 0 0 0 4px var(--bot-' + hue + ')' : 'none'
    }
  }, ch), status ? React.createElement('span', {
    style: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: Math.max(8, size * 0.3),
      height: Math.max(8, size * 0.3),
      borderRadius: '50%',
      border: '2px solid var(--bg-app)',
      background: status === 'working' ? 'var(--accent)' : status === 'online' ? 'var(--success)' : status === 'blocked' ? 'var(--danger)' : 'var(--fg-4)',
      animation: status === 'working' ? 'bz-pulse 1.2s ease-in-out infinite' : 'none'
    }
  }) : null, React.createElement('style', null, '@keyframes bz-pulse{0%,100%{opacity:1}50%{opacity:.35}}'));
}
Object.assign(__ds_scope, { BOT_HUES, BotAvatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/BotAvatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
// Lucide wrapper. Requires window.lucide (https://unpkg.com/lucide@latest). name is kebab-case, e.g. "arrow-right".
const pascal = s => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('');
function Icon({
  name,
  size = 16,
  strokeWidth = 1.5,
  color = 'currentColor',
  style,
  ...rest
}) {
  const lib = typeof window !== 'undefined' && window.lucide && window.lucide.icons;
  let node = lib && (lib[pascal(name)] || lib[name]);
  let kids = [];
  if (Array.isArray(node)) {
    kids = typeof node[0] === 'string' ? node[2] || [] : node;
  }
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: {
      flexShrink: 0,
      display: 'inline-block',
      verticalAlign: 'middle',
      ...style
    },
    'aria-hidden': true,
    ...rest
  }, kids.map((k, i) => React.createElement(k[0], {
    key: i,
    ...k[1]
  })));
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/agent/ComputerCard.jsx
try { (() => {
const T = {
  done: ['success', '完成'],
  working: ['accent', '干活中'],
  waiting: ['info', '等你'],
  failed: ['danger', '失败']
};
function ComputerCard({
  title = '电脑',
  status = 'working',
  children,
  preview,
  onOpen,
  style
}) {
  const [tone, label] = T[status] || T.working;
  return React.createElement('div', {
    onClick: onOpen,
    style: {
      maxWidth: 440,
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-inset)',
      padding: '11px 11px 11px 15px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      cursor: onOpen ? 'pointer' : 'default',
      font: 'var(--type-body)',
      fontSize: 15,
      lineHeight: 1.5,
      ...style
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12
    }
  }, React.createElement('span', {
    style: {
      font: 'var(--type-ui)',
      fontSize: 15,
      fontWeight: 600,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'monitor',
    size: 15,
    color: 'var(--fg-3)'
  }), title), React.createElement(__ds_scope.Badge, {
    tone,
    dot: status === 'working' || status === 'done'
  }, label)), children ? React.createElement('div', null, children) : null, preview ? React.createElement('div', {
    style: {
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline)',
      height: 180
    }
  }, preview) : null);
}
Object.assign(__ds_scope, { ComputerCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agent/ComputerCard.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const {
  useState
} = React;
const H = {
  sm: 'var(--control-h-sm)',
  md: 'var(--control-h-md)',
  lg: 'var(--control-h-lg)'
};
const PX = {
  sm: '0 12px',
  md: '0 16px',
  lg: '0 22px'
};
const FS = {
  sm: 'var(--text-xs)',
  md: 'var(--text-sm)',
  lg: 'var(--text-md)'
};
function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading,
  disabled,
  block,
  children,
  style,
  ...rest
}) {
  const [h, setH] = useState(false),
    [a, setA] = useState(false);
  const base = {
    display: block ? 'flex' : 'inline-flex',
    width: block ? '100%' : undefined,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: H[size],
    padding: PX[size],
    borderRadius: 'var(--radius-full)',
    font: 'var(--type-ui)',
    fontSize: FS[size],
    cursor: disabled ? 'default' : 'pointer',
    border: '1px solid transparent',
    transition: 'background var(--dur-fast),border-color var(--dur-fast),color var(--dur-fast),transform var(--dur-fast)',
    transform: a ? 'scale(.98)' : 'none',
    opacity: disabled ? 0.4 : 1,
    pointerEvents: disabled ? 'none' : undefined,
    whiteSpace: 'nowrap',
    outline: 'none',
    userSelect: 'none',
    boxSizing: 'border-box'
  };
  const v = {
    primary: {
      background: h ? 'var(--btn-primary-hover)' : 'var(--btn-primary-bg)',
      color: 'var(--btn-primary-fg)'
    },
    accent: {
      background: h ? 'var(--accent-strong)' : 'var(--accent)',
      color: 'var(--accent-fg)'
    },
    dark: {
      background: h ? 'var(--btn-primary-hover)' : 'var(--btn-primary-bg)',
      color: 'var(--btn-primary-fg)'
    },
    secondary: {
      background: a ? 'var(--bg-active)' : h ? 'var(--bg-hover)' : 'var(--bg-surface)',
      color: 'var(--fg-1)',
      borderColor: h ? 'var(--border-3)' : 'var(--border-2)'
    },
    ghost: {
      background: a ? 'var(--bg-active)' : h ? 'var(--bg-hover)' : 'transparent',
      color: h ? 'var(--fg-1)' : 'var(--fg-2)'
    },
    danger: {
      background: a ? 'var(--danger)' : h ? 'var(--danger-soft)' : 'transparent',
      color: a ? '#fff' : 'var(--danger)',
      borderColor: 'var(--danger)'
    },
    soft: {
      background: h ? 'var(--bg-active)' : 'var(--bg-selected)',
      color: 'var(--fg-1)'
    }
  }[variant];
  return React.createElement('button', {
    type: 'button',
    disabled,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => {
      setH(false);
      setA(false);
    },
    onMouseDown: () => setA(true),
    onMouseUp: () => setA(false),
    onFocus: e => {
      if (e.target.matches(':focus-visible')) e.target.style.boxShadow = 'var(--ring-focus)';
    },
    onBlur: e => {
      e.target.style.boxShadow = 'none';
    },
    style: {
      ...base,
      ...v,
      ...style
    },
    ...rest
  }, loading ? React.createElement(__ds_scope.Icon, {
    name: 'loader-circle',
    size: 14,
    style: {
      animation: 'bz-spin 1s linear infinite'
    }
  }) : icon ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === 'sm' ? 14 : 16
  }) : null, children, iconRight ? React.createElement(__ds_scope.Icon, {
    name: iconRight,
    size: size === 'sm' ? 14 : 16
  }) : null, React.createElement('style', null, '@keyframes bz-spin{to{transform:rotate(360deg)}}'));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
const {
  useState
} = React;
const S = {
  sm: 24,
  md: 28,
  lg: 32
};
function IconButton({
  icon,
  size = 'md',
  active,
  label,
  disabled,
  variant = 'ghost',
  style,
  ...rest
}) {
  const [h, setH] = useState(false);
  const px = S[size];
  return React.createElement('button', {
    type: 'button',
    'aria-label': label,
    title: label,
    disabled,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: px,
      height: px,
      padding: 0,
      borderRadius: 'var(--radius-full)',
      border: variant === 'outline' ? '1px solid var(--border-2)' : '1px solid transparent',
      background: active ? 'var(--bg-selected)' : h ? 'var(--bg-hover)' : variant === 'outline' ? 'var(--bg-surface)' : 'transparent',
      color: active || h ? 'var(--fg-1)' : 'var(--fg-3)',
      cursor: 'pointer',
      transition: 'background var(--dur-fast),color var(--dur-fast)',
      opacity: disabled ? 0.4 : 1,
      pointerEvents: disabled ? 'none' : undefined,
      outline: 'none',
      ...style
    },
    ...rest
  }, React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === 'sm' ? 14 : 16
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/agent/Message.jsx
try { (() => {
const {
  useState
} = React;
function Message({
  role = 'assistant',
  bot,
  children,
  time,
  streaming,
  actions = false,
  showAvatar = false,
  style
}) {
  const [h, setH] = useState(false);
  if (role === 'system') return React.createElement('div', {
    style: {
      textAlign: 'center',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      padding: '2px 0',
      ...style
    }
  }, children);
  if (role === 'time') return React.createElement('div', {
    style: {
      textAlign: 'center',
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      padding: '6px 0',
      ...style
    }
  }, children);
  if (role === 'user') return React.createElement('div', {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      ...style
    }
  }, React.createElement('div', {
    style: {
      maxWidth: '72%',
      padding: '11px 15px',
      borderRadius: 18,
      background: 'var(--bg-bubble)',
      color: 'var(--fg-1)',
      boxShadow: 'var(--inset-hairline)',
      font: 'var(--type-body)',
      fontSize: 15,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap'
    }
  }, children));
  const b = bot || {
    name: '白泽',
    hue: 'tangerine'
  };
  return React.createElement('div', {
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'flex-end',
      ...style
    }
  }, showAvatar ? React.createElement(__ds_scope.BotAvatar, {
    name: b.name,
    hue: b.hue,
    size: 28
  }) : null, React.createElement('div', {
    style: {
      maxWidth: '72%',
      minWidth: 0
    }
  }, React.createElement('div', {
    style: {
      padding: '11px 15px',
      borderRadius: 18,
      background: 'var(--bg-bubble)',
      color: 'var(--fg-1)',
      font: 'var(--type-body)',
      fontSize: 15,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap'
    }
  }, children, streaming ? React.createElement('span', {
    style: {
      display: 'inline-block',
      width: 8,
      height: 8,
      marginLeft: 6,
      borderRadius: '50%',
      background: 'var(--accent)',
      animation: 'bz-pulse 1.2s ease-in-out infinite',
      verticalAlign: 'middle'
    }
  }) : null), actions || time ? React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      marginTop: 4,
      height: 20,
      opacity: h ? 1 : 0,
      transition: 'opacity var(--dur-fast)'
    }
  }, actions ? [React.createElement(__ds_scope.IconButton, {
    key: 'c',
    icon: 'copy',
    label: '复制',
    size: 'sm'
  }), React.createElement(__ds_scope.IconButton, {
    key: 'r',
    icon: 'refresh-cw',
    label: '重新生成',
    size: 'sm'
  })] : null, time ? React.createElement('span', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      marginLeft: 4
    }
  }, time) : null) : null));
}
Object.assign(__ds_scope, { Message });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agent/Message.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusDot.jsx
try { (() => {
const C = {
  idle: 'var(--fg-4)',
  running: 'var(--accent)',
  success: 'var(--success)',
  error: 'var(--danger)',
  info: 'var(--info)'
};
function StatusDot({
  status = 'idle',
  size = 8,
  label,
  style
}) {
  return React.createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      font: 'var(--type-caption)',
      color: 'var(--fg-2)',
      ...style
    }
  }, React.createElement('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      background: C[status],
      animation: status === 'running' ? 'bz-pulse 1.2s ease-in-out infinite' : 'none',
      flexShrink: 0
    }
  }), label, React.createElement('style', null, '@keyframes bz-pulse{0%,100%{opacity:1}50%{opacity:.35}}'));
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/agent/Terminal.jsx
try { (() => {
function Terminal({
  lines = [],
  title = 'sandbox',
  container,
  status = 'idle',
  height = 240,
  style
}) {
  return React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--code-bg)',
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      font: 'var(--type-mono)',
      color: 'var(--code-fg)',
      ...style
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 12px',
      borderBottom: '1px solid var(--border-1)',
      fontSize: 11,
      color: 'var(--fg-3)'
    }
  }, React.createElement('span', null, title), container ? React.createElement('span', {
    style: {
      color: 'var(--fg-4)'
    }
  }, container) : null, React.createElement('span', {
    style: {
      flex: 1
    }
  }), React.createElement(__ds_scope.StatusDot, {
    status,
    size: 6
  })), React.createElement('pre', {
    style: {
      margin: 0,
      padding: '10px 12px',
      height,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all'
    }
  }, lines.map((l, i) => {
    const t = typeof l === 'string' ? {
      text: l
    } : l;
    const c = t.type === 'cmd' ? 'var(--fg-1)' : t.type === 'err' ? 'var(--danger)' : t.type === 'dim' ? 'var(--fg-4)' : 'var(--code-fg)';
    return React.createElement('div', {
      key: i,
      style: {
        color: c
      }
    }, t.type === 'cmd' ? React.createElement('span', {
      style: {
        color: 'var(--code-prompt)'
      }
    }, '$ ') : null, t.text);
  }), status === 'running' ? React.createElement('span', {
    style: {
      display: 'inline-block',
      width: 7,
      height: 13,
      background: 'var(--accent)',
      verticalAlign: '-2px'
    }
  }) : null));
}
Object.assign(__ds_scope, { Terminal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agent/Terminal.jsx", error: String((e && e.message) || e) }); }

// components/agent/ToolCall.jsx
try { (() => {
const {
  useState
} = React;
const K = {
  bash: 'terminal',
  read: 'file-text',
  write: 'file-pen',
  search: 'search',
  browse: 'globe',
  docker: 'container'
};
function ToolCall({
  kind = 'bash',
  title,
  command,
  status = 'running',
  output,
  duration,
  needsApproval,
  onApprove,
  onDeny,
  defaultOpen,
  style
}) {
  const [o, setO] = useState(!!defaultOpen || !!needsApproval);
  return React.createElement('div', {
    style: {
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-surface)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-sm)',
      font: 'var(--type-ui)',
      ...style
    }
  }, React.createElement('button', {
    type: 'button',
    onClick: () => setO(!o),
    style: {
      all: 'unset',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      width: '100%',
      padding: '8px 12px',
      cursor: 'pointer'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: K[kind] || 'wrench',
    size: 14,
    color: 'var(--fg-3)'
  }), React.createElement('span', {
    style: {
      color: 'var(--fg-2)',
      flexShrink: 0
    }
  }, title), command ? React.createElement('code', {
    style: {
      font: 'var(--type-mono)',
      color: 'var(--fg-1)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 1,
      minWidth: 0
    }
  }, command) : React.createElement('span', {
    style: {
      flex: 1
    }
  }), duration ? React.createElement('span', {
    style: {
      font: 'var(--type-mono)',
      fontSize: 10,
      color: 'var(--fg-4)'
    }
  }, duration) : null, React.createElement(__ds_scope.StatusDot, {
    status: needsApproval ? 'info' : status
  }), React.createElement(__ds_scope.Icon, {
    name: 'chevron-down',
    size: 14,
    color: 'var(--fg-4)',
    style: {
      transform: o ? 'rotate(180deg)' : 'none',
      transition: 'transform var(--dur-base)'
    }
  })), o && output ? React.createElement('pre', {
    style: {
      margin: 0,
      padding: '10px 12px',
      borderTop: '1px solid var(--border-1)',
      background: 'var(--code-bg)',
      color: 'var(--code-fg)',
      font: 'var(--type-mono)',
      maxHeight: 240,
      overflow: 'auto',
      whiteSpace: 'pre-wrap'
    }
  }, output) : null, needsApproval ? React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderTop: '1px solid var(--border-1)',
      background: 'var(--info-soft)'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'shield-alert',
    size: 14,
    color: 'var(--info)'
  }), React.createElement('span', {
    style: {
      flex: 1,
      color: 'var(--fg-1)'
    }
  }, '需要你点头 · Needs your approval'), React.createElement(__ds_scope.Button, {
    size: 'sm',
    variant: 'ghost',
    onClick: onDeny
  }, '拒绝'), React.createElement(__ds_scope.Button, {
    size: 'sm',
    variant: 'primary',
    onClick: onApprove
  }, '批准')) : null);
}
Object.assign(__ds_scope, { ToolCall });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agent/ToolCall.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
const {
  useState
} = React;
function Tag({
  icon,
  onRemove,
  selected,
  children,
  style,
  onClick
}) {
  const [h, setH] = useState(false);
  return React.createElement('span', {
    onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 26,
      padding: '0 10px',
      borderRadius: 'var(--radius-full)',
      background: selected ? 'var(--bg-selected)' : h && onClick ? 'var(--bg-hover)' : 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline)',
      color: 'var(--fg-2)',
      font: 'var(--type-caption)',
      cursor: onClick ? 'pointer' : 'default',
      whiteSpace: 'nowrap',
      ...style
    }
  }, icon ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 12
  }) : null, children, onRemove ? React.createElement('button', {
    type: 'button',
    onClick: e => {
      e.stopPropagation();
      onRemove();
    },
    style: {
      all: 'unset',
      display: 'inline-flex',
      cursor: 'pointer',
      color: 'var(--fg-3)',
      marginLeft: 2
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'x',
    size: 12
  })) : null);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/agent/Composer.jsx
try { (() => {
const {
  useState
} = React;
function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  placeholder = '给白泽发消息',
  attachments = [],
  onRemoveAttachment,
  onAttach,
  style
}) {
  const [f, setF] = useState(false),
    [v, setV] = useState(''),
    [hp, setHp] = useState(false);
  const val = value !== undefined ? value : v;
  const set = onChange || setV;
  const fire = () => {
    if (!val) return;
    onSend && onSend(val);
    if (value === undefined) setV('');
  };
  const round = {
    all: 'unset',
    boxSizing: 'border-box',
    width: 34,
    height: 34,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background var(--dur-fast),color var(--dur-fast)'
  };
  return React.createElement('div', {
    style: {
      width: '100%',
      maxWidth: 'var(--composer-max-w)',
      boxSizing: 'border-box',
      borderRadius: 'var(--radius-2xl)',
      background: 'var(--bg-surface)',
      border: '1px solid ' + (f ? 'var(--border-3)' : 'var(--border-2)'),
      boxShadow: f ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      transition: 'border-color var(--dur-fast),box-shadow var(--dur-fast)',
      ...style
    }
  }, attachments.length ? React.createElement('div', {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      padding: '10px 12px 0 52px'
    }
  }, attachments.map((a, i) => React.createElement(__ds_scope.Tag, {
    key: i,
    icon: a.icon || 'file',
    onRemove: onRemoveAttachment ? () => onRemoveAttachment(i) : undefined
  }, a.name))) : null, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 8,
      padding: 8
    }
  }, React.createElement('button', {
    type: 'button',
    'aria-label': '添加',
    onClick: onAttach,
    onMouseEnter: () => setHp(true),
    onMouseLeave: () => setHp(false),
    style: {
      ...round,
      background: hp ? 'var(--bg-active)' : 'var(--bg-inset)',
      color: 'var(--fg-2)'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'plus',
    size: 18
  })), React.createElement('textarea', {
    value: val,
    onChange: e => set(e.target.value),
    onFocus: () => setF(true),
    onBlur: () => setF(false),
    placeholder,
    rows: 1,
    onKeyDown: e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        fire();
      }
    },
    style: {
      flex: 1,
      display: 'block',
      boxSizing: 'border-box',
      minHeight: 34,
      maxHeight: 200,
      padding: '7px 6px',
      border: 'none',
      outline: 'none',
      resize: 'none',
      background: 'transparent',
      color: 'var(--fg-1)',
      font: 'var(--type-body)',
      fontSize: 15,
      lineHeight: 1.35
    }
  }), running ? React.createElement('button', {
    type: 'button',
    onClick: onStop,
    'aria-label': '停止',
    style: {
      ...round,
      background: 'var(--btn-primary-bg)',
      color: 'var(--btn-primary-fg)'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'square',
    size: 12,
    strokeWidth: 0,
    style: {
      fill: 'currentColor'
    }
  })) : val ? React.createElement('button', {
    type: 'button',
    onClick: fire,
    'aria-label': '发送',
    style: {
      ...round,
      background: 'var(--btn-primary-bg)',
      color: 'var(--btn-primary-fg)'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'arrow-up',
    size: 18,
    strokeWidth: 2.2
  })) : React.createElement('button', {
    type: 'button',
    'aria-label': '语音',
    style: {
      ...round,
      background: 'var(--btn-primary-bg)',
      color: 'var(--btn-primary-fg)'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'mic',
    size: 16
  }))));
}
Object.assign(__ds_scope, { Composer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/agent/Composer.jsx", error: String((e && e.message) || e) }); }

// components/core/Tooltip.jsx
try { (() => {
const {
  useState
} = React;
function Tooltip({
  content,
  shortcut,
  side = 'top',
  children
}) {
  const [o, setO] = useState(false);
  const pos = side === 'bottom' ? {
    top: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)'
  } : side === 'right' ? {
    left: 'calc(100% + 6px)',
    top: '50%',
    transform: 'translateY(-50%)'
  } : {
    bottom: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)'
  };
  return React.createElement('span', {
    style: {
      position: 'relative',
      display: 'inline-flex'
    },
    onMouseEnter: () => setO(true),
    onMouseLeave: () => setO(false)
  }, children, o ? React.createElement('span', {
    role: 'tooltip',
    style: {
      position: 'absolute',
      ...pos,
      zIndex: 50,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '5px 8px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-md), var(--inset-hairline)',
      color: 'var(--fg-1)',
      font: 'var(--type-caption)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none'
    }
  }, content, shortcut ? React.createElement('span', {
    style: {
      font: 'var(--type-mono)',
      fontSize: 10,
      color: 'var(--fg-3)'
    }
  }, shortcut) : null) : null);
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  description,
  disabled,
  style
}) {
  const on = checked || indeterminate;
  return React.createElement('label', {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      font: 'var(--type-ui)',
      color: 'var(--fg-1)',
      ...style
    }
  }, React.createElement('span', {
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      width: 16,
      height: 16,
      marginTop: 1,
      borderRadius: 'var(--radius-xs)',
      border: '1px solid ' + (on ? 'var(--fg-1)' : 'var(--border-3)'),
      background: on ? 'var(--fg-1)' : 'var(--bg-inset)',
      color: 'var(--fg-inverse)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      transition: 'background var(--dur-fast)'
    }
  }, on ? React.createElement(__ds_scope.Icon, {
    name: indeterminate ? 'minus' : 'check',
    size: 12,
    strokeWidth: 2.5
  }) : null), label || description ? React.createElement('span', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, label, description ? React.createElement('span', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, description) : null) : null);
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
const {
  useState
} = React;
const wrap = (label, hint, error, el) => React.createElement('label', {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    font: 'var(--type-ui)',
    color: 'var(--fg-1)'
  }
}, label ? React.createElement('span', null, label) : null, el, error || hint ? React.createElement('span', {
  style: {
    font: 'var(--type-caption)',
    color: error ? 'var(--danger)' : 'var(--fg-3)'
  }
}, error || hint) : null);
function Input({
  label,
  hint,
  error,
  icon,
  size = 'md',
  mono,
  style,
  ...rest
}) {
  const [f, setF] = useState(false);
  const el = React.createElement('span', {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center'
    }
  }, icon ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14,
    style: {
      position: 'absolute',
      left: 10,
      color: 'var(--fg-3)'
    }
  }) : null, React.createElement('input', {
    onFocus: () => setF(true),
    onBlur: () => setF(false),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      height: size === 'sm' ? 'var(--control-h-sm)' : size === 'lg' ? 'var(--control-h-lg)' : 'var(--control-h-md)',
      padding: icon ? '0 10px 0 30px' : '0 10px',
      borderRadius: 'var(--radius-md)',
      border: '1px solid ' + (error ? 'var(--danger)' : f ? 'var(--border-3)' : 'var(--border-2)'),
      background: 'var(--bg-inset)',
      color: 'var(--fg-1)',
      font: mono ? 'var(--type-mono)' : 'var(--type-body)',
      fontSize: size === 'sm' ? 'var(--text-xs)' : 'var(--text-sm)',
      outline: 'none',
      boxShadow: f ? 'var(--ring-focus)' : 'none',
      transition: 'box-shadow var(--dur-fast),border-color var(--dur-fast)',
      ...style
    },
    ...rest
  }));
  return wrap(label, hint, error, el);
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function Radio({
  options = [],
  value,
  onChange,
  name,
  direction = 'column',
  style
}) {
  return React.createElement('div', {
    role: 'radiogroup',
    style: {
      display: 'flex',
      flexDirection: direction,
      gap: direction === 'row' ? 16 : 10,
      ...style
    }
  }, options.map(o => {
    const on = o.value === value;
    return React.createElement('label', {
      key: o.value,
      style: {
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        cursor: o.disabled ? 'default' : 'pointer',
        opacity: o.disabled ? 0.4 : 1,
        font: 'var(--type-ui)',
        color: 'var(--fg-1)'
      }
    }, React.createElement('span', {
      onClick: () => !o.disabled && onChange && onChange(o.value),
      style: {
        width: 16,
        height: 16,
        marginTop: 1,
        borderRadius: '50%',
        border: '1px solid ' + (on ? 'var(--fg-1)' : 'var(--border-3)'),
        background: 'var(--bg-inset)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }
    }, on ? React.createElement('span', {
      style: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--fg-1)'
      }
    }) : null), React.createElement('span', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }
    }, o.label, o.description ? React.createElement('span', {
      style: {
        font: 'var(--type-caption)',
        color: 'var(--fg-3)'
      }
    }, o.description) : null));
  }));
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
const {
  useState
} = React;
const wrap = (label, hint, error, el) => React.createElement('label', {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    font: 'var(--type-ui)',
    color: 'var(--fg-1)'
  }
}, label ? React.createElement('span', null, label) : null, el, error || hint ? React.createElement('span', {
  style: {
    font: 'var(--type-caption)',
    color: error ? 'var(--danger)' : 'var(--fg-3)'
  }
}, error || hint) : null);
function Select({
  label,
  hint,
  error,
  options = [],
  size = 'md',
  style,
  ...rest
}) {
  const [f, setF] = useState(false);
  const el = React.createElement('span', {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center'
    }
  }, React.createElement('select', {
    onFocus: () => setF(true),
    onBlur: () => setF(false),
    style: {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '100%',
      height: size === 'sm' ? 'var(--control-h-sm)' : 'var(--control-h-md)',
      padding: '0 30px 0 10px',
      borderRadius: 'var(--radius-md)',
      border: '1px solid ' + (error ? 'var(--danger)' : f ? 'var(--border-3)' : 'var(--border-2)'),
      background: 'var(--bg-surface)',
      color: 'var(--fg-1)',
      font: 'var(--type-ui)',
      fontSize: size === 'sm' ? 'var(--text-xs)' : 'var(--text-sm)',
      outline: 'none',
      boxShadow: f ? 'var(--ring-focus)' : 'none',
      cursor: 'pointer',
      ...style
    },
    ...rest
  }, options.map(o => React.createElement('option', {
    key: o.value,
    value: o.value
  }, o.label))), React.createElement(__ds_scope.Icon, {
    name: 'chevron-down',
    size: 14,
    style: {
      position: 'absolute',
      right: 10,
      color: 'var(--fg-3)',
      pointerEvents: 'none'
    }
  }));
  return wrap(label, hint, error, el);
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  size = 'md',
  style
}) {
  const w = size === 'sm' ? 28 : 34,
    h = size === 'sm' ? 16 : 20,
    k = h - 4;
  return React.createElement('label', {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      font: 'var(--type-ui)',
      color: 'var(--fg-1)',
      ...style
    }
  }, label || description ? React.createElement('span', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, label, description ? React.createElement('span', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      fontWeight: 400
    }
  }, description) : null) : null, React.createElement('span', {
    role: 'switch',
    'aria-checked': !!checked,
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      width: w,
      height: h,
      borderRadius: 'var(--radius-full)',
      background: checked ? 'var(--fg-1)' : 'var(--border-3)',
      position: 'relative',
      flexShrink: 0,
      transition: 'background var(--dur-base) var(--ease-out)'
    }
  }, React.createElement('span', {
    style: {
      position: 'absolute',
      top: 2,
      left: checked ? w - k - 2 : 2,
      width: k,
      height: k,
      borderRadius: '50%',
      background: checked ? 'var(--fg-inverse)' : 'var(--bg-app)',
      transition: 'left var(--dur-base) var(--ease-out)'
    }
  })));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/layout/Card.jsx
try { (() => {
const {
  useState
} = React;
function Card({
  title,
  meta,
  actions,
  padding = 16,
  interactive,
  onClick,
  children,
  style
}) {
  const [h, setH] = useState(false);
  return React.createElement('div', {
    onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      background: 'var(--bg-surface)',
      border: '1px solid ' + (interactive && h ? 'var(--border-2)' : 'var(--border-1)'),
      borderRadius: 'var(--radius-lg)',
      padding,
      cursor: interactive ? 'pointer' : undefined,
      boxShadow: interactive && h ? 'var(--shadow-md)' : 'none',
      transform: interactive && h ? 'translateY(-1px)' : 'none',
      transition: 'border-color var(--dur-fast),box-shadow var(--dur-base),transform var(--dur-base)',
      boxSizing: 'border-box',
      ...style
    }
  }, title || actions ? React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: children ? 12 : 0
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, title ? React.createElement('div', {
    style: {
      font: 'var(--type-ui)'
    }
  }, title) : null, meta ? React.createElement('div', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, meta) : null), actions ? React.createElement('div', {
    style: {
      display: 'flex',
      gap: 4
    }
  }, actions) : null) : null, children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Card.jsx", error: String((e && e.message) || e) }); }

// components/layout/Dialog.jsx
try { (() => {
function Dialog({
  open,
  title,
  description,
  footer,
  onClose,
  width = 460,
  children
}) {
  if (!open) return null;
  return React.createElement('div', {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 100,
      background: 'var(--overlay)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      animation: 'bz-fade var(--dur-base) var(--ease-out)'
    }
  }, React.createElement('div', {
    role: 'dialog',
    'aria-modal': true,
    onClick: e => e.stopPropagation(),
    style: {
      width,
      maxWidth: 'calc(100vw - 32px)',
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-lg), var(--inset-hairline)',
      padding: 24,
      boxSizing: 'border-box',
      animation: 'bz-pop var(--dur-slow) var(--ease-out)'
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12
    }
  }, React.createElement('div', null, React.createElement('div', {
    style: {
      font: 'var(--type-heading)'
    }
  }, title), description ? React.createElement('div', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 4
    }
  }, description) : null), onClose ? React.createElement(__ds_scope.IconButton, {
    icon: 'x',
    label: '关闭',
    size: 'sm',
    onClick: onClose
  }) : null), children ? React.createElement('div', {
    style: {
      marginTop: 16,
      font: 'var(--type-body)',
      fontSize: 'var(--text-sm)',
      color: 'var(--fg-2)'
    }
  }, children) : null, footer ? React.createElement('div', {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 20
    }
  }, footer) : null, React.createElement('style', null, '@keyframes bz-fade{from{opacity:0}}@keyframes bz-pop{from{opacity:0;transform:scale(.98) translateY(4px)}}')));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/layout/Tabs.jsx
try { (() => {
const {
  useState
} = React;
function Tabs({
  items = [],
  value,
  onChange,
  variant = 'underline',
  size = 'md',
  style
}) {
  const [h, setH] = useState(null);
  const seg = variant === 'segmented';
  return React.createElement('div', {
    role: 'tablist',
    style: {
      display: 'flex',
      gap: seg ? 2 : 0,
      padding: seg ? 2 : 0,
      borderRadius: seg ? 'var(--radius-md)' : 0,
      background: seg ? 'var(--bg-inset)' : 'transparent',
      boxShadow: seg ? 'var(--inset-hairline)' : 'none',
      borderBottom: seg ? 'none' : '1px solid var(--border-1)',
      ...style
    }
  }, items.map(it => {
    const on = it.value === value;
    return React.createElement('button', {
      key: it.value,
      role: 'tab',
      'aria-selected': on,
      type: 'button',
      onClick: () => onChange && onChange(it.value),
      onMouseEnter: () => setH(it.value),
      onMouseLeave: () => setH(null),
      style: {
        all: 'unset',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: seg ? 26 : size === 'sm' ? 30 : 36,
        padding: seg ? '0 10px' : '0 12px',
        flex: seg ? 1 : undefined,
        justifyContent: 'center',
        borderRadius: seg ? 'var(--radius-sm)' : 0,
        font: 'var(--type-ui)',
        fontSize: size === 'sm' ? 'var(--text-xs)' : 'var(--text-sm)',
        color: on ? 'var(--fg-1)' : h === it.value ? 'var(--fg-2)' : 'var(--fg-3)',
        background: seg && on ? 'var(--bg-elevated)' : 'transparent',
        boxShadow: seg && on ? 'var(--shadow-sm), var(--inset-hairline)' : 'none',
        borderBottom: !seg ? '1px solid ' + (on ? 'var(--fg-1)' : 'transparent') : 'none',
        marginBottom: !seg ? -1 : 0,
        cursor: 'pointer',
        transition: 'color var(--dur-fast),background var(--dur-fast)',
        whiteSpace: 'nowrap'
      }
    }, it.icon ? React.createElement(__ds_scope.Icon, {
      name: it.icon,
      size: 14
    }) : null, it.label, it.count != null ? React.createElement('span', {
      style: {
        font: 'var(--type-mono)',
        fontSize: 10,
        color: 'var(--fg-3)'
      }
    }, it.count) : null);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/layout/Toast.jsx
try { (() => {
const I = {
  neutral: 'info',
  success: 'circle-check',
  danger: 'circle-alert',
  info: 'info'
};
const C = {
  neutral: 'var(--fg-2)',
  success: 'var(--success)',
  danger: 'var(--danger)',
  info: 'var(--info)'
};
function Toast({
  tone = 'neutral',
  title,
  description,
  action,
  onDismiss,
  style
}) {
  return React.createElement('div', {
    role: 'status',
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      width: 340,
      padding: '10px 12px',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-lg), var(--inset-hairline)',
      font: 'var(--type-ui)',
      color: 'var(--fg-1)',
      boxSizing: 'border-box',
      animation: 'bz-toast var(--dur-base) var(--ease-out)',
      ...style
    }
  }, React.createElement(__ds_scope.Icon, {
    name: I[tone],
    size: 16,
    color: C[tone],
    style: {
      marginTop: 1
    }
  }), React.createElement('div', {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, React.createElement('div', null, title), description ? React.createElement('div', {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, description) : null), action ? React.createElement('button', {
    type: 'button',
    onClick: action.onClick,
    style: {
      all: 'unset',
      cursor: 'pointer',
      font: 'var(--type-ui)',
      color: 'var(--fg-1)',
      textDecoration: 'underline',
      textUnderlineOffset: 3
    }
  }, action.label) : null, onDismiss ? React.createElement('button', {
    type: 'button',
    onClick: onDismiss,
    style: {
      all: 'unset',
      cursor: 'pointer',
      color: 'var(--fg-3)',
      display: 'inline-flex'
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'x',
    size: 14
  })) : null, React.createElement('style', null, '@keyframes bz-toast{from{opacity:0;transform:translateY(6px)}}'));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Toast.jsx", error: String((e && e.message) || e) }); }

// ui_kits/console/ConsoleApp.jsx
try { (() => {
const {
  Icon,
  IconButton,
  BotAvatar,
  Badge,
  Button,
  Card,
  Tag,
  Tabs,
  StatusDot,
  Tooltip
} = window.BaizeDesignSystem_7d7772;
const TONE = {
  running: ['var(--blue-5)', 'var(--blue-soft)', 'var(--blue-3)'],
  done: ['var(--green-5)', 'var(--green-soft)', 'var(--green-3)'],
  flow: ['var(--purple-5)', 'var(--purple-soft)', 'var(--purple-3)'],
  wait: ['var(--orange-5)', 'var(--orange-soft)', 'var(--orange-3)'],
  fail: ['var(--red-5)', 'var(--red-soft)', 'var(--red-3)'],
  idle: ['var(--gray-8)', 'var(--gray-11)', 'var(--fg-2)']
};
const T0 = 9,
  T1 = 18,
  NOW = 14 + 20 / 60;
const pct = t => (t - T0) / (T1 - T0) * 100;
const LANES = [{
  id: 'fix',
  name: '小修',
  job: '运维巡检',
  hue: 'sky',
  status: 'working',
  bars: [{
    s: 9.2,
    e: 10.4,
    tone: 'done',
    label: '节点健康巡检'
  }, {
    s: 10.6,
    e: 12.1,
    tone: 'flow',
    label: '编排 3 个修复工作流'
  }, {
    s: 12.4,
    e: 13.2,
    tone: 'fail',
    label: '网关重启失败'
  }, {
    s: 13.5,
    e: 15.1,
    tone: 'running',
    label: '回滚 canary-04'
  }]
}, {
  id: 'yan',
  name: '小研',
  job: '数据研判',
  hue: 'violet',
  status: 'working',
  bars: [{
    s: 9,
    e: 11.2,
    tone: 'done',
    label: '采集 42 个数据源'
  }, {
    s: 11.4,
    e: 13.9,
    tone: 'flow',
    label: '归因分析'
  }, {
    s: 14.1,
    e: 16.2,
    tone: 'running',
    label: '生成周度研判'
  }]
}, {
  id: 'xiao',
  name: '小销',
  job: '线索跟进',
  hue: 'tangerine',
  status: 'online',
  bars: [{
    s: 9.6,
    e: 10.8,
    tone: 'done',
    label: '同步 CRM'
  }, {
    s: 11,
    e: 12.6,
    tone: 'wait',
    label: '等待人工确认报价'
  }, {
    s: 13,
    e: 14.2,
    tone: 'done',
    label: '外呼 18 条线索'
  }, {
    s: 15.3,
    e: 17,
    tone: 'idle',
    label: '计划：季度复盘'
  }]
}, {
  id: 'zhang',
  name: '小账',
  job: '对账结算',
  hue: 'mint',
  status: 'online',
  bars: [{
    s: 9,
    e: 9.9,
    tone: 'done',
    label: '拉取账单'
  }, {
    s: 12.2,
    e: 14.6,
    tone: 'running',
    label: '差异对账 2,318 笔'
  }, {
    s: 15,
    e: 16.4,
    tone: 'idle',
    label: '计划：生成凭证'
  }]
}];
function Chrome({
  children
}) {
  const rail = [['layout-grid', '总览', true], ['activity', '运行态'], ['radar', '发现'], ['workflow', '工作流'], ['bar-chart-3', '报表'], ['settings', '设置']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-app)'
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 'var(--topbar-h)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '0 24px',
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 9,
      background: 'var(--gray-1)',
      color: 'var(--white)',
      display: 'grid',
      placeItems: 'center',
      font: 'var(--type-heading)',
      fontSize: 15
    }
  }, "\u767D"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-heading)',
      fontSize: 16
    }
  }, "\u767D\u6CFD\u63A7\u5236\u53F0")), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 1,
      height: 24,
      background: 'var(--border-1)'
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      all: 'unset',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 36,
      padding: '0 12px',
      borderRadius: 'var(--radius-full)',
      background: 'var(--bg-inset)',
      font: 'var(--type-ui)',
      color: 'var(--fg-2)',
      cursor: 'pointer'
    }
  }, "\u751F\u4EA7\u73AF\u5883 \xB7 \u534E\u4E1C", /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-down",
    size: 14
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 36,
      padding: '0 14px',
      borderRadius: 'var(--radius-full)',
      border: '1px solid var(--border-1)',
      font: 'var(--type-ui)',
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 15
  }), "\u641C\u7D22\u4E8B\u4EF6\u3001Trace ID", /*#__PURE__*/React.createElement("kbd", {
    style: {
      marginLeft: 6
    }
  }, "\u2318K")), /*#__PURE__*/React.createElement(IconButton, {
    icon: "bell",
    label: "\u901A\u77E5"
  }), /*#__PURE__*/React.createElement(BotAvatar, {
    name: "Lu",
    hue: "coral",
    size: 32
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("nav", {
    style: {
      width: 'var(--rail-w)',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      padding: '16px 0',
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-1)'
    }
  }, rail.map(([i, l, on]) => /*#__PURE__*/React.createElement(Tooltip, {
    key: i,
    content: l,
    side: "right"
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      all: 'unset',
      width: 44,
      height: 44,
      display: 'grid',
      placeItems: 'center',
      borderRadius: 'var(--radius-lg)',
      cursor: 'pointer',
      color: on ? 'var(--fg-1)' : 'var(--fg-3)',
      background: on ? 'var(--bg-selected)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: i,
    size: 20
  }))))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      minWidth: 0,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--console-max-w)',
      margin: '0 auto',
      padding: '32px 40px 48px',
      display: 'grid',
      gridTemplateColumns: 'repeat(12,1fr)',
      gap: 'var(--grid-gutter)'
    }
  }, children))));
}
const Panel = ({
  span,
  title,
  meta,
  action,
  children,
  pad = 26
}) => /*#__PURE__*/React.createElement("section", {
  style: {
    gridColumn: `span ${span}`,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-1)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-md)',
    padding: pad,
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("h2", {
  style: {
    margin: 0,
    font: 'var(--type-title)',
    fontSize: 20,
    letterSpacing: '-0.02em'
  }
}, title), meta && /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 4,
    font: 'var(--type-caption)',
    color: 'var(--fg-3)'
  }
}, meta)), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}), action), children);
function Timeline() {
  const hours = [];
  for (let h = T0; h <= T1; h++) hours.push(h);
  return /*#__PURE__*/React.createElement(Panel, {
    span: 12,
    title: "\u7CFB\u7EDF\u53D1\u73B0 \xB7 \u8FD0\u884C\u6001\u65F6\u95F4\u8F74",
    meta: "14 \u4E2A\u961F\u53CB \xB7 \u4ECA\u65E5 09:00 \u2013 18:00 \xB7 \u6700\u8FD1\u66F4\u65B0 2 \u5206\u949F\u524D",
    action: /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement(Tabs, {
      variant: "segmented",
      size: "sm",
      value: "today",
      items: [{
        value: 'today',
        label: '今日'
      }, {
        value: '7d',
        label: '7 天'
      }, {
        value: '30d',
        label: '30 天'
      }]
    }), /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "sm",
      icon: "download"
    }, "\u5BFC\u51FA"))
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      flexWrap: 'wrap'
    }
  }, [['running', '执行中'], ['done', '已完成'], ['flow', '编排中'], ['wait', '待确认'], ['fail', '异常'], ['idle', '未开始']].map(([k, l]) => /*#__PURE__*/React.createElement("span", {
    key: k,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 3,
      background: TONE[k][0]
    }
  }), l))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg-inset)',
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-xl)',
      padding: '18px 20px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '180px 1fr',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", null), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: 18,
      marginBottom: 4,
      marginTop: 22
    }
  }, hours.map(h => /*#__PURE__*/React.createElement("span", {
    key: h,
    style: {
      position: 'absolute',
      left: pct(h) + '%',
      transform: 'translateX(-50%)',
      font: 'var(--type-mono)',
      fontSize: 11,
      color: 'var(--fg-4)'
    }
  }, String(h).padStart(2, '0'), ":00")))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 196,
      right: 0,
      top: 0,
      bottom: 0,
      pointerEvents: 'none'
    }
  }, hours.map(h => /*#__PURE__*/React.createElement("span", {
    key: h,
    style: {
      position: 'absolute',
      left: pct(h) + '%',
      top: 0,
      bottom: 0,
      width: 1,
      background: 'var(--border-1)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: pct(NOW) + '%',
      top: -6,
      bottom: 0,
      width: 2,
      background: 'var(--accent)',
      borderRadius: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -42,
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '2px 8px',
      borderRadius: 'var(--radius-full)',
      background: 'var(--accent)',
      color: 'var(--accent-fg)',
      font: 'var(--type-label)',
      whiteSpace: 'nowrap'
    }
  }, "\u73B0\u5728 14:20"))), LANES.map(l => /*#__PURE__*/React.createElement("div", {
    key: l.id,
    style: {
      display: 'grid',
      gridTemplateColumns: '180px 1fr',
      gap: 16,
      alignItems: 'center',
      padding: '10px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: l.name,
    hue: l.hue,
    size: 32,
    status: l.status === 'working' ? 'working' : 'online'
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)',
      fontWeight: 600,
      color: 'var(--fg-1)'
    }
  }, l.name), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-mono)',
      fontSize: 11,
      color: 'var(--fg-4)'
    }
  }, l.job))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: 34
    }
  }, l.bars.map((b, i) => {
    const [c, soft, deep] = TONE[b.tone];
    return /*#__PURE__*/React.createElement("span", {
      key: i,
      title: b.label,
      style: {
        position: 'absolute',
        left: pct(b.s) + '%',
        width: pct(b.e) - pct(b.s) + '%',
        top: 0,
        height: 34,
        borderRadius: 'var(--radius-md)',
        background: soft,
        border: `1px solid ${c}`,
        borderLeft: `4px solid ${c}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        boxSizing: 'border-box',
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-ui)',
        fontSize: 12,
        color: deep,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, b.label));
  })))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 16
    }
  }, [['执行中任务', '7', 'running'], ['今日完成', '126', 'done'], ['待人工确认', '3', 'wait'], ['异常事件', '1', 'fail']].map(([l, v, t]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      padding: '14px 16px',
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: 3,
      background: TONE[t][0]
    }
  }), l), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      font: 'var(--type-metric)',
      color: 'var(--fg-1)'
    }
  }, v)))));
}
const Row = ({
  children,
  style
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 0',
    borderTop: '1px solid var(--border-1)',
    ...style
  }
}, children);
function NextSteps() {
  const items = [['为 canary-04 回滚结果签字', '小修', '高', 'wait'], ['确认 Q3 报价单变更', '小销', '中', 'wait'], ['审阅周度研判初稿', '小研', '低', 'idle']];
  return /*#__PURE__*/React.createElement(Panel, {
    span: 4,
    title: "Next steps",
    meta: "3 \u9879\u7B49\u5F85\u4F60\u5904\u7406",
    action: /*#__PURE__*/React.createElement(Badge, {
      tone: "neutral"
    }, "\u4ECA\u65E5")
  }, /*#__PURE__*/React.createElement("div", null, items.map(([t, who, p, tone], i) => /*#__PURE__*/React.createElement(Row, {
    key: t,
    style: i === 0 ? {
      borderTop: 'none',
      paddingTop: 0
    } : undefined
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 38,
      borderRadius: 3,
      background: p === '高' ? 'var(--yellow-5)' : p === '中' ? 'var(--orange-5)' : 'var(--gray-8)',
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)',
      fontSize: 14,
      color: 'var(--fg-1)'
    }
  }, t), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, who, " \xB7 \u4F18\u5148\u7EA7 ", p)), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm"
  }, "\u5904\u7406")))));
}
function Detected() {
  const rows = [['支付网关 v2', '已接入', 'done', '42 指标'], ['数据仓库 · Hive', '已接入', 'done', '18 指标'], ['客服工单系统', '采集中', 'running', '进度 64%'], ['财务 ERP', '未授权', 'idle', '待连接']];
  return /*#__PURE__*/React.createElement(Panel, {
    span: 4,
    title: "Detected",
    meta: "\u81EA\u52A8\u53D1\u73B0\u7684\u7CFB\u7EDF\u4E0E\u6570\u636E\u6E90",
    action: /*#__PURE__*/React.createElement(Button, {
      variant: "ghost",
      size: "sm",
      iconRight: "arrow-right"
    }, "\u5168\u90E8")
  }, /*#__PURE__*/React.createElement("div", null, rows.map(([n, s, t, m], i) => /*#__PURE__*/React.createElement(Row, {
    key: n,
    style: i === 0 ? {
      borderTop: 'none',
      paddingTop: 0
    } : undefined
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 'var(--radius-md)',
      background: TONE[t][1],
      display: 'grid',
      placeItems: 'center',
      color: TONE[t][2],
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "database",
    size: 17
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)',
      fontSize: 14,
      color: 'var(--fg-1)'
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 3,
      font: 'var(--type-mono)',
      fontSize: 11,
      color: 'var(--fg-4)'
    }
  }, m)), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 'var(--radius-full)',
      background: TONE[t][1],
      color: TONE[t][2],
      font: 'var(--type-label)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: TONE[t][0]
    }
  }), s)))));
}
function Assistant() {
  return /*#__PURE__*/React.createElement(Panel, {
    span: 4,
    title: "AI Assistant",
    meta: "\u5C0F\u7814 \xB7 \u6570\u636E\u7814\u5224",
    action: /*#__PURE__*/React.createElement(StatusDot, {
      status: "running",
      label: "\u5728\u7EBF"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: "\u5C0F\u7814",
    hue: "violet",
    size: 36,
    status: "working"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      background: 'var(--workflow-soft)',
      borderRadius: 'var(--radius-lg)',
      borderTopLeftRadius: 6,
      padding: '14px 16px',
      font: 'var(--type-body)',
      fontSize: 14,
      color: 'var(--fg-1)'
    }
  }, "\u7F51\u5173\u91CD\u542F\u5931\u8D25\u4E0E 12:40 \u7684\u914D\u7F6E\u63A8\u9001\u76F8\u5173\uFF0C\u5DF2\u5B9A\u4F4D\u5230 canary-04 \u7684\u8D85\u65F6\u53C2\u6570\u3002\u8981\u6211\u8D77\u8349\u56DE\u6EDA\u65B9\u6848\u5E76\u540C\u6B65\u7ED9\u5C0F\u4FEE\u5417\uFF1F")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8
    }
  }, ['起草回滚方案', '查看关联 Trace', '解释归因过程'].map(t => /*#__PURE__*/React.createElement(Tag, {
    key: t,
    icon: "sparkles"
  }, t))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      height: 'var(--control-h-lg)',
      padding: '0 6px 0 16px',
      borderRadius: 'var(--radius-full)',
      border: '1px solid var(--border-2)',
      background: 'var(--bg-surface)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      font: 'var(--type-ui)',
      color: 'var(--fg-4)'
    }
  }, "\u95EE\u70B9\u4EC0\u4E48\u2026"), /*#__PURE__*/React.createElement(IconButton, {
    icon: "mic",
    label: "\u8BED\u97F3"
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    icon: "arrow-up",
    style: {
      width: 34,
      padding: 0,
      justifyContent: 'center'
    }
  })));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Chrome, null, /*#__PURE__*/React.createElement(Timeline, null), /*#__PURE__*/React.createElement(NextSteps, null), /*#__PURE__*/React.createElement(Detected, null), /*#__PURE__*/React.createElement(Assistant, null)));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/console/ConsoleApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/BotPanel.jsx
try { (() => {
const {
  Icon,
  IconButton,
  Tabs,
  Terminal,
  Tag,
  Badge,
  Card,
  Button,
  StatusDot,
  BotAvatar
} = window.BaizeDesignSystem_7d7772;
function BotPanel({
  open,
  bot,
  term,
  files,
  artifacts,
  running
}) {
  const [tab, setTab] = React.useState('screen');
  const Row = ({
    f
  }) => {
    const [h, setH] = React.useState(false);
    return /*#__PURE__*/React.createElement("div", {
      onMouseEnter: () => setH(true),
      onMouseLeave: () => setH(false),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        background: h ? 'var(--bg-hover)' : 'transparent',
        font: 'var(--type-caption)',
        color: 'var(--fg-2)',
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: f.kind,
      size: 14,
      color: "var(--fg-3)"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        font: 'var(--type-mono)',
        fontSize: 12,
        color: 'var(--fg-1)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, f.name), f.changed && /*#__PURE__*/React.createElement(Badge, {
      tone: "accent"
    }, "M"), /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--fg-4)'
      }
    }, f.size));
  };
  const W = {
    width: 'var(--panel-w)',
    boxSizing: 'border-box'
  };
  const b = bot || {
    name: '白泽',
    hue: 'tangerine',
    job: ''
  };
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: open ? 'var(--panel-w)' : 0,
      overflow: 'hidden',
      flexShrink: 0,
      borderLeft: open ? '1px solid var(--border-1)' : 'none',
      background: 'var(--bg-sidebar)',
      display: 'flex',
      flexDirection: 'column',
      transition: 'width var(--dur-slow) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      height: 'var(--titlebar-h)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 14px',
      gap: 8,
      WebkitAppRegion: 'drag'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "monitor",
    size: 16,
    color: "var(--fg-3)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ui)',
      fontWeight: 600
    }
  }, b.name, "\u7684\u7535\u8111"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-mono)',
      fontSize: 11,
      color: 'var(--fg-4)'
    }
  }, "9f3a2c"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), running ? /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    dot: true
  }, "\u5E72\u6D3B\u4E2D") : /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "\u7A7A\u95F2")), /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      padding: '4px 14px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(Tabs, {
    variant: "segmented",
    size: "sm",
    value: tab,
    onChange: setTab,
    items: [{
      value: 'screen',
      label: '屏幕',
      icon: 'app-window'
    }, {
      value: 'terminal',
      label: '终端',
      icon: 'terminal'
    }, {
      value: 'files',
      label: '文件',
      icon: 'folder'
    }, {
      value: 'artifacts',
      label: '成果',
      icon: 'package',
      count: artifacts.length
    }]
  }), tab === 'screen' && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 30,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 10px',
      borderBottom: '1px solid var(--border-1)',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "globe",
    size: 12
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 18,
      borderRadius: 999,
      background: 'var(--bg-inset)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      font: 'var(--type-mono)',
      fontSize: 10
    }
  }, "acme.lightning.force.com/o/Account/list")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ui)'
    }
  }, "Accounts \xB7 \u6211\u540D\u4E0B"), /*#__PURE__*/React.createElement(Badge, {
    tone: "success"
  }, "42")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '80%'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '60%'
    }
  }), [['Globex', '高'], ['Initech', '中'], ['Umbrella', '高']].map(([n, s]) => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      font: 'var(--type-caption)',
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--success)'
    }
  }), n, /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: s === '高' ? 'accent' : 'neutral'
  }, "\u610F\u5411 ", s)))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '70%'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: b.name,
    hue: b.hue,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, running ? '正在翻客户资料…' : '等你回复'), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "secondary",
    icon: "hand"
  }, "\u63A5\u7BA1"))), tab === 'terminal' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Terminal, {
    title: b.name + '的电脑',
    container: "9f3a2c",
    status: running ? 'running' : 'idle',
    height: "100%",
    lines: term,
    style: {
      flex: 1,
      minHeight: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "2 vCPU \xB7 4 GB"), /*#__PURE__*/React.createElement("span", null, "\u7F51\u7EDC\uFF1A\u5185\u7F51"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "ghost",
    icon: "rotate-ccw"
  }, "\u91CD\u542F"))), tab === 'files' && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-label)',
      color: 'var(--fg-4)',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      padding: '4px 10px 6px'
    }
  }, "/workspace"), files.map(f => /*#__PURE__*/React.createElement(Row, {
    key: f.name,
    f: f
  }))), tab === 'artifacts' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, artifacts.map(a => /*#__PURE__*/React.createElement(Card, {
    key: a.name,
    interactive: true,
    padding: 12,
    title: /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: a.kind,
      size: 16,
      color: "var(--fg-3)"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-mono)',
        fontSize: 12
      }
    }, a.name)),
    meta: a.size + ' · 刚刚',
    actions: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(IconButton, {
      icon: "download",
      label: "\u4E0B\u8F7D",
      size: "sm"
    }), /*#__PURE__*/React.createElement(IconButton, {
      icon: "external-link",
      label: "\u6253\u5F00",
      size: "sm"
    }))
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      padding: '4px 2px'
    }
  }, "\u6210\u679C\u4F1A\u5728\u7535\u8111\u56DE\u6536\u524D\u81EA\u52A8\u5F52\u6863\u5230\u4F01\u4E1A\u5B58\u50A8\u3002"))));
}
window.BotPanel = BotPanel;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/BotPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/DesktopApp.jsx
try { (() => {
function App() {
  const D = window.BZ_DATA,
    I = window.BZ_INIT || {};
  const [auth, setAuth] = React.useState(!!I.auth);
  const [view, setView] = React.useState(I.view || 'thread');
  const [active, setActive] = React.useState('b1');
  const [bots, setBots] = React.useState(D.bots);
  const [msgs, setMsgs] = React.useState(D.threads);
  const [running, setRunning] = React.useState(false);
  const [sb, setSb] = React.useState(true),
    [pn, setPn] = React.useState(!!I.panel),
    [settings, setSettings] = React.useState(!!I.settings),
    [dark, setDark] = React.useState(!!I.dark);
  const [term, setTerm] = React.useState(D.term);
  React.useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : '';
  }, [dark]);
  React.useEffect(() => {
    const k = e => {
      if (e.metaKey && e.key === 'b') {
        e.preventDefault();
        setSb(v => !v);
      }
      if (e.metaKey && e.key === '.') {
        e.preventDefault();
        setPn(v => !v);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const bot = bots.find(b => b.id === active);
  const items = msgs[active] || [];
  const push = it => setMsgs(m => ({
    ...m,
    [active]: [...(m[active] || []), it]
  }));
  const setLast = (last, status) => setBots(b => b.map(x => x.id === active ? {
    ...x,
    last,
    time: '刚刚',
    status: status || x.status
  } : x));
  const send = text => {
    if (!text) return;
    push({
      role: 'user',
      text
    });
    setRunning(true);
    setLast(text, 'working');
    setTimeout(() => push({
      bot: active,
      text: '收到，我去看看。'
    }), 500);
    setTimeout(() => {
      push({
        tool: {
          kind: 'browse',
          title: '浏览',
          command: 'salesforce.com/lightning/o/Account/list',
          status: 'success',
          duration: '48s'
        }
      });
      setTerm(t => [...t, {
        type: 'cmd',
        text: 'baize browse salesforce.com/lightning/o/Account/list'
      }, {
        type: 'out',
        text: '12 accounts loaded'
      }]);
    }, 1400);
    setTimeout(() => {
      push({
        tool: {
          kind: 'write',
          title: '发送',
          command: '12 封跟进邮件',
          needsApproval: true,
          status: 'idle'
        }
      });
      setRunning(false);
      setLast('起草好了，等你点头。', 'blocked');
    }, 2400);
  };
  const approve = i => {
    setMsgs(m => ({
      ...m,
      [active]: m[active].map((x, j) => j === i ? {
        tool: {
          ...x.tool,
          needsApproval: false,
          status: 'success',
          duration: '3s'
        }
      } : x)
    }));
    setTimeout(() => {
      push({
        bot: active,
        text: '发出去了。有回复我第一时间告诉你。',
        time: new Date().toTimeString().slice(0, 5)
      });
      setLast('发出去了。有回复我第一时间告诉你。', 'online');
    }, 600);
  };
  const deny = i => {
    setMsgs(m => ({
      ...m,
      [active]: m[active].map((x, j) => j === i ? {
        tool: {
          ...x.tool,
          needsApproval: false,
          status: 'error'
        }
      } : x)
    }));
    setTimeout(() => {
      push({
        bot: active,
        text: '好，先不发。草稿留在我电脑里，你随时改。'
      });
      setLast('好，先不发。', 'online');
    }, 400);
  };
  const hire = (name, hue, job) => {
    const id = 'b' + Date.now();
    setBots(b => [{
      id,
      name,
      hue,
      job,
      status: 'online',
      last: '电脑开好了，随时开工。',
      time: '刚刚'
    }, ...b]);
    setMsgs(m => ({
      ...m,
      [id]: [{
        role: 'time',
        text: new Date().toTimeString().slice(0, 5)
      }, {
        bot: id,
        text: '你好，我是' + name + '，负责' + job + '。电脑开好了，随时开工。你打算让我先干什么？'
      }]
    }));
    setActive(id);
    setView('thread');
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1440,
      height: 900,
      borderRadius: 14,
      overflow: 'hidden',
      boxShadow: 'var(--shadow-window)',
      display: 'flex',
      position: 'relative',
      background: 'var(--bg-app)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 16,
      left: 16,
      display: 'flex',
      gap: 8,
      zIndex: 10
    }
  }, ['#ff5f57', '#febc2e', '#28c840'].map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    style: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: c
    }
  }))), !auth ? /*#__PURE__*/React.createElement(LoginView, {
    onLogin: () => setAuth(true)
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Sidebar, {
    bots: bots,
    active: active,
    view: view,
    onSelect: id => {
      setActive(id);
      setView('thread');
    },
    onHire: () => setView('hire'),
    onSettings: () => setSettings(true),
    collapsed: !sb
  }), view === 'hire' ? /*#__PURE__*/React.createElement(HireView, {
    roles: D.roles,
    onHire: hire,
    onBack: () => setView('thread'),
    sidebarOpen: sb,
    toggleSidebar: () => setSb(!sb)
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ThreadView, {
    bot: bot,
    bots: bots,
    items: items,
    running: running,
    onSend: send,
    onStop: () => setRunning(false),
    onApprove: approve,
    onDeny: deny,
    sidebarOpen: sb,
    panelOpen: pn,
    toggleSidebar: () => setSb(!sb),
    togglePanel: () => setPn(!pn),
    onTheme: () => setDark(!dark),
    dark: dark,
    onHire: () => setView('hire')
  }), /*#__PURE__*/React.createElement(BotPanel, {
    open: pn,
    bot: bot,
    term: term,
    files: D.files,
    artifacts: D.artifacts,
    running: running
  })), /*#__PURE__*/React.createElement(SettingsView, {
    open: settings,
    onClose: () => setSettings(false)
  }), /*#__PURE__*/React.createElement("style", null, '@keyframes bz-fade{from{opacity:0}}@keyframes bz-pop{from{opacity:0;transform:scale(.98) translateY(4px)}}')));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/DesktopApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/HireView.jsx
try { (() => {
const {
  Icon,
  IconButton,
  Button,
  Card,
  BotAvatar,
  Input,
  Badge
} = window.BaizeDesignSystem_7d7772;
function HireView({
  roles,
  onHire,
  onBack,
  sidebarOpen,
  toggleSidebar
}) {
  const [sel, setSel] = React.useState(0);
  const [name, setName] = React.useState('');
  const r = roles[sel];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-app)'
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 'var(--titlebar-h)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 10px 0 ' + (sidebarOpen ? 10 : 80) + 'px',
      WebkitAppRegion: 'drag'
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: "panel-left",
    label: "\u4FA7\u680F",
    active: sidebarOpen,
    onClick: toggleSidebar
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: "arrow-left",
    label: "\u8FD4\u56DE",
    onClick: onBack
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ui)',
      fontWeight: 600,
      marginLeft: 4
    }
  }, "\u62DB\u52DF\u961F\u53CB")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '16px 40px 40px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 980,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '16px 0 6px',
      font: 'var(--type-display)',
      fontSize: 40
    }
  }, "\u7ED9\u6BCF\u4E2A\u961F\u53CB\u4E00\u4EFD\u5DE5\u4F5C"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '0 0 28px',
      font: 'var(--type-body)',
      fontSize: 15,
      color: 'var(--fg-3)'
    }
  }, "\u6311\u4E00\u4E2A\u5C97\u4F4D\uFF0C\u8D77\u4E2A\u540D\u5B57\u3002\u5B83\u4F1A\u6709\u81EA\u5DF1\u7684\u7535\u8111\u3001\u81EA\u5DF1\u7684\u8BB0\u5FC6\uFF0C24 \u5C0F\u65F6\u4E0D\u4E0B\u7EBF\u3002"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 340px',
      gap: 24,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
      gap: 12
    }
  }, roles.map(([t, h, i, d], k) => /*#__PURE__*/React.createElement(Card, {
    key: t,
    interactive: true,
    padding: 18,
    onClick: () => setSel(k),
    style: sel === k ? {
      borderColor: 'var(--bot-' + h + ')',
      boxShadow: '0 0 0 1px var(--bot-' + h + ')'
    } : {}
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 12,
      background: 'var(--bot-' + h + '-soft)',
      color: 'var(--bot-' + h + ')',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: i,
    size: 18
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-heading)'
    }
  }, t)), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '12px 0 0',
      font: 'var(--type-caption)',
      fontSize: 13,
      lineHeight: 1.55,
      color: 'var(--fg-3)',
      textWrap: 'pretty'
    }
  }, d)))), /*#__PURE__*/React.createElement(Card, {
    padding: 22,
    style: {
      position: 'sticky',
      top: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: name || r[0],
    hue: r[1],
    size: 72,
    ring: true
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-heading)'
    }
  }, name || '给它起个名字'), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, r[0]))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "\u540D\u5B57",
    placeholder: "\u4F8B\u5982\uFF1A\u5C0F\u5A92",
    value: name,
    onChange: e => setName(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)'
    }
  }, "\u5B83\u4F1A\u62FF\u5230", /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 8
    }
  }, ['自己的电脑', '公司内网', '你的工具登录', '企业记忆'].map(x => /*#__PURE__*/React.createElement(Badge, {
    key: x
  }, x)))), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    block: true,
    icon: "sparkles",
    onClick: () => onHire(name || r[0], r[1], r[0])
  }, "\u5165\u804C"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      textAlign: 'center'
    }
  }, "\u654F\u611F\u64CD\u4F5C\u4ECD\u9700\u4F60\u6279\u51C6 \xB7 \u968F\u65F6\u53EF\u4EE5\u89E3\u96C7")))))));
}
window.HireView = HireView;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/HireView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/LoginView.jsx
try { (() => {
const {
  Button,
  Input,
  Icon,
  BotAvatar
} = window.BaizeDesignSystem_7d7772;
function LoginView({
  onLogin
}) {
  const [step, setStep] = React.useState(0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      background: 'var(--bg-app)',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 'var(--titlebar-h)',
      WebkitAppRegion: 'drag'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 360,
      display: 'flex',
      flexDirection: 'column',
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      padding: '6px 14px 6px 6px',
      borderRadius: 999,
      background: 'var(--gray-1)',
      color: 'var(--white)',
      font: '600 16px/1 var(--font-display)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 22,
      borderRadius: 7,
      background: 'var(--white)',
      color: 'var(--gray-1)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11
    }
  }, "\u767D"), "\u767D\u6CFD"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      font: 'var(--type-title)',
      fontSize: 32
    }
  }, "\u6B22\u8FCE\u56DE\u6765"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-3)',
      marginTop: 6
    }
  }, "\u4F60\u7684\u961F\u53CB\u4E00\u76F4\u5728\u7EBF\u3002\u767B\u5F55\u770B\u770B\u4ED6\u4EEC\u5E72\u4E86\u4EC0\u4E48\u3002")), step === 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Input, {
    label: "\u4F01\u4E1A\u57DF\u540D \xB7 Workspace",
    defaultValue: "acme",
    hint: "acme.baize.app"
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    block: true,
    iconRight: "arrow-right",
    onClick: () => setStep(1)
  }, "\u7EE7\u7EED"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      color: 'var(--fg-4)',
      font: 'var(--type-caption)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 1,
      background: 'var(--border-1)'
    }
  }), "\u6216", /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 1,
      background: 'var(--border-1)'
    }
  })), /*#__PURE__*/React.createElement(Button, {
    size: "lg",
    block: true,
    icon: "key-round",
    onClick: () => setStep(1)
  }, "\u4F7F\u7528 SSO \u767B\u5F55")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--border-1)',
      background: 'var(--bg-surface)',
      display: 'flex',
      gap: 12,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "shield-check",
    size: 20,
    color: "var(--success)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)'
    }
  }, "Okta \xB7 acme.okta.com", /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      fontWeight: 400,
      marginTop: 2
    }
  }, "\u6B63\u5728\u6D4F\u89C8\u5668\u91CC\u5B8C\u6210\u9A8C\u8BC1\u2026"))), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    block: true,
    onClick: onLogin
  }, "\u597D\u4E86\uFF0C\u8FDB\u53BB"), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    block: true,
    onClick: () => setStep(0)
  }, "\u8FD4\u56DE")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)'
    }
  }, "\u767B\u5F55\u5373\u540C\u610F\u4F01\u4E1A\u4F7F\u7528\u6761\u6B3E \xB7 \u6570\u636E\u4E0D\u51FA\u4F01\u4E1A\u8FB9\u754C"))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 560,
      margin: 16,
      marginLeft: 0,
      borderRadius: 'var(--radius-xl)',
      background: 'var(--gray-1)',
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: 36,
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 40,
      left: 36,
      display: 'flex'
    }
  }, [['小销', 'tangerine'], ['幕僚长', 'mint'], ['小收', 'violet'], ['小客', 'sky'], ['小招', 'pink']].map(([n, h], i) => /*#__PURE__*/React.createElement(BotAvatar, {
    key: n,
    name: n,
    hue: h,
    size: 64,
    style: {
      marginLeft: i ? -16 : 0,
      boxShadow: '0 0 0 4px var(--gray-1)',
      borderRadius: Math.round(64 * 0.32)
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 44px/1.08 var(--font-display)',
      letterSpacing: '-0.02em',
      color: 'var(--white)',
      maxWidth: 420
    }
  }, "\u53EF\u4EE5\u628A\u771F\u6D3B\u4EA4\u7ED9\u7684 AI \u961F\u53CB"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-body)',
      fontSize: 15,
      color: 'var(--gray-8)',
      marginTop: 14,
      maxWidth: 400
    }
  }, "\u4ED6\u4EEC\u6709\u81EA\u5DF1\u7684\u7535\u8111\uFF0C\u50CF\u4F60\u4E00\u6837\u7528\u4F60\u7684\u5DE5\u5177\uFF0C\u5E72\u5B8C\u4E86\u5E26\u7740\u6210\u679C\u56DE\u6765\u627E\u4F60\u3002")));
}
window.LoginView = LoginView;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/LoginView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/SettingsView.jsx
try { (() => {
const {
  Icon,
  IconButton,
  Tabs,
  Switch,
  Radio,
  Select,
  Input,
  Checkbox,
  Button,
  Badge,
  Card,
  Tag
} = window.BaizeDesignSystem_7d7772;
function SettingsView({
  open,
  onClose
}) {
  const [tab, setTab] = React.useState('sandbox');
  const [s, setS] = React.useState({
    destroy: true,
    approve: true,
    net: 'intranet',
    telemetry: false,
    sso: true
  });
  const D = window.BZ_DATA;
  if (!open) return null;
  const Row = ({
    label,
    desc,
    children
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 24,
      padding: '14px 0',
      borderBottom: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)'
    }
  }, label), desc && /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 3,
      maxWidth: 420
    }
  }, desc)), /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      minWidth: 200
    }
  }, children));
  const nav = [['general', '通用', 'settings'], ['sandbox', '队友的电脑', 'monitor'], ['security', '安全与点头', 'shield-check'], ['members', '成员', 'users'], ['sso', 'SSO 与目录', 'key-round'], ['billing', '账单', 'credit-card']];
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'absolute',
      inset: 0,
      zIndex: 60,
      background: 'var(--overlay)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      animation: 'bz-fade var(--dur-base) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: 920,
      height: 620,
      background: 'var(--bg-app)',
      borderRadius: 'var(--radius-2xl)',
      boxShadow: 'var(--shadow-lg), var(--inset-hairline)',
      display: 'flex',
      overflow: 'hidden',
      animation: 'bz-pop var(--dur-slow) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("nav", {
    style: {
      width: 220,
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-1)',
      padding: 12,
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-label)',
      color: 'var(--fg-4)',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      padding: '6px 8px 10px'
    }
  }, "\u8BBE\u7F6E \xB7 Settings"), nav.map(([v, l, i]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    onClick: () => setTab(v),
    style: {
      all: 'unset',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 30,
      padding: '0 8px',
      borderRadius: 'var(--radius-md)',
      background: tab === v ? 'var(--bg-selected)' : 'transparent',
      color: tab === v ? 'var(--fg-1)' : 'var(--fg-2)',
      font: 'var(--type-ui)',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: i,
    size: 16,
    color: tab === v ? 'var(--fg-1)' : 'var(--fg-3)'
  }), l)), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      padding: 8
    }
  }, "Baize Desktop 1.4.2", /*#__PURE__*/React.createElement("br", null), "pi runtime 2.3.0")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '14px 24px 0',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      font: 'var(--type-heading)',
      fontSize: 20
    }
  }, nav.find(n => n[0] === tab)[1]), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: "x",
    label: "\u5173\u95ED",
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '8px 24px 24px'
    }
  }, tab === 'sandbox' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Row, {
    label: "\u9ED8\u8BA4\u955C\u50CF \xB7 Image",
    desc: "\u65B0\u961F\u53CB\u5165\u804C\u65F6\u62FF\u5230\u7684\u7535\u8111\u955C\u50CF\u3002\u4F01\u4E1A\u955C\u50CF\u7531\u7BA1\u7406\u5458\u7EF4\u62A4\u3002"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: '1.4',
      label: 'baize/sandbox:1.4'
    }, {
      value: '1.3',
      label: 'baize/sandbox:1.3'
    }, {
      value: 'py',
      label: 'acme/sandbox-py:2'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u8D44\u6E90\u4E0A\u9650"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: '2',
      label: '2 vCPU'
    }, {
      value: '4',
      label: '4 vCPU'
    }]
  }), /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: '4',
      label: '4 GB'
    }, {
      value: '8',
      label: '8 GB'
    }]
  }))), /*#__PURE__*/React.createElement(Row, {
    label: "\u7F51\u7EDC\u8BBF\u95EE",
    desc: "\u5BB9\u5668\u53EF\u8BBF\u95EE\u7684\u7F51\u7EDC\u8303\u56F4\u3002"
  }, /*#__PURE__*/React.createElement(Radio, {
    value: s.net,
    onChange: v => setS({
      ...s,
      net: v
    }),
    options: [{
      value: 'none',
      label: '无'
    }, {
      value: 'intranet',
      label: '仅内网'
    }, {
      value: 'all',
      label: '全部'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u4EFB\u52A1\u7ED3\u675F\u540E\u56DE\u6536\u7535\u8111",
    desc: "\u5173\u95ED\u540E\u7535\u8111\u4FDD\u7559 24 \u5C0F\u65F6\uFF0C\u961F\u53CB\u4E0B\u6B21\u63A5\u7740\u7528\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: s.destroy,
    onChange: v => setS({
      ...s,
      destroy: v
    })
  }))), /*#__PURE__*/React.createElement(Row, {
    label: "\u5DE5\u4F5C\u533A\u6302\u8F7D",
    desc: "\u5BBF\u4E3B\u673A\u76EE\u5F55 \u2192 \u5BB9\u5668\u8DEF\u5F84"
  }, /*#__PURE__*/React.createElement(Input, {
    mono: true,
    defaultValue: "~/work \u2192 /workspace",
    size: "sm"
  }))), tab === 'security' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Row, {
    label: "\u654F\u611F\u64CD\u4F5C\u5148\u95EE\u6211",
    desc: "rm\u3001docker\u3001git push\u3001\u5BF9\u5916\u53D1\u9001\u7B49\u5728\u6267\u884C\u524D\u6682\u505C\uFF0C\u7B49\u4F60\u70B9\u5934\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: s.approve,
    onChange: v => setS({
      ...s,
      approve: v
    })
  }))), /*#__PURE__*/React.createElement(Row, {
    label: "\u6279\u51C6\u89C4\u5219",
    desc: "\u7BA1\u7406\u5458\u7B56\u7565\uFF0C\u6210\u5458\u4E0D\u53EF\u4FEE\u6539\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Checkbox, {
    checked: true,
    label: "\u5220\u9664\u6587\u4EF6 / \u5BB9\u5668"
  }), /*#__PURE__*/React.createElement(Checkbox, {
    checked: true,
    label: "git push \u5230\u53D7\u4FDD\u62A4\u5206\u652F"
  }), /*#__PURE__*/React.createElement(Checkbox, {
    label: "\u8BFB\u53D6\u73AF\u5883\u53D8\u91CF"
  }), /*#__PURE__*/React.createElement(Checkbox, {
    checked: true,
    disabled: true,
    label: "\u8BBF\u95EE\u5916\u7F51\uFF08\u7B56\u7565\u9501\u5B9A\uFF09"
  }))), /*#__PURE__*/React.createElement(Row, {
    label: "\u5BA1\u8BA1\u65E5\u5FD7\u4FDD\u7559",
    desc: "\u6240\u6709\u5DE5\u5177\u8C03\u7528\u4E0E\u8F93\u51FA\u52A0\u5BC6\u5B58\u50A8\u3002"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: '90',
      label: '90 天'
    }, {
      value: '365',
      label: '1 年'
    }, {
      value: 'forever',
      label: '永久'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u9065\u6D4B",
    desc: "\u4EC5\u533F\u540D\u5D29\u6E83\u62A5\u544A\uFF0C\u4E0D\u5305\u542B\u5BF9\u8BDD\u5185\u5BB9\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: s.telemetry,
    onChange: v => setS({
      ...s,
      telemetry: v
    })
  })))), tab === 'members' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      padding: '8px 0 12px'
    }
  }, /*#__PURE__*/React.createElement(Input, {
    icon: "search",
    size: "sm",
    placeholder: "\u641C\u7D22\u6210\u5458\u2026",
    style: {
      width: 260
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    icon: "user-plus"
  }, "\u9080\u8BF7\u6210\u5458")), /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1.4fr 120px 40px',
      padding: '8px 12px',
      font: 'var(--type-label)',
      color: 'var(--fg-4)',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u59D3\u540D"), /*#__PURE__*/React.createElement("span", null, "\u90AE\u7BB1"), /*#__PURE__*/React.createElement("span", null, "\u89D2\u8272"), /*#__PURE__*/React.createElement("span", null)), D.members.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.email,
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1.4fr 120px 40px',
      alignItems: 'center',
      padding: '10px 12px',
      borderBottom: '1px solid var(--border-1)',
      font: 'var(--type-ui)',
      fontWeight: 400
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 22,
      borderRadius: '50%',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--inset-hairline)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '500 10px var(--font-sans)'
    }
  }, m.name[0]), m.name), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)'
    }
  }, m.email), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(Badge, {
    tone: m.role === '管理员' ? 'accent' : 'neutral'
  }, m.role)), /*#__PURE__*/React.createElement(IconButton, {
    icon: "ellipsis",
    label: "\u66F4\u591A",
    size: "sm"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      marginTop: 8
    }
  }, "4 / 50 \u5E2D\u4F4D \xB7 \u4F01\u4E1A\u7248")), tab === 'sso' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Row, {
    label: "\u5355\u70B9\u767B\u5F55 \xB7 SSO",
    desc: "\u901A\u8FC7 Okta / Azure AD / \u4F01\u4E1A\u5FAE\u4FE1 \u767B\u5F55\u3002\u542F\u7528\u540E\u5BC6\u7801\u767B\u5F55\u5C06\u88AB\u7981\u7528\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: s.sso,
    onChange: v => setS({
      ...s,
      sso: v
    })
  }))), /*#__PURE__*/React.createElement(Row, {
    label: "\u8EAB\u4EFD\u63D0\u4F9B\u5546"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: 'okta',
      label: 'Okta (SAML 2.0)'
    }, {
      value: 'aad',
      label: 'Azure AD'
    }, {
      value: 'wecom',
      label: '企业微信'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u56DE\u8C03 URL"
  }, /*#__PURE__*/React.createElement(Input, {
    mono: true,
    size: "sm",
    defaultValue: "https://baize.acme.com/sso/callback"
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u76EE\u5F55\u540C\u6B65 \xB7 SCIM",
    desc: "\u81EA\u52A8\u521B\u5EFA/\u505C\u7528\u6210\u5458\u3002\u4E0A\u6B21\u540C\u6B65 12 \u5206\u949F\u524D\u3002"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "\u5DF2\u8FDE\u63A5"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "ghost"
  }, "\u7ACB\u5373\u540C\u6B65")))), tab === 'general' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Row, {
    label: "\u5916\u89C2"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: 'sys',
      label: '跟随系统'
    }, {
      value: 'dark',
      label: '深色'
    }, {
      value: 'light',
      label: '浅色'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u8BED\u8A00 \xB7 Language"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: 'zh',
      label: '中文（简体）'
    }, {
      value: 'en',
      label: 'English'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u9ED8\u8BA4\u6A21\u578B"
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: 'pi-2',
      label: 'pi-2'
    }, {
      value: 'pi-2-mini',
      label: 'pi-2-mini'
    }]
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u5FEB\u6377\u952E",
    desc: "\u5168\u5C40\u5524\u8D77\u767D\u6CFD"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("kbd", null, "\u2325"), /*#__PURE__*/React.createElement("kbd", null, "Space")))), tab === 'billing' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Card, {
    title: "\u4F01\u4E1A\u7248 \xB7 Enterprise",
    meta: "\u5E74\u4ED8 \xB7 \u4E0B\u6B21\u7EED\u8D39 2027-03-01",
    actions: /*#__PURE__*/React.createElement(Button, {
      size: "sm"
    }, "\u7BA1\u7406")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 24,
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u5E2D\u4F4D 4 / 50"), /*#__PURE__*/React.createElement("span", null, "\u672C\u6708 sandbox \u65F6\u957F 182 h"), /*#__PURE__*/React.createElement("span", null, "\u5B58\u50A8 12.4 GB"))), /*#__PURE__*/React.createElement(Row, {
    label: "\u53D1\u7968\u62AC\u5934"
  }, /*#__PURE__*/React.createElement(Input, {
    size: "sm",
    defaultValue: "Acme \u79D1\u6280\u6709\u9650\u516C\u53F8"
  })), /*#__PURE__*/React.createElement(Row, {
    label: "\u7528\u91CF\u544A\u8B66",
    desc: "\u8D85\u8FC7\u989D\u5EA6 80% \u65F6\u901A\u77E5\u7BA1\u7406\u5458"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: true
  }))))))));
}
window.SettingsView = SettingsView;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/SettingsView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/Sidebar.jsx
try { (() => {
const {
  Icon,
  IconButton,
  BotAvatar,
  Tooltip,
  Input
} = window.BaizeDesignSystem_7d7772;
function Sidebar({
  bots,
  active,
  view,
  onSelect,
  onHire,
  onSettings,
  collapsed
}) {
  const [q, setQ] = React.useState('');
  const Row = ({
    b
  }) => {
    const [h, setH] = React.useState(false);
    const on = view === 'thread' && b.id === active;
    return /*#__PURE__*/React.createElement("button", {
      onClick: () => onSelect(b.id),
      onMouseEnter: () => setH(true),
      onMouseLeave: () => setH(false),
      style: {
        all: 'unset',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        height: 56,
        padding: '0 12px',
        borderRadius: 'var(--radius-lg)',
        background: on ? 'var(--bg-selected)' : h ? 'var(--bg-hover)' : 'transparent',
        cursor: 'pointer',
        transition: 'background var(--dur-fast)'
      }
    }, b.group ? /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'relative',
        width: 36,
        height: 36,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement(BotAvatar, {
      name: "\u9500",
      hue: "tangerine",
      size: 24,
      style: {
        position: 'absolute',
        left: 0,
        top: 0
      }
    }), /*#__PURE__*/React.createElement(BotAvatar, {
      name: "\u5E55",
      hue: "mint",
      size: 24,
      style: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        boxShadow: '0 0 0 2px var(--bg-sidebar)',
        borderRadius: '50%'
      }
    })) : /*#__PURE__*/React.createElement(BotAvatar, {
      name: b.name,
      hue: b.hue,
      size: 36,
      status: b.status === 'working' ? 'working' : b.status === 'blocked' ? 'blocked' : undefined
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        font: 'var(--type-ui)',
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--fg-1)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, b.name), /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 'auto',
        font: 'var(--type-caption)',
        color: 'var(--fg-4)',
        flexShrink: 0
      }
    }, b.time)), /*#__PURE__*/React.createElement("div", {
      style: {
        font: 'var(--type-caption)',
        fontSize: 13,
        color: 'var(--fg-3)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        marginTop: 2
      }
    }, b.last)));
  };
  const W = {
    width: 'var(--sidebar-w)',
    boxSizing: 'border-box'
  };
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: collapsed ? 0 : 'var(--sidebar-w)',
      overflow: 'hidden',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-sidebar)',
      borderRight: collapsed ? 'none' : '1px solid var(--border-1)',
      transition: 'width var(--dur-slow) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      height: 'var(--titlebar-h)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 80,
      paddingRight: 10,
      WebkitAppRegion: 'drag'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Tooltip, {
    content: "\u62DB\u52DF\u961F\u53CB",
    shortcut: "\u2318N",
    side: "bottom"
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: "plus",
    label: "\u62DB\u52DF\u961F\u53CB",
    onClick: onHire
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      padding: '2px 12px 10px'
    }
  }, /*#__PURE__*/React.createElement(Input, {
    icon: "search",
    size: "md",
    placeholder: "\u641C\u7D22",
    value: q,
    onChange: e => setQ(e.target.value),
    style: {
      borderRadius: 999,
      background: 'var(--bg-inset)',
      border: '1px solid transparent'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      flex: 1,
      overflowY: 'auto',
      padding: '0 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, bots.filter(b => b.name.includes(q) || b.job.includes(q)).map(b => /*#__PURE__*/React.createElement(Row, {
    key: b.id,
    b: b
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      ...W,
      padding: '10px 12px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      borderRadius: '50%',
      background: 'var(--bg-inset)',
      boxShadow: 'var(--inset-hairline)',
      color: 'var(--fg-2)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '600 11px var(--font-sans)'
    }
  }, "AS"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      font: 'var(--type-ui)',
      fontSize: 14
    }
  }, "Armand Segall"), /*#__PURE__*/React.createElement(IconButton, {
    icon: "settings",
    label: "\u8BBE\u7F6E",
    onClick: onSettings
  })));
}
window.Sidebar = Sidebar;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/ThreadView.jsx
try { (() => {
const {
  Icon,
  IconButton,
  Badge,
  Message,
  ToolCall,
  Composer,
  ComputerCard,
  StatusDot,
  Tooltip,
  Button,
  BotAvatar
} = window.BaizeDesignSystem_7d7772;
function CrmPreview() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      background: 'linear-gradient(180deg,var(--gray-9),var(--gray-10))',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '12%',
      right: '12%',
      top: 22,
      bottom: -10,
      background: 'var(--bg-surface)',
      borderRadius: '10px 10px 0 0',
      boxShadow: 'var(--shadow-md)',
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 6,
      width: '30%',
      borderRadius: 3,
      background: 'var(--gray-8)'
    }
  }), [80, 64, 72].map((w, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--success)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 6,
      width: w + '%',
      borderRadius: 3,
      background: 'var(--gray-9)'
    }
  })))));
}
function ThreadView({
  bot,
  bots,
  items,
  running,
  onSend,
  onStop,
  onApprove,
  onDeny,
  sidebarOpen,
  panelOpen,
  toggleSidebar,
  togglePanel,
  onTheme,
  dark,
  onHire
}) {
  const ref = React.useRef();
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items.length, running, bot && bot.id]);
  const byId = id => bots.find(b => b.id === id);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-app)'
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 'var(--titlebar-h)',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 12px 0 ' + (sidebarOpen ? 12 : 80) + 'px',
      borderBottom: '1px solid var(--border-1)',
      WebkitAppRegion: 'drag'
    }
  }, !sidebarOpen && /*#__PURE__*/React.createElement(IconButton, {
    icon: "panel-left",
    label: "\u4FA7\u680F",
    onClick: toggleSidebar
  }), bot && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: bot.name,
    hue: bot.hue,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ui)',
      fontSize: 15,
      fontWeight: 600
    }
  }, bot.job), bot.group && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, bot.job), running && /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    dot: true
  }, "\u5E72\u6D3B\u4E2D")), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Tooltip, {
    content: dark ? '浅色' : '深色',
    side: "bottom"
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: dark ? 'sun' : 'moon',
    label: "\u4E3B\u9898",
    onClick: onTheme
  })), /*#__PURE__*/React.createElement(Tooltip, {
    content: "\u5B83\u7684\u7535\u8111",
    shortcut: "\u2318.",
    side: "bottom"
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: "monitor",
    label: "\u7535\u8111",
    active: panelOpen,
    onClick: togglePanel
  }))), /*#__PURE__*/React.createElement("div", {
    ref: ref,
    style: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      maxWidth: 'var(--composer-max-w)',
      margin: 'auto auto 0',
      padding: '20px 20px 12px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, items.map((m, i) => {
    if (m.tool) return /*#__PURE__*/React.createElement(ToolCall, {
      key: i,
      kind: m.tool.kind,
      title: m.tool.title,
      command: m.tool.command,
      status: m.tool.status,
      duration: m.tool.duration,
      output: m.tool.output,
      needsApproval: m.tool.needsApproval,
      onApprove: () => onApprove(i),
      onDeny: () => onDeny(i),
      style: {
        maxWidth: '72%'
      }
    });
    if (m.computer) return /*#__PURE__*/React.createElement(ComputerCard, {
      key: i,
      title: "\u7535\u8111",
      status: m.computer.status,
      preview: m.computer.preview === 'crm' ? /*#__PURE__*/React.createElement(CrmPreview, null) : null,
      onOpen: togglePanel
    }, m.computer.text);
    if (m.role === 'time' || m.role === 'system') return /*#__PURE__*/React.createElement(Message, {
      key: i,
      role: m.role
    }, m.text);
    if (m.role === 'user') return /*#__PURE__*/React.createElement(Message, {
      key: i,
      role: "user"
    }, m.text);
    const b = byId(m.bot);
    return /*#__PURE__*/React.createElement(Message, {
      key: i,
      bot: b ? {
        name: b.name,
        hue: b.hue
      } : undefined,
      showAvatar: !!m.avatar,
      time: m.time,
      streaming: m.streaming,
      actions: true
    }, m.text);
  }), running && /*#__PURE__*/React.createElement(Message, {
    streaming: true,
    bot: bot ? {
      name: bot.name,
      hue: bot.hue
    } : undefined
  }, "\u6B63\u5728\u81EA\u5DF1\u7684\u7535\u8111\u4E0A\u5E72\u6D3B"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '6px 20px 16px',
      display: 'flex',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Composer, {
    running: running,
    onSend: onSend,
    onStop: onStop,
    placeholder: bot ? '给' + bot.job + '发消息' : '给白泽发消息'
  })));
}
window.ThreadView = ThreadView;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/ThreadView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/data.js
try { (() => {
window.BZ_DATA = {
  bots: [{
    id: 'b1',
    name: '小销',
    hue: 'tangerine',
    job: '销售外联',
    status: 'working',
    last: '搞定。',
    time: '16:52'
  }, {
    id: 'b2',
    name: '幕僚长',
    hue: 'mint',
    job: '幕僚长',
    status: 'online',
    last: '场地订好了，日程已经发给大家。',
    time: '昨天'
  }, {
    id: 'b3',
    name: '小收',
    hue: 'violet',
    job: '收件箱管理',
    status: 'online',
    last: '发了。收件箱清零，5 封草稿放在草稿箱。',
    time: '13:53'
  }, {
    id: 'b4',
    name: '小客',
    hue: 'sky',
    job: '客户经理',
    status: 'online',
    last: '邀请发给 Vicky 了。Globex 的备注我记下了。',
    time: '11:53'
  }, {
    id: 'b5',
    name: '小招',
    hue: 'pink',
    job: '招聘猎手',
    status: 'blocked',
    last: '用你的口吻起草了 3 封引荐信，你看一眼。',
    time: '8:53'
  }, {
    id: 'b6',
    name: '小账',
    hue: 'lime',
    job: '报销管理',
    status: 'offline',
    last: '报表交了。9 张发票，没有异常。',
    time: '12:53'
  }, {
    id: 'b7',
    name: '团建组',
    hue: 'coral',
    job: '小销 · 幕僚长 · 小账',
    group: true,
    status: 'online',
    last: '那 pipeline 这周就先这样，我去排行程。',
    time: '10:53'
  }],
  threads: {
    b1: [{
      role: 'time',
      text: '16:45'
    }, {
      bot: 'b1',
      text: '嗨 Armand，很高兴见到你。你打算让我负责什么？具体的活，还是先当个万金油？'
    }, {
      role: 'user',
      text: '连夜攒 pipeline，做外联。\n\n从这份 Google Sheet 里挑合格的潜在客户，网上查一遍，从 Hex、Sumble 和 Salesforce 里拿联系人和账号的上下文。用我的口吻起草邮件和 LinkedIn 消息序列。'
    }, {
      role: 'system',
      text: '已改名为 销售外联'
    }, {
      bot: 'b1',
      text: '先看看连了哪些。Hex、Gmail、LinkedIn 已经登录了，Salesforce 还没有。'
    }, {
      computer: {
        status: 'done',
        text: '登录 Salesforce，让我能看到你名下的客户。',
        preview: 'crm'
      }
    }, {
      role: 'user',
      text: '登好了。'
    }, {
      bot: 'b1',
      text: '收到，开始了。表里 118 行，先筛。',
      time: '16:50'
    }, {
      tool: {
        kind: 'browse',
        title: '浏览',
        command: 'hex.tech/acme/workspace · 意向分',
        status: 'success',
        duration: '2m 10s'
      }
    }, {
      tool: {
        kind: 'write',
        title: '起草',
        command: '36 封邮件 + 36 条 LinkedIn 序列',
        status: 'success',
        duration: '6m 40s'
      }
    }, {
      bot: 'b1',
      text: '搞定。42 个账号，36 位联系人进入待审名单。要不要我明早 8 点前发出去？',
      time: '16:52'
    }, {
      tool: {
        kind: 'browse',
        title: '发送',
        command: '36 封外联邮件 · 明早 08:00',
        needsApproval: true,
        status: 'idle'
      }
    }],
    b2: [{
      role: 'time',
      text: '昨天 18:10'
    }, {
      role: 'user',
      text: '下周三的 offsite 场地和日程搞一下。'
    }, {
      bot: 'b2',
      text: '场地订好了，日程已经发给大家。'
    }],
    b3: [{
      role: 'time',
      text: '13:40'
    }, {
      bot: 'b3',
      text: '发了。收件箱清零，5 封草稿放在草稿箱。'
    }],
    b5: [{
      role: 'time',
      text: '8:50'
    }, {
      bot: 'b5',
      text: '用你的口吻起草了 3 封引荐信，你看一眼。'
    }, {
      tool: {
        kind: 'write',
        title: '发送',
        command: '3 封引荐信 · 给 Priya / Marcus / Yuki',
        needsApproval: true,
        status: 'idle'
      }
    }],
    b7: [{
      role: 'time',
      text: '10:40'
    }, {
      bot: 'b2',
      text: '团建定在 11 月 14 日，杭州。',
      avatar: true
    }, {
      bot: 'b1',
      text: '那 pipeline 这周就先这样，我去排行程。',
      avatar: true
    }]
  },
  files: [{
    name: 'prospects.xlsx',
    kind: 'file-spreadsheet',
    size: '48 KB'
  }, {
    name: 'outreach/',
    kind: 'folder',
    size: '72 项'
  }, {
    name: 'review-list.md',
    kind: 'file-text',
    size: '6.0 KB',
    changed: true
  }],
  artifacts: [{
    name: 'review-list.md',
    kind: 'file-text',
    size: '6.0 KB'
  }, {
    name: 'sequences.csv',
    kind: 'file-spreadsheet',
    size: '14 KB'
  }],
  term: [{
    type: 'cmd',
    text: 'baize browse https://hex.tech/acme/workspace'
  }, {
    type: 'out',
    text: 'signed in as armand@acme.com'
  }, {
    type: 'cmd',
    text: 'baize score --sheet prospects.xlsx --model intent'
  }, {
    type: 'out',
    text: '118 rows → 42 accounts, 36 contacts'
  }, {
    type: 'dim',
    text: 'done in 2m 10s'
  }],
  roles: [['销售外联', 'tangerine', 'user-search', '连夜攒 pipeline。研究账号、给联系人打意向分、用你的口吻写邮件和 LinkedIn，留一份待审名单。'], ['招聘猎手', 'pink', 'users', '按 JD 找人、初筛简历、约时间，把合适的人排进你的日历。'], ['投放优化', 'coral', 'megaphone', '每天看一遍广告数据，关掉烧钱的，把预算挪给能跑的。'], ['报销管理', 'lime', 'receipt', '收发票、对预算、每周五出报表。'], ['产品数据', 'violet', 'chart-column', '盯留存和转化，异常波动第一时间告诉你原因。'], ['Bug 复现', 'sky', 'bug', '用户报一个，它复现一个，附上最小复现步骤和日志。'], ['客户健康', 'mint', 'heart-pulse', '看谁最近不活跃、谁工单变多，提前预警流失。'], ['幕僚长', 'mint', 'crown', '整理你的日程、会议纪要和待办，早上给你一份今日要点。']],
  members: [{
    name: '林晓',
    email: 'lin.xiao@corp.example',
    role: '管理员'
  }, {
    name: 'Wei Chen',
    email: 'wei.chen@corp.example',
    role: '成员'
  }, {
    name: '张一鸣',
    email: 'zhang.ym@corp.example',
    role: '成员'
  }, {
    name: 'Sara Ito',
    email: 'sara.ito@corp.example',
    role: '只读'
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/data.js", error: String((e && e.message) || e) }); }

// ui_kits/website/Hero.jsx
try { (() => {
const {
  Button,
  Badge,
  Message,
  ToolCall,
  Composer,
  BotAvatar,
  Icon,
  StatusDot
} = window.BaizeDesignSystem_7d7772;
const BOTS = [['小销', 'tangerine', '销售外联'], ['幕僚长', 'mint', '幕僚长'], ['小收', 'violet', '收件箱管理'], ['小客', 'sky', '客户经理'], ['小招', 'pink', '招聘猎手']];
function Hero() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      position: 'relative',
      padding: '88px 40px 0',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'radial-gradient(ellipse 50% 40% at 50% 10%,var(--accent-soft),transparent 70%)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      maxWidth: 'var(--content-max-w)',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: 22
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 14px 6px 8px',
      borderRadius: 999,
      background: 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline), var(--shadow-sm)',
      font: 'var(--type-ui)',
      textDecoration: 'none'
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "accent"
  }, "\u65B0"), "\u767D\u6CFD 1.4 \u53D1\u5E03 \xB7 \u961F\u53CB\u53EF\u4EE5\u4E92\u76F8\u534F\u4F5C\u4E86", /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-right",
    size: 14
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      marginTop: 6
    }
  }, BOTS.map(([n, h], i) => /*#__PURE__*/React.createElement(BotAvatar, {
    key: n,
    name: n,
    hue: h,
    size: 56,
    style: {
      marginLeft: i ? -14 : 0,
      boxShadow: '0 0 0 4px var(--bg-app)',
      borderRadius: '50%'
    }
  }))), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      font: 'var(--type-display)',
      maxWidth: 900,
      textWrap: 'balance'
    }
  }, "\u8BA4\u8BC6\u767D\u6CFD", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--accent-strong)'
    }
  }, "\u53EF\u4EE5\u628A\u771F\u6D3B\u4EA4\u7ED9\u7684 AI \u961F\u53CB")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      font: 'var(--type-body)',
      fontSize: 19,
      color: 'var(--fg-2)',
      maxWidth: 600,
      textWrap: 'pretty'
    }
  }, "\u4ED6\u4EEC\u6709\u81EA\u5DF1\u7684\u7535\u8111\uFF0C\u80FD\u767B\u5F55\u4F60\u7684\u5DE5\u5177\u3001\u50CF\u4F60\u4E00\u6837\u4F7F\u7528\u5B83\u4EEC\uFF0C\u5E72\u5B8C\u4E86\u5E26\u7740\u6210\u679C\u56DE\u6765\u627E\u4F60\u3002"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    icon: "download"
  }, "\u4E0B\u8F7D macOS \u7248"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg"
  }, "\u8054\u7CFB\u9500\u552E")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)'
    }
  }, "macOS 13+ \xB7 \u4F01\u4E1A\u7248\u652F\u6301\u79C1\u6709\u5316\u90E8\u7F72\u4E0E SSO")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      maxWidth: 1120,
      margin: '64px auto -2px',
      borderRadius: '20px 20px 0 0',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-window)',
      background: 'var(--bg-app)',
      display: 'flex',
      height: 560
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 250,
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-1)',
      padding: '14px 10px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      padding: '0 6px 12px'
    }
  }, ['#ff5f57', '#febc2e', '#28c840'].map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: c
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      padding: '0 6px 12px'
    }
  }, BOTS.slice(0, 4).map(([n, h], i) => /*#__PURE__*/React.createElement(BotAvatar, {
    key: n,
    name: n,
    hue: h,
    size: 34,
    status: i === 0 ? 'working' : 'online'
  }))), [['小销', '搞定。', 'tangerine', 'working'], ['幕僚长', '场地订好了。', 'mint'], ['小收', '收件箱清零。', 'violet'], ['小招', '3 封引荐信等你看。', 'pink', 'blocked']].map(([n, t, h, s], i) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      height: 46,
      padding: '0 10px',
      borderRadius: 'var(--radius-lg)',
      background: i === 0 ? 'var(--bg-surface)' : 'transparent',
      boxShadow: i === 0 ? 'var(--shadow-sm), var(--inset-hairline)' : 'none'
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: n,
    hue: h,
    size: 28,
    status: s
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)',
      fontWeight: 600
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, t))))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      padding: '28px 36px 20px',
      gap: 16,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement(Message, {
    role: "time"
  }, "16:45"), /*#__PURE__*/React.createElement(Message, null, "\u55E8\uFF0C\u4F60\u6253\u7B97\u8BA9\u6211\u8D1F\u8D23\u4EC0\u4E48\uFF1F\u5177\u4F53\u7684\u6D3B\uFF0C\u8FD8\u662F\u5148\u5F53\u4E2A\u4E07\u91D1\u6CB9\uFF1F"), /*#__PURE__*/React.createElement(Message, {
    role: "user"
  }, "\u8FDE\u591C\u6512 pipeline\uFF0C\u505A\u5916\u8054\u3002\u7528\u6211\u7684\u53E3\u543B\u8D77\u8349\u90AE\u4EF6\u548C LinkedIn \u5E8F\u5217\u3002"), /*#__PURE__*/React.createElement(Message, {
    role: "system"
  }, "\u5DF2\u6539\u540D\u4E3A \u9500\u552E\u5916\u8054"), /*#__PURE__*/React.createElement(Message, null, "\u5148\u770B\u770B\u8FDE\u4E86\u54EA\u4E9B\u3002Hex\u3001Gmail\u3001LinkedIn \u5DF2\u7ECF\u767B\u5F55\u4E86\uFF0CSalesforce \u8FD8\u6CA1\u6709\u3002"), /*#__PURE__*/React.createElement(ToolCall, {
    kind: "write",
    title: "\u53D1\u9001",
    command: "36 \u5C01\u5916\u8054\u90AE\u4EF6 \xB7 \u660E\u65E9 08:00",
    needsApproval: true,
    style: {
      maxWidth: '72%'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Composer, {
    placeholder: "\u7ED9\u9500\u552E\u5916\u8054\u53D1\u6D88\u606F",
    style: {
      maxWidth: 'none'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 300,
      borderLeft: '1px solid var(--border-1)',
      background: 'var(--bg-sidebar)',
      padding: 14,
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      font: 'var(--type-ui)',
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "monitor",
    size: 14
  }), "\u5C0F\u4FEE\u7684\u7535\u8111", /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    dot: true
  }, "\u5E72\u6D3B\u4E2D")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline)',
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 18,
      borderRadius: 999,
      background: 'var(--bg-inset)',
      font: 'var(--type-mono)',
      fontSize: 10,
      color: 'var(--fg-4)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px'
    }
  }, "github.com/acme/api/actions"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: 'var(--danger)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-ui)'
    }
  }, "build-and-test"), /*#__PURE__*/React.createElement(Badge, {
    tone: "danger"
  }, "failed")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '80%'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '55%'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 10,
      borderRadius: 'var(--radius-md)',
      background: 'var(--code-bg)',
      color: 'var(--code-fg)',
      font: 'var(--type-mono)',
      fontSize: 11
    }
  }, "error: node >=18 required"), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '70%'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'var(--bg-inset)',
      width: '40%'
    }
  })))));
}
window.Hero = Hero;
window.BZ_BOTS = BOTS;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Nav.jsx
try { (() => {
const {
  Button,
  IconButton
} = window.BaizeDesignSystem_7d7772;
function Nav({
  dark,
  onTheme
}) {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 20,
      height: 64,
      display: 'flex',
      alignItems: 'center',
      padding: '0 40px',
      gap: 32,
      background: 'var(--glass-bg)',
      backdropFilter: 'blur(20px)',
      borderBottom: '1px solid var(--glass-border)'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      textDecoration: 'none',
      font: '600 20px/1 var(--font-display)',
      letterSpacing: '-0.03em'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 26,
      height: 26,
      borderRadius: '50%',
      background: 'var(--accent)',
      color: 'var(--gray-0)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12
    }
  }, "\u767D"), "\u767D\u6CFD"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 24,
      font: 'var(--type-ui)',
      color: 'var(--fg-2)'
    }
  }, ['产品', '队友市场', '企业版', '定价', '文档'].map(t => /*#__PURE__*/React.createElement("a", {
    key: t,
    href: "#",
    style: {
      textDecoration: 'none',
      color: 'inherit'
    }
  }, t))), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: dark ? 'sun' : 'moon',
    label: "\u4E3B\u9898",
    onClick: onTheme
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost"
  }, "\u767B\u5F55"), /*#__PURE__*/React.createElement(Button, {
    variant: "dark",
    icon: "download"
  }, "\u4E0B\u8F7D macOS \u7248"));
}
window.Nav = Nav;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Nav.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Sections.jsx
try { (() => {
const {
  Button,
  Card,
  Icon,
  Badge,
  Tabs,
  BotAvatar,
  Message,
  ToolCall
} = window.BaizeDesignSystem_7d7772;
const Wrap = ({
  children,
  style
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 'var(--content-max-w)',
    margin: '0 auto',
    padding: '0 40px',
    ...style
  }
}, children);
const H2 = ({
  kicker,
  children,
  sub,
  center
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 44,
    maxWidth: 680,
    alignItems: center ? 'center' : 'flex-start',
    textAlign: center ? 'center' : 'left',
    margin: center ? '0 auto 44px' : '0 0 44px'
  }
}, kicker && /*#__PURE__*/React.createElement(Badge, {
  tone: "accent"
}, kicker), /*#__PURE__*/React.createElement("h2", {
  style: {
    margin: 0,
    font: '600 44px/1.1 var(--font-display)',
    letterSpacing: '-0.03em',
    textWrap: 'balance'
  }
}, children), sub && /*#__PURE__*/React.createElement("p", {
  style: {
    margin: 0,
    font: 'var(--type-body)',
    fontSize: 17,
    color: 'var(--fg-2)',
    textWrap: 'pretty'
  }
}, sub));
function LikeTeammates() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '112px 0 0',
      background: 'var(--bg-sidebar)'
    }
  }, /*#__PURE__*/React.createElement(Wrap, {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 64,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(H2, {
    kicker: "\u50CF\u540C\u4E8B\u4E00\u6837"
  }, "\u628A\u6D3B\u6D3E\u7ED9\u961F\u53CB\uFF0C\u5C31\u50CF\u53D1\u6D88\u606F"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      font: 'var(--type-body)',
      fontSize: 15,
      color: 'var(--fg-2)',
      marginTop: -20
    }
  }, [['message-square', '在桌面或手机上给队友发任务，它从头做到尾。'], ['brain', '记得你怎么干活，越用越顺手。'], ['hand', '需要你点头的时候才回来找你。']].map(([i, t]) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 32,
      height: 32,
      borderRadius: 10,
      background: 'var(--accent-soft)',
      color: 'var(--accent-strong)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: i,
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      paddingTop: 5
    }
  }, t))))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-2xl)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-lg), var(--inset-hairline)',
      padding: 28,
      display: 'flex',
      flexDirection: 'column',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Message, {
    role: "user"
  }, "\u767B\u5F55 Zendesk \u628A\u4ECA\u5929\u7684\u5DE5\u5355\u8FC7\u4E00\u904D\u3002"), /*#__PURE__*/React.createElement(Message, null, "\u597D\uFF0C\u6211\u5728\u81EA\u5DF1\u7535\u8111\u4E0A\u767B\u4E86\u300223 \u5F20\u5DE5\u5355\uFF0C5 \u5F20\u662F\u8D26\u5355\u95EE\u9898\u6211\u5148\u56DE\u4E86\uFF0C2 \u5F20\u8981\u9000\u6B3E\u7684\u7B49\u4F60\u70B9\u5934\u3002"), /*#__PURE__*/React.createElement(ToolCall, {
    kind: "browse",
    title: "\u6D4F\u89C8",
    command: "acme.zendesk.com/agent/filters/open",
    status: "success",
    duration: "38s",
    style: {
      maxWidth: '80%'
    }
  }), /*#__PURE__*/React.createElement(ToolCall, {
    kind: "write",
    title: "\u9000\u6B3E",
    command: "#4821 \xB7 \xA51,280 \xB7 \u5BA2\u6237 Linda",
    needsApproval: true,
    style: {
      maxWidth: '80%'
    }
  }))));
}
function ManyBots() {
  const bots = window.BZ_BOTS;
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '112px 0',
      background: 'var(--bg-sidebar)'
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement(H2, {
    kicker: "\u5E76\u884C",
    center: true,
    sub: "\u5EFA\u4E00\u4E2A\u961F\u53CB\uFF0C\u6D3E\u4E00\u4E2A\u6D3B\uFF0C\u6D3B\u591A\u4E86\u518D\u52A0\u4E00\u4E2A\u3002\u4ED6\u4EEC\u540C\u65F6\u5E72\u3001\u8BE5\u914D\u5408\u65F6\u914D\u5408\u300124 \u5C0F\u65F6\u4E0D\u4E0B\u7EBF\u3002"
  }, "\u540C\u65F6\u7528\u4E0A\u4E00\u6574\u961F"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(5,minmax(0,1fr))',
      gap: 12
    }
  }, bots.map(([n, h, j], i) => /*#__PURE__*/React.createElement(Card, {
    key: n,
    padding: 18,
    interactive: true,
    style: {
      background: 'var(--bot-' + h + '-soft)',
      borderColor: 'transparent'
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: n,
    hue: h,
    size: 44,
    status: i % 2 ? 'online' : 'working'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-heading)',
      marginTop: 14
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, j), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      font: 'var(--type-caption)',
      color: 'var(--fg-2)',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: i % 2 ? 'var(--success)' : 'var(--accent)'
    }
  }), ['在攒 pipeline', '在排日程', '在清收件箱', '在跟客户', '在筛简历'][i])))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      display: 'flex',
      gap: 8,
      justifyContent: 'center',
      flexWrap: 'wrap'
    }
  }, ['小研 → 小销：客户名单整理好了', '小修 → 小账：这月云账单多了 12%', '小招 → 幕僚长：三个候选人排到周四'].map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    style: {
      padding: '6px 12px',
      borderRadius: 999,
      background: 'var(--bg-surface)',
      boxShadow: 'var(--inset-hairline)',
      font: 'var(--type-caption)',
      color: 'var(--fg-2)'
    }
  }, t)))));
}
function Roles() {
  const roles = [['销售外联', 'coral', 'user-search', '连夜攒 pipeline。研究账号、给联系人打意向分、用你的口吻写邮件，留一份待审名单。'], ['招聘猎手', 'mint', 'users', '按 JD 找人、初筛简历、约时间。'], ['投放优化', 'pink', 'megaphone', '每天看广告数据，关掉烧钱的。'], ['报销管理', 'lime', 'receipt', '收发票、对预算、周五出报表。'], ['产品数据', 'violet', 'chart-column', '盯留存和转化，异常先告诉你原因。'], ['Bug 复现', 'sky', 'bug', '用户报一个，它复现一个。'], ['客户健康', 'tangerine', 'heart-pulse', '提前预警流失。'], ['幕僚长', 'coral', 'crown', '早上给你一份今日要点。']];
  const [sel, setSel] = React.useState(0);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '112px 0',
      borderTop: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 24
    }
  }, /*#__PURE__*/React.createElement(H2, {
    kicker: "\u961F\u53CB\u5E02\u573A"
  }, "\u7ED9\u6BCF\u4E2A\u961F\u53CB\u4E00\u4EFD\u5DE5\u4F5C"), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    iconRight: "arrow-right",
    style: {
      marginBottom: 44
    }
  }, "\u6D4F\u89C8\u66F4\u591A\u5C97\u4F4D")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 20
    }
  }, roles.map(([t, h], i) => /*#__PURE__*/React.createElement("button", {
    key: t,
    onClick: () => setSel(i),
    style: {
      all: 'unset',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      height: 40,
      padding: '0 16px 0 8px',
      borderRadius: 999,
      background: sel === i ? 'var(--gray-0)' : 'var(--bg-surface)',
      color: sel === i ? 'var(--gray-11)' : 'var(--fg-1)',
      boxShadow: 'var(--inset-hairline)',
      font: 'var(--type-ui)',
      transition: 'background var(--dur-fast)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: 'var(--bot-' + h + ')'
    }
  }), t))), /*#__PURE__*/React.createElement(Card, {
    padding: 32,
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 32,
      alignItems: 'center',
      background: 'var(--bot-' + roles[sel][1] + '-soft)',
      borderColor: 'transparent'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(BotAvatar, {
    name: roles[sel][0],
    hue: roles[sel][1],
    size: 56
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 28px/1.1 var(--font-display)',
      letterSpacing: '-0.02em'
    }
  }, roles[sel][0])), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '18px 0 22px',
      font: 'var(--type-body)',
      fontSize: 16,
      color: 'var(--fg-2)',
      maxWidth: 440
    }
  }, roles[sel][3]), /*#__PURE__*/React.createElement(Button, {
    variant: "dark",
    icon: "sparkles"
  }, "\u8BA9\u5B83\u5165\u804C")), /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-md)',
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, ['研究 42 个目标账号', '给 118 位联系人打分', '按你的口吻起草 36 封邮件', '留下待审名单 · 等你点头'].map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      font: 'var(--type-ui)',
      fontWeight: i === 3 ? 600 : 400,
      color: i === 3 ? 'var(--fg-1)' : 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: i === 3 ? 'hand' : 'check',
    size: 14,
    color: i === 3 ? 'var(--accent-strong)' : 'var(--success)'
  }), t))))));
}
function Security() {
  const rows = [['自己的电脑', '每个队友一台隔离容器，任务结束可回收'], ['先问再做', '删除、推送、对外发送等敏感操作需要你点头'], ['可审计', '每一步操作、输出、文件改动加密留存'], ['不出边界', '私有化部署，模型网关在你的 VPC'], ['SSO / SCIM', 'Okta、Azure AD、企业微信，自动开停账号']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '112px 0',
      background: 'var(--gray-0)',
      color: 'var(--gray-11)'
    }
  }, /*#__PURE__*/React.createElement(Wrap, {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 64,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Badge, {
    tone: "accent"
  }, "\u4F01\u4E1A\u7248"), /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '14px 0 12px',
      font: '600 44px/1.1 var(--font-display)',
      letterSpacing: '-0.03em',
      color: 'var(--gray-11)'
    }
  }, "\u961F\u53CB\u53EA\u80FD\u505A\u4F60\u5141\u8BB8\u7684\u4E8B"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '0 0 24px',
      font: 'var(--type-body)',
      fontSize: 17,
      color: 'var(--gray-8)'
    }
  }, "\u5B89\u5168\u56E2\u961F\u6700\u5148\u95EE\u7684\u95EE\u9898\uFF0C\u6211\u4EEC\u5728\u67B6\u6784\u4E0A\u56DE\u7B54\u3002"), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconRight: "arrow-right"
  }, "\u9605\u8BFB\u5B89\u5168\u767D\u76AE\u4E66")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, rows.map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'grid',
      gridTemplateColumns: '130px 1fr',
      gap: 16,
      padding: '16px 18px',
      borderRadius: 'var(--radius-lg)',
      background: 'rgba(255,255,255,0.06)',
      font: 'var(--type-ui)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--gray-11)'
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--gray-8)',
      fontWeight: 400
    }
  }, v))))));
}
function Pricing() {
  const tiers = [['个人', '¥0', '', '1 位队友，共享电脑', ['pi-2 模型', '每周基础用量', '社区支持'], '免费开始', 'secondary'], ['团队', '¥199', '/席位/月', '最多 20 席位', ['不限队友数', '每人独立电脑', '定时例程', '审计 90 天'], '开始试用', 'primary'], ['企业', '联系销售', '', '私有化，无上限', ['私有 VPC 电脑', 'SSO / SCIM', '审计永久 + SIEM', '专属支持'], '联系销售', 'dark']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '112px 0'
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement(H2, {
    kicker: "\u5B9A\u4EF7",
    center: true
  }, "\u5148\u62DB\u4E00\u4F4D\uFF0C\u5408\u9002\u518D\u52A0"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
      gap: 12
    }
  }, tiers.map(([n, p, u, d, f, cta, v]) => /*#__PURE__*/React.createElement(Card, {
    key: n,
    padding: 26,
    style: v === 'primary' ? {
      borderColor: 'var(--accent)',
      boxShadow: '0 0 0 1px var(--accent)'
    } : {}
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-heading)'
    }
  }, n), v === 'primary' && /*#__PURE__*/React.createElement(Badge, {
    tone: "accent"
  }, "\u6700\u591A\u4EBA\u9009")), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '18px 0 4px',
      font: '600 40px/1 var(--font-display)',
      letterSpacing: '-0.03em'
    }
  }, p, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginLeft: 4
    }
  }, u)), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, d), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      margin: '22px 0 26px'
    }
  }, f.map(x => /*#__PURE__*/React.createElement("div", {
    key: x,
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      font: 'var(--type-ui)',
      fontWeight: 400,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 14,
    color: "var(--accent-strong)"
  }), x))), /*#__PURE__*/React.createElement(Button, {
    variant: v,
    block: true,
    size: "lg"
  }, cta))))));
}
function Download() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '0 0 112px'
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-2xl)',
      background: 'var(--accent)',
      padding: '64px 56px',
      display: 'flex',
      alignItems: 'center',
      gap: 40,
      color: 'var(--gray-0)',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      font: '600 48px/1.05 var(--font-display)',
      letterSpacing: '-0.03em'
    }
  }, "\u8BA4\u8BC6\u4F60\u7684\u7B2C\u4E00\u4F4D\u961F\u53CB"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '14px 0 26px',
      font: 'var(--type-body)',
      fontSize: 17,
      opacity: .8,
      maxWidth: 440
    }
  }, "\u4E00\u652F\u56E2\u961F\uFF0C\u5728\u4F60\u684C\u4E0A\uFF0C\u4E5F\u5728\u4F60\u53E3\u888B\u91CC\u3002"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "dark",
    size: "lg",
    icon: "download"
  }, "\u4E0B\u8F7D macOS \u7248"), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "lg",
    style: {
      color: 'var(--gray-0)'
    }
  }, "\u5176\u4ED6\u5E73\u53F0"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex'
    }
  }, window.BZ_BOTS.map(([n, h], i) => /*#__PURE__*/React.createElement(BotAvatar, {
    key: n,
    name: n,
    hue: h,
    size: 80,
    style: {
      marginLeft: i ? -20 : 0,
      boxShadow: '0 0 0 4px var(--bg-surface)',
      borderRadius: '50%'
    }
  }))))));
}
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: '1px solid var(--border-1)',
      padding: '56px 0 40px'
    }
  }, /*#__PURE__*/React.createElement(Wrap, {
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1fr 1fr 1fr',
      gap: 32
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 22px/1 var(--font-display)',
      letterSpacing: '-0.03em'
    }
  }, "\u767D\u6CFD"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      marginTop: 10
    }
  }, "\xA9 2026 Baize \xB7 \u53EF\u4EE5\u628A\u771F\u6D3B\u4EA4\u7ED9\u7684 AI \u961F\u53CB")), [['产品', ['macOS 客户端', 'iOS', '队友市场', '更新日志']], ['企业', ['安全', '合规', '私有化部署', '联系销售']], ['资源', ['文档', '指南', '状态页', '支持']]].map(([h, ls]) => /*#__PURE__*/React.createElement("div", {
    key: h,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-ui)',
      fontWeight: 600
    }
  }, h), ls.map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#",
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      textDecoration: 'none'
    }
  }, l))))));
}
Object.assign(window, {
  LikeTeammates,
  ManyBots,
  Roles,
  Security,
  Pricing,
  Download,
  Footer
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Sections.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/SiteApp.jsx
try { (() => {
function SiteApp() {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : '';
  }, [dark]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Nav, {
    dark: dark,
    onTheme: () => setDark(!dark)
  }), /*#__PURE__*/React.createElement(Hero, null), /*#__PURE__*/React.createElement(LikeTeammates, null), /*#__PURE__*/React.createElement(ManyBots, null), /*#__PURE__*/React.createElement(Roles, null), /*#__PURE__*/React.createElement(Security, null), /*#__PURE__*/React.createElement(Pricing, null), /*#__PURE__*/React.createElement(Download, null), /*#__PURE__*/React.createElement(Footer, null));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(SiteApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/SiteApp.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Composer = __ds_scope.Composer;

__ds_ns.ComputerCard = __ds_scope.ComputerCard;

__ds_ns.Message = __ds_scope.Message;

__ds_ns.Terminal = __ds_scope.Terminal;

__ds_ns.ToolCall = __ds_scope.ToolCall;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.BOT_HUES = __ds_scope.BOT_HUES;

__ds_ns.BotAvatar = __ds_scope.BotAvatar;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.StatusDot = __ds_scope.StatusDot;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Toast = __ds_scope.Toast;

})();
