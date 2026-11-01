import { Alert } from "@/components/ui/alert";
import { getSubscriptionStatus } from "@/modules/plan/queries";
import { planBanners } from "@/modules/plan/status";

/** Avisos de plano (teste acabando, assinatura vencida/cancelada, limite atingido) acima do conteúdo. */
export async function PlanBanners({ restaurantId }: { restaurantId: string }) {
  const banners = planBanners(await getSubscriptionStatus(restaurantId));
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {banners.map((banner) => (
        <Alert key={banner.title} tone={banner.tone === "danger" ? "danger" : banner.tone} title={banner.title}>
          {banner.message}
        </Alert>
      ))}
    </div>
  );
}
