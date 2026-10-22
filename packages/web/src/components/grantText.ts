import { GRANTABLE_SCOPES, type ActionKind, type Approval, type ApprovalScope, type GrantTarget } from "@baize/shared";

export const ACTION_TEXT: Record<ActionKind, string> = {
  read: "读取",
  write_workspace: "写工作目录",
  write_outside: "写外部文件",
  delete: "删除",
  shell: "运行命令",
  publish: "公开发布",
  message_person: "对外发送",
  engage: "互动",
  spend: "付钱",
  account_security: "账号安全",
  install: "安装",
  external_write: "改生产数据",
};

export const SCOPE_TEXT: Record<ApprovalScope, string> = {
  once: "仅这一次",
  project: "这个项目里",
  forever: "一直",
};

// Web 还没有账号列表可查，账号只写「这个账号」，id 不上屏。
export const targetText = (target: GrantTarget): string => {
  switch (target.kind) {
    case "account":
      return "这个账号";
    case "domain":
      return `域名 ${target.domain}`;
    case "path":
      return `路径 ${target.prefix}`;
  }
};

// 授权按目标匹配，没有目标的审批存不下长期授权，只能批这一次。
export const offeredScopes = (approval: Approval): readonly ApprovalScope[] =>
  approval.target === null ? ["once"] : GRANTABLE_SCOPES[approval.action];
