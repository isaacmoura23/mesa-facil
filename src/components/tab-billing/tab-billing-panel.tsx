"use client";

import { useCallback, useState } from "react";
import { RotateCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/modules/operations/format";
import { useTabBalance } from "@/modules/tab-billing/use-tab-balance";
import type { TabBalance } from "@/modules/tab-billing/types";
import { BalanceSummary } from "./balance-summary";
import { CloseTabSection } from "./close-tab-section";
import { PaymentForm } from "./payment-form";
import { PaymentList } from "./payment-list";
import { PrintBillActions } from "./print-bill-actions";

export type TabBillingPanelProps = {
  restaurantId: string;
  tabId: string;
  /** Permissões do usuário no restaurante. Só orientam a tela; o banco valida cada ação. */
  permissions: string[];
  /** Chamado após cada ação que mudou a comanda (pagamento, fechamento, cancelamento). */
  onChanged?: () => void;
};

/**
 * O aviso do último pagamento (com o troco!) sobrevive a remontagens do painel
 * (quem hospeda pode remontá-lo ao reler a comanda). Vale por 2 minutos.
 */
const NOTICE_TTL_MS = 120_000;
const lastNotices = new Map<string, { text: string; at: number }>();

function recallNotice(tabId: string): string | null {
  const stored = lastNotices.get(tabId);
  return stored && Date.now() - stored.at < NOTICE_TTL_MS ? stored.text : null;
}

const STATUS_NOTE: Record<string, string> = {
  CLOSED: "Comanda fechada. Não é possível registrar novos pagamentos.",
  CANCELLED: "Comanda cancelada.",
};

function placeLabel(balance: TabBalance): string {
  const { tab } = balance;
  return [tab.table_label ?? tab.table_name, tab.label].filter(Boolean).join(" / ") || "comanda";
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Carregando saldo da comanda">
      <div className="grid grid-cols-3 gap-4">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
      <Skeleton className="h-24" />
      <Skeleton className="h-10 w-40" />
    </div>
  );
}

/**
 * Saldo, pagamentos manuais, impressão da conta e fechamento/cancelamento da
 * comanda. Mostra só o que a pessoa pode fazer e explica o que está bloqueado;
 * a autoridade é sempre o banco (RPCs validam permissão e estado).
 */
export function TabBillingPanel({ restaurantId, tabId, permissions, onChanged }: TabBillingPanelProps) {
  const { supabase, state, reload } = useTabBalance(restaurantId, tabId);
  const [notice, setNoticeState] = useState<string | null>(() => recallNotice(tabId));
  const setNotice = useCallback(
    (text: string | null) => {
      setNoticeState(text);
      if (text) lastNotices.set(tabId, { text, at: Date.now() });
      else lastNotices.delete(tabId);
    },
    [tabId],
  );

  const can = useCallback((permission: string) => permissions.includes(permission), [permissions]);

  /** Relê o saldo do banco e só então avisa quem hospeda o painel. */
  const refreshAndNotify = useCallback(
    async (message?: string) => {
      if (message !== undefined) setNotice(message);
      await reload();
      onChanged?.();
    },
    [reload, onChanged, setNotice],
  );

  const staleReload = useCallback(async () => {
    await reload();
    onChanged?.();
  }, [reload, onChanged]);

  if (state.status === "loading") return <PanelSkeleton />;

  const balance = state.balance;
  if (!balance) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert tone="danger">{state.status === "error" ? state.message : "Não foi possível ler a comanda."}</Alert>
        <Button variant="secondary" onClick={() => void reload()}>
          <RotateCw aria-hidden="true" className="size-4" />
          Tentar de novo
        </Button>
      </div>
    );
  }

  const status = balance.tab.status;
  const isOpen = status === "OPEN";
  const canRecord = can("payments.record");
  const remaining = balance.remaining_cents;
  const hasOpenOrders = balance.orders.some((order) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(order.status));

  let paymentBlocked: string | null = null;
  if (!isOpen) paymentBlocked = STATUS_NOTE[status] ?? "Esta comanda não está aberta.";
  else if (!canRecord) paymentBlocked = "Você não tem permissão para registrar pagamentos. Peça a quem estiver no caixa.";
  else if (remaining <= 0) {
    paymentBlocked =
      balance.consumed_cents > 0
        ? "Nada a receber: a conta está quitada."
        : hasOpenOrders
          ? "Ainda não há valor consumido para receber."
          : "Ainda não há consumo nesta comanda.";
  }

  return (
    <div className="flex flex-col gap-6">
      {state.status === "error" ? (
        <Alert tone="warning">
          Não foi possível atualizar o saldo agora. Os valores abaixo podem estar desatualizados.{" "}
          <button type="button" onClick={() => void reload()} className="font-semibold underline underline-offset-2">
            Atualizar
          </button>
        </Alert>
      ) : null}

      <BalanceSummary balance={balance} />

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
      </div>

      <PaymentList payments={balance.payments} />

      <section aria-labelledby="tb-record-title" className="flex flex-col gap-3 border-t border-line pt-5">
        <h3 id="tb-record-title" className="text-sm font-semibold">
          Registrar pagamento
        </h3>
        {paymentBlocked ? (
          <p className="text-sm text-muted">{paymentBlocked}</p>
        ) : (
          <PaymentForm
            supabase={supabase}
            tabId={tabId}
            remainingCents={remaining}
            onStale={staleReload}
            onRecorded={refreshAndNotify}
            onAttempt={() => setNotice(null)}
          />
        )}
      </section>

      <div className="border-t border-line pt-5">
        <PrintBillActions
          tabId={tabId}
          placeLabel={placeLabel(balance)}
          canPrint={can("print.request")}
          tabStatus={status}
        />
      </div>

      {isOpen ? (
        <div className="border-t border-line pt-5">
          <CloseTabSection
            supabase={supabase}
            balance={balance}
            canManage={can("tabs.manage")}
            canRecord={canRecord}
            onChanged={refreshAndNotify}
          />
        </div>
      ) : (
        <p className="border-t border-line pt-5 text-sm text-muted">
          {STATUS_NOTE[status] ?? `Comanda ${status}.`}
          {status === "CLOSED" && balance.tab.unpaid_cents ? ` Fechada com ${formatMoney(balance.tab.unpaid_cents)} em aberto.` : ""}
        </p>
      )}
    </div>
  );
}
