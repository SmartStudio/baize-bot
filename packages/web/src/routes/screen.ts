import { GroupId } from "@baize/shared";

// 主窗口的每个入口一条路径，路径是「现在在哪」的唯一来源。reducer 不记选中，刷新后照路径回到原处。
export type Screen =
  | { kind: "today" }
  | { kind: "group"; groupId: GroupId }
  | { kind: "project"; groupId: GroupId }
  | { kind: "routines" }
  | { kind: "team" };

const GROUP_PATH = /^\/(g|p)\/([^/]+)\/?$/;

export const screenOf = (pathname: string): Screen | null => {
  if (pathname === "/") return { kind: "today" };
  if (pathname === "/routines") return { kind: "routines" };
  if (pathname === "/team") return { kind: "team" };
  const match = GROUP_PATH.exec(pathname);
  if (match === null) return null;
  const parsed = GroupId.safeParse(decodeSegment(match[2] ?? ""));
  if (!parsed.success) return null;
  return match[1] === "p" ? { kind: "project", groupId: parsed.data } : { kind: "group", groupId: parsed.data };
};

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const pathOf = (screen: Screen): string => {
  switch (screen.kind) {
    case "today":
      return "/";
    case "routines":
      return "/routines";
    case "team":
      return "/team";
    case "group":
      return `/g/${encodeURIComponent(screen.groupId)}`;
    case "project":
      return `/p/${encodeURIComponent(screen.groupId)}`;
  }
};
