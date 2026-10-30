"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BellOff, Inbox } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils/cn";
import { resolveClosedQuery, useOrdersFeed } from "@/modules/operations/use-orders-feed";
import { useOrderActions, type OrderAction } from "@/modules/operations/use-order-actions";
import { useAlertSound } from "@/modules/operations/use-alert-sound";
import {
  ACTIVE_STATUSES,
  DEFAULT_FILTERS,
  ORDER_STATUSES,
  TAB_LABELS,
  isActiveStatus,
  type OperationsOrder,
  type OperationsPermissions,
  type OrderFilters,
  type OrderStatus,
} from "@/modules/operations/types";
import { ConnectionIndicator } from "./connection-indicator";
import { OrderCard } from "./order-card";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { OrderFiltersBar } from "./order-filters";
import { ReasonDialog } from "./reason-dialog";
import { SoundControls } from "./sound-controls";

type TabKey = "ACTIVE" | OrderStatus;

const TABS: TabKey[] = ["ACTIVE", ...ORDER_STATUSES];

const REJECT_SUGGESTIONS = ["Sem estoque", "Fora da área de entrega", "Restaurante fechado", "Pedido duplicado"];
const CANCEL_SUGGESTIONS = ["Cliente desistiu", "Problema na cozinha", "Erro no pedido", "Falta de ingrediente"];

type OrdersBoardProps = {
  /** Resolvido no servidor pelo guard (nunca do slug do navegador). */
  restaurantId: string;
  restaurantName: string;
  permissions: OperationsPermissions;
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function matchesSearch(order: OperationsOrder, query: string): boolean {
  if (!query) return true;
  const digits = query.replace(/\D/g, "");
  if (query.startsWith("#") || /^\d+$/.test(query)) {
    const number = query.replace("#", "");
    if (String(order.order_number).includes(number)) return true;
  }
  if (digits.length >= 4 && (order.customer_phone ?? "").replace(/\D/g, "").includes(digits)) return true;
  return normalize(order.customer_name ?? "").includes(query.replace("#", ""));
}

function sortOrders(list: OperationsOrder[], active: boolean): OperationsOrder[] {
  const dir = active ? 1 : -1;
  return [...list].sort(
    (a, b) =>
      dir * a.created_at.localeCompare(b.created_at) || dir * (a.order_number - b.order_number),
  );
}

export function OrdersBoard({ restaurantId, restaurantName, permissions }: OrdersBoardProps) {
  const [filters, setFilters] = useState<OrderFilters>(DEFAULT_FILTERS);
  const [tab, setTab] = useState<TabKey>("ACTIVE");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ orderId: string; action: OrderAction } | null>(null);
  const [soundOpen, setSoundOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const tabRefs = useRef(new Map<TabKey, HTMLButtonElement>());

  // O feed precisa do callback de chegada antes de o alerta existir: ponte por ref.
  const arrivalRef = useRef<(order: OperationsOrder) => void>(() => {});
  const feed = useOrdersFeed({
    restaurantId,
    filters,
    onArrival: (order) => arrivalRef.current(order),
  });

  const waitingIds = useMemo(
    () => new Set(feed.orders.filter((order) => order.status === "RECEIVED").map((order) => order.id)),
    [feed.orders],
  );
  const alerts = useAlertSound(waitingIds);
  const { notify, dismiss, dismissAll } = alerts;

  useEffect(() => {
    arrivalRef.current = (order) => {
      notify(order.id);
      setAnnouncement(`Novo pedido número ${order.order_number}`);
    };
  }, [notify]);

  const actions = useOrderActions({
    feed,
    permissions,
    onHandled: (order) => dismiss(order.id),
  });

  // Relógio para "há X min".
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Contador de pedidos aguardando no título da aba.
  const waitingCount = waitingIds.size;
  useEffect(() => {
    if (waitingCount === 0) return;
    const previous = document.title;
    document.title = `(${waitingCount}) Pedidos novos - ${restaurantName}`;
    return () => {
      document.title = previous;
    };
  }, [waitingCount, restaurantName]);

  const visible = useMemo(() => {
    const range = resolveClosedQuery(filters, new Date(now));
    const since = Date.parse(range.since);
    const until = range.until ? Date.parse(range.until) : Infinity;
    const query = normalize(filters.search);
    return feed.orders.filter((order) => {
      if (filters.fulfillment !== "ALL" && order.fulfillment_type !== filters.fulfillment) return false;
      if (!isActiveStatus(order.status)) {
        const created = Date.parse(order.created_at);
        if (created < since || created > until) return false;
      }
      return matchesSearch(order, query);
    });
  }, [feed.orders, filters, now]);

  const counts = useMemo(() => {
    const result = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<OrderStatus, number>;
    for (const order of visible) result[order.status] += 1;
    return result;
  }, [visible]);

  const activeTotal = ACTIVE_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  const tabOrders = useMemo(() => {
    if (tab === "ACTIVE") return sortOrders(visible.filter((order) => isActiveStatus(order.status)), true);
    return sortOrders(
      visible.filter((order) => order.status === tab),
      isActiveStatus(tab),
    );
  }, [visible, tab]);

  const selected = selectedId ? (feed.orders.find((order) => order.id === selectedId) ?? null) : null;
  const reasonOrder = reasonTarget
    ? (feed.orders.find((order) => order.id === reasonTarget.orderId) ?? null)
    : null;

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      if (next !== "ACTIVE" && !isActiveStatus(next)) feed.loadClosed();
    },
    [feed],
  );

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    const next = TABS[(index + move + TABS.length) % TABS.length];
    selectTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const openOrder = useCallback(
    (order: OperationsOrder) => {
      setSelectedId(order.id);
      dismiss(order.id); // visto: para de repetir o alerta
    },
    [dismiss],
  );

  const { run, pending, actionsFor } = actions;
  const handleAction = useCallback(
    (order: OperationsOrder, action: OrderAction) => {
      if (action.needsReason) setReasonTarget({ orderId: order.id, action });
      else void run(order, action);
    },
    [run],
  );

  async function confirmReason(reason: string) {
    if (!reasonTarget || !reasonOrder) return;
    const ok = await run(reasonOrder, reasonTarget.action, reason);
    if (ok) setReasonTarget(null);
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await feed.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const isClosedTab = tab !== "ACTIVE" && !isActiveStatus(tab);
  const showSkeleton = feed.loading || (isClosedTab && !feed.closedLoaded && tabOrders.length === 0);
  const unseenCount = alerts.pendingCount;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Pedidos"
        description={restaurantName}
        actions={
          <ConnectionIndicator state={feed.connection} syncing={refreshing || feed.loading} onRefresh={handleRefresh} />
        }
      />

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {unseenCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-accent px-4 py-3 text-accent-fg">
          <p className="text-base font-semibold">
            {unseenCount === 1 ? "1 novo pedido aguardando" : `${unseenCount} novos pedidos aguardando`}
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              dismissAll();
              setTab("ACTIVE");
            }}
          >
            <BellOff aria-hidden="true" className="size-4" />
            Parar alerta
          </Button>
        </div>
      ) : null}

      {feed.error ? (
        <Alert tone="danger" title="Não foi possível atualizar os pedidos">
          <span>{feed.error}. Os dados na tela podem estar desatualizados. </span>
          <button type="button" onClick={handleRefresh} className="font-semibold underline underline-offset-4">
            Tentar de novo
          </button>
        </Alert>
      ) : null}

      {actions.transitionsError ? (
        <Alert tone="warning" title="Ações indisponíveis">
          Não foi possível carregar as regras de status. Recarregue a página para agir nos pedidos.
        </Alert>
      ) : null}

      <div
        role="tablist"
        aria-label="Estados dos pedidos"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      >
        {TABS.map((key, index) => {
          const selectedTab = tab === key;
          const closed = key !== "ACTIVE" && !isActiveStatus(key);
          const count = key === "ACTIVE" ? activeTotal : counts[key];
          const showCount = !closed || feed.closedLoaded;
          const hot = key === "RECEIVED" && count > 0;
          return (
            <button
              key={key}
              ref={(element) => {
                if (element) tabRefs.current.set(key, element);
                else tabRefs.current.delete(key);
              }}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={selectedTab}
              aria-controls="orders-panel"
              tabIndex={selectedTab ? 0 : -1}
              onClick={() => selectTab(key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                "inline-flex h-12 shrink-0 items-center gap-2 rounded-control border px-4 text-base font-medium whitespace-nowrap transition-colors",
                selectedTab
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-line-strong bg-surface text-fg hover:bg-surface-2",
              )}
            >
              {key === "ACTIVE" ? "Em andamento" : TAB_LABELS[key]}
              <span
                className={cn(
                  "inline-flex min-w-7 items-center justify-center rounded-full px-2 py-0.5 text-sm font-semibold tabular-nums",
                  selectedTab
                    ? "bg-accent-fg/20 text-accent-fg"
                    : hot
                      ? "bg-accent text-accent-fg"
                      : "bg-surface-2 text-muted",
                )}
              >
                {showCount ? count : "-"}
              </span>
            </button>
          );
        })}
      </div>

      <SoundControls
        prefs={alerts.prefs}
        unlocked={alerts.unlocked}
        open={soundOpen}
        onToggleOpen={() => setSoundOpen((value) => !value)}
        onChange={alerts.setPrefs}
        onUnlock={() => void alerts.unlock()}
        onPreview={alerts.preview}
      />

      <OrderFiltersBar
        filters={filters}
        open={filtersOpen}
        onToggle={() => setFiltersOpen((value) => !value)}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />

      <div id="orders-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
        {tab === "ACTIVE" ? (
          <p className="mb-3 hidden text-sm text-muted sm:block">
            Pedidos em andamento aparecem sempre, mesmo de dias anteriores. O período vale para concluídos,
            cancelados e recusados.
          </p>
        ) : null}

        {showSkeleton ? (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Carregando pedidos">
            {[0, 1, 2].map((key) => (
              <li key={key}>
                <Skeleton className="h-56 w-full rounded-card" />
              </li>
            ))}
          </ul>
        ) : tabOrders.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={
              filters.search || filters.fulfillment !== "ALL"
                ? "Nenhum pedido com esses filtros"
                : tab === "ACTIVE"
                  ? "Nenhum pedido em andamento"
                  : `Nenhum pedido ${TAB_LABELS[tab as OrderStatus].toLowerCase()}`
            }
            description={
              filters.search || filters.fulfillment !== "ALL"
                ? "Limpe a busca ou a modalidade para ver todos."
                : "Novos pedidos aparecem aqui sozinhos, sem precisar recarregar a página."
            }
            action={
              filters.search || filters.fulfillment !== "ALL" ? (
                <Button
                  variant="secondary"
                  onClick={() => setFilters((current) => ({ ...current, search: "", fulfillment: "ALL" }))}
                >
                  Limpar filtros
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tabOrders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                now={now}
                unseen={alerts.alertIds.has(order.id) && order.status === "RECEIVED"}
                actions={actionsFor(order)}
                busy={pending.has(order.id)}
                canPrint={permissions.print}
                onOpen={openOrder}
                onAction={handleAction}
              />
            ))}
          </ul>
        )}

        {isClosedTab && feed.closedLoaded && feed.closedHasMore ? (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" size="lg" onClick={feed.loadMoreClosed} loading={feed.closedLoading}>
              Carregar mais antigos
            </Button>
          </div>
        ) : null}
        {isClosedTab && feed.closedLoading && tabOrders.length > 0 ? (
          <div className="mt-4 flex justify-center">
            <Spinner />
          </div>
        ) : null}
      </div>

      <OrderDetailDrawer
        order={selected}
        restaurantId={restaurantId}
        actions={selected ? actionsFor(selected) : []}
        busy={selected ? pending.has(selected.id) : false}
        canPrint={permissions.print}
        canRecordPayments={permissions.recordPayments}
        onPaymentRecorded={(paidOrder) => void feed.syncOrder(paidOrder.id)}
        onClose={() => setSelectedId(null)}
        onAction={handleAction}
      />

      <ReasonDialog
        open={reasonTarget !== null && reasonOrder !== null}
        title={
          reasonTarget?.action.kind === "reject"
            ? `Recusar pedido #${reasonOrder?.order_number ?? ""}`
            : `Cancelar pedido #${reasonOrder?.order_number ?? ""}`
        }
        description="O motivo fica registrado no histórico e é mostrado ao cliente no acompanhamento."
        confirmLabel={reasonTarget?.action.kind === "reject" ? "Recusar pedido" : "Cancelar pedido"}
        suggestions={reasonTarget?.action.kind === "reject" ? REJECT_SUGGESTIONS : CANCEL_SUGGESTIONS}
        pending={reasonOrder ? pending.has(reasonOrder.id) : false}
        onConfirm={confirmReason}
        onClose={() => setReasonTarget(null)}
      />
    </div>
  );
}
