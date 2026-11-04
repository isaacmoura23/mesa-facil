import type { Metadata } from "next";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { PeriodFilter } from "@/components/dashboard/period-filter";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { STATUS_LABELS } from "@/lib/auth/permissions";
import { comparisonLabel, describePeriod, periodFromParams, previousPeriod } from "@/modules/dashboard/period-params";
import { getDashboardMetrics, getRestaurantTimezone } from "@/modules/dashboard/queries";
import { formatTimeTz } from "@/modules/dashboard/orders";

export const metadata: Metadata = { title: "Visão geral" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/dashboard">) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });
  const { restaurant } = access;

  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const period = periodFromParams(query, timezone, "7d");
  const previous = previousPeriod(period);
  const [result, previousResult] = await Promise.all([
    getDashboardMetrics(restaurant.restaurant_id, period),
    previous ? getDashboardMetrics(restaurant.restaurant_id, previous) : Promise.resolve(null),
  ]);
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Visão geral"
        description={`Vendas e operação de ${restaurant.name}, somente leitura.`}
        badge={
          <Badge tone={restaurant.status === "active" ? "accent" : "warning"}>{STATUS_LABELS[restaurant.status]}</Badge>
        }
        actions={<AutoRefresh generatedAt={now.toISOString()} timeLabel={formatTimeTz(now.toISOString(), period.timezone)} />}
      />

      <PeriodFilter
        basePath={`/app/${restaurant.slug}/dashboard`}
        preset={period.preset}
        fromDate={period.fromDate}
        toDate={period.toDate}
        summary={describePeriod(period)}
        fellBack={period.fellBack}
      />

      {result.ok ? (
        <DashboardView
          metrics={result.data}
          previous={previousResult?.ok ? previousResult.data : null}
          comparedTo={comparisonLabel(period)}
          ordersHref={`/app/${restaurant.slug}/pedidos`}
        />
      ) : (
        <Alert tone="danger" title="Não foi possível carregar os indicadores">
          {result.message}
        </Alert>
      )}
    </>
  );
}
