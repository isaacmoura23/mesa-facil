import { requireRestaurantAccess } from "@/lib/auth/guards";
import { buildReportCsv } from "@/modules/reports/csv";
import { fetchReport, getRestaurantTimezone } from "@/modules/reports/queries";
import { parseReportFilters } from "@/modules/reports/schemas";

/**
 * Exporta (CSV) qualquer relatório com o filtro da URL. Somente leitura;
 * exige `reports.view`. Os relatórios são agregados: sem dados pessoais.
 * Separador ";", BOM UTF-8, vírgula decimal, proteção contra injeção de fórmula.
 */
export async function GET(request: Request, { params }: RouteContext<"/app/[slug]/relatorios/export">) {
  const { slug } = await params;
  const { restaurant } = await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });

  const url = new URL(request.url);
  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const filters = parseReportFilters(Object.fromEntries(url.searchParams), timezone);

  const result = await fetchReport(restaurant.restaurant_id, filters.report, filters.period, filters.group);
  if (!result.ok) {
    return new Response(result.message, {
      status: result.code === "FORBIDDEN" ? 403 : 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const name = `relatorio-${filters.report}-${restaurant.slug}-${filters.period.fromDate}_${filters.period.toDate}.csv`;
  return new Response(buildReportCsv(result.data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
