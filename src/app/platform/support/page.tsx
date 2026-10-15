import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requirePlatformAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Suporte (plataforma)" };

export default async function Page() {
  await requirePlatformAdmin("/platform/support");
  return <ModulePlaceholder module="platform-support" />;
}
