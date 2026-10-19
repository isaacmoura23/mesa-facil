import type { Metadata } from "next";
import { TeamWorkspace } from "@/components/team/team-workspace";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getAuditPage, getTeam } from "@/modules/team/queries";

export const metadata: Metadata = { title: "Equipe" };

export default async function Page({ params }: PageProps<"/app/[slug]/equipe">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "team.manage" });
  const { restaurant, user } = access;

  const [team, audit] = await Promise.all([
    getTeam(restaurant.restaurant_id),
    getAuditPage(restaurant.restaurant_id, { category: "", from: "", to: "" }, null),
  ]);

  return (
    <>
      <PageHeader
        title="Equipe"
        description="Quem tem acesso ao restaurante, com qual função e o que cada pessoa pode fazer."
      />
      {team.ok ? (
        <TeamWorkspace
          slug={restaurant.slug}
          restaurantName={restaurant.name}
          members={team.members}
          currentUserId={user.id}
          initialAudit={audit}
        />
      ) : (
        <Alert tone="danger" title="Não foi possível carregar a equipe">
          {team.message}
        </Alert>
      )}
    </>
  );
}
