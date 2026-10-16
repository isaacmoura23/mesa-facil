"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { History, LayoutGrid, Pencil, Plus, Power, PowerOff, Search, Trash2, Users } from "lucide-react";
import { IconButton } from "@/components/menu-admin/icon-button";
import { ReorderButtons } from "@/components/menu-admin/reorder-buttons";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import {
  deleteTableAction,
  moveTableAction,
  setTableActiveAction,
} from "@/modules/tables-admin/actions";
import {
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
  capacityLabel,
  formatMoney,
} from "@/modules/tables-admin/format";
import { TABLE_STATUSES, type TableRow, type TableStatus, type TableWithTab } from "@/modules/tables-admin/types";
import { OpenSince, RefreshOnFocus } from "./live";
import { TableFormDialog } from "./table-form-dialog";
import { TableHistoryDialog } from "./table-history-dialog";

type Props = {
  slug: string;
  tables: TableWithTab[];
  canManage: boolean;
  canViewTabs: boolean;
};

type StatusFilter = "ALL" | TableStatus;

export function TablesWorkspace({ slug, tables, canManage, canViewTabs }: Props) {
  const { run, isBusy, pending } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ table: TableRow | null } | null>(null);
  const [history, setHistory] = useState<TableRow | null>(null);

  const counts = useMemo(() => {
    const out: Record<StatusFilter, number> = { ALL: tables.length, AVAILABLE: 0, OCCUPIED: 0, CLEANING: 0, INACTIVE: 0 };
    for (const table of tables) out[table.status] += 1;
    return out;
  }, [tables]);

  const needle = search.trim().toLowerCase();
  const visible = tables.filter(
    (table) => (filter === "ALL" || table.status === filter) && (!needle || table.name.toLowerCase().includes(needle)),
  );
  const filtering = filter !== "ALL" || needle !== "";

  function toggleActive(table: TableWithTab) {
    const activate = table.status === "INACTIVE";
    if (activate) {
      void run(() => setTableActiveAction(slug, table.id, true), { key: table.id });
      return;
    }
    confirm({
      title: `Inativar ${table.name}?`,
      description:
        "Uma mesa inativa some das opções da equipe e não recebe comandas. Você pode reativá-la quando quiser. Mesas com comanda aberta não podem ser inativadas.",
      confirmLabel: "Inativar mesa",
      onConfirm: () => run(() => setTableActiveAction(slug, table.id, false), { key: table.id }),
    });
  }

  function remove(table: TableWithTab) {
    confirm({
      title: `Excluir ${table.name}?`,
      description:
        "A mesa será apagada de vez. Só é possível excluir mesas inativas que nunca foram usadas; se ela tiver histórico, inative em vez de excluir.",
      confirmLabel: "Excluir mesa",
      tone: "danger",
      onConfirm: () => run(() => deleteTableAction(slug, table.id), { key: table.id }),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <RefreshOnFocus />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Filtrar por estado" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {(["ALL", ...TABLE_STATUSES] as const).map((status) => {
            const active = filter === status;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(status)}
                className={cn(
                  "inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
                  active
                    ? "border-transparent bg-accent text-accent-fg"
                    : "border-line bg-surface text-fg hover:bg-surface-2",
                )}
              >
                {status === "ALL" ? "Todas" : TABLE_STATUS_LABELS[status]}
                <span className={cn("text-xs tabular-nums", active ? "text-accent-fg/80" : "text-muted")}>
                  {counts[status]}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <label className="relative block min-w-0 flex-1 sm:w-56 sm:flex-none">
            <span className="sr-only">Buscar mesa pelo nome</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar mesa"
              autoComplete="off"
              className={inputStyles(false, "pl-9")}
            />
          </label>
          {canManage ? (
            <Button onClick={() => setEditing({ table: null })} className="shrink-0">
              <Plus aria-hidden="true" className="size-4" />
              Nova mesa
            </Button>
          ) : null}
        </div>
      </div>

      {tables.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid />}
          title="Nenhuma mesa cadastrada"
          description={
            canManage
              ? "Cadastre as mesas do salão para que a equipe possa abrir comandas na Operação."
              : "Quando o gerente cadastrar as mesas, elas aparecem aqui."
          }
          action={
            canManage ? (
              <Button onClick={() => setEditing({ table: null })}>
                <Plus aria-hidden="true" className="size-4" />
                Cadastrar a primeira mesa
              </Button>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="Nenhuma mesa encontrada"
          description="Nenhuma mesa combina com o filtro ou a busca atual."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setFilter("ALL");
                setSearch("");
              }}
            >
              Limpar filtros
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((table, index) => {
            const busy = isBusy(table.id);
            return (
              <li key={table.id}>
                <article
                  aria-label={table.name}
                  className={cn(
                    "flex h-full flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-card",
                    table.status === "INACTIVE" && "bg-surface-2/60",
                  )}
                >
                  <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className={cn("truncate text-base font-semibold text-fg", table.status === "INACTIVE" && "text-muted")}>
                        {table.name}
                      </h3>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                        <Users aria-hidden="true" className="size-3.5" />
                        {capacityLabel(table.capacity)}
                      </p>
                    </div>
                    <Badge tone={TABLE_STATUS_TONES[table.status]} className="shrink-0">
                      {TABLE_STATUS_LABELS[table.status]}
                    </Badge>
                  </header>

                  <TabSummary slug={slug} table={table} canViewTabs={canViewTabs} />

                  <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                    <div className="flex items-center gap-0.5">
                      {canViewTabs ? (
                        <IconButton label={`Ver histórico de ${table.name}`} onClick={() => setHistory(table)}>
                          <History aria-hidden="true" />
                        </IconButton>
                      ) : null}
                      {canManage ? (
                        <>
                          <IconButton
                            label={`Editar ${table.name}`}
                            disabled={busy}
                            onClick={() => setEditing({ table })}
                          >
                            <Pencil aria-hidden="true" />
                          </IconButton>
                          {table.status === "INACTIVE" ? (
                            <IconButton
                              label={`Excluir ${table.name}`}
                              tone="danger"
                              disabled={busy}
                              onClick={() => remove(table)}
                            >
                              <Trash2 aria-hidden="true" />
                            </IconButton>
                          ) : null}
                          {!filtering ? (
                            <ReorderButtons
                              name={table.name}
                              canMoveUp={index > 0}
                              canMoveDown={index < visible.length - 1}
                              disabled={pending}
                              onMove={(direction) => void run(() => moveTableAction(slug, table.id, direction), { key: table.id })}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    {canManage && table.status !== "OCCUPIED" && table.status !== "CLEANING" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy}
                        disabled={pending && !busy}
                        onClick={() => toggleActive(table)}
                      >
                        {table.status === "INACTIVE" ? (
                          <>
                            <Power aria-hidden="true" className="size-4" />
                            Reativar
                          </>
                        ) : (
                          <>
                            <PowerOff aria-hidden="true" className="size-4" />
                            Inativar
                          </>
                        )}
                      </Button>
                    ) : null}
                  </footer>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {tables.some((table) => table.status === "OCCUPIED" || table.status === "CLEANING") ? (
        <p className="text-sm text-muted">
          Os estados Ocupada e Em limpeza são controlados pela equipe na Operação, conforme as comandas
          abrem e fecham. Aqui você só cadastra, ativa e inativa as mesas.
        </p>
      ) : null}

      <TableFormDialog
        key={editing?.table?.id ?? "new"}
        open={editing !== null}
        slug={slug}
        table={editing?.table ?? null}
        onClose={() => setEditing(null)}
      />
      <TableHistoryDialog slug={slug} table={history} onClose={() => setHistory(null)} />
      {dialog}
    </div>
  );
}

/** Comanda aberta da mesa: somente leitura (nenhuma ação operacional). */
function TabSummary({ slug, table, canViewTabs }: { slug: string; table: TableWithTab; canViewTabs: boolean }) {
  const tab = table.openTab;
  if (!tab) {
    return (
      <p className="text-sm text-muted">
        {table.status === "INACTIVE" ? "Mesa fora de uso." : "Sem comanda aberta."}
      </p>
    );
  }
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-fg">Comanda aberta</span>
        <OpenSince since={tab.openedAt} />
      </span>
      <span className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">
          {tab.label ? `${tab.label} · ` : ""}
          {tab.guests ? `${tab.guests} ${tab.guests === 1 ? "pessoa" : "pessoas"}` : "Pessoas não informadas"}
          {tab.ordersCount !== null ? ` · ${tab.ordersCount} ${tab.ordersCount === 1 ? "pedido" : "pedidos"}` : ""}
        </span>
        <span className="text-right">
          <span className="block text-xs text-muted">Parcial</span>
          <span className="text-lg font-semibold tabular-nums text-fg">
            {tab.consumedCents === null ? "--" : formatMoney(tab.consumedCents)}
          </span>
        </span>
      </span>
    </>
  );
  const boxClass = "block rounded-control border border-line bg-surface-2 px-3 py-2.5";
  return canViewTabs ? (
    <Link
      href={`/app/${slug}/comandas/${tab.id}`}
      className={cn(boxClass, "transition-colors hover:border-line-strong")}
      aria-label={`Ver comanda aberta da ${table.name}`}
    >
      {body}
    </Link>
  ) : (
    <div className={boxClass}>{body}</div>
  );
}
