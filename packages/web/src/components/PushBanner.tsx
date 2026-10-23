import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import type { PushLink } from "../state/types.js";

// 掐断后第一次重连在 1 秒后，顺利的话这之内就连回来了，不值得打扰人。
const GRACE_MS = 2_000;

// 播报区域一直挂着，读屏要先认识这块区域，后来塞进去的字才会念。
export const PushBanner = ({ link }: { link: PushLink }) => {
  const [lagging, setLagging] = useState(false);
  useEffect(() => {
    if (link === "open") return;
    const timer = setTimeout(() => setLagging(true), GRACE_MS);
    return () => {
      clearTimeout(timer);
      setLagging(false);
    };
  }, [link]);

  return (
    <div className="push-status" aria-live="polite">
      {lagging ? (
        <div className="push-banner" data-testid="push-banner">
          <WifiOff size={14} aria-hidden="true" />
          <span>连不上服务，正在重试。连上后会补上这段时间的消息</span>
        </div>
      ) : null}
    </div>
  );
};
