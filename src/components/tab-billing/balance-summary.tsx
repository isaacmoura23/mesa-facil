import { CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/modules/operations/format";
import type { TabBalance } from "@/modules/tab-billing/types";

function Figure({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className={cn("mt-0.5 font-semibold tabular-nums", strong ? "text-2xl sm:text-3xl" : "text-lg")}>
        {formatMoney(cents)}
      </dd>
    </div>
  );
}

/**
 * Consumido, pago e saldo restante (pedidos cancelados/recusados não contam: o
 * cálculo vem do banco em `get_tab_balance`). O saldo é uma região viva para
 * leitores de tela perceberem a mudança após cada pagamento.
 */
export function BalanceSummary({ balance }: { balance: TabBalance }) {
  const settled = balance.remaining_cents === 0;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Figure label="Consumido" cents={balance.consumed_cents} />
        <Figure label="Pago" cents={balance.paid_cents} />
        <div className="col-span-2 border-t border-line pt-3 sm:col-span-1 sm:border-t-0 sm:pt-0">
          <div aria-live="polite" aria-atomic="true">
            <Figure label="Saldo restante" cents={balance.remaining_cents} strong />
          </div>
        </div>
      </dl>
      {settled && balance.consumed_cents > 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm font-medium text-accent-soft-fg">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          Conta quitada
        </p>
      ) : null}
    </div>
  );
}
