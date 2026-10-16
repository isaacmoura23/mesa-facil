import type { Metadata } from "next";
import Link from "next/link";
import { RefreshOnFocus } from "@/components/tables-admin/live";
import { TabsFilters, TabsList } from "@/components/tables-admin/tabs-list";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { decodeCursor } from "@/modules/tables-admin/cursor";
import { getTableOptions, listTabs } from "@/modules/tables-admin/queries";
import { EMPTY_FILTERS, filtersToQuery, parseTabFilters } from "@/modules/tables-admin/schemas";

export const metadata: Metadata = { title: "Comandas" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/comandas">) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "tabs.view" });
  const { restaurant } = access;

  const filters = parseTabFilters(query);
  const rawCursor = Array.isArray(query.cursor) ? query.cursor[0] : query.cursor;
  const cursor = decodeCursor(rawCursor);
  const filtered = filtersToQuery(filters) !== filtersToQuery(EMPTY_FILTERS);

  const tables = await getTableOptions(restaurant.restaurant_id);
  const result = await listTabs(restaurant.restaurant_id, filters, cursor, tables, {
    orders: access.can("orders.view"),
    payments: access.canAny(["reports.view", "payments.record"]),
  });

  const basePath = `/app/${restaurant.slug}/comandas`;
  const withQuery = (extra: Record<string, string | null>) => {
    const qs = filtersToQuery(filters, extra);
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <>
      <PageHeader
        title="Comandas"
        description="Acompanhe as comandas abertas e o histórico das fechadas, com pedidos e pagamentos."
      />

      <div className="mb-6">
        <Alert tone="info" title="Monitoramento">
          Esta área é somente leitura. A operação (abrir, lançar pedidos, receber e fechar) é feita pela
          equipe em <span className="font-medium">/operacao</span>.
        </Alert>
      </div>

      <RefreshOnFocus />
      <TabsFilters slug={restaurant.slug} filters={filters} tables={tables} filtered={filtered} />

      {result.ok ? (
        <>
          <TabsList slug={restaurant.slug} items={result.data.items} filtered={filtered} />
          {cursor || result.data.nextCursor ? (
            <nav aria-label="Paginação das comandas" className="mt-4 flex items-center justify-between gap-3">
              {cursor ? (
                <Link href={withQuery({})} className={buttonStyles({ variant: "secondary" })}>
                  Voltar ao início
                </Link>
              ) : (
                <span />
              )}
              {result.data.nextCursor ? (
                <Link href={withQuery({ cursor: result.data.nextCursor })} className={buttonStyles({ variant: "secondary" })}>
                  Comandas mais antigas
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <Alert tone="danger" title="Não foi possível carregar as comandas">
          {result.message}
        </Alert>
      )}
    </>
  );
}
