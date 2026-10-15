import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Pedidos" };

export default async function Page({ params }: PageProps<"/app/[slug]/pedidos">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: "orders.view" });
  return (
    <ModulePlaceholder
      module="pedidos"
      readOnly
      note="Na Gestão este módulo é apenas de acompanhamento: criar e alterar é feito na Operação pelos papéis autorizados. O proprietário nunca executa ações operacionais."
    />
  );
}
