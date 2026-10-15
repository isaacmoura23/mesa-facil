import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Histórico (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/historico">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "operacao", permission: "orders.view" });
  return <ModulePlaceholder module="historico" />;
}
