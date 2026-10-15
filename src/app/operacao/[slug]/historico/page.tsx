import type { Metadata } from "next";
import { HistoryView } from "@/components/history/history-view";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Histórico (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/historico">) {
  const { slug } = await params;
  // A autorização e o restaurant_id vêm do guard (memberships), nunca do slug do cliente.
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "orders.view" });

  return (
    <HistoryView
      restaurantId={access.restaurant.restaurant_id}
      restaurantName={access.restaurant.name}
      restaurantSlug={slug}
    />
  );
}
