import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requirePlatformAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Configurações da plataforma (plataforma)" };

export default async function Page() {
  await requirePlatformAdmin("/platform/settings");
  return <ModulePlaceholder module="platform-settings" />;
}
