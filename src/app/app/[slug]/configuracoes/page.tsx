import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Configurações" };

export default async function Page({ params }: PageProps<"/app/[slug]/configuracoes">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: "restaurant.settings.manage" });
  return (
    <ModulePlaceholder
      module="configuracoes"
    />
  );
}
