"use client";

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import type { Cursor, PageResult, SubscriptionStatus, TicketStatus } from "@/modules/platform-admin/types";

export const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  trial: "Em teste",
  active: "Ativa",
  past_due: "Em atraso",
  cancelled: "Cancelada",
};

const SUBSCRIPTION_TONES: Record<SubscriptionStatus, BadgeTone> = {
  trial: "info",
  active: "accent",
  past_due: "warning",
  cancelled: "neutral",
};

export function SubscriptionBadge({ status }: { status: SubscriptionStatus | null }) {
  if (!status) return <Badge>Sem assinatura</Badge>;
  return <Badge tone={SUBSCRIPTION_TONES[status]}>{SUBSCRIPTION_LABELS[status]}</Badge>;
}

export const TICKET_LABELS: Record<TicketStatus, string> = {
  open: "Aberto",
  in_progress: "Em andamento",
  resolved: "Resolvido",
  closed: "Fechado",
};

const TICKET_TONES: Record<TicketStatus, BadgeTone> = {
  open: "warning",
  in_progress: "info",
  resolved: "accent",
  closed: "neutral",
};

export function TicketBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge>;
}

/** Texto de apoio quando o papel não permite escrever (o banco decide de fato). */
export function ReadOnlyNotice({ children }: { children?: ReactNode }) {
  return (
    <Alert tone="info" title="Modo somente leitura">
      {children ?? "Seu papel (suporte) não permite alterar a plataforma. Apenas superadministradores gravam alterações."}
    </Alert>
  );
}

export type PagedList<T> = {
  rows: T[];
  setRows: (rows: T[]) => void;
  cursor: Cursor | null;
  error: string | null;
  loading: "reload" | "more" | null;
  reload: (loader: (cursor: Cursor | null) => Promise<PageResult<T>>) => Promise<void>;
  more: (loader: (cursor: Cursor | null) => Promise<PageResult<T>>) => Promise<void>;
};

/** Lista paginada por cursor keyset, com descarte de respostas atrasadas. */
export function usePagedList<T>(initialRows: T[], initialCursor: Cursor | null, initialError: string | null): PagedList<T> {
  const [rows, setRows] = useState<T[]>(initialRows);
  const [cursor, setCursor] = useState<Cursor | null>(initialCursor);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState<"reload" | "more" | null>(null);
  const requestId = useRef(0);
  const cursorRef = useRef<Cursor | null>(initialCursor);

  const run = useCallback(async (mode: "reload" | "more", loader: (cursor: Cursor | null) => Promise<PageResult<T>>) => {
    const id = ++requestId.current;
    setLoading(mode);
    setError(null);
    let result: PageResult<T>;
    try {
      result = await loader(mode === "more" ? cursorRef.current : null);
    } catch {
      result = { ok: false, message: "Não foi possível carregar os dados agora. Tente novamente em instantes." };
    }
    if (id !== requestId.current) return;
    setLoading(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRows((current) => (mode === "more" ? [...current, ...result.rows] : result.rows));
    cursorRef.current = result.nextCursor;
    setCursor(result.nextCursor);
  }, []);

  const reload = useCallback((loader: (cursor: Cursor | null) => Promise<PageResult<T>>) => run("reload", loader), [run]);
  const more = useCallback((loader: (cursor: Cursor | null) => Promise<PageResult<T>>) => run("more", loader), [run]);

  return { rows, setRows, cursor, error, loading, reload, more };
}

export function LoadMore({
  hasMore,
  loading,
  onClick,
  empty,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  empty: boolean;
}) {
  if (hasMore) {
    return (
      <div className="flex justify-center">
        <Button variant="secondary" onClick={onClick} loading={loading}>
          Carregar mais
        </Button>
      </div>
    );
  }
  return empty ? null : <p className="text-center text-sm text-muted">Fim da lista.</p>;
}
