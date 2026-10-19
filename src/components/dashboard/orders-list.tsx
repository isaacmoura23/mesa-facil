import Link from "next/link";
import { ChevronRight, ClipboardList, Download } from "lucide-react";
import type { ResolvedPeriod } from "@/lib/period";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import {
  CSV_MAX_ROWS,
  STATUS_TONES,
  formatDateTimeTz,
  hasActiveFilters,
  ordersQuery,
  type OrderFilters,
} from "@/modules/dashboard/orders";
import type { OrderListRow, StatusCounts } from "@/modules/dashboard/orders-queries";
import { periodQuery } from "@/modules/dashboard/period-params";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  STATUS_LABELS,
  TAB_LABELS,
} from "@/modules/operations/types";

const labelClass = "text-sm font-medium text-fg";

/** Filtros por GET (modalidade, estado, nº do pedido); o período é preservado em campos ocultos. */
export function OrdersFilters({
  slug,
  period,
  filters,
  exportQuery,
}: {
  slug: string;
  period: ResolvedPeriod;
  filters: OrderFilters;
  exportQuery: string;
}) {
  const base = `/app/${slug}/pedidos`;
  return (
    <form
      method="get"
      action={base}
      aria-label="Filtros dos pedidos"
      className="mb-5 grid grid-cols-1 gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]"
    >
      {Object.entries(periodQuery(period)).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <div className="flex flex-col gap-2">
        <label htmlFor="f-fulfillment" className={labelClass}>
          Modalidade
        </label>
        <select id="f-fulfillment" name="fulfillment" defaultValue={filters.fulfillment} className={inputStyles()}>
          <option value="ALL">Todas</option>
          {FULFILLMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {FULFILLMENT_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="f-status" className={labelClass}>
          Estado
        </label>
        <select id="f-status" name="status" defaultValue={filters.status} className={inputStyles()}>
          <option value="ALL">Todos</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="f-number" className={labelClass}>
          Número do pedido
        </label>
        <input
          id="f-number"
          name="number"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={9}
          defaultValue={filters.number}
          placeholder="Ex.: 128"
          className={inputStyles()}
        />
      </div>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
        <button type="submit" className={buttonStyles({ variant: "primary", className: "flex-1 lg:flex-none" })}>
          Filtrar
        </button>
        {hasActiveFilters(filters) ? (
          <Link
            href={`${base}?${new URLSearchParams(periodQuery(period)).toString()}`}
            className={buttonStyles({ variant: "ghost", className: "flex-1 lg:flex-none" })}
          >
            Limpar
          </Link>
        ) : null}
        <a
          href={`${base}/export?${exportQuery}`}
          download
          className={buttonStyles({ variant: "secondary", className: "flex-1 lg:flex-none" })}
        >
          <Download aria-hidden="true" className="size-4" />
          CSV
          <span className="sr-only"> dos pedidos do filtro</span>
        </a>
      </div>
    </form>
  );
}

/** Contadores por estado (no período e na modalidade escolhidos); cada um filtra a lista. */
export function StatusCounters({
  slug,
  period,
  filters,
  counts,
}: {
  slug: string;
  period: ResolvedPeriod;
  filters: OrderFilters;
  counts: StatusCounts;
}) {
  const total = ORDER_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const link = (status: OrderFilters["status"]) =>
    `/app/${slug}/pedidos?${ordersQuery(period, { ...filters, status })}`;
  const chip = "inline-flex min-h-9 items-center gap-2 rounded-control border px-3 py-1.5 text-sm transition-colors";
  const items: { key: OrderFilters["status"]; label: string; count: number }[] = [
    { key: "ALL", label: "Todos", count: total },
    ...ORDER_STATUSES.map((status) => ({ key: status, label: TAB_LABELS[status], count: counts[status] })),
  ];
  return (
    <nav aria-label="Pedidos por estado" className="mb-5">
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const active = filters.status === item.key;
          return (
            <li key={item.key}>
              <Link
                href={link(item.key)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  chip,
                  active
                    ? "border-transparent bg-accent text-accent-fg"
                    : "border-line-strong bg-surface text-fg hover:bg-surface-2",
                )}
              >
                {item.label}
                <span className={cn("font-semibold tabular-nums", active ? "text-accent-fg" : "text-muted")}>
                  {item.count}
                </span>
                <span className="sr-only">{item.count === 1 ? " pedido" : " pedidos"}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function ExportNotice({ total }: { total: number }) {
  if (total <= CSV_MAX_ROWS) return null;
  return (
    <div className="mb-5">
      <Alert tone="warning" title="Exportação limitada">
        Este filtro tem {total} pedidos. O CSV inclui os {CSV_MAX_ROWS} mais recentes; reduza o período para exportar
        todos.
      </Alert>
    </div>
  );
}

function placeOf(row: OrderListRow): string {
  const type = FULFILLMENT_LABELS[row.fulfillment_type];
  if (row.fulfillment_type === "DINE_IN" && row.table_label) return `${type} · ${row.table_label}`;
  return type;
}

function paymentOf(row: OrderListRow): string {
  const intent = row.payment_method_intent
    ? (PAYMENT_METHOD_LABELS[row.payment_method_intent] ?? row.payment_method_intent)
    : null;
  const status = PAYMENT_STATUS_LABELS[row.payment_status] ?? row.payment_status;
  return intent ? `${intent} · ${status}` : status;
}

export function OrdersList({
  slug,
  rows,
  timezone,
  filtered,
  detailQuery,
}: {
  slug: string;
  rows: OrderListRow[];
  timezone: string;
  filtered: boolean;
  /** Query string (período + filtros) repassada ao detalhe para o link de voltar. */
  detailQuery: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title={filtered ? "Nenhum pedido encontrado" : "Nenhum pedido neste período"}
        description={
          filtered
            ? "Nenhum pedido combina com os filtros escolhidos. Ajuste o período, a modalidade, o estado ou o número."
            : "Os pedidos aparecem aqui assim que forem criados. Escolha outro período para ver pedidos anteriores."
        }
      />
    );
  }
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      {rows.map((row, index) => (
        <li key={row.id} className={index > 0 ? "border-t border-line" : undefined}>
          <Link
            href={`/app/${slug}/pedidos/${row.id}${detailQuery ? `?${detailQuery}` : ""}`}
            className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7rem_auto] md:gap-x-6"
          >
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums text-fg">Pedido #{row.order_number}</span>
                <Badge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</Badge>
              </span>
              <span className="mt-0.5 block truncate text-sm text-muted">
                {row.customer_name ? row.customer_name : "Cliente não informado"}
              </span>
            </span>
            <span className="col-span-2 row-start-2 text-sm text-muted md:col-span-1 md:row-start-auto">
              {placeOf(row)}
            </span>
            <span className="col-span-2 row-start-3 text-sm text-muted md:col-span-1 md:row-start-auto">
              <span className="block">{formatDateTimeTz(row.created_at, timezone)}</span>
              <span className="block">{paymentOf(row)}</span>
            </span>
            <span className="row-start-1 col-start-2 text-right text-base font-semibold tabular-nums text-fg md:col-start-auto md:row-start-auto">
              {formatCents(row.total_cents)}
            </span>
            <ChevronRight aria-hidden="true" className="hidden size-4 text-muted md:block" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
