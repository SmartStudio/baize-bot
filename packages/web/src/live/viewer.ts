import {
  LiveToViewer,
  LiveViewerClose,
  decodeLive,
  encodeLive,
  type LiveFromViewer,
  type LiveId,
  type LiveSession,
} from "@baize/shared";

export type LiveCloseReason = "gone" | "replaced" | "not_found" | "network";

export interface LiveSink {
  session(session: LiveSession): void;
  frame(jpeg: Blob): void;
  // 终端输出的原始字节，按到达顺序原样交给 xterm。replay 是每次连上补发的整份回滚缓冲，空的也来。
  term(bytes: Uint8Array, replay: boolean): void;
  closed(why: LiveCloseReason): void;
}

// 只为发一句结束临时连的那条，收到什么都不管。
export const IGNORE: LiveSink = {
  session: () => undefined,
  frame: () => undefined,
  term: () => undefined,
  closed: () => undefined,
};

export interface LiveViewer {
  send(message: LiveFromViewer): void;
  close(): void;
}

const reasonOf = (code: number): LiveCloseReason =>
  code === LiveViewerClose.gone
    ? "gone"
    : code === LiveViewerClose.replaced
      ? "replaced"
      : code === LiveViewerClose.notFound
        ? "not_found"
        : "network";

// 一条 socket 看一个画面，cookie 认人。帧解不开就丢，不报原文：上行帧里可能是用户打的字，下行帧也照同一规矩。
export const openLiveViewer = (liveId: LiveId, sink: LiveSink): LiveViewer => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${window.location.host}/api/live/${liveId}`);
  socket.binaryType = "arraybuffer";
  // 连上之前点的「不登了」、打的字先攒着，连上一并发出去，不能因为手快就丢。
  const queued: Uint8Array[] = [];
  let closed = false;

  socket.addEventListener("open", () => {
    for (const bytes of queued.splice(0)) socket.send(bytes);
    if (closed) socket.close(1000);
  });
  socket.addEventListener("message", (event) => {
    if (closed || !(event.data instanceof ArrayBuffer)) return;
    const decoded = decodeLive(LiveToViewer, new Uint8Array(event.data));
    if (decoded === null) return;
    if (decoded.header.t === "session") sink.session(decoded.header.session);
    else if (decoded.header.t === "term") sink.term(decoded.payload.slice(), decoded.header.replay === true);
    else sink.frame(new Blob([decoded.payload.slice()], { type: "image/jpeg" }));
  });
  socket.addEventListener("close", (event) => {
    if (closed) return;
    closed = true;
    sink.closed(reasonOf(event.code));
  });

  return {
    send(message) {
      if (closed) return;
      const bytes = encodeLive(message);
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
      else if (socket.readyState === WebSocket.CONNECTING) queued.push(bytes);
    },
    // 关了就不再回调。还没连上又攒着话的，等连上发完再关：「不登了」点得比握手快也要送到。
    close() {
      if (closed) return;
      closed = true;
      if (socket.readyState === WebSocket.CONNECTING && queued.length > 0) return;
      socket.close(1000);
    },
  };
};
