"use client";

import { TabBillingPanel } from "@/components/tab-billing/tab-billing-panel";
import type { TablesPermissions } from "@/modules/tables/types";

export type TabBillingSlotProps = {
  restaurantId: string;
  tabId: string;
  permissions: TablesPermissions;
  /** Chamado após registrar pagamento/fechar/cancelar para reler a comanda. */
  onChanged: () => void;
};

/** Integração com o `TabBillingPanel` (OPS-C2): saldo, pagamentos, conta e fechamento. */
export function TabBillingSlot({ restaurantId, tabId, permissions, onChanged }: TabBillingSlotProps) {
  return (
    <section aria-labelledby="tab-billing-title" className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
      <h2 id="tab-billing-title" className="mb-4 text-lg font-semibold text-fg">
        Conta e pagamento
      </h2>
      <TabBillingPanel
        restaurantId={restaurantId}
        tabId={tabId}
        permissions={permissions.granted}
        onChanged={onChanged}
      />
    </section>
  );
}
