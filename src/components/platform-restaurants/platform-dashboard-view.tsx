import Link from "next/link";
import { Building2, LifeBuoy, ReceiptText, ShieldQuestion } from "lucide-react";
import { BarList, type BarItem } from "@/components/dashboard/bar-list";
import { buttonStyles } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
import type { DashboardData } from "@/modules/platform-restaurants/types";

const nf = new Intl.NumberFormat("pt-BR");

function Stat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string;
  note?: string;
  href?: string;
}) {
  const body = (
    <>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-fg tabular-nums sm:text-3xl">{value}</dd>
      {note ? <dd className="mt-1 text-xs text-muted">{note}</dd> : null}
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-card border border-line bg-surface p-5 shadow-card transition-colors hover:bg-surface-2"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">{body}</div>
  );
}

const STATUS_SEGMENTS = [
  { key: "active", label: "Ativos", color: "var(--accent)" },
  { key: "pending", label: "Aguardando aprovação", color: "var(--info-soft-fg)" },
  { key: "suspended", label: "Suspensos", color: "var(--danger)" },
] as const;

/** Barra empilhada com 2px de respiro entre os trechos; a legenda traz os números. */
function StatusBar({ data }: { data: DashboardData["restaurants"] }) {
  const total = data.active + data.pending + data.suspended;
  return (
    <div>
      <div
        role="img"
        aria-label={`Restaurantes por situação: ${STATUS_SEGMENTS.map((s) => `${data[s.key]} ${s.label.toLowerCase()}`).join(", ")}`}
        className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-surface-2"
      >
        {STATUS_SEGMENTS.map((segment) =>
          data[segment.key] > 0 ? (
            <div
              key={segment.key}
              style={{ width: `${(data[segment.key] / total) * 100}%`, background: segment.color }}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-3">
        {STATUS_SEGMENTS.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2 text-sm">
            <span aria-hidden="true" className="size-3 shrink-0 rounded-[3px]" style={{ background: segment.color }} />
            <span className="text-muted">{segment.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-fg">{nf.format(data[segment.key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Indicadores da plataforma: somente agregados, nenhum dado de restaurante. */
export function PlatformDashboardView({ data }: { data: DashboardData }) {
  if (data.restaurants.total === 0) {
    return (
      <EmptyState
        icon={<Building2 />}
        title="Nenhum restaurante cadastrado"
        description="Quando houver restaurantes, os indicadores aparecem aqui. Crie o primeiro para começar."
        action={
          <Link href="/platform/restaurants" className={buttonStyles({ variant: "primary" })}>
            Ir para restaurantes
          </Link>
        }
      />
    );
  }

  const subs = data.subscriptions;
  const subscriptionItems: BarItem[] = [
    { key: "active", label: "Ativas", value: subs.active, valueLabel: nf.format(subs.active) },
    { key: "trial", label: "Em teste", value: subs.trial, valueLabel: nf.format(subs.trial) },
    { key: "past_due", label: "Em atraso", value: subs.past_due, valueLabel: nf.format(subs.past_due), color: "var(--danger)" },
    { key: "cancelled", label: "Canceladas", value: subs.cancelled, valueLabel: nf.format(subs.cancelled), color: "var(--line-strong)" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Restaurantes" value={nf.format(data.restaurants.total)} note={`${nf.format(data.restaurants.new_30d)} novos em 30 dias`} href="/platform/restaurants" />
        <Stat label="Receita mensal estimada" value={formatCents(data.mrr_cents)} note="Estimado, cobrança manual" href="/platform/subscriptions" />
        <Stat label="Pedidos em 30 dias" value={nf.format(data.orders_30d)} note="Total agregado, todos os restaurantes" />
        <Stat label="Tickets abertos" value={nf.format(data.tickets_open)} href="/platform/support" />
      </dl>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card aria-labelledby="dash-status">
          <CardHeader
            title={<span id="dash-status">Restaurantes por situação</span>}
            description="Quem está operando, aguardando aprovação ou suspenso."
          />
          <StatusBar data={data.restaurants} />
        </Card>

        <Card aria-labelledby="dash-subs">
          <CardHeader
            title={<span id="dash-subs">Assinaturas</span>}
            description="A receita mensal estimada soma o preço do plano das assinaturas ativas. Cobrança manual."
          />
          <BarList items={subscriptionItems} label="Assinaturas por situação" />
        </Card>
      </div>

      <Card aria-labelledby="dash-support">
        <CardHeader
          title={<span id="dash-support">Suporte</span>}
          description="Acesso a dados de um restaurante só acontece em sessão de suporte, com justificativa registrada."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-8">
          <p className="flex items-center gap-2 text-sm text-fg">
            <LifeBuoy aria-hidden="true" className="size-4 text-muted" />
            <span className="font-semibold tabular-nums">{nf.format(data.support_sessions_active)}</span>
            {data.support_sessions_active === 1 ? "sessão de suporte ativa" : "sessões de suporte ativas"}
          </p>
          <p className="flex items-center gap-2 text-sm text-fg">
            <ShieldQuestion aria-hidden="true" className="size-4 text-muted" />
            <span className="font-semibold tabular-nums">{nf.format(data.tickets_open)}</span>
            {data.tickets_open === 1 ? "ticket aberto" : "tickets abertos"}
          </p>
          <Link href="/platform/support" className={buttonStyles({ variant: "secondary", size: "sm", className: "sm:ml-auto" })}>
            <ReceiptText aria-hidden="true" className="size-4" />
            Abrir suporte
          </Link>
        </div>
      </Card>
    </div>
  );
}
