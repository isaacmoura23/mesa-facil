import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { ReportChart } from "@/components/reports/report-chart";
import { ReportFilterForm, ReportPicker } from "@/components/reports/report-filters";
import { ReportSummary, ReportTable } from "@/components/reports/report-table";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { REPORTS } from "@/modules/reports/catalog";
import { formatYmd } from "@/modules/reports/format";
import { fetchReport, getRestaurantTimezone } from "@/modules/reports/queries";
import { parseReportFilters } from "@/modules/reports/schemas";

export const metadata: Metadata = { title: "Relatórios" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/relatorios">) {
  const { slug } = await params;
  const query = await searchParams;
  const { restaurant } = await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });

  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const filters = parseReportFilters(query, timezone);
  const { report, group, period } = filters;
  const result = await fetchReport(restaurant.restaurant_id, report, period, group);

  const periodLabel = `${formatYmd(period.fromDate)} a ${formatYmd(period.toDate)}`;
  const meta = REPORTS[report];

  return (
    <>
      <PageHeader
        title="Relatórios"
        description="Faturamento e operação do restaurante por período. Os valores são de faturamento, não de lucro: custos não são considerados."
      />

      {filters.warnings.length > 0 ? (
        <div className="mb-5 flex flex-col gap-2">
          {filters.warnings.map((warning) => (
            <Alert key={warning} tone="warning">
              {warning}
            </Alert>
          ))}
        </div>
      ) : null}

      <ReportPicker slug={restaurant.slug} filters={filters} />
      <ReportFilterForm slug={restaurant.slug} filters={filters} />

      <section aria-labelledby="report-title">
        <h2 id="report-title" className="text-lg font-semibold text-fg">
          {meta.label}
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          {meta.description} Período: {periodLabel}.
        </p>

        {!result.ok ? (
          <Alert tone="danger" title="Não foi possível carregar o relatório">
            {result.message}
          </Alert>
        ) : result.data.rows.length === 0 ? (
          <EmptyState
            icon={<BarChart3 />}
            title="Sem dados neste período"
            description="Nenhum registro foi encontrado para o período escolhido. Tente um intervalo maior."
          />
        ) : (
          <>
            {result.data.truncated ? (
              <div className="mb-4">
                <Alert tone="warning" title="Resultado limitado">
                  O relatório tem mais de 5.000 linhas e foi limitado. Reduza o período para ver tudo.
                </Alert>
              </div>
            ) : null}
            <ReportSummary report={report} data={result.data} />
            <ReportChart report={report} data={result.data} group={group} />
            <ReportTable report={report} data={result.data} group={group} periodLabel={periodLabel} />
          </>
        )}
      </section>
    </>
  );
}
