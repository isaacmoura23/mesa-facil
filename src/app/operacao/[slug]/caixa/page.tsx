import type { Metadata } from "next";
import { CashView } from "@/components/cash/cash-view";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Caixa (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/caixa">) {
  const { slug } = await params;
  // A autorização e o restaurant_id vêm do guard (memberships), nunca do slug do cliente.
  const access = await requireRestaurantAccess(slug, { area: "operacao", permission: "cash.view" });

  return (
    <>
      <PageHeader title="Caixa" description="Dinheiro da gaveta: turno, entradas, saídas, retiradas e histórico. O troco de cada venda fica registrado." />
      <CashView
        restaurantId={access.restaurant.restaurant_id}
        restaurantName={access.restaurant.name}
        userId={access.user.id}
        canOperate={access.can("cash.operate")}
        canApprove={access.can("cash.approve")}
      />
    </>
  );
}
