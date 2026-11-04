import type { ReactNode } from "react";
import Link from "next/link";
import { ChartColumn, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { paymentMethodName, type DashboardMetrics } from "@/modules/dashboard/types";
import { FULFILLMENT_LABELS, type FulfillmentType } from "@/modules/operations/types";
import { BarList, type BarItem } from "./bar-list";
import { SalesChart } from "./sales-chart";

/**
 * Cores categóricas validadas (paleta de referência do dataviz, passos claro e
 * escuro). Cada modalidade tem sempre a mesma cor; o texto ao lado de cada barra
 * garante que a identidade nunca dependa só da cor.
 */
const VIZ_STYLE = `
.viz-root{--viz-1:#2a78d6;--viz-2:#eb6834;--viz-3:#1baf7a}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .viz-root{--viz-1:#3987e5;--viz-2:#d95926;--viz-3:#199e70}}
:root[data-theme="dark"] .viz-root{--viz-1:#3987e5;--viz-2:#d95926;--viz-3:#199e70}
`;

const FULFILLMENT_COLORS: Record<FulfillmentType, string> = {
  DELIVERY: "var(--viz-1)",
  PICKUP: "var(--viz-2)",
  DINE_IN: "var(--viz-3)",
};

const integer = new Intl.NumberFormat("pt-BR");
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

/**
 * Variação contra o período anterior. Sem período anterior (ou sem base para
 * comparar) não mostra percentual: nada de número inventado.
 */
function Delta({
  current,
  previous,
  comparedTo,
}: {
  current: number;
  previous: number | null;
  comparedTo: string;
}) {
  if (previous === null) return null;
  if (previous <= 0) {
    return current > 0 ? <p className="mt-2 text-xs text-muted">Sem vendas em {comparedTo} para comparar.</p> : null;
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) {
    return <p className="mt-2 text-xs text-muted">Igual a {comparedTo}.</p>;
  }
  const up = pct > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
      <Badge tone={up ? "accent" : "danger"}>
        <Icon aria-hidden="true" className="mr-1 size-3.5" />
        {up ? "+" : "-"}
        {percent.format(Math.abs(pct))}%
      </Badge>
      <span>{up ? "a mais" : "a menos"} que {comparedTo}</span>
    </p>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "attention";
  href?: string;
}) {
  const body = (
    <>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold tabular-nums text-fg">{value}</dd>
      {hint ? <dd className="mt-1 text-xs leading-relaxed text-muted">{hint}</dd> : null}
    </>
  );
  const box = cn(
    "block rounded-card border p-4",
    tone === "attention" ? "border-transparent bg-warning-soft [&_*]:!text-warning-soft-fg" : "border-line bg-surface",
  );
  return href ? (
    <Link href={href} className={cn(box, "transition-colors hover:border-line-strong")}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

function MiniStat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</dd>
      {children}
    </div>
  );
}

export function DashboardView({
  metrics,
  previous,
  comparedTo,
  ordersHref,
}: {
  metrics: DashboardMetrics;
  previous: DashboardMetrics | null;
  comparedTo: string;
  ordersHref: string;
}) {
  const m = metrics;
  const hasOrders = m.orders_count > 0;

  const fulfillmentItems: BarItem[] = m.by_fulfillment.map((row) => ({
    key: row.type,
    label: FULFILLMENT_LABELS[row.type],
    detail: `${integer.format(row.orders)} ${row.orders === 1 ? "pedido" : "pedidos"}${
      m.gross_sales_cents > 0 ? ` · ${percent.format((row.sales_cents / m.gross_sales_cents) * 100)}% das vendas` : ""
    }`,
    value: row.sales_cents,
    valueLabel: formatCents(row.sales_cents),
    color: FULFILLMENT_COLORS[row.type],
  }));

  const paymentItems: BarItem[] = m.payment_methods.map((row) => ({
    key: row.method,
    label: paymentMethodName(row.method),
    detail: `${integer.format(row.count)} ${row.count === 1 ? "pagamento" : "pagamentos"}`,
    value: row.amount_cents,
    valueLabel: formatCents(row.amount_cents),
  }));

  const productItems: BarItem[] = m.top_products.map((row, index) => ({
    key: `${index}-${row.name}-${row.variant ?? ""}`,
    label: row.variant ? `${row.name} (${row.variant})` : row.name,
    detail: `${integer.format(row.quantity)} ${row.quantity === 1 ? "unidade" : "unidades"}`,
    value: row.sales_cents,
    valueLabel: formatCents(row.sales_cents),
  }));

  return (
    <div className="viz-root flex flex-col gap-6">
      <style>{VIZ_STYLE}</style>

      <section aria-labelledby="kpi-agora">
        <h2 id="kpi-agora" className="mb-1 text-base font-semibold text-fg">
          Agora
        </h2>
        <p className="mb-3 text-sm text-muted">Situação atual da operação. Não depende do período escolhido.</p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile
            label="Pedidos em andamento"
            value={integer.format(m.in_progress_orders)}
            hint={
              m.in_progress_orders > 0
                ? "Toque para ver e atender os pedidos"
                : "Novos, em preparo, prontos ou em entrega"
            }
            tone={m.in_progress_orders > 0 ? "attention" : "default"}
            href={ordersHref}
          />
          <Tile label="Comandas abertas" value={integer.format(m.open_tabs)} hint="Atendimento no salão" />
          <Tile
            label="Mesas ocupadas"
            value={
              <>
                {integer.format(m.occupied_tables)}
                <span className="text-lg font-normal text-muted"> de {integer.format(m.tables_total)}</span>
              </>
            }
            hint="Mesas ativas do salão"
          />
        </dl>
      </section>

      <section aria-labelledby="kpi-periodo" className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <h2 id="kpi-periodo" className="sr-only">
          No período
        </h2>
        <Card>
          <CardHeader
            as="h3"
            title="Vendas brutas"
            description="Sem pedidos cancelados e recusados, no período escolhido."
          />
          <p className="text-4xl font-semibold tracking-tight tabular-nums text-fg sm:text-5xl">
            {formatCents(m.gross_sales_cents)}
          </p>
          <p className="mt-1 text-sm text-muted">
            {integer.format(m.gross_orders_count)} {m.gross_orders_count === 1 ? "pedido" : "pedidos"}
          </p>
          <Delta
            current={m.gross_sales_cents}
            previous={previous ? previous.gross_sales_cents : null}
            comparedTo={comparedTo}
          />
          <div className="mt-6">
            {hasOrders ? (
              <SalesChart series={m.sales_series} />
            ) : (
              <EmptyState
                icon={<ChartColumn />}
                title="Nenhum pedido neste período"
                description="Escolha outro período para ver as vendas por dia. Os pedidos aparecem aqui assim que forem criados."
                className="border-0 py-8"
              />
            )}
          </div>
        </Card>

        <dl className="grid grid-cols-2 content-start gap-3 lg:grid-cols-1">
          <MiniStat label="Pedidos" value={integer.format(m.orders_count)}>
            <Delta
              current={m.orders_count}
              previous={previous ? previous.orders_count : null}
              comparedTo={comparedTo}
            />
          </MiniStat>
          <MiniStat label="Ticket médio" value={formatCents(m.avg_ticket_cents)}>
            <p className="mt-1 text-xs text-muted">Vendas brutas por pedido</p>
          </MiniStat>
          <MiniStat label="Vendas concluídas" value={formatCents(m.completed_sales_cents)}>
            <p className="mt-1 text-xs text-muted">Somente pedidos concluídos</p>
          </MiniStat>
          <MiniStat label="Cancelados e recusados" value={integer.format(m.cancelled_count + m.rejected_count)}>
            <p className="mt-1 text-xs text-muted">
              {integer.format(m.cancelled_count)} cancelados · {integer.format(m.rejected_count)} recusados
            </p>
          </MiniStat>
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-labelledby="chart-produtos">
          <CardHeader
            as="h2"
            title={<span id="chart-produtos">Produtos mais vendidos</span>}
            description="Os 10 itens com maior valor vendido no período, por variante."
          />
          {productItems.length > 0 ? (
            <BarList items={productItems} label="Produtos mais vendidos" />
          ) : (
            <p className="text-sm text-muted">Nenhum item vendido no período.</p>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card aria-labelledby="chart-modalidade">
            <CardHeader
              as="h2"
              title={<span id="chart-modalidade">Como o cliente pediu</span>}
              description="Vendas por modalidade: entrega, retirada e consumo no local."
            />
            {hasOrders ? (
              <BarList items={fulfillmentItems} label="Vendas por modalidade" />
            ) : (
              <p className="text-sm text-muted">Sem pedidos no período.</p>
            )}
          </Card>

          <Card aria-labelledby="chart-pagamento">
            <CardHeader
              as="h2"
              title={<span id="chart-pagamento">Formas de pagamento registradas</span>}
              description="Pagamentos registrados pela equipe no período (pela data do pagamento)."
            />
            {paymentItems.length > 0 ? (
              <BarList items={paymentItems} label="Pagamentos registrados por forma" />
            ) : (
              <p className="text-sm text-muted">Nenhum pagamento registrado no período.</p>
            )}
          </Card>
        </div>
      </div>

      <p className="text-xs text-muted">
        Faturamento não é lucro: os valores são vendas registradas, sem descontar custos de ingredientes, equipe ou
        taxas. Pedidos cancelados e recusados não entram nas vendas.
      </p>
    </div>
  );
}
