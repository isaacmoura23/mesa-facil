import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CounterSaleView } from "@/components/counter-sale/counter-sale-view";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Venda no balcão" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/venda">) {
  const { slug } = await params;
  // A autorização e o restaurant_id vêm do guard (memberships), nunca do slug do cliente.
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "orders.create" });
  // A venda recebe em dinheiro na mesma operação; sem esta permissão o servidor recusaria.
  if (!access.can("payments.record")) notFound();

  return (
    <>
      <PageHeader title="Venda no balcão" description="Toque nos produtos, receba em dinheiro e finalize. O troco é calculado na hora e o pedido vai para a cozinha." />
      <CounterSaleView slug={access.restaurant.slug} restaurantId={access.restaurant.restaurant_id} />
    </>
  );
}
