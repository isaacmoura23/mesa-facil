import Link from "next/link";
import { Mail, Phone, Search, Users } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import { formatInt, type DateFormatters } from "@/modules/reports/format";
import { SEARCH_MAX, type CustomerRow } from "@/modules/customers/schemas";

const displayName = (row: CustomerRow) => row.name?.trim() || "Cliente sem nome";

/** Busca por GET (nome ou telefone): funciona sem JavaScript e fica na URL. */
export function CustomerSearch({ slug, q }: { slug: string; q: string }) {
  return (
    <form
      method="get"
      role="search"
      aria-label="Buscar clientes"
      className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:flex-row sm:items-end"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor="c-q" className="text-sm font-medium text-fg">
          Nome ou telefone
        </label>
        <input
          id="c-q"
          type="search"
          name="q"
          defaultValue={q}
          maxLength={SEARCH_MAX}
          autoComplete="off"
          placeholder="Ex.: Maria ou 11 98765"
          className={inputStyles()}
        />
      </div>
      <div className="flex gap-2">
        <button type="submit" className={buttonStyles({ variant: "primary", className: "flex-1 sm:flex-none" })}>
          <Search aria-hidden="true" className="size-4" />
          Buscar
        </button>
        {q ? (
          <Link
            href={`/app/${slug}/clientes`}
            className={buttonStyles({ variant: "ghost", className: "flex-1 sm:flex-none" })}
          >
            Limpar
          </Link>
        ) : null}
      </div>
    </form>
  );
}

export function CustomersList({
  slug,
  rows,
  searching,
  dates,
}: {
  slug: string;
  rows: CustomerRow[];
  searching: boolean;
  dates: DateFormatters;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title={searching ? "Nenhum cliente encontrado" : "Ainda não há clientes"}
        description={
          searching
            ? "Nenhum cliente combina com a busca. Confira o nome ou o telefone."
            : "Os clientes aparecem aqui assim que fizerem o primeiro pedido."
        }
      />
    );
  }

  return (
    <>
      {/* Telas médias e maiores: tabela */}
      <div className="hidden overflow-x-auto rounded-card border border-line bg-surface shadow-card md:block">
        <table className="w-full border-collapse">
          <caption className="sr-only">Clientes do restaurante</caption>
          <thead>
            <tr className="border-b border-line-strong bg-surface-2 text-xs font-semibold text-muted">
              <th scope="col" className="px-4 py-2.5 text-left">
                Nome
              </th>
              <th scope="col" className="px-3 py-2.5 text-left">
                Telefone
              </th>
              <th scope="col" className="px-3 py-2.5 text-left">
                E-mail
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                Pedidos
              </th>
              <th scope="col" className="px-3 py-2.5 text-left">
                Último pedido
              </th>
              <th scope="col" className="px-4 py-2.5 text-right">
                Total gasto
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-sm text-fg">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-surface-2">
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  <Link
                    href={`/app/${slug}/clientes/${row.id}`}
                    prefetch={false}
                    className="rounded-control underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {displayName(row)}
                  </Link>
                </th>
                <td className="px-3 py-3 whitespace-nowrap">{row.phone || "-"}</td>
                <td className="max-w-[16rem] truncate px-3 py-3" title={row.email ?? undefined}>
                  {row.email || "-"}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{formatInt(row.orders_count)}</td>
                <td className="px-3 py-3 whitespace-nowrap">{dates.date(row.last_order_at)}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{formatCents(row.total_spent_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Celular: cartões */}
      <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-card md:hidden">
        {rows.map((row, index) => (
          <li key={row.id} className={index > 0 ? "border-t border-line" : undefined}>
            <Link
              href={`/app/${slug}/clientes/${row.id}`}
                    prefetch={false}
              className="block px-4 py-3.5 transition-colors hover:bg-surface-2"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-fg">{displayName(row)}</span>
                <span className="shrink-0 font-semibold tabular-nums text-fg">{formatCents(row.total_spent_cents)}</span>
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                <Phone aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{row.phone || "Sem telefone"}</span>
              </span>
              {row.email ? (
                <span className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                  <Mail aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{row.email}</span>
                </span>
              ) : null}
              <span className="mt-1 block text-sm text-muted">
                {formatInt(row.orders_count)} {row.orders_count === 1 ? "pedido" : "pedidos"}
                {row.last_order_at ? `, último em ${dates.date(row.last_order_at)}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
