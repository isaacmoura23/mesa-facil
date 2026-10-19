import { requireRestaurantAccess } from "@/lib/auth/guards";
import { CSV_MAX_ROWS, csvCell, formatCsvDateTime, parseOrderFilters } from "@/modules/dashboard/orders";
import { listOrdersForCsv } from "@/modules/dashboard/orders-queries";
import { periodFromParams } from "@/modules/dashboard/period-params";
import { getRestaurantTimezone } from "@/modules/dashboard/queries";
import { FULFILLMENT_LABELS, PAYMENT_METHOD_LABELS, STATUS_LABELS } from "@/modules/operations/types";

/**
 * Exporta (CSV) os pedidos do filtro. Somente leitura; exige `orders.view`.
 * Separador ";", vírgula decimal e BOM UTF-8 para abrir direto no Excel em pt-BR.
 * No máximo {@link CSV_MAX_ROWS} linhas (as mais recentes).
 */
export async function GET(request: Request, { params }: RouteContext<"/app/[slug]/pedidos/export">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "orders.view" });
  const { restaurant } = access;

  const query = Object.fromEntries(new URL(request.url).searchParams);
  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const period = periodFromParams(query, timezone, "today");
  const filters = parseOrderFilters(query);

  const result = await listOrdersForCsv(restaurant.restaurant_id, period, filters);
  if (!result.ok) {
    return new Response("Não foi possível gerar o arquivo agora. Tente novamente.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const header = ["Número", "Data e hora", "Modalidade", "Estado", "Total (R$)", "Forma de pagamento"];
  const lines = [header.map(csvCell).join(";")];
  for (const row of result.data.rows) {
    lines.push(
      [
        String(row.order_number),
        formatCsvDateTime(row.created_at, period.timezone),
        FULFILLMENT_LABELS[row.fulfillment_type],
        STATUS_LABELS[row.status],
        (row.total_cents / 100).toFixed(2).replace(".", ","),
        row.payment_method_intent ? (PAYMENT_METHOD_LABELS[row.payment_method_intent] ?? row.payment_method_intent) : "",
      ]
        .map(csvCell)
        .join(";"),
    );
  }

  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pedidos-${restaurant.slug}-${period.fromDate}_${period.toDate}.csv"`,
      "Cache-Control": "no-store",
      ...(result.data.truncated ? { "X-Export-Truncated": String(CSV_MAX_ROWS) } : {}),
    },
  });
}
