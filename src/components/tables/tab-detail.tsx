"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, Plus, ReceiptText, Users } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/modules/operations/format";
import { formatOpenFor, tabTitle } from "@/modules/tables/format";
import {
  TAB_STATUS_LABELS,
  countsTowardTab,
  type StaffCartItemPayload,
  type TablesPermissions,
} from "@/modules/tables/types";
import { useNow } from "@/modules/tables/use-now";
import { useTabActions } from "@/modules/tables/use-tab-actions";
import { useTabDetail } from "@/modules/tables/use-tab-detail";
import { AddItemsDialog } from "./add-items-dialog";
import { LiveStatus } from "./live-status";
import { TabBillingSlot } from "./tab-billing-slot";
import { TabOrdersList } from "./tab-orders-list";

type TabDetailViewProps = {
  slug: string;
  restaurantId: string;
  tabId: string;
  permissions: TablesPermissions;
};

export function TabDetailView({ slug, restaurantId, tabId, permissions }: TabDetailViewProps) {
  const detail = useTabDetail(restaurantId, tabId);
  const { toast } = useToast();
  const now = useNow();
  const [adding, setAdding] = useState(false);

  const refresh = detail.refresh;
  const onStale = useCallback(() => void refresh(), [refresh]);
  const actions = useTabActions({ onStale });
  const { createStaffOrder } = actions;

  const base = `/operacao/${encodeURIComponent(slug)}`;
  const data = detail.data;
  const tab = data?.tab ?? null;

  const sendOrder = useCallback(
    async (items: StaffCartItemPayload[], notes: string | null, idempotencyKey: string) => {
      // Replay idempotente (idempotent_replay) volta como sucesso: o pedido original já existe.
      const result = await createStaffOrder(tabId, items, notes, idempotencyKey);
      if (result?.ok) {
        toast({ title: "Pedido enviado para a cozinha", tone: "success", duration: 3500 });
        setAdding(false);
        void refresh();
      }
      return result;
    },
    [createStaffOrder, tabId, toast, refresh],
  );

  const backLink = (
    <div className="mb-3 flex flex-wrap items-center gap-x-4">
      <Link
        href={`${base}/comandas`}
        className="-ml-2 inline-flex h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Comandas
      </Link>
    </div>
  );

  if (detail.loading && !data) {
    return (
      <div>
        {backLink}
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-24 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        {backLink}
        <Alert tone="danger" title="Não foi possível carregar a comanda">
          <div className="flex flex-wrap items-center gap-3">
            <span>{detail.error ?? "Erro inesperado."}</span>
            <Button size="sm" variant="secondary" onClick={() => void detail.refresh()}>
              Tentar de novo
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  if (!tab) {
    return (
      <div>
        {backLink}
        <EmptyState
          icon={<ReceiptText />}
          title="Comanda não encontrada"
          description="Ela pode ter sido removida ou você não tem acesso a ela."
          action={
            <Link href={`${base}/comandas`} className={buttonStyles({ size: "lg" })}>
              Ver comandas
            </Link>
          }
        />
      </div>
    );
  }

  // O painel de cobrança busca o próprio saldo: remonta quando o consumo muda.
  const billingSignature = data.orders
    .filter((o) => countsTowardTab(o.status))
    .map((o) => `${o.id}:${o.total_cents}`)
    .join(",");
  const isOpen = tab.status === "OPEN";
  const title = tabTitle(tab, data.tableName);
  const canAddItems = isOpen && permissions.manageTabs && permissions.createOrders;

  return (
    <div className="pb-24 lg:pb-0">
      {backLink}

      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{title}</h1>
            <Badge tone={isOpen ? "accent" : tab.status === "CANCELLED" ? "danger" : "neutral"}>
              {TAB_STATUS_LABELS[tab.status]}
            </Badge>
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock aria-hidden="true" className="size-4" />
              {isOpen
                ? `Aberta há ${formatOpenFor(tab.opened_at, now)}`
                : `Aberta em ${formatDateTime(tab.opened_at)}`}
            </span>
            {tab.guests ? (
              <span className="inline-flex items-center gap-1.5">
                <Users aria-hidden="true" className="size-4" />
                {tab.guests} {tab.guests === 1 ? "pessoa" : "pessoas"}
              </span>
            ) : null}
            {tab.table_id && tab.label?.trim() ? <span>{tab.label.trim()}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveStatus
            state={detail.connection}
            syncing={detail.loading}
            onRefresh={() => void detail.refresh()}
            refreshLabel="Atualizar comanda agora"
          />
          {canAddItems ? (
            <Button size="lg" className="hidden lg:inline-flex" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" className="size-4" />
              Adicionar itens
            </Button>
          ) : null}
        </div>
      </header>

      {detail.error ? (
        <Alert tone="warning" className="mb-4" title="Dados podem estar desatualizados">
          Não foi possível atualizar agora. Mostrando a última leitura.
        </Alert>
      ) : null}

      {!isOpen ? (
        <Alert tone={tab.status === "CANCELLED" ? "danger" : "info"} className="mb-4" title={`Comanda ${TAB_STATUS_LABELS[tab.status].toLowerCase()}`}>
          {tab.status === "CANCELLED" && tab.status_reason
            ? `Motivo: ${tab.status_reason}`
            : tab.closed_at
              ? `Encerrada em ${formatDateTime(tab.closed_at)}. Não é possível lançar novos itens.`
              : "Não é possível lançar novos itens."}
        </Alert>
      ) : null}

      <section aria-label="Pedidos da comanda" className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-fg">Pedidos</h2>
        {permissions.viewOrders ? (
          <TabOrdersList orders={data.orders} />
        ) : (
          <Alert tone="info">Seu papel não pode ver os pedidos desta comanda. O saldo continua disponível abaixo.</Alert>
        )}
      </section>

      <div className="">
        <TabBillingSlot
          key={`${tab.status}|${tab.updated_at}|${billingSignature}`}
          restaurantId={restaurantId} tabId={tabId} permissions={permissions} onChanged={() => void refresh()} />
      </div>

      {canAddItems ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:hidden">
          <Button size="lg" fullWidth onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="size-5" />
            Adicionar itens
          </Button>
        </div>
      ) : isOpen ? (
        <p className="mt-6 text-sm text-muted">Seu papel não lança pedidos nesta comanda.</p>
      ) : null}

      {canAddItems ? (
        <AddItemsDialog
          open={adding}
          slug={slug}
          destination={title}
          sending={actions.pending.has(`order:${tabId}`)}
          onClose={() => setAdding(false)}
          onSend={sendOrder}
        />
      ) : null}
    </div>
  );
}

