import Link from "next/link";
import { Building2, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  RESTAURANT_STATUS_LABEL,
  RESTAURANT_STATUS_TONE,
  SUBSCRIPTION_STATUS_LABEL,
  SUBSCRIPTION_STATUS_TONE,
} from "@/modules/platform-restaurants/labels";
import type { RestaurantRow } from "@/modules/platform-restaurants/types";

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={RESTAURANT_STATUS_TONE[status] ?? "neutral"}>{RESTAURANT_STATUS_LABEL[status] ?? status}</Badge>;
}

function SubscriptionBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted">Sem assinatura</span>;
  return <Badge tone={SUBSCRIPTION_STATUS_TONE[status] ?? "neutral"}>{SUBSCRIPTION_STATUS_LABEL[status] ?? status}</Badge>;
}

function Owner({ row }: { row: RestaurantRow }) {
  if (!row.owner_email && !row.owner_name) return <span className="text-muted">Sem dono</span>;
  return (
    <span className="block min-w-0">
      <span className="block truncate text-fg">{row.owner_name ?? row.owner_email}</span>
      {row.owner_name && row.owner_email ? <span className="block truncate text-xs text-muted">{row.owner_email}</span> : null}
    </span>
  );
}

export function RestaurantsTable({ rows, filtered }: { rows: RestaurantRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Building2 />}
        title={filtered ? "Nenhum restaurante encontrado" : "Nenhum restaurante cadastrado"}
        description={
          filtered
            ? "Ajuste a busca ou o filtro de situação para ver outros resultados."
            : "Use Novo restaurante para criar o primeiro."
        }
      />
    );
  }

  return (
    <>
      {/* Telas pequenas: um cartão por restaurante */}
      <ul className="flex flex-col gap-3 md:hidden" aria-label="Restaurantes">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/platform/restaurants/${row.id}`}
              className="block rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-fg">{row.name}</p>
                  <p className="truncate text-sm text-muted">{row.slug}</p>
                </div>
                <StatusBadge status={row.status} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Plano</dt>
                  <dd className="text-fg">{row.plan_name ?? "Sem plano"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Assinatura</dt>
                  <dd><SubscriptionBadge status={row.subscription_status} /></dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Equipe</dt>
                  <dd className="text-fg tabular-nums">{row.members_count}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Dono</dt>
                  <dd><Owner row={row} /></dd>
                </div>
              </dl>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-card border border-line bg-surface shadow-card md:block">
        <table className="w-full table-fixed text-left text-sm">
          <caption className="sr-only">Restaurantes da plataforma</caption>
          <thead className="bg-surface-2 text-xs text-muted">
            <tr>
              <th scope="col" className="w-[24%] px-4 py-3 font-medium">Nome</th>
              <th scope="col" className="w-[13%] px-4 py-3 font-medium">Slug</th>
              <th scope="col" className="w-[12%] px-4 py-3 font-medium">Situação</th>
              <th scope="col" className="w-[11%] px-4 py-3 font-medium">Plano</th>
              <th scope="col" className="w-[12%] px-4 py-3 font-medium">Assinatura</th>
              <th scope="col" className="w-[8%] px-4 py-3 font-medium">Equipe</th>
              <th scope="col" className="px-4 py-3 font-medium">Dono</th>
              <th scope="col" className="w-10 px-2 py-3"><span className="sr-only">Abrir</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-surface-2/60">
                <th scope="row" className="px-4 py-3 font-medium text-fg">
                  <Link
                    href={`/platform/restaurants/${row.id}`}
                    className="block truncate underline-offset-2 hover:underline"
                    title={row.name}
                  >
                    {row.name}
                  </Link>
                </th>
                <td className="truncate px-4 py-3 text-muted" title={row.slug}>{row.slug}</td>
                <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                <td className="truncate px-4 py-3 text-fg">{row.plan_name ?? <span className="text-muted">Sem plano</span>}</td>
                <td className="px-4 py-3"><SubscriptionBadge status={row.subscription_status} /></td>
                <td className="px-4 py-3 tabular-nums text-fg">{row.members_count}</td>
                <td className="px-4 py-3"><Owner row={row} /></td>
                <td className="px-2 py-3 text-muted">
                  <ChevronRight aria-hidden="true" className="size-4" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
