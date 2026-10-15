import type { Metadata } from "next";
import { ChartColumn } from "lucide-react";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { PERMISSION_LABELS, ROLE_LABELS, STATUS_LABELS } from "@/lib/auth/permissions";
import { PERMISSIONS } from "@/lib/auth/types";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Visão geral" };

export default async function Page({ params }: PageProps<"/app/[slug]/dashboard">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app" });
  const { restaurant, role } = access;

  const granted = PERMISSIONS.filter((permission) => access.can(permission));

  return (
    <>
      <PageHeader
        title="Visão geral"
        description={`Painel de gestão de ${restaurant.name}.`}
        badge={
          <Badge tone={restaurant.status === "active" ? "accent" : "warning"}>
            {STATUS_LABELS[restaurant.status]}
          </Badge>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card aria-labelledby="seu-acesso">
          <CardHeader
            title={<span id="seu-acesso">Seu acesso</span>}
            description={`Papel neste restaurante: ${ROLE_LABELS[role]}.`}
          />
          {role === "owner" ? (
            <Alert tone="info" className="mb-4">
              Como proprietário, você configura e acompanha o restaurante em modo
              leitura. As ações do dia a dia (pedidos, mesas, comandas e pagamentos)
              ficam com a equipe operacional.
            </Alert>
          ) : null}
          {granted.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Permissões efetivas">
              {granted.map((permission) => (
                <li key={permission}>
                  <Badge>{PERMISSION_LABELS[permission]}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nenhuma permissão atribuída.</p>
          )}
        </Card>

        <EmptyState
          icon={<ChartColumn />}
          title="Indicadores ainda não disponíveis"
          description="Vendas, pedidos e desempenho aparecerão aqui quando os módulos de pedidos e relatórios forem construídos (previsto para a Fase 5)."
        />
      </div>
    </>
  );
}
