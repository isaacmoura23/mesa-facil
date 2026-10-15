import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Relatórios" };

export default async function Page({ params }: PageProps<"/app/[slug]/relatorios">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });
  return (
    <ModulePlaceholder
      module="relatorios"
    />
  );
}
