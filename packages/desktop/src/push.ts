import { ServerPush, type GroupId, type NotifyKind } from "@baize/shared";

export type DesktopNotice = { readonly kind: NotifyKind; readonly text: string; readonly groupId: GroupId | null };

export type DesktopPush = {
  notify(input: DesktopNotice): void;
  refreshPending(): void;
};

export function receiveServerPush(raw: string, target: DesktopPush): boolean {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }
  const parsed = ServerPush.safeParse(json);
  if (!parsed.success) return false;
  if (parsed.data.type === "notify") {
    target.notify({
      kind: parsed.data.notice.kind,
      text: parsed.data.notice.text,
      groupId: parsed.data.notice.groupId,
    });
  } else if (parsed.data.type === "approval_updated") {
    target.refreshPending();
  }
  return true;
}
