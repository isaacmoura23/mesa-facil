import type { ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
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

function Stat({
  label,
  value,
  hint,
  large,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={
          large
            ? "mt-1 text-3xl font-semibold tracking-tight tabular-nums text-fg sm:text-4xl"
            : "mt-1 text-2xl font-semibold tabular-nums text-fg"
        }
      >
        {value}
      </dd>
      {hint ? <dd className="mt-1 text-xs leading-relaxed text-muted">{hint}</dd> : null}
    </div>
  );
}

export function DashboardView({ metrics }: { metrics: DashboardMetrics }) {
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

      <Alert tone="info" title="Faturamento não é lucro">
        Os valores abaixo são vendas registradas, sem descontar custos de ingredientes, equipe ou taxas. Pedidos
        cancelados e recusados não entram nas vendas.
      </Alert>

      <Card aria-labelledby="kpi-periodo">
        <CardHeader as="h2" title={<span id="kpi-periodo">No período</span>} description="Pedidos criados dentro do período escolhido." />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
          <Stat
            large
            className="col-span-2 lg:col-span-2"
            label="Vendas brutas"
            value={formatCents(m.gross_sales_cents)}
            hint={`${integer.format(m.gross_orders_count)} ${m.gross_orders_count === 1 ? "pedido" : "pedidos"} sem cancelados e recusados`}
          />
          <Stat label="Pedidos" value={integer.format(m.orders_count)} hint="Todos os estados" />
          <Stat label="Ticket médio" value={formatCents(m.avg_ticket_cents)} hint="Vendas brutas por pedido" />
          <Stat
            label="Vendas concluídas"
            value={formatCents(m.completed_sales_cents)}
            hint="Somente pedidos concluídos"
          />
          <Stat label="Cancelados" value={integer.format(m.cancelled_count)} />
          <Stat label="Recusados" value={integer.format(m.rejected_count)} />
        </dl>
      </Card>

      <Card aria-labelledby="kpi-agora">
        <CardHeader
          as="h2"
          title={<span id="kpi-agora">Agora</span>}
          description="Situação atual da operação. Não depende do período escolhido."
        />
        <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Stat label="Pedidos em andamento" value={integer.format(m.in_progress_orders)} hint="Novos, em preparo, prontos ou em entrega" />
          <Stat label="Comandas abertas" value={integer.format(m.open_tabs)} />
          <Stat
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
      </Card>

      <Card aria-labelledby="chart-vendas">
        <CardHeader
          as="h2"
          title={<span id="chart-vendas">Vendas por dia</span>}
          description="Vendas brutas por dia, no horário do restaurante."
        />
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
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-labelledby="chart-modalidade">
          <CardHeader
            as="h2"
            title={<span id="chart-modalidade">Vendas por modalidade</span>}
            description="Entrega, retirada e consumo no local."
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
    </div>
  );
}
