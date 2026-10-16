import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TabDetailView } from "@/components/tables/tab-detail";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { isUuid } from "@/modules/storefront/schemas";

export const metadata: Metadata = { title: "Comanda (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/comandas/[tabId]">) {
  const { slug, tabId } = await params;
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "tabs.view" });
  if (!isUuid(tabId)) notFound();

  return (
    <TabDetailView
      slug={access.restaurant.slug}
      restaurantId={access.restaurant.restaurant_id}
      tabId={tabId.toLowerCase()}
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
