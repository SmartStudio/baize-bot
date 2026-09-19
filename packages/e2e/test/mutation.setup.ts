import { afterEach, beforeEach, vi } from "vitest";
import { WebSocket } from "ws";
import { AgentHub, computers } from "@baize/control-plane/testing";

// 仅 mutation.config.ts 加载；故障注入不改其他包的源码，也不参与默认验收。
beforeEach(() => {
  switch (process.env["E2E_MUTATION"]) {
    case "offline":
      vi.spyOn(AgentHub.prototype, "isOnline").mockReturnValue(true);
      break;
    case "disconnect":
      vi.spyOn(computers, "markComputerSleeping").mockResolvedValue(undefined);
      break;
    case "supersede": {
      const close = WebSocket.prototype.close;
      vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (this: WebSocket, code, data) {
        if (code !== 4000) close.call(this, code, data);
      });
      break;
    }
    case "handoff": {
      const send = AgentHub.prototype.send;
      vi.spyOn(AgentHub.prototype, "send").mockImplementation(function (this: AgentHub, ownerId, message) {
        if (message.type === "prompt" && message.handoffId !== undefined) {
          const { handoffId: _handoffId, ...withoutHandoff } = message;
          return send.call(this, ownerId, withoutHandoff);
        }
        return send.call(this, ownerId, message);
      });
      break;
    }
    default:
      throw new Error("E2E_MUTATION 必须是 offline、disconnect、supersede 或 handoff");
  }
});

afterEach(() => vi.restoreAllMocks());
