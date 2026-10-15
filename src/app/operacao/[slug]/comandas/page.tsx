import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Comandas (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/comandas">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "operacao", permission: "tabs.view" });
  return <ModulePlaceholder module="comandas" />;
}
