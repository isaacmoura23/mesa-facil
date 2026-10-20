import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { PlansWorkspace } from "@/components/platform-admin/plans-workspace";
import { fetchPlans, getPlatformAccess } from "@/modules/platform-admin/queries";

export const metadata: Metadata = { title: "Planos (plataforma)" };

export default async function Page() {
  const { superadmin } = await getPlatformAccess("/platform/plans");
  const plans = await fetchPlans();

  return (
    <>
      <PageHeader
        title="Planos"
        description="Preço, limites e recursos de cada plano. Planos em uso só podem ser inativados."
      />
      <PlansWorkspace
        plans={plans.ok ? plans.plans : []}
        canWrite={superadmin}
        loadError={plans.ok ? null : plans.message}
      />
    </>
  );
}
