import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Mesas" };

export default async function Page({ params }: PageProps<"/app/[slug]/mesas">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: ["tables.view", "tables.manage"] });
  return (
    <ModulePlaceholder
      module="mesas"
      readOnly
      note="Na Gestão este módulo é apenas de acompanhamento: criar e alterar é feito na Operação pelos papéis autorizados. O proprietário nunca executa ações operacionais."
    />
  );
}
