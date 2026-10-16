"use client";

import { useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/modules/operations/format";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { BillingActionError } from "@/modules/tab-billing/errors";
import { cancelTab, closeTab } from "@/modules/tab-billing/rpc";
import {
  TERMINAL_ORDER_STATUSES,
  UNPAID_REASON_MAX,
  UNPAID_REASON_MIN,
  type TabBalance,
} from "@/modules/tab-billing/types";
import { ReasonDialog } from "./reason-dialog";

type CloseTabSectionProps = {
  supabase: AppSupabaseClient;
  balance: TabBalance;
  canManage: boolean;
  canRecord: boolean;
  /** Relê o saldo e avisa o chamador. */
  onChanged: (notice?: string) => Promise<void>;
};

type Dialog = "close" | "close-unpaid" | "cancel" | null;

function errorText(cause: unknown): { message: string; stale: boolean } {
  if (cause instanceof BillingActionError) return { message: cause.message, stale: cause.stale };
  return { message: "Não foi possível concluir a ação. Verifique a conexão e tente novamente.", stale: false };
}

function Reason({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="text-xs leading-relaxed text-muted">
      {children}
    </p>
  );
}

/** Fechar (com ou sem saldo) e cancelar comanda vazia. Cada ação desabilitada diz o motivo; o banco decide de verdade. */
export function CloseTabSection({ supabase, balance, canManage, canRecord, onChanged }: CloseTabSectionProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openOrders = balance.orders.filter((order) => !TERMINAL_ORDER_STATUSES.includes(order.status)).length;
  const remaining = balance.remaining_cents;
  const hasPayments = balance.payments.some((payment) => payment.status == null || payment.status === "PAID");
  const isEmpty = openOrders === 0 && !hasPayments && balance.consumed_cents === 0;
  const canCloseWithBalance = canManage && canRecord;

  let closeBlocked: string | null = null;
  if (!canManage) closeBlocked = "Você não tem permissão para fechar comandas.";
  else if (openOrders > 0) {
    closeBlocked = `Há ${openOrders} ${openOrders === 1 ? "pedido em andamento" : "pedidos em andamento"}. Conclua ou cancele antes de fechar.`;
  } else if (remaining > 0) {
    closeBlocked = `Ainda há ${formatMoney(remaining)} a receber. Registre o pagamento para fechar.`;
  }

  async function run(action: () => Promise<void>, notice: string): Promise<string | null> {
    setPending(true);
    setError(null);
    try {
      await action();
      setDialog(null);
      await onChanged(notice);
      return null;
    } catch (cause) {
      const info = errorText(cause);
      if (info.stale) await onChanged();
      return info.message;
    } finally {
      setPending(false);
    }
  }

  async function confirmClose() {
    const failure = await run(() => closeTab(supabase, balance.tab.id, null), "Comanda fechada.");
    if (failure) {
      setDialog(null);
      setError(failure);
    }
  }

  const closeReasonId = "tb-close-reason";
  const unpaidReasonId = "tb-unpaid-reason";

  return (
    <section aria-labelledby="tb-close-title" className="flex flex-col gap-3">
      <h3 id="tb-close-title" className="text-sm font-semibold">
        Encerrar comanda
      </h3>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => setDialog("close")}
            disabled={closeBlocked !== null || pending}
            aria-describedby={closeBlocked ? closeReasonId : undefined}
          >
            <Lock aria-hidden="true" className="size-4" />
            Fechar comanda
          </Button>
          {remaining > 0 && openOrders === 0 && canCloseWithBalance ? (
            <Button variant="secondary" onClick={() => setDialog("close-unpaid")} disabled={pending}>
              Fechar com saldo em aberto
            </Button>
          ) : null}
        </div>
        {closeBlocked ? <Reason id={closeReasonId}>{closeBlocked}</Reason> : null}
        {remaining > 0 && openOrders === 0 && canManage && !canRecord ? (
          <Reason id={unpaidReasonId}>
            Fechar com saldo em aberto exige também a permissão de registrar pagamentos.
          </Reason>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div>
            <Button
              variant="secondary"
              onClick={() => setDialog("cancel")}
              disabled={!canManage || pending}
              aria-describedby={!canManage ? "tb-cancel-reason" : undefined}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              Cancelar comanda
            </Button>
          </div>
          {!canManage ? (
            <Reason id="tb-cancel-reason">Você não tem permissão para cancelar comandas.</Reason>
          ) : (
            <Reason id="tb-cancel-hint">Só vale para comanda sem pedidos nem pagamentos. A mesa volta a ficar livre.</Reason>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === "close"}
        title="Fechar esta comanda?"
        description="A conta está quitada e os pedidos foram concluídos. A mesa passa para limpeza. Depois de fechada, não dá para registrar novos pagamentos."
        confirmLabel="Fechar comanda"
        pending={pending}
        onConfirm={() => void confirmClose()}
        onClose={() => setDialog(null)}
      />

      <ReasonDialog
        open={dialog === "close-unpaid"}
        title="Fechar com saldo em aberto"
        description={
          <>
            <p>
              Restam <strong className="text-fg">{formatMoney(remaining)}</strong> sem pagamento registrado. Fechar assim
              exige uma justificativa, que fica gravada na auditoria com seu nome e o horário.
            </p>
          </>
        }
        label="Justificativa"
        confirmLabel="Fechar mesmo assim"
        tone="danger"
        minLength={UNPAID_REASON_MIN}
        maxLength={UNPAID_REASON_MAX}
        onSubmit={(reason) => run(() => closeTab(supabase, balance.tab.id, reason), "Comanda fechada com saldo em aberto.")}
        onClose={() => setDialog(null)}
      />

      <ReasonDialog
        open={dialog === "cancel"}
        title="Cancelar comanda"
        description="A comanda sai da lista de abertas e a mesa volta a ficar livre. Isso não pode ser desfeito."
        label="Motivo do cancelamento"
        confirmLabel="Cancelar comanda"
        cancelLabel="Manter comanda"
        tone="danger"
        minLength={3}
        onSubmit={(reason) => run(() => cancelTab(supabase, balance.tab.id, reason), "Comanda cancelada.")}
        onClose={() => setDialog(null)}
      />
    </section>
  );
}
