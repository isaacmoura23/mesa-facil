"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

const MIN_GAP_MS = 15_000;
const INTERVAL_MS = 60_000;

/**
 * Relê os dados do servidor ao voltar o foco para a aba e a cada 60 s enquanto
 * a aba estiver visível (sem Realtime: na gestão basta reler). Mostra o horário
 * da última leitura e permite atualizar na hora.
 */
export function AutoRefresh({ generatedAt, timeLabel }: { generatedAt: string; timeLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const last = useRef(0);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    last.current = Date.now();
    const refresh = (force: boolean) => {
      if (document.visibilityState !== "visible") return;
      if (!force && Date.now() - last.current < MIN_GAP_MS) return;
      last.current = Date.now();
      startTransition(() => router.refresh());
    };
    const onFocus = () => refresh(false);
    const timer = setInterval(() => refresh(true), INTERVAL_MS);
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [router]);

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>
        Atualizado às <time dateTime={generatedAt}>{timeLabel}</time>
        {online ? "" : " (sem conexão)"}
      </span>
      <button
        type="button"
        onClick={() => {
          last.current = Date.now();
          startTransition(() => router.refresh());
        }}
        disabled={pending}
        className="inline-flex h-7 items-center gap-1.5 rounded-control px-2 font-medium text-fg hover:bg-surface-2 disabled:opacity-60"
      >
        <RefreshCw aria-hidden="true" className={pending ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"} />
        Atualizar
      </button>
    </div>
  );
}
