import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Mesas (operação)" };

export default async function Page({ params }: PageProps<"/operacao/[slug]/mesas">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "operacao", permission: "tables.view" });
  return <ModulePlaceholder module="mesas" />;
}
