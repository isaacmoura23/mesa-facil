"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Clock, LayoutGrid, ReceiptText, Search } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";
import { formatMoney, formatTime } from "@/modules/operations/format";
import { formatOpenFor, normalizeText, tabSubtitle, tabTitle } from "@/modules/tables/format";
import { TAB_STATUS_LABELS, type TabSummary, type TablesPermissions } from "@/modules/tables/types";
import { useNow } from "@/modules/tables/use-now";
import { useTablesFeed } from "@/modules/tables/use-tables-feed";
import { LiveStatus } from "./live-status";

type View = "OPEN" | "ENDED";

type TabsBoardProps = {
  slug: string;
  restaurantId: string;
  permissions: TablesPermissions;
};

export function TabsBoard({ slug, restaurantId, permissions }: TabsBoardProps) {
  const feed = useTablesFeed(restaurantId);
  const now = useNow();
  const [view, setView] = useState<View>("OPEN");
  const [search, setSearch] = useState("");

  const base = `/operacao/${encodeURIComponent(slug)}`;

  const { open, ended } = useMemo(() => {
    const openList: TabSummary[] = [];
    const endedList: TabSummary[] = [];
    for (const tab of feed.data?.tabs ?? []) (tab.status === "OPEN" ? openList : endedList).push(tab);
    // Abertas: mais antigas primeiro (quem espera há mais tempo); encerradas: mais recentes.
    openList.sort((a, b) => a.opened_at.localeCompare(b.opened_at));
    endedList.sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""));
    return { open: openList, ended: endedList };
  }, [feed.data]);

  const list = view === "OPEN" ? open : ended;
  const visible = useMemo(() => {
    const query = normalizeText(search);
    if (!query) return list;
    return list.filter((tab) =>
      normalizeText(`${tabTitle(tab, tab.tableName)} ${tabSubtitle(tab)}`).includes(query),
    );
  }, [list, search]);

  return (
    <div>
      <PageHeader
        title="Comandas"
        description="Consumo de cada mesa e do balcão. Abra uma comanda para lançar itens."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <LiveStatus
              state={feed.connection}
              syncing={feed.loading}
              onRefresh={() => void feed.refresh()}
              refreshLabel="Atualizar comandas agora"
            />
            {permissions.manageTabs || permissions.operateTables ? (
              <Link href={`${base}/mesas`} className={buttonStyles({ variant: "secondary", size: "md" })}>
                <LayoutGrid aria-hidden="true" className="size-4" />
                Mesas
              </Link>
            ) : null}
          </div>
        }
      />

      {feed.error && feed.data ? (
        <Alert tone="warning" className="mb-4" title="Dados podem estar desatualizados">
          Não foi possível atualizar agora. Mostrando a última leitura.
        </Alert>
      ) : null}

      {feed.loading && !feed.data ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-card" />
          ))}
        </div>
      ) : null}

      {!feed.data && !feed.loading ? (
        <Alert tone="danger" title="Não foi possível carregar as comandas">
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
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div role="group" aria-label="Situação" className="flex gap-2">
              <ViewChip active={view === "OPEN"} onClick={() => setView("OPEN")} label="Abertas" count={open.length} />
              <ViewChip active={view === "ENDED"} onClick={() => setView("ENDED")} label="Encerradas hoje" count={ended.length} />
            </div>
            <div className="relative sm:w-72">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Buscar por mesa ou identificação"
                placeholder="Buscar mesa ou cliente"
                className={inputStyles(false, "pl-9")}
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<ReceiptText />}
              title={
                search
                  ? "Nenhuma comanda encontrada"
                  : view === "OPEN"
                    ? "Nenhuma comanda aberta"
                    : "Nenhuma comanda encerrada hoje"
              }
              description={
                search
                  ? "Revise a busca ou troque a situação."
                  : view === "OPEN"
                    ? "Abra uma comanda pela tela de Mesas ou pelo balcão."
                    : "As comandas fechadas ou canceladas hoje aparecem aqui."
              }
              action={
                view === "OPEN" && !search && (permissions.manageTabs || permissions.operateTables) ? (
                  <Link href={`${base}/mesas`} className={buttonStyles({ size: "lg" })}>
                    Ir para Mesas
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {visible.map((tab) => (
                <TabRow key={tab.id} tab={tab} now={now} href={`${base}/comandas/${tab.id}`} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

function TabRow({ tab, now, href }: { tab: TabSummary; now: number; href: string }) {
  const isOpen = tab.status === "OPEN";
  const subtitle = tabSubtitle(tab);
  const cents = isOpen ? tab.consumedCents : tab.status === "CLOSED" ? tab.total_cents : 0;
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-20 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-line-strong hover:bg-surface-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold text-fg">{tabTitle(tab, tab.tableName)}</span>
            {!isOpen ? (
              <Badge tone={tab.status === "CANCELLED" ? "danger" : "neutral"}>{TAB_STATUS_LABELS[tab.status]}</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden="true" className="size-3.5" />
              {isOpen
                ? `Aberta há ${formatOpenFor(tab.opened_at, now)}`
                : `Encerrada às ${tab.closed_at ? formatTime(tab.closed_at) : "--:--"}`}
            </span>
            {tab.ordersCount > 0 ? <span>{tab.ordersCount} {tab.ordersCount === 1 ? "pedido" : "pedidos"}</span> : null}
            {subtitle ? <span className="truncate">{subtitle}</span> : null}
          </p>
        </div>
        <p className={cn("shrink-0 text-lg font-semibold tabular-nums", !isOpen && "text-muted")}>{formatMoney(cents)}</p>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted" />
      </Link>
    </li>
  );
}

function ViewChip({
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
        "inline-flex h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line bg-surface text-fg hover:bg-surface-2",
      )}
    >
      {label}
      <span className="tabular-nums text-muted">{count}</span>
    </button>
  );
}
