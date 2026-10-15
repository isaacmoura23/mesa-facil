import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requirePlatformAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Restaurantes (plataforma)" };

export default async function Page() {
  await requirePlatformAdmin("/platform/restaurants");
  return <ModulePlaceholder module="platform-restaurants" />;
}
