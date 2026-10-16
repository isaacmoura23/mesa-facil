import Link from "next/link";
import { ChevronRight, Download, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import {
  TAB_STATUS_LABELS,
  TAB_STATUS_TONES,
  formatFullDateTime,
  formatMoney,
} from "@/modules/tables-admin/format";
import { filtersToQuery, type TabFilters } from "@/modules/tables-admin/schemas";
import type { TabListItem, TableRow } from "@/modules/tables-admin/types";

const labelClass = "text-sm font-medium text-fg";

/** Filtros por GET: funcionam sem JavaScript e ficam na URL (compartilháveis). */
export function TabsFilters({
  slug,
  filters,
  tables,
  filtered,
}: {
  slug: string;
  filters: TabFilters;
  tables: TableRow[];
  filtered: boolean;
}) {
  const exportQuery = filtersToQuery(filters);
  return (
    <form
      method="get"
      aria-label="Filtros das comandas"
      className="mb-5 grid grid-cols-1 gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="f-status" className={labelClass}>
          Estado
        </label>
        <select id="f-status" name="status" defaultValue={filters.status} className={inputStyles()}>
          <option value="ALL">Todas</option>
          <option value="OPEN">Abertas</option>
          <option value="CLOSED">Fechadas</option>
          <option value="CANCELLED">Canceladas</option>
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="f-table" className={labelClass}>
          Mesa
        </label>
        <select id="f-table" name="table" defaultValue={filters.table ?? ""} className={inputStyles()}>
          <option value="">Todas as mesas</option>
          <option value="none">Sem mesa (balcão)</option>
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="f-from" className={labelClass}>
          Aberta a partir de
        </label>
        <input id="f-from" type="date" name="from" defaultValue={filters.from ?? ""} className={inputStyles()} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="f-to" className={labelClass}>
          Aberta até
        </label>
        <input id="f-to" type="date" name="to" defaultValue={filters.to ?? ""} className={inputStyles()} />
      </div>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
        <button type="submit" className={buttonStyles({ variant: "primary", className: "flex-1 lg:flex-none" })}>
          Filtrar
        </button>
        {filtered ? (
          <Link
            href={`/app/${slug}/comandas`}
            className={buttonStyles({ variant: "ghost", className: "flex-1 lg:flex-none" })}
          >
            Limpar
          </Link>
        ) : null}
        <a
          href={`/app/${slug}/comandas/export${exportQuery ? `?${exportQuery}` : ""}`}
          download
          className={buttonStyles({ variant: "secondary", className: "flex-1 lg:flex-none" })}
        >
          <Download aria-hidden="true" className="size-4" />
          CSV
          <span className="sr-only"> das comandas do filtro</span>
        </a>
      </div>
    </form>
  );
}

function placeOf(item: TabListItem): { title: string; subtitle: string | null } {
  if (item.tableName) return { title: item.tableName, subtitle: item.label };
  return { title: item.label ? `Balcão: ${item.label}` : "Balcão", subtitle: null };
}

export function TabsList({
  slug,
  items,
  filtered,
}: {
  slug: string;
  items: TabListItem[];
  filtered: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Receipt />}
        title={filtered ? "Nenhuma comanda encontrada" : "Ainda não há comandas"}
        description={
          filtered
            ? "Nenhuma comanda combina com os filtros escolhidos. Ajuste o período, o estado ou a mesa."
            : "As comandas aparecem aqui assim que a equipe abrir a primeira na Operação."
        }
      />
    );
  }

  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      {items.map((item, index) => {
        const place = placeOf(item);
        return (
          <li key={item.id} className={index > 0 ? "border-t border-line" : undefined}>
            <Link
              href={`/app/${slug}/comandas/${item.id}`}
              className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_8rem_auto] md:gap-x-6"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-fg">{place.title}</span>
                  <Badge tone={TAB_STATUS_TONES[item.status]}>{TAB_STATUS_LABELS[item.status]}</Badge>
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted">
                  Comanda {item.shortCode}
                  {place.subtitle ? ` · ${place.subtitle}` : ""}
                  {item.guests ? ` · ${item.guests} ${item.guests === 1 ? "pessoa" : "pessoas"}` : ""}
                </span>
              </span>
              <span className="col-span-2 row-start-2 text-sm text-muted md:col-span-1 md:row-start-auto">
                <span className="block">Aberta {formatFullDateTime(item.openedAt)}</span>
                <span className="block">
                  {item.closedAt ? `Encerrada ${formatFullDateTime(item.closedAt)}` : "Em andamento"}
                </span>
              </span>
              <span className="row-start-1 col-start-2 text-right md:col-start-auto md:row-start-auto">
                <span className="block text-base font-semibold tabular-nums text-fg">
                  {item.totalCents === null ? "--" : formatMoney(item.totalCents)}
                </span>
                {item.partial ? <span className="block text-xs text-muted">parcial</span> : null}
              </span>
              <ChevronRight aria-hidden="true" className="hidden size-4 text-muted md:block" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
