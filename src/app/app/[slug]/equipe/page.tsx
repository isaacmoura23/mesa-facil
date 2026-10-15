import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireRestaurantAccess } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Equipe" };

export default async function Page({ params }: PageProps<"/app/[slug]/equipe">) {
  const { slug } = await params;
  await requireRestaurantAccess(slug, { area: "app", permission: "team.manage" });
  return (
    <ModulePlaceholder
      module="equipe"
    />
  );
}
