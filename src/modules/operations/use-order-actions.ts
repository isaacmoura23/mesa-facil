"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { useToast } from "@/components/ui/toast";
import { parseActionError } from "./errors";
import { fetchTransitions } from "./queries";
import type { OrdersFeed } from "./use-orders-feed";
import type {
  OperationsOrder,
  OperationsPermissions,
  OrderStatus,
  OrderTransition,
} from "./types";

export type OrderActionKind = "advance" | "reject" | "cancel";

export type OrderAction = {
  to: OrderStatus;
  kind: OrderActionKind;
  label: string;
  /** Pede motivo obrigatório (modal). */
  needsReason: boolean;
};

const ADVANCE_LABELS: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: "Aceitar",
  PREPARING: "Iniciar preparo",
  READY: "Marcar pronto",
  OUT_FOR_DELIVERY: "Saiu para entrega",
  COMPLETED: "Concluir",
};

function labelFor(order: OperationsOrder, to: OrderStatus): string {
  if (to === "COMPLETED") {
    if (order.fulfillment_type === "DELIVERY") return "Entregue";
    if (order.fulfillment_type === "PICKUP") return "Retirado";
    return "Servido";
  }
  return ADVANCE_LABELS[to] ?? to;
}

function permissionGranted(permission: string, granted: OperationsPermissions): boolean {
  switch (permission) {
    case "orders.accept":
      return granted.accept;
    case "orders.reject":
      return granted.reject;
    case "orders.update_status":
      return granted.updateStatus;
    case "orders.cancel":
      return granted.cancel;
    default:
      return false;
  }
}

const rpcResultSchema = z
  .object({ ok: z.boolean().optional(), code: z.string().optional(), error: z.string().optional() })
  .passthrough();

type ActionsOptions = {
  feed: Pick<OrdersFeed, "applyOptimistic" | "syncOrder">;
  permissions: OperationsPermissions;
  /** Chamado após aceitar/recusar/avançar com sucesso (ex.: marcar como visto). */
  onHandled?: (order: OperationsOrder) => void;
};

export function useOrderActions({ feed, permissions, onHandled }: ActionsOptions) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const { toast } = useToast();
  const [transitions, setTransitions] = useState<OrderTransition[] | null>(null);
  const [transitionsError, setTransitionsError] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    fetchTransitions(supabase)
      .then((rows) => {
        if (!cancelled) setTransitions(rows);
      })
      .catch(() => {
        if (!cancelled) setTransitionsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  /** Próximos estados válidos (tabela do banco) filtrados pelas permissões do usuário. */
  const actionsFor = useCallback(
    (order: OperationsOrder): OrderAction[] => {
      if (!transitions) return [];
      const result: OrderAction[] = [];
      for (const row of transitions) {
        if (row.fulfillment_type !== order.fulfillment_type) continue;
        if (row.from_status !== order.status) continue;
        if (!permissionGranted(row.required_permission, permissions)) continue;
        const kind: OrderActionKind =
          row.to_status === "REJECTED" ? "reject" : row.to_status === "CANCELLED" ? "cancel" : "advance";
        result.push({
          to: row.to_status,
          kind,
          label:
            kind === "reject" ? "Recusar" : kind === "cancel" ? "Cancelar pedido" : labelFor(order, row.to_status),
          needsReason: kind !== "advance",
        });
      }
      // Avanço primeiro, depois recusar, depois cancelar.
      const rank: Record<OrderActionKind, number> = { advance: 0, reject: 1, cancel: 2 };
      return result.sort((a, b) => rank[a.kind] - rank[b.kind]);
    },
    [transitions, permissions],
  );

  const run = useCallback(
    async (order: OperationsOrder, action: OrderAction, reason?: string): Promise<boolean> => {
      if (pendingRef.current.has(order.id)) return false; // clique duplo
      const trimmed = reason?.trim() ?? "";
      if (action.needsReason && trimmed.length === 0) {
        toast({ title: "Informe o motivo", description: "O motivo é obrigatório.", tone: "danger" });
        return false;
      }

      pendingRef.current.add(order.id);
      setPending(new Set(pendingRef.current));
      const rollback = feed.applyOptimistic(order.id, {
        status: action.to,
        status_reason: action.needsReason ? trimmed : null,
      });

      try {
        const { data, error } = await supabase.rpc("transition_order_status", {
          p_order: order.id,
          p_to: action.to,
          p_reason: action.needsReason ? trimmed : null,
        });
        const parsed = rpcResultSchema.safeParse(data);
        const rejectedByRpc = parsed.success && parsed.data.ok === false;
        if (error || rejectedByRpc) {
          rollback();
          const failure = parseActionError(
            error ?? { message: parsed.success ? (parsed.data.code ?? parsed.data.error) : undefined },
          );
          toast({ title: "Ação não concluída", description: failure.message, tone: "danger" });
          if (failure.stale) void feed.syncOrder(order.id);
          return false;
        }
        onHandled?.(order);
        void feed.syncOrder(order.id);
        return true;
      } catch {
        rollback();
        toast({
          title: "Sem conexão",
          description: "Não foi possível falar com o servidor. Tente novamente.",
          tone: "danger",
        });
        return false;
      } finally {
        pendingRef.current.delete(order.id);
        setPending(new Set(pendingRef.current));
      }
    },
    [supabase, feed, toast, onHandled],
  );

  return { actionsFor, run, pending, ready: transitions !== null, transitionsError };
}
