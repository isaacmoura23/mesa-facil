import type { Metadata } from "next";
import Link from "next/link";
import { CustomerSearch, CustomersList } from "@/components/customers/customers-list";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { listCustomers } from "@/modules/customers/queries";
import { customersQuery, parseCustomerFilters } from "@/modules/customers/schemas";
import { makeDateFormatters } from "@/modules/reports/format";
import { getRestaurantTimezone } from "@/modules/reports/queries";

export const metadata: Metadata = { title: "Clientes" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/clientes">) {
  const { slug } = await params;
  const query = await searchParams;
  const { restaurant } = await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });

  const filters = parseCustomerFilters(query);
  const [result, timezone] = await Promise.all([
    listCustomers(restaurant.restaurant_id, filters.q, filters.cursor),
    getRestaurantTimezone(restaurant.restaurant_id),
  ]);
  const dates = makeDateFormatters(timezone);

  const basePath = `/app/${restaurant.slug}/clientes`;
  const withQuery = (qs: string) => (qs ? `${basePath}?${qs}` : basePath);

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Quem pediu no seu restaurante, com quantos pedidos e quanto gastou. Somente consulta."
      />

      <div className="mb-5">
        <Alert tone="info" title="Dados pessoais protegidos">
          O acesso a dados de clientes é registrado. Use as informações apenas para a operação do restaurante.
        </Alert>
      </div>

      <CustomerSearch slug={restaurant.slug} q={filters.q} />

      {result.ok ? (
        <>
          <CustomersList
            slug={restaurant.slug}
            rows={result.data.rows}
            searching={Boolean(filters.q)}
            dates={dates}
          />
          {filters.cursor || result.data.next_cursor ? (
            <nav aria-label="Paginação dos clientes" className="mt-4 flex items-center justify-between gap-3">
              {filters.cursor ? (
                <Link href={withQuery(customersQuery(filters.q))} className={buttonStyles({ variant: "secondary" })}>
                  Voltar ao início
                </Link>
              ) : (
                <span />
              )}
              {result.data.next_cursor ? (
                <Link
                  href={withQuery(customersQuery(filters.q, result.data.next_cursor))}
                  className={buttonStyles({ variant: "secondary" })}
                >
                  Carregar mais
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <Alert tone="danger" title="Não foi possível carregar os clientes">
          {result.message}
        </Alert>
      )}
    </>
  );
}
