import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { PUSH_GRACE_MS } from "../state/reconnect.js";
import type { PushLink } from "../state/types.js";

// 播报区域一直挂着，读屏要先认识这块区域，后来塞进去的字才会念。
export const PushBanner = ({ link }: { link: PushLink }) => {
  const [lagging, setLagging] = useState(false);
  useEffect(() => {
    if (link === "open") return;
    const timer = setTimeout(() => setLagging(true), PUSH_GRACE_MS);
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
