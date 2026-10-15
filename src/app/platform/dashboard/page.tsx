import type { Metadata } from "next";
import { ChartColumn } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Visão geral (plataforma)" };

export default async function Page() {
  const user = await requirePlatformAdmin("/platform/dashboard");

  return (
    <>
      <PageHeader
        title="Visão geral"
        description="Administração da plataforma: restaurantes, planos, assinaturas e suporte."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card aria-labelledby="sessao-admin">
          <CardHeader
            title={<span id="sessao-admin">Sua sessão</span>}
            description="Você está autenticado como administrador da plataforma."
          />
          <dl className="text-sm">
            <dt className="text-muted">E-mail</dt>
            <dd className="mt-1 font-medium break-all text-fg">{user.email ?? "Não informado"}</dd>
          </dl>
        </Card>

        <EmptyState
          icon={<ChartColumn />}
          title="Indicadores ainda não disponíveis"
          description="Os números da plataforma aparecerão aqui quando os módulos de restaurantes e assinaturas forem construídos."
        />
      </div>
    </>
  );
}
