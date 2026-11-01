import type { Metadata } from "next";
import { OrdersBoard } from "@/components/operations/orders-board";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Pedidos (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/pedidos">) {
  const { slug } = await params;
  // A autorização e o restaurant_id vêm do guard (memberships), nunca do slug do cliente.
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "orders.view" });

  return (
    <OrdersBoard
      restaurantId={access.restaurant.restaurant_id}
      restaurantName={access.restaurant.name}
      permissions={{
        accept: access.can("orders.accept"),
        reject: access.can("orders.reject"),
        updateStatus: access.can("orders.update_status"),
        cancel: access.can("orders.cancel"),
        print: access.can("print.request"),
        recordPayments: access.can("payments.record"),
      }}
    />
  );
}
