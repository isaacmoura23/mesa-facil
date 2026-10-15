"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BellOff, ChefHat, Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";
import { ConnectionIndicator } from "@/components/operations/connection-indicator";
import { SoundControls } from "@/components/operations/sound-controls";
import { useAlertSound } from "@/modules/operations/use-alert-sound";
import { useOrderActions, type OrderAction } from "@/modules/operations/use-order-actions";
import { useOrdersFeed } from "@/modules/operations/use-orders-feed";
import {
  DEFAULT_FILTERS,
  type OperationsOrder,
  type OperationsPermissions,
  type OrderStatus,
} from "@/modules/operations/types";
import { KitchenCard } from "./kitchen-card";
import {
  getZoomIndexServerSnapshot,
  getZoomIndexSnapshot,
  KITCHEN_ZOOMS,
  setZoomIndex,
  subscribeZoom,
} from "./kitchen-prefs";

type ColumnKey = "NEW" | "PREPARING" | "READY";

type Column = {
  key: ColumnKey;
  title: string;
  statuses: readonly OrderStatus[];
  empty: string;
};

/** O que a cozinha pode fazer: aceitar (se tiver permissão), iniciar preparo e marcar pronto. */
const KITCHEN_TARGETS: readonly OrderStatus[] = ["CONFIRMED", "PREPARING", "READY"];

function sortOldestFirst(list: OperationsOrder[]): OperationsOrder[] {
  return [...list].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.order_number - b.order_number,
  );
}

type KitchenBoardProps = {
  /** Resolvido no servidor pelo guard (nunca do slug do navegador). */
  restaurantId: string;
  restaurantName: string;
  permissions: OperationsPermissions;
};

export function KitchenBoard({ restaurantId, restaurantName, permissions }: KitchenBoardProps) {
  const feed = useOrdersFeed({ restaurantId, filters: DEFAULT_FILTERS });
  const [now, setNow] = useState(() => Date.now());
  const [soundOpen, setSoundOpen] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const [column, setColumn] = useState<ColumnKey>("NEW");
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomIndex = useSyncExternalStore(subscribeZoom, getZoomIndexSnapshot, getZoomIndexServerSnapshot);
  const zoom = KITCHEN_ZOOMS[zoomIndex] ?? 1;

  // Quem aceita pedidos é alertado por RECEIVED; a cozinha que não aceita, por CONFIRMED (pronto para preparar).
  const alertStatus: OrderStatus = permissions.accept ? "RECEIVED" : "CONFIRMED";
  const waitingIds = useMemo(
    () => new Set(feed.orders.filter((order) => order.status === alertStatus).map((order) => order.id)),
    [feed.orders, alertStatus],
  );
  const alerts = useAlertSound(waitingIds);
  const { notify, dismiss, dismissAll } = alerts;

  const knownRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (feed.loading) return;
    const known = knownRef.current;
    knownRef.current = waitingIds;
    if (known === null) return; // carga inicial: nada de alerta para o que já estava na fila
    for (const id of waitingIds) {
      if (known.has(id)) continue;
      notify(id);
      setAnnouncement("Novo pedido na fila da cozinha");
    }
  }, [waitingIds, feed.loading, notify]);

  const actions = useOrderActions({ feed, permissions, onHandled: (order) => dismiss(order.id) });
  const { actionsFor, run, pending } = actions;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Sair da tela cheia do navegador (Esc) encerra o modo quiosque.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setKiosk(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const columns = useMemo<Column[]>(
    () => [
      {
        key: "NEW",
        title: "Novos",
        statuses: ["RECEIVED", "CONFIRMED"],
        empty: "Nenhum pedido novo na fila.",
      },
      { key: "PREPARING", title: "Em preparo", statuses: ["PREPARING"], empty: "Nada em preparo agora." },
      { key: "READY", title: "Prontos", statuses: ["READY"], empty: "Nenhum pedido pronto aguardando." },
    ],
    [],
  );

  const grouped = useMemo(() => {
    const result: Record<ColumnKey, OperationsOrder[]> = { NEW: [], PREPARING: [], READY: [] };
    for (const col of columns) {
      result[col.key] = sortOldestFirst(feed.orders.filter((order) => col.statuses.includes(order.status)));
    }
    return result;
  }, [feed.orders, columns]);

  const kitchenAction = useCallback(
    (order: OperationsOrder): OrderAction | null =>
      actionsFor(order).find((action) => action.kind === "advance" && KITCHEN_TARGETS.includes(action.to)) ?? null,
    [actionsFor],
  );

  const handleAction = useCallback(
    (order: OperationsOrder, action: OrderAction) => {
      void run(order, action);
    },
    [run],
  );

  function hintFor(order: OperationsOrder): string | null {
    if (order.status === "RECEIVED") return "Aguardando o aceite do atendimento";
    if (order.status === "READY") return "Pronto, aguardando retirada ou entrega";
    return null;
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await feed.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleKiosk() {
    if (kiosk) {
      setKiosk(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      return;
    }
    setKiosk(true);
    // Se o navegador negar a tela cheia, o modo quiosque continua cobrindo a janela.
    await containerRef.current?.requestFullscreen?.().catch(() => {});
  }

  const pendingAlerts = alerts.pendingCount;
  const showSkeleton = feed.loading;

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-col gap-4", kiosk && "fixed inset-0 z-50 overflow-y-auto bg-bg p-4 sm:p-6")}
    >
      {kiosk ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <ChefHat aria-hidden="true" className="size-6" />
            Cozinha: {restaurantName}
          </h1>
        </div>
      ) : (
        <PageHeader title="Cozinha" description={restaurantName} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ConnectionIndicator state={feed.connection} syncing={refreshing || feed.loading} onRefresh={handleRefresh} />
        <div className="flex items-center gap-1" role="group" aria-label="Tamanho da fonte">
          <Button
            variant="secondary"
            size="md"
            aria-label="Diminuir fonte"
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex(zoomIndex - 1)}
          >
            <Minus aria-hidden="true" className="size-4" />
          </Button>
          <span className="min-w-12 text-center text-sm font-medium tabular-nums text-muted" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="secondary"
            size="md"
            aria-label="Aumentar fonte"
            disabled={zoomIndex === KITCHEN_ZOOMS.length - 1}
            onClick={() => setZoomIndex(zoomIndex + 1)}
          >
            <Plus aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <Button variant="secondary" size="md" onClick={() => void toggleKiosk()} aria-pressed={kiosk}>
          {kiosk ? <Minimize2 aria-hidden="true" className="size-4" /> : <Maximize2 aria-hidden="true" className="size-4" />}
          {kiosk ? "Sair da tela cheia" : "Tela cheia"}
        </Button>
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

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {pendingAlerts > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-accent px-4 py-3 text-accent-fg">
          <p className="text-lg font-semibold">
            {pendingAlerts === 1 ? "1 pedido novo na fila" : `${pendingAlerts} pedidos novos na fila`}
          </p>
          <Button variant="secondary" size="md" onClick={dismissAll}>
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

      {!permissions.accept && !permissions.updateStatus ? (
        <Alert tone="info" title="Somente leitura">
          Seu perfil não pode mudar o estado dos pedidos. Você pode acompanhar a fila e imprimir comandas.
        </Alert>
      ) : null}

      <div role="tablist" aria-label="Colunas da cozinha" className="flex gap-2 overflow-x-auto lg:hidden">
        {columns.map((col) => (
          <button
            key={col.key}
            type="button"
            role="tab"
            id={`kitchen-tab-${col.key}`}
            aria-selected={column === col.key}
            aria-controls={`kitchen-col-${col.key}`}
            onClick={() => setColumn(col.key)}
            className={cn(
              "inline-flex h-12 shrink-0 items-center gap-2 rounded-control border px-4 text-base font-medium",
              column === col.key
                ? "border-accent bg-accent text-accent-fg"
                : "border-line-strong bg-surface text-fg hover:bg-surface-2",
            )}
          >
            {col.title}
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-sm font-semibold text-muted tabular-nums">
              {showSkeleton ? "-" : grouped[col.key].length}
            </span>
          </button>
        ))}
      </div>

      <div style={{ zoom }} className="grid items-start gap-4 lg:grid-cols-3">
        {columns.map((col) => {
          const list = grouped[col.key];
          return (
            <section
              key={col.key}
              id={`kitchen-col-${col.key}`}
              aria-labelledby={`kitchen-head-${col.key}`}
              className={cn("min-w-0", column === col.key ? "block" : "hidden", "lg:block")}
            >
              <h2
                id={`kitchen-head-${col.key}`}
                className="mb-3 hidden items-center justify-between rounded-control bg-surface-2 px-4 py-2 text-lg font-bold text-fg lg:flex"
              >
                {col.title}
                <span className="tabular-nums text-muted">{showSkeleton ? "-" : list.length}</span>
              </h2>
              {showSkeleton ? (
                <Skeleton className="h-64 w-full rounded-card" />
              ) : list.length === 0 ? (
                <EmptyState icon={<ChefHat />} title={col.empty} />
              ) : (
                <ul className="flex flex-col gap-4">
                  {list.map((order) => (
                    <KitchenCard
                      key={order.id}
                      order={order}
                      now={now}
                      action={kitchenAction(order)}
                      busy={pending.has(order.id)}
                      canPrint={permissions.print}
                      idleHint={kitchenAction(order) ? null : hintFor(order)}
                      unseen={alerts.alertIds.has(order.id) && order.status === alertStatus}
                      onAction={handleAction}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
