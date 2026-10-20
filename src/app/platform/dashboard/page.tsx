import type { Metadata } from "next";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { PlatformDashboardView } from "@/components/platform-restaurants/platform-dashboard-view";
import { getDashboard } from "@/modules/platform-restaurants/queries";

export const metadata: Metadata = { title: "Visão geral (plataforma)" };

export default async function Page() {
  await requirePlatformAdmin("/platform/dashboard");
  const result = await getDashboard();

  return (
    <>
      <PageHeader
        title="Visão geral"
        description="Números agregados da plataforma. Nenhum dado operacional ou pessoal de restaurantes aparece aqui."
      />
      {result.ok ? (
        <PlatformDashboardView data={result.data} />
      ) : (
        <Alert tone="danger" title="Não foi possível carregar os indicadores">
          {result.message}
        </Alert>
      )}
    </>
  );
}
