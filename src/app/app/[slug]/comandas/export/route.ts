import { requireRestaurantAccess } from "@/lib/auth/guards";
import { formatFullDateTime } from "@/modules/tables-admin/format";
import { getTableOptions, getTabsForCsv } from "@/modules/tables-admin/queries";
import { parseTabFilters } from "@/modules/tables-admin/schemas";
import { TAB_STATUS_LABELS } from "@/modules/tables-admin/format";
import type { TabStatus } from "@/modules/tables-admin/types";

/**
 * Exporta (CSV) as comandas do filtro. Somente leitura; exige `tabs.view`.
 * Separador ";" e BOM UTF-8 para abrir direto no Excel em pt-BR.
 */

/** Neutraliza injeção de fórmula (=, +, -, @, tab, CR) e escapa aspas. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(request: Request, { params }: RouteContext<"/app/[slug]/comandas/export">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "tabs.view" });
  const { restaurant } = access;

  const url = new URL(request.url);
  const filters = parseTabFilters(Object.fromEntries(url.searchParams));
  const tables = await getTableOptions(restaurant.restaurant_id);
  const result = await getTabsForCsv(restaurant.restaurant_id, filters, tables, {
    orders: access.can("orders.view"),
    payments: access.canAny(["reports.view", "payments.record"]),
  });
  if (!result.ok) {
    return new Response("Não foi possível gerar o arquivo agora. Tente novamente.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const header = ["Comanda", "Mesa / identificação", "Estado", "Abertura", "Fechamento", "Total (R$)", "Forma de pagamento"];
  const lines = [header.map(csvCell).join(";")];
  for (const row of result.data.rows) {
    lines.push(
      [
        row.code,
        row.place,
        TAB_STATUS_LABELS[row.status as TabStatus] ?? row.status,
        formatFullDateTime(row.openedAt),
        row.closedAt ? formatFullDateTime(row.closedAt) : "",
        row.total,
        row.methods,
      ]
        .map(csvCell)
        .join(";"),
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="comandas-${restaurant.slug}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
