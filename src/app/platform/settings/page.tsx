import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsForm } from "@/components/platform-admin/settings-form";
import { fetchSettings, getPlatformAccess } from "@/modules/platform-admin/queries";

export const metadata: Metadata = { title: "Configurações (plataforma)" };

export default async function Page() {
  const { superadmin } = await getPlatformAccess("/platform/settings");
  const result = await fetchSettings();

  return (
    <>
      <PageHeader title="Configurações" description="Opções globais da plataforma." />
      {result.ok ? (
        <SettingsForm key={JSON.stringify(result.settings)} settings={result.settings} canWrite={superadmin} />
      ) : (
        <Alert tone="danger">{result.message}</Alert>
      )}
    </>
  );
}
