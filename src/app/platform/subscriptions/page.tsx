import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { SubscriptionsWorkspace } from "@/components/platform-admin/subscriptions-workspace";
import { fetchPlans, fetchSubscriptions, getPlatformAccess } from "@/modules/platform-admin/queries";
import { subscriptionFilterSchema } from "@/modules/platform-admin/schemas";

export const metadata: Metadata = { title: "Assinaturas (plataforma)" };

export default async function Page({ searchParams }: PageProps<"/platform/subscriptions">) {
  const { superadmin } = await getPlatformAccess("/platform/subscriptions");
  const raw = (await searchParams).status;
  const parsed = subscriptionFilterSchema.safeParse(typeof raw === "string" ? raw : "");
  const status = parsed.success ? parsed.data : "";
  const [page, plans] = await Promise.all([fetchSubscriptions(status, null), fetchPlans()]);

  return (
    <>
      <PageHeader title="Assinaturas" description="Plano, estado e fim do período de cada restaurante." />
      <SubscriptionsWorkspace
        initialRows={page.ok ? page.rows : []}
        initialCursor={page.ok ? page.nextCursor : null}
        initialStatus={status}
        loadError={page.ok ? null : page.message}
        plans={plans.ok ? plans.plans : []}
        canWrite={superadmin}
      />
    </>
  );
}
