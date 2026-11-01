import type { Metadata } from "next";
import { CashView } from "@/components/cash/cash-view";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Caixa" };

/** Gestão: o caixa em modo SOMENTE LEITURA (quem opera usa /operacao). */
export default async function Page({ params }: PageProps<"/app/[slug]/caixa">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "cash.view" });

  return (
    <>
      <PageHeader title="Caixa" description="Acompanhe o dinheiro do caixa: turnos, entradas, saídas, retiradas e troco. Somente leitura." />
      <CashView
        restaurantId={access.restaurant.restaurant_id}
        restaurantName={access.restaurant.name}
        userId={access.user.id}
        canOperate={false}
        canApprove={false}
      />
    </>
  );
}
