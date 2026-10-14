import { type RawData, WebSocket } from "ws";
import { createRunner } from "@baize/bot-runner";
import { type AgentHandle, type AgentOptions, startAgent } from "@baize/computer-agent";
import { DEV_EMAIL, DEV_PASSWORD } from "@baize/control-plane";
import {
  ComputerListResponse,
  type ComputerId,
  ComputerTokenResponse,
  decodeLive,
  encodeLive,
  type LiveUserEnd,
  type LiveId,
  type LiveInput,
  LiveToViewer,
  type ServerPush,
} from "@baize/shared";
import type { Stack } from "./stack.js";

/**
 * 登记一台远程电脑，进程内起它的电脑代理，等它在线并且收下了第一份 config。
 * 控制面只给 config 已经发出的连接派活，在这之前发消息会落成「电脑不在线」。
 */
export async function startRemoteComputer(
  stack: Stack,
  options: { readonly makeChrome: NonNullable<AgentOptions["makeChrome"]>; readonly log?: (line: string) => void },
): Promise<{ readonly computerId: ComputerId; readonly agent: AgentHandle }> {
  const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
  let configured = 0;
  const agent = startAgent({
    url: `ws://127.0.0.1:${stack.port}/agent`,
    computerId: remote.computerId,
    token: remote.token,
    version: "remote-e2e",
    dataDir: stack.dataDir,
    ...(options.log === undefined ? {} : { log: options.log }),
    makeChrome: options.makeChrome,
    makeRunner: (config) => {
      configured += 1;
      return createRunner(config);
    },
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { computers } = ComputerListResponse.parse(await stack.get("/api/computers"));
    if (configured > 0 && computers.find((computer) => computer.id === remote.computerId)?.status === "online") {
      return { computerId: remote.computerId, agent };
    }
    if (Date.now() > deadline) {
      await agent.stop();
      throw new Error("远程电脑 30 秒内没上线");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function pushUntil<T>(stack: Stack, pick: (push: ServerPush) => T | undefined): Promise<T> {
  for (;;) {
    const found = pick(await stack.nextPush());
    if (found !== undefined) return found;
  }
}

/** 看画面的人自己的登录 cookie。/api/live 只认 cookie，不认测试栈手里那份。 */
export async function cookieFor(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
  });
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (!response.ok || cookie === undefined) throw new Error(`看画面的人登录失败 ${response.status}`);
  return cookie;
}

const bytesOf = (data: RawData): Uint8Array =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;

export async function watchLive(port: number, cookie: string, liveId: LiveId) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live/${liveId}`, { headers: { cookie } });
  const frames: Uint8Array[] = [];
  socket.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const decoded = decodeLive(LiveToViewer, bytesOf(data));
    if (decoded?.header.t === "frame") frames.push(Uint8Array.from(decoded.payload));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    frames: () => frames,
    input: (input: LiveInput) => socket.send(encodeLive({ t: "input", input })),
    end: (action: LiveUserEnd) => socket.send(encodeLive({ t: "end", action })),
    close: () => socket.close(),
  };
}
