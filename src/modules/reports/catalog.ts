/** Catálogo dos relatórios (rótulos, descrição e comportamento de cada um). */

export const REPORT_KEYS = [
  "sales_by_period",
  "orders_by_fulfillment",
  "top_products",
  "avg_ticket",
  "cancellations",
  "fees_discounts",
  "payment_methods",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_GROUPS = [
  { value: "day", label: "Por dia" },
  { value: "week", label: "Por semana" },
  { value: "month", label: "Por mês" },
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number]["value"];

export const DEFAULT_REPORT: ReportKey = "sales_by_period";

export type ReportMeta = {
  label: string;
  description: string;
  /** Aceita `p_group` (série por período). */
  grouped: boolean;
};

export const REPORTS: Record<ReportKey, ReportMeta> = {
  sales_by_period: {
    label: "Vendas por período",
    description: "Pedidos e faturamento bruto ao longo do tempo. Não inclui pedidos cancelados ou recusados.",
    grouped: true,
  },
  orders_by_fulfillment: {
    label: "Pedidos por tipo",
    description: "Entrega, retirada e consumo no local: quantidade, faturamento e ticket médio.",
    grouped: false,
  },
  top_products: {
    label: "Produtos mais vendidos",
    description:
      "Itens vendidos no período, do maior para o menor faturamento. Não inclui pedidos cancelados ou recusados.",
    grouped: false,
  },
  avg_ticket: {
    label: "Ticket médio",
    description: "Valor médio por pedido em cada período.",
    grouped: true,
  },
  cancellations: {
    label: "Cancelamentos e recusas",
    description: "Pedidos cancelados ou recusados, agrupados pelo motivo informado.",
    grouped: false,
  },
  fees_discounts: {
    label: "Taxas e descontos",
    description: "Subtotal, taxas de entrega e descontos concedidos em cada período.",
    grouped: true,
  },
  payment_methods: {
    label: "Formas de pagamento",
    description: "Pagamentos confirmados (pagos) no período, por forma de pagamento.",
    grouped: false,
  },
};

export function isReportKey(value: unknown): value is ReportKey {
  return typeof value === "string" && (REPORT_KEYS as readonly string[]).includes(value);
}

export function isReportGroup(value: unknown): value is ReportGroup {
  return typeof value === "string" && REPORT_GROUPS.some((group) => group.value === value);
}
