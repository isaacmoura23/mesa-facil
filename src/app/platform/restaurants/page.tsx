import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { NewRestaurantForm } from "@/components/platform-restaurants/new-restaurant-form";
import { RestaurantsTable } from "@/components/platform-restaurants/restaurants-table";
import { RESTAURANT_STATUS_LABEL } from "@/modules/platform-restaurants/labels";
import { isSuperadmin, listRestaurants } from "@/modules/platform-restaurants/queries";
import { encodeCursor, parseListParams } from "@/modules/platform-restaurants/schemas";

export const metadata: Metadata = { title: "Restaurantes (plataforma)" };

function href(params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return query ? `/platform/restaurants?${query}` : "/platform/restaurants";
}

export default async function Page({ searchParams }: PageProps<"/platform/restaurants">) {
  await requirePlatformAdmin("/platform/restaurants");
  const { q, status, cursor } = parseListParams(await searchParams);
  const [canWrite, result] = await Promise.all([isSuperadmin(), listRestaurants({ q, status, cursor })]);
  const filtered = Boolean(q || status);

  return (
    <>
      <PageHeader
        title="Restaurantes"
        description="Metadados e situação dos restaurantes. Dados operacionais só ficam visíveis em sessão de suporte."
      />

      <div className="mb-6">
        <NewRestaurantForm canWrite={canWrite} />
      </div>

      <form method="get" role="search" className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor="q" className="text-sm font-medium text-fg">Buscar por nome ou endereço</label>
          <input id="q" name="q" type="search" defaultValue={q} maxLength={80} autoComplete="off" className={inputStyles()} />
        </div>
        <div className="flex flex-col gap-2 sm:w-56">
          <label htmlFor="status" className="text-sm font-medium text-fg">Situação</label>
          <select id="status" name="status" defaultValue={status} className={inputStyles()}>
            <option value="">Todas</option>
            {Object.entries(RESTAURANT_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonStyles({ variant: "secondary" })}>
          <Search aria-hidden="true" className="size-4" />
          Filtrar
        </button>
        {filtered ? (
          <Link href="/platform/restaurants" className={buttonStyles({ variant: "ghost" })}>
            Limpar
          </Link>
        ) : null}
      </form>

      {result.ok ? (
        <>
          <RestaurantsTable rows={result.data.rows} filtered={filtered} />
          {cursor || result.data.next_cursor ? (
            <nav aria-label="Paginação" className="mt-4 flex items-center justify-between gap-3">
              {cursor ? (
                <Link href={href({ q, status })} className={buttonStyles({ variant: "secondary", size: "sm" })}>
                  Voltar ao início
                </Link>
              ) : <span />}
              {result.data.next_cursor ? (
                <Link
                  href={href({ q, status, cursor: encodeCursor(result.data.next_cursor) })}
                  className={buttonStyles({ variant: "secondary", size: "sm" })}
                >
                  Próxima página
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <Alert tone="danger" title="Não foi possível carregar os restaurantes">
          {result.message}
        </Alert>
      )}
    </>
  );
}
