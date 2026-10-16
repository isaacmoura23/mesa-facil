"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Armchair, ReceiptText, Store } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/modules/operations/format";
import {
  TABLE_STATUSES,
  TABLE_STATUS_LABELS,
  type RestaurantTable,
  type TabSummary,
  type TableStatus,
  type TablesPermissions,
} from "@/modules/tables/types";
import { tabIdFrom, useTabActions } from "@/modules/tables/use-tab-actions";
import { useNow } from "@/modules/tables/use-now";
import { useTablesFeed } from "@/modules/tables/use-tables-feed";
import { LiveStatus } from "./live-status";
import { OpenTabDialog, type OpenTabTarget } from "./open-tab-dialog";
import { TableCard } from "./table-card";

type Filter = "ALL" | TableStatus;

type TablesBoardProps = {
  slug: string;
  /** Resolvido no servidor pelo guard (nunca do slug do navegador). */
  restaurantId: string;
  permissions: TablesPermissions;
};

export function TablesBoard({ slug, restaurantId, permissions }: TablesBoardProps) {
  const router = useRouter();
  const feed = useTablesFeed(restaurantId);
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [target, setTarget] = useState<OpenTabTarget | null>(null);

  const refresh = feed.refresh;
  const onStale = useCallback(() => void refresh(), [refresh]);
  const actions = useTabActions({ onStale });

  const tabHref = useCallback(
    (tabId: string) => `/operacao/${encodeURIComponent(slug)}/comandas/${tabId}`,
    [slug],
  );

  const tables = feed.data?.tables;
  const openByTable = useMemo(() => {
    const map = new Map<string, TabSummary>();
    for (const tab of feed.data?.tabs ?? []) {
      if (tab.status === "OPEN" && tab.table_id) map.set(tab.table_id, tab);
    }
    return map;
  }, [feed.data]);
  const counterTabs = useMemo(
    () => (feed.data?.tabs ?? []).filter((tab) => tab.status === "OPEN" && !tab.table_id),
    [feed.data],
  );

  const counts = useMemo(() => {
    const result: Record<TableStatus, number> = { AVAILABLE: 0, OCCUPIED: 0, CLEANING: 0, INACTIVE: 0 };
    for (const table of tables ?? []) result[table.status] += 1;
    return result;
  }, [tables]);

  const visible = useMemo(
    () => (tables ?? []).filter((table) => filter === "ALL" || table.status === filter),
    [tables, filter],
  );

  async function submitOpen(input: { tableId: string | null; label: string | null; guests: number | null }) {
    const result = await actions.openTab({ restaurantId, ...input });
    if (!result) return;
    if (result.ok) {
      setTarget(null);
      const id = tabIdFrom(result.data);
      if (id && permissions.viewTabs) router.push(tabHref(id));
      else void feed.refresh();
    } else if (result.error.stale) {
      setTarget(null);
    }
  }

  const openBusy = target
    ? actions.pending.has(target.kind === "table" ? `table:${target.table.id}` : "counter")
    : false;

  const onOpenTab = useCallback((table: RestaurantTable) => setTarget({ kind: "table", table }), []);
  const { releaseTable } = actions;
  const onRelease = useCallback(
    async (table: RestaurantTable) => {
      const result = await releaseTable(table.id);
      if (result?.ok) void refresh();
    },
    [releaseTable, refresh],
  );

  return (
    <div>
      <PageHeader
        title="Mesas"
        description="Estado do salão em tempo real. Abra a comanda ao sentar o cliente."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <LiveStatus
              state={feed.connection}
              syncing={feed.loading}
              onRefresh={() => void feed.refresh()}
              refreshLabel="Atualizar mesas agora"
            />
            {permissions.viewTabs ? (
              <Link
                href={`/operacao/${encodeURIComponent(slug)}/comandas`}
                className={buttonStyles({ variant: "secondary", size: "md" })}
              >
                <ReceiptText aria-hidden="true" className="size-4" />
                Comandas
              </Link>
            ) : null}
            {permissions.manageTabs ? (
              <Button onClick={() => setTarget({ kind: "counter" })}>
                <Store aria-hidden="true" className="size-4" />
                Comanda de balcão
              </Button>
            ) : null}
          </div>
        }
      />

      {feed.error && feed.data ? (
        <Alert tone="warning" className="mb-4" title="Dados podem estar desatualizados">
          Não foi possível atualizar agora. Mostrando a última leitura.
        </Alert>
      ) : null}

      {feed.loading && !feed.data ? <BoardSkeleton /> : null}

      {!feed.data && !feed.loading ? (
        <Alert tone="danger" title="Não foi possível carregar as mesas">
          <div className="flex flex-wrap items-center gap-3">
            <span>{feed.error ?? "Erro inesperado."}</span>
            <Button size="sm" variant="secondary" onClick={() => void feed.refresh()}>
              Tentar de novo
            </Button>
          </div>
        </Alert>
      ) : null}

      {feed.data ? (
        <>
          {(tables?.length ?? 0) > 0 ? (
            <div role="group" aria-label="Filtrar por estado" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
              <FilterChip active={filter === "ALL"} onClick={() => setFilter("ALL")} label="Todas" count={tables?.length ?? 0} />
              {TABLE_STATUSES.map((status) => (
                <FilterChip
                  key={status}
                  active={filter === status}
                  onClick={() => setFilter(status)}
                  label={TABLE_STATUS_LABELS[status]}
                  count={counts[status]}
                />
              ))}
            </div>
          ) : null}

          {counterTabs.length > 0 ? (
            <section aria-label="Comandas de balcão abertas" className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-muted">Balcão</h2>
              <ul className="flex flex-wrap gap-2">
                {counterTabs.map((tab) => (
                  <li key={tab.id}>
                    {permissions.viewTabs ? (
                      <Link
                        href={tabHref(tab.id)}
                        className={buttonStyles({ variant: "secondary", size: "md" })}
                      >
                        {tab.label?.trim() || "Balcão"}
                        <span className="tabular-nums text-muted">
                          {formatMoney(tab.consumedCents)}
                        </span>
                      </Link>
                    ) : (
                      <span className="inline-flex h-11 items-center rounded-control border border-line px-4 text-sm">
                        {tab.label?.trim() || "Balcão"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {(tables?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Armchair />}
              title="Nenhuma mesa cadastrada"
              description="Peça ao gestor para cadastrar as mesas em Administração. Enquanto isso, use a comanda de balcão."
            />
          ) : visible.length === 0 ? (
            <EmptyState icon={<Armchair />} title="Nenhuma mesa neste estado" description="Escolha outro filtro para ver as demais mesas." />
          ) : (
            <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((table) => {
                const tab = openByTable.get(table.id) ?? null;
                return (
                  <TableCard
                    key={table.id}
                    table={table}
                    tab={tab}
                    now={now}
                    detailHref={tab && permissions.viewTabs ? tabHref(tab.id) : null}
                    canOpenTab={permissions.manageTabs}
                    canRelease={permissions.operateTables}
                    busy={actions.pending.has(`table:${table.id}`)}
                    onOpenTab={onOpenTab}
                    onRelease={onRelease}
                  />
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      <OpenTabDialog
        target={target}
        busy={openBusy}
        onClose={() => setTarget(null)}
        onSubmit={(input) => void submitOpen(input)}
      />
    </div>
  );
}

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line bg-surface text-fg hover:bg-surface-2",
      )}
    >
      {label}
      <span className="tabular-nums text-muted">{count}</span>
    </button>
  );
}

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-44 rounded-card" />
      ))}
    </div>
  );
}
