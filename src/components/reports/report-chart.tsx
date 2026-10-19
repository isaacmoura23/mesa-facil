import { formatCents } from "@/lib/format";
import type { ReportGroup, ReportKey } from "@/modules/reports/catalog";
import {
  fulfillmentLabel,

  formatCompactCents,
  formatInt,
  formatPeriodLabel,
  formatPeriodShort,
  numberOf,
  orderStatusLabel,
  paymentMethodLabel,
} from "@/modules/reports/format";
import type { ReportData } from "@/modules/reports/schemas";

/**
 * Gráficos simples em HTML/CSS (sem dependência), uma única série na cor de
 * destaque do tema. Sempre acompanham a tabela de dados logo abaixo, que é a
 * alternativa acessível; o gráfico em si é descrito por `aria-label`.
 */

type Bar = { label: string; shortLabel?: string; value: number; text: string };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function ChartFrame({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <figure className="mb-5 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
      <figcaption className="mb-4 text-sm font-semibold text-fg">{title}</figcaption>
      <div role="img" aria-label={`${title}. ${summary} Os dados completos estão na tabela abaixo.`}>
        {children}
      </div>
    </figure>
  );
}

/** Colunas verticais (série no tempo). */
function ColumnChart({
  title,
  bars,
  formatAxis,
}: {
  title: string;
  bars: Bar[];
  formatAxis: (value: number) => string;
}) {
  const max = niceMax(Math.max(...bars.map((bar) => bar.value), 0));
  const peak = bars.reduce((best, bar) => (bar.value > best.value ? bar : best), bars[0]);
  const showAllLabels = bars.length <= 12;
  const last = bars.length - 1;
  const mid = Math.floor(last / 2);

  return (
    <ChartFrame title={title} summary={`Maior valor: ${peak.text} em ${peak.label}.`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div className="flex h-48 flex-col justify-between text-right text-xs tabular-nums text-muted" aria-hidden="true">
          <span>{formatAxis(max)}</span>
          <span>{formatAxis(max / 2)}</span>
          <span>{formatAxis(0)}</span>
        </div>
        <div className="relative h-48" aria-hidden="true">
          <div className="absolute inset-x-0 top-0 border-t border-line" />
          <div className="absolute inset-x-0 top-1/2 border-t border-line" />
          <div className="absolute inset-x-0 bottom-0 border-t border-line-strong" />
          <div className={`relative flex h-full items-end ${bars.length > 62 ? "gap-px" : "gap-0.5"}`}>
            {bars.map((bar, index) => {
              const align =
                index < bars.length * 0.25 ? "left-0" : index > bars.length * 0.75 ? "right-0" : "left-1/2 -translate-x-1/2";
              return (
                <div key={index} className="group relative flex h-full min-w-0 flex-1 items-end">
                  <div
                    className="mx-auto w-full max-w-10 rounded-t-[3px] bg-accent transition-opacity group-hover:opacity-80"
                    style={{ height: `${Math.max(bar.value > 0 ? 1 : 0, (bar.value / max) * 100)}%` }}
                  />
                  <span
                    className={`pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-control bg-fg px-2 py-1 text-xs text-bg shadow-card group-hover:block ${align}`}
                  >
                    {bar.label}: {bar.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div />
        {showAllLabels ? (
          <div className="mt-2 flex gap-0.5 text-center text-xs text-muted" aria-hidden="true">
            {bars.map((bar, index) => (
              <span key={index} className="min-w-0 flex-1 truncate">
                {bar.shortLabel ?? bar.label}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-2 flex justify-between text-xs text-muted" aria-hidden="true">
            <span>{bars[0].shortLabel ?? bars[0].label}</span>
            <span>{bars[mid].shortLabel ?? bars[mid].label}</span>
            <span>{bars[last].shortLabel ?? bars[last].label}</span>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/** Barras horizontais (comparação entre categorias), com rótulo direto. */
function RankedBars({ title, bars }: { title: string; bars: Bar[] }) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);
  const top = bars[0];
  return (
    <ChartFrame title={title} summary={`Maior: ${top.label}, ${top.text}.`}>
      <ul className="flex flex-col gap-3" aria-hidden="true">
        {bars.map((bar, index) => (
          <li key={index}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-fg">{bar.label}</span>
              <span className="shrink-0 tabular-nums font-medium text-fg">{bar.text}</span>
            </div>
            <div className="mt-1 h-2">
              <div
                className="h-full rounded-r-[4px] bg-accent"
                style={{ width: `${max > 0 ? Math.max(bar.value > 0 ? 1 : 0, (bar.value / max) * 100) : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

function productLabel(name: unknown, variant: unknown): string {
  const base = typeof name === "string" ? name : "Item";
  return typeof variant === "string" && variant ? `${base} (${variant})` : base;
}

/** Escolhe o gráfico de cada relatório. Sem dados > 0 não há o que desenhar. */
export function ReportChart({ report, data, group }: { report: ReportKey; data: ReportData; group: ReportGroup }) {
  const { rows } = data;
  if (rows.length === 0) return null;
  const unitWord = group === "week" ? "semana" : group === "month" ? "mês" : "dia";

  if (report === "sales_by_period" || report === "avg_ticket") {
    const key = report === "sales_by_period" ? "sales_cents" : "avg_ticket_cents";
    const bars: Bar[] = rows.map((row) => {
      const value = numberOf(row[key]);
      const period = String(row.period ?? "");
      return {
        label: formatPeriodLabel(period, group),
        shortLabel: formatPeriodShort(period, group),
        value,
        text: formatCents(value),
      };
    });
    if (bars.every((bar) => bar.value === 0)) return null;
    return (
      <ColumnChart
        title={report === "sales_by_period" ? `Faturamento bruto por ${unitWord}` : `Ticket médio por ${unitWord}`}
        bars={bars}
        formatAxis={formatCompactCents}
      />
    );
  }

  if (report === "orders_by_fulfillment") {
    const bars: Bar[] = rows.map((row) => {
      const value = numberOf(row.sales_cents);
      const orders = numberOf(row.orders);
      return {
        label: fulfillmentLabel(String(row.type ?? "")),
        value,
        text: `${formatCents(value)} (${formatInt(orders)} ${orders === 1 ? "pedido" : "pedidos"})`,
      };
    });
    if (bars.every((bar) => bar.value === 0)) return null;
    return <RankedBars title="Faturamento bruto por tipo de pedido" bars={bars} />;
  }

  if (report === "top_products") {
    const bars: Bar[] = rows.slice(0, 10).map((row) => {
      const value = numberOf(row.sales_cents);
      return {
        label: productLabel(row.name, row.variant),
        value,
        text: `${formatCents(value)} (${formatInt(numberOf(row.quantity))} un.)`,
      };
    });
    if (bars.every((bar) => bar.value === 0)) return null;
    return <RankedBars title="Faturamento dos 10 itens mais vendidos" bars={bars} />;
  }

  if (report === "cancellations") {
    const bars: Bar[] = rows.slice(0, 8).map((row) => {
      const count = numberOf(row.count);
      return {
        label: `${orderStatusLabel(String(row.status ?? ""))}: ${String(row.reason ?? "")}`,
        value: count,
        text: `${formatInt(count)} ${count === 1 ? "pedido" : "pedidos"}`,
      };
    });
    return <RankedBars title="Motivos mais frequentes" bars={bars} />;
  }

  if (report === "payment_methods") {
    const bars: Bar[] = rows.map((row) => {
      const value = numberOf(row.amount_cents);
      const count = numberOf(row.count);
      return {
        label: paymentMethodLabel(String(row.method ?? "")),
        value,
        text: `${formatCents(value)} (${formatInt(count)} ${count === 1 ? "pagamento" : "pagamentos"})`,
      };
    });
    if (bars.every((bar) => bar.value === 0)) return null;
    return <RankedBars title="Valor recebido por forma de pagamento" bars={bars} />;
  }

  return null;
}
