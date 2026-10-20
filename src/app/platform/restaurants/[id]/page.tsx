import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RestaurantActions } from "@/components/platform-restaurants/restaurant-actions";
import { formatCents } from "@/lib/format";
import { describeAudit, formatDate, formatDateTime } from "@/modules/team/audit";
import {
  MEMBER_STATUS_LABEL,
  RESTAURANT_STATUS_LABEL,
  RESTAURANT_STATUS_TONE,
  SUBSCRIPTION_STATUS_LABEL,
  SUBSCRIPTION_STATUS_TONE,
  describePlatformAudit,
  roleLabel,
} from "@/modules/platform-restaurants/labels";
import { getRestaurantDetail, isSuperadmin } from "@/modules/platform-restaurants/queries";
import { idSchema } from "@/modules/platform-restaurants/schemas";

export const metadata: Metadata = { title: "Restaurante (plataforma)" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-fg">{children}</dd>
    </div>
  );
}

export default async function Page({ params }: PageProps<"/platform/restaurants/[id]">) {
  const { id } = await params;
  await requirePlatformAdmin(`/platform/restaurants/${encodeURIComponent(id)}`);
  if (!idSchema.safeParse(id).success) notFound();

  const [canWrite, result] = await Promise.all([isSuperadmin(), getRestaurantDetail(id)]);
  if (!result.ok && "notFound" in result) notFound();

  const back = (
    <Link href="/platform/restaurants" className={buttonStyles({ variant: "ghost", size: "sm", className: "mb-4 -ml-3" })}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      Restaurantes
    </Link>
  );

  if (!result.ok) {
    return (
      <>
        {back}
        <Alert tone="danger" title="Não foi possível carregar o restaurante">
          {"message" in result ? result.message : null}
        </Alert>
      </>
    );
  }

  const { restaurant, subscription, team, audit } = result.data;

  return (
    <>
      {back}
      <PageHeader
        title={restaurant.name}
        description={`Endereço: ${restaurant.slug}`}
        badge={
          <Badge tone={RESTAURANT_STATUS_TONE[restaurant.status] ?? "neutral"}>
            {RESTAURANT_STATUS_LABEL[restaurant.status] ?? restaurant.status}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card aria-labelledby="det-meta">
          <CardHeader title={<span id="det-meta">Dados do restaurante</span>} />
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Nome">{restaurant.name}</Field>
            <Field label="Slug"><span className="font-mono text-xs">{restaurant.slug}</span></Field>
            <Field label="Criado em">{formatDate(restaurant.created_at) || "Não informado"}</Field>
            <Field label="Dono">
              {restaurant.owner_name ?? restaurant.owner_email ?? "Sem dono ativo"}
              {restaurant.owner_name && restaurant.owner_email ? (
                <span className="block text-xs text-muted">{restaurant.owner_email}</span>
              ) : null}
            </Field>
            <Field label="Equipe">{team.length} {team.length === 1 ? "vínculo" : "vínculos"}</Field>
          </dl>
        </Card>

        <Card aria-labelledby="det-sub">
          <CardHeader
            title={<span id="det-sub">Assinatura</span>}
            description="Cobrança manual, administrada pelo superadministrador."
          />
          {subscription ? (
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Plano">{subscription.plan_name ?? "Sem plano"}</Field>
              <Field label="Situação">
                {subscription.status ? (
                  <Badge tone={SUBSCRIPTION_STATUS_TONE[subscription.status] ?? "neutral"}>
                    {SUBSCRIPTION_STATUS_LABEL[subscription.status] ?? subscription.status}
                  </Badge>
                ) : "Não informada"}
              </Field>
              <Field label="Preço mensal">
                {subscription.price_cents !== null ? formatCents(subscription.price_cents) : "Não informado"}
              </Field>
              <Field label="Fim do período">{formatDate(subscription.period_end) || "Não informado"}</Field>
              {subscription.status === "trial" && subscription.trial_ends_at ? (
                <Field label="Fim do teste">{formatDate(subscription.trial_ends_at)}</Field>
              ) : null}
              {subscription.note ? <Field label="Observação">{subscription.note}</Field> : null}
            </dl>
          ) : (
            <p className="text-sm text-muted">Este restaurante não tem assinatura registrada.</p>
          )}
        </Card>

        <Card aria-labelledby="det-actions" className="lg:col-span-2">
          <CardHeader
            title={<span id="det-actions">Ações</span>}
            description="Suspensão e sessões de suporte ficam registradas na auditoria do restaurante."
          />
          <RestaurantActions
            restaurantId={restaurant.id}
            restaurantName={restaurant.name}
            status={restaurant.status}
            canWrite={canWrite}
          />
        </Card>

        <Card aria-labelledby="det-team">
          <CardHeader
            title={<span id="det-team">Equipe</span>}
            description="Apenas papel e situação. Telefones e dados pessoais não são exibidos."
          />
          {team.length === 0 ? (
            <p className="text-sm text-muted">Nenhum vínculo cadastrado.</p>
          ) : (
            <ul className="divide-y divide-line">
              {team.map((member, index) => (
                <li key={index} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{member.name ?? member.email ?? "Sem identificação"}</p>
                    {member.name && member.email ? <p className="truncate text-xs text-muted">{member.email}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm text-muted">{roleLabel(member.role)}</span>
                    <Badge tone={member.status === "active" ? "accent" : member.status === "revoked" ? "neutral" : "info"}>
                      {MEMBER_STATUS_LABEL[member.status ?? ""] ?? member.status ?? "Sem situação"}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="det-audit">
          <CardHeader title={<span id="det-audit">Auditoria recente</span>} description="Últimas 20 atividades registradas." />
          {audit.length === 0 ? (
            <EmptyState title="Sem atividades registradas" className="border-0 py-6" />
          ) : (
            <ol className="flex flex-col gap-3">
              {audit.map((entry, index) => (
                <li key={entry.id ?? index} className="text-sm">
                  <p className="text-fg">{describePlatformAudit(entry.action, entry.metadata) ?? describeAudit(entry.action, entry.metadata).text}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(entry.created_at)}
                    {entry.actor_name ? ` por ${entry.actor_name}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
