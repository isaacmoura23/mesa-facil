"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { formatDuration, formatTime } from "@/modules/tables-admin/format";

const TICK_MS = 30_000;

function subscribe(onChange: () => void): () => void {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/** Relógio que só existe no navegador (no servidor devolve 0: sem divergência de hidratação). */
function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / TICK_MS) * TICK_MS,
    () => 0,
  );
}

/** "Aberta há 12 min" (antes da hidratação: "Aberta às 14:32"). */
export function OpenSince({ since }: { since: string }) {
  const now = useNow();
  return (
    <time dateTime={since}>
      {now === 0 ? `Aberta às ${formatTime(since)}` : `Aberta há ${formatDuration(since, now)}`}
    </time>
  );
}

/**
 * Atualiza os dados da página ao voltar o foco para a aba (tempo real não é
 * obrigatório na gestão). No máximo uma atualização a cada 15 s.
 */
export function RefreshOnFocus() {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < 15_000) return;
      last = Date.now();
      router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  return null;
}
