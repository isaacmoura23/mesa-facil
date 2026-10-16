import type { Metadata } from "next";
import { TablesBoard } from "@/components/tables/tables-board";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Mesas (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/mesas">) {
  const { slug } = await params;
  // A autorização e o restaurant_id vêm do guard (memberships), nunca do slug do cliente.
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "tables.view" });

  return (
    <TablesBoard
      slug={access.restaurant.slug}
      restaurantId={access.restaurant.restaurant_id}
      permissions={{
        viewTabs: access.can("tabs.view"),
        manageTabs: access.can("tabs.manage"),
        operateTables: access.can("tables.operate"),
        createOrders: access.can("orders.create"),
        viewOrders: access.can("orders.view"),
        recordPayments: access.can("payments.record"),
        print: access.can("print.request"),
        granted: [...access.permissions],
      }}
    />
  );
}
