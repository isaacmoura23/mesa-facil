"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { useToast } from "@/components/ui/toast";
import { parseTabsError, type TabsError } from "./errors";
import type { StaffCartItemPayload } from "./types";

const rpcResultSchema = z
  .object({ ok: z.boolean().optional(), code: z.string().optional(), error: z.string().optional() })
  .passthrough();

export type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: TabsError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extrai o id da comanda do retorno de `open_tab` (aceita `{id}` ou `{tab:{id}}`). */
export function tabIdFrom(data: unknown): string | null {
  const raw: unknown = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const direct = record.id ?? record.tab_id;
  if (typeof direct === "string" && UUID.test(direct)) return direct;
  const nested = record.tab;
  if (nested && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === "string" && UUID.test(id)) return id;
  }
  return null;
}

type RpcCall = () => PromiseLike<{
  data: unknown;
  error: { message?: string; code?: string } | null;
}>;

/**
 * Ações de mesas/comandas. Cada chave (mesa, comanda, "balcão") só roda uma
 * vez por vez: o segundo clique durante a chamada é ignorado (idempotência de
 * UI). A autoridade é sempre o banco; o erro vem em PT-BR por prefixo de código.
 */
export function useTabActions({ onStale }: { onStale?: () => void } = {}) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const { toast } = useToast();
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const guarded = useCallback(
    async <T,>(key: string, call: RpcCall, silent = false): Promise<ActionResult<T> | null> => {
      if (pendingRef.current.has(key)) return null; // clique duplo
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      try {
        const { data, error } = await call();
        const parsed = rpcResultSchema.safeParse(data);
        const rejected = parsed.success && parsed.data.ok === false;
        if (error || rejected) {
          const failure = parseTabsError(
            error ?? { message: parsed.success ? (parsed.data.code ?? parsed.data.error) : undefined },
          );
          if (!silent) toast({ title: "Ação não concluída", description: failure.message, tone: "danger" });
          if (failure.stale) onStale?.();
          return { ok: false, error: failure };
        }
        return { ok: true, data: data as T };
      } catch {
        const failure: TabsError = {
          code: "NETWORK",
          message: "Não foi possível falar com o servidor. Tente novamente.",
          stale: false,
        };
        if (!silent) toast({ title: "Sem conexão", description: failure.message, tone: "danger" });
        return { ok: false, error: failure };
      } finally {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    },
    [toast, onStale],
  );

  const openTab = useCallback(
    (input: { restaurantId: string; tableId: string | null; label: string | null; guests: number | null }) =>
      guarded<unknown>(input.tableId ? `table:${input.tableId}` : "counter", () =>
        supabase.rpc("open_tab", {
          p_restaurant: input.restaurantId,
          p_table_id: input.tableId,
          p_label: input.label,
          p_guests: input.guests,
        }),
      ),
    [guarded, supabase],
  );

  const releaseTable = useCallback(
    async (tableId: string) => {
      const result = await guarded<unknown>(`table:${tableId}`, () =>
        supabase.rpc("set_table_status", { p_table: tableId, p_to: "AVAILABLE" }),
      );
      if (result?.ok) toast({ title: "Mesa liberada", tone: "success", duration: 2500 });
      return result;
    },
    [guarded, supabase, toast],
  );

  const createStaffOrder = useCallback(
    (tabId: string, items: StaffCartItemPayload[], notes: string | null, idempotencyKey: string) =>
      guarded<unknown>(`order:${tabId}`, () =>
        supabase.rpc("create_staff_order", {
          p_tab: tabId,
          p_items: items,
          p_notes: notes,
          p_idempotency_key: idempotencyKey,
        }),
      ),
    [guarded, supabase],
  );

  return { openTab, releaseTable, createStaffOrder, pending };
}
