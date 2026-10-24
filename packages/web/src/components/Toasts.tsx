import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { RequestFailed } from "../api/client.js";

const TOAST_MS = 5_000;
const MAX_TOASTS = 3;

type Toast = { id: number; text: string };

const ToastContext = createContext<(text: string) => void>(() => undefined);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastId = useRef(0);
  const show = useCallback((text: string) => {
    lastId.current += 1;
    const id = lastId.current;
    setToasts((list) => [...list.filter((toast) => toast.text !== text), { id, text }].slice(-MAX_TOASTS));
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), TOAST_MS);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <p key={toast.id} className="toast" role="alert" data-testid="toast">
            {toast.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useFailureToast = () => {
  const show = useContext(ToastContext);
  return useCallback(
    (fallback: string) => (cause: unknown) => {
      console.warn(fallback, cause);
      show(cause instanceof RequestFailed ? cause.message : fallback);
    },
    [show],
  );
};
