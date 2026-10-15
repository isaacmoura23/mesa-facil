"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ToastTone = "info" | "success" | "danger";

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Tempo na tela em ms. Padrão: 6000. */
  duration?: number;
};

type ToastItem = Required<Pick<ToastInput, "title" | "tone">> &
  Pick<ToastInput, "description"> & { id: number };

type ToastContextValue = { toast: (input: ToastInput) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const toneStyles: Record<ToastTone, string> = {
  info: "border-line bg-surface text-fg",
  success: "border-transparent bg-accent-soft text-accent-soft-fg",
  danger: "border-transparent bg-danger-soft text-danger-soft-fg",
};

/** Feedback transitório. Para erros de formulário use <Alert> inline. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({ title, description, tone = "info", duration = 6000 }: ToastInput) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { id, title, description, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-control border px-4 py-3 text-sm shadow-pop animate-[toast-in_180ms_ease-out]",
              toneStyles[item.tone],
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 leading-relaxed opacity-90">{item.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="-m-1 rounded-control p-1 hover:bg-fg/10"
              aria-label="Fechar aviso"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast precisa estar dentro de <ToastProvider>.");
  return context;
}
