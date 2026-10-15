import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requirePlatformAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Auditoria (plataforma)" };

export default async function Page() {
  await requirePlatformAdmin("/platform/audit-logs");
  return <ModulePlaceholder module="platform-audit" />;
}
