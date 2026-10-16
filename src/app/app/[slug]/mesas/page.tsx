import type { Metadata } from "next";
import { TablesWorkspace } from "@/components/tables-admin/tables-workspace";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getTablesAdminData } from "@/modules/tables-admin/queries";

export const metadata: Metadata = { title: "Mesas" };

export default async function Page({ params }: PageProps<"/app/[slug]/mesas">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, {
    area: "app",
    permission: ["tables.view", "tables.manage"],
  });
  const canManage = access.can("tables.manage");
  const canViewTabs = access.can("tabs.view");

  const result = await getTablesAdminData(access.restaurant.restaurant_id, {
    tabs: canViewTabs,
    orders: access.can("orders.view"),
  });

  return (
    <>
      <PageHeader
        title="Mesas"
        description={
          canManage
            ? "Cadastre as mesas do salão e acompanhe quais estão com comanda aberta."
            : "Acompanhe as mesas do salão e as comandas abertas."
        }
      />

      <div className="mb-6">
        <Alert tone="info" title="Monitoramento">
          Aqui você acompanha e cadastra as mesas. Abrir comanda, lançar pedidos, receber e fechar é
          feito pela equipe em <span className="font-medium">/operacao</span>.
        </Alert>
      </div>

      {result.ok ? (
        <TablesWorkspace
          slug={access.restaurant.slug}
          tables={result.data.tables}
          canManage={canManage}
          canViewTabs={canViewTabs}
        />
      ) : (
        <Alert tone="danger" title="Não foi possível carregar as mesas">
          {result.message}
        </Alert>
      )}
    </>
  );
}
