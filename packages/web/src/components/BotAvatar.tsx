import type { BotHue, BotShape } from "@baize/shared";

type Size = "xs" | "sm" | "md" | "lg";
export type BotAvatarState = "idle" | "working" | "confirm" | "happy" | "sleep";

export const SHAPES: Record<BotShape, { name: string; path: string; y: number; dx: number }> = {
  pillow: {
    name: "方团",
    y: 51,
    dx: 0,
    path: "M29 15 C38 14 43 18 50 18 C57 18 62 14 71 15 C86 16 91 26 91 43 L91 62 C91 79 83 86 67 87 L33 87 C17 86 9 79 9 62 L9 43 C9 26 14 16 29 15 Z",
  },
  cloud: {
    name: "云团",
    y: 55,
    dx: 0,
    path: "M30 84 C16 84 7 75 7 62 C7 51 12 43 21 39 C18 24 28 12 44 12 C61 12 72 25 71 41 C84 39 94 49 94 62 C94 75 84 84 71 84 Z",
  },
  triangle: {
    name: "糯角",
    y: 58,
    dx: 0,
    path: "M40 17 Q50 3 60 18 L91 70 Q102 89 80 90 L20 90 Q0 89 10 71 Z",
  },
  bean: {
    name: "豆豆",
    y: 53,
    dx: -2,
    path: "M35 11 C54 4 83 14 88 33 C93 49 74 49 73 63 C72 79 62 92 42 91 C20 90 9 74 10 55 C11 36 18 18 35 11 Z",
  },
  droplet: {
    name: "水滴",
    y: 59,
    dx: 0,
    path: "M52 8 C55 6 58 9 60 13 C67 29 89 43 89 62 C89 81 73 93 51 93 C28 93 12 80 12 61 C12 40 36 28 48 12 Q50 9 52 8 Z",
  },
  arch: {
    name: "小拱",
    y: 54,
    dx: 0,
    path: "M8 73 L8 56 C8 29 26 11 50 11 C74 11 92 29 92 56 L92 73 Q92 86 79 86 L21 86 Q8 86 8 73 Z",
  },
  leaf: {
    name: "小叶",
    y: 56,
    dx: -1,
    path: "M83 10 Q89 9 89 16 C91 42 83 69 64 84 C48 97 25 90 15 74 C4 56 13 34 34 23 C50 15 67 16 83 10 Z",
  },
  pudding: {
    name: "布丁",
    y: 54,
    dx: 0,
    path: "M37 15 L65 15 Q76 15 79 26 L92 73 Q97 89 80 90 L20 90 Q3 89 8 73 L22 26 Q25 15 37 15 Z",
  },
};

const face = (state: BotAvatarState, y: number) => (
  <g className="avatar-face">
    {([39, 61] as const).map((x, index) => {
      const direction = index === 0 ? 1 : -1;
      if (state === "happy") {
        return (
          <g key={x}>
            <ellipse cx={x} cy={y} rx="8" ry="7" fill="#fffaf0" />
            <path
              d={`M${x - 4.8} ${y + 1} Q${x} ${y - 5.5} ${x + 4.8} ${y + 1}`}
              fill="none"
              stroke="#18243b"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
          </g>
        );
      }
      if (state === "sleep") {
        return (
          <g key={x}>
            <rect x={x - 8} y={y - 2} width="16" height="7" rx="3.5" fill="#fffaf0" />
            <path
              d={`M${x - 5} ${y + 0.2} Q${x} ${y + 4.2} ${x + 5} ${y + 0.2}`}
              fill="none"
              stroke="#18243b"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </g>
        );
      }
      const eyeY = y + (state === "confirm" && x === 61 ? -1.5 : 0);
      const ry = state === "working" ? 6 : state === "confirm" ? 10 : 9;
      const pupilX = x + (state === "working" ? 2.6 : state === "confirm" ? 1.5 : direction * 0.8);
      const pupilY = eyeY + (state === "working" ? 1.2 : state === "confirm" ? -1.3 : 1.4);
      const pupilRy = state === "working" ? 4.3 : 5.8;
      return (
        <g key={x}>
          <ellipse cx={x} cy={eyeY} rx="8" ry={ry} fill="#fffaf0" />
          <ellipse cx={pupilX} cy={pupilY} rx="4.8" ry={pupilRy} fill="#18243b" />
        </g>
      );
    })}
    {state === "happy" ? (
      <path
        d={`M43 ${y + 14} Q50 ${y + 12} 57 ${y + 14} Q56 ${y + 25} 50 ${y + 25} Q44 ${y + 25} 43 ${y + 14} Z`}
        fill="#18243b"
      />
    ) : state === "confirm" ? (
      <ellipse cx="50" cy={y + 19} rx="3.2" ry="4" fill="#18243b" />
    ) : state === "sleep" ? (
      <path d={`M47 ${y + 18} L53 ${y + 18}`} fill="none" stroke="#18243b" strokeWidth="2" strokeLinecap="round" />
    ) : state === "working" ? (
      <path d={`M48 ${y + 18} L54 ${y + 17}`} fill="none" stroke="#18243b" strokeWidth="2" strokeLinecap="round" />
    ) : (
      <path
        d={`M46 ${y + 17} Q50 ${y + 21} 54 ${y + 17}`}
        fill="none"
        stroke="#18243b"
        strokeWidth="2"
        strokeLinecap="round"
      />
    )}
  </g>
);

export const resolveBotAvatarState = ({
  paused,
  pendingApproval,
  working,
}: {
  paused: boolean;
  pendingApproval: boolean;
  working: boolean;
}): BotAvatarState => (paused ? "sleep" : pendingApproval ? "confirm" : working ? "working" : "idle");

export const BotAvatar = ({
  hue,
  shape,
  state = "idle",
  size = "md",
}: {
  hue: BotHue;
  shape: BotShape;
  state?: BotAvatarState;
  size?: Size;
}) => {
  const item = SHAPES[shape];
  return (
    <span
      className={`avatar avatar-${size}${state === "working" ? " is-working" : ""}`}
      data-shape={shape}
      data-state={state}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width="100%" height="100%" focusable="false">
        <path d={item.path} fill={`var(--bot-${hue})`} />
        <g transform={`translate(${item.dx} 0)`}>{face(state, item.y)}</g>
      </svg>
      {state === "confirm" ? <span className="avatar-confirm" aria-hidden="true" /> : null}
    </span>
  );
};
