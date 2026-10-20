import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AuditWorkspace } from "@/components/platform-admin/audit-workspace";
import { fetchAudit, fetchRestaurantOptions, getPlatformAccess } from "@/modules/platform-admin/queries";

export const metadata: Metadata = { title: "Auditoria (plataforma)" };

const NO_FILTERS = { actor: "", prefix: "", restaurant: "", from: "", to: "" };

export default async function Page() {
  const { superadmin } = await getPlatformAccess("/platform/audit-logs");

  if (!superadmin) {
    return (
      <>
        <PageHeader title="Auditoria" />
        <EmptyState
          icon={<ShieldAlert />}
          title="Disponível apenas para superadministradores"
          description="O papel de suporte não consulta o registro de auditoria da plataforma."
        />
      </>
    );
  }

  const [page, restaurants] = await Promise.all([fetchAudit(NO_FILTERS, null), fetchRestaurantOptions()]);

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Registro imutável das ações da plataforma e dos restaurantes. Dados sensíveis nunca são exibidos."
      />
      <AuditWorkspace
        restaurants={restaurants}
        initial={{
          rows: page.ok ? page.rows : [],
          cursor: page.ok ? page.nextCursor : null,
          error: page.ok ? null : page.message,
        }}
      />
    </>
  );
}
