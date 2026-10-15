import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Comandas" };

export default async function Page({ params }: PageProps<"/app/[slug]/comandas">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: "tabs.view" });
  return (
    <ModulePlaceholder
      module="comandas"
      readOnly
      note="Na Gestão este módulo é apenas de acompanhamento: criar e alterar é feito na Operação pelos papéis autorizados. O proprietário nunca executa ações operacionais."
    />
  );
}
