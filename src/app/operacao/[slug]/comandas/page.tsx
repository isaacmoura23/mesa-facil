import type { Metadata } from "next";
import { TabsBoard } from "@/components/tables/tabs-board";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Comandas (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/comandas">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "tabs.view" });

  return (
    <TabsBoard
      slug={access.restaurant.slug}
      restaurantId={access.restaurant.restaurant_id}
      permissions={{
        viewTabs: true,
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
