import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ExportNotice, OrdersFilters, OrdersList, StatusCounters } from "@/components/dashboard/orders-list";
import { PeriodFilter } from "@/components/dashboard/period-filter";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import {
  decodeCursor,
  formatTimeTz,
  hasActiveFilters,
  ordersQuery,
  parseOrderFilters,
} from "@/modules/dashboard/orders";
import { getStatusCounts, listOrders } from "@/modules/dashboard/orders-queries";
import { describePeriod, firstParam, periodFromParams } from "@/modules/dashboard/period-params";
import { getRestaurantTimezone } from "@/modules/dashboard/queries";
import { ORDER_STATUSES } from "@/modules/operations/types";

export const metadata: Metadata = { title: "Pedidos" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/pedidos">) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "orders.view" });
  const { restaurant } = access;

  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const period = periodFromParams(query, timezone, "today");
  const filters = parseOrderFilters(query);
  const cursor = decodeCursor(firstParam(query.cursor));
  const filtered = hasActiveFilters(filters);

  const [list, counts] = await Promise.all([
    listOrders(restaurant.restaurant_id, period, filters, cursor),
    getStatusCounts(restaurant.restaurant_id, period, filters),
  ]);

  const basePath = `/app/${restaurant.slug}/pedidos`;
  const baseQuery = ordersQuery(period, filters);
  const withCursor = (value: string | null) => `${basePath}?${ordersQuery(period, filters, { cursor: value })}`;
  const total = counts.ok
    ? filters.status === "ALL"
      ? ORDER_STATUSES.reduce((sum, status) => sum + counts.data[status], 0)
      : counts.data[filters.status]
    : 0;
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Pedidos"
        description="Acompanhe os pedidos do restaurante: estado, itens, pagamento declarado e histórico."
        actions={<AutoRefresh generatedAt={now.toISOString()} timeLabel={formatTimeTz(now.toISOString(), period.timezone)} />}
      />

      <div className="mb-6">
        <Alert tone="info" title="Monitoramento">
          Esta área é somente leitura. A operação (aceitar, recusar, preparar, entregar, cancelar e imprimir) é feita
          pela equipe em <span className="font-medium">/operacao</span>.
        </Alert>
      </div>

      <PeriodFilter
        basePath={basePath}
        preset={period.preset}
        fromDate={period.fromDate}
        toDate={period.toDate}
        summary={describePeriod(period)}
        fellBack={period.fellBack}
        extra={Object.fromEntries(
          Object.entries({
            fulfillment: filters.fulfillment === "ALL" ? "" : filters.fulfillment,
            status: filters.status === "ALL" ? "" : filters.status,
            number: filters.number,
          }).filter(([, value]) => value),
        )}
      />

      <OrdersFilters slug={restaurant.slug} period={period} filters={filters} exportQuery={baseQuery} />

      {counts.ok ? (
        <>
          <StatusCounters slug={restaurant.slug} period={period} filters={filters} counts={counts.data} />
          <ExportNotice total={total} />
          <p className="mb-3 text-sm text-muted" role="status" aria-live="polite">
            {total} {total === 1 ? "pedido" : "pedidos"} no filtro
          </p>
        </>
      ) : null}

      {list.ok ? (
        <>
          <OrdersList
            slug={restaurant.slug}
            rows={list.data.rows}
            timezone={period.timezone}
            filtered={filtered}
            detailQuery={baseQuery}
          />
          {cursor || list.data.nextCursor ? (
            <nav aria-label="Paginação dos pedidos" className="mt-4 flex items-center justify-between gap-3">
              {cursor ? (
                <Link href={withCursor(null)} className={buttonStyles({ variant: "secondary" })}>
                  Voltar ao início
                </Link>
              ) : (
                <span />
              )}
              {list.data.nextCursor ? (
                <Link href={withCursor(list.data.nextCursor)} className={buttonStyles({ variant: "secondary" })}>
                  Pedidos mais antigos
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <Alert tone="danger" title="Não foi possível carregar os pedidos">
          {list.message}
        </Alert>
      )}
    </>
  );
}
