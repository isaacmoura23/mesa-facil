import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TeamReadOnly } from "@/components/team/team-readonly";
import { TeamWorkspace } from "@/components/team/team-workspace";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { NO_ACCESS_PATH, requireRestaurantAccess } from "@/lib/auth/guards";
import { getAuditPage, getTeam, getTeamBasic } from "@/modules/team/queries";

export const metadata: Metadata = { title: "Equipe" };

export default async function Page({ params }: PageProps<"/app/[slug]/equipe">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app" });
  const { restaurant, user } = access;

  // Dono (team.manage): edita. Gerente: só vê a lista. Qualquer outro papel não entra aqui.
  if (!access.can("team.manage")) {
    if (access.role !== "manager") redirect(NO_ACCESS_PATH);
    const basic = await getTeamBasic(restaurant.restaurant_id);
    return (
      <>
        <PageHeader title="Equipe" description="Quem trabalha no restaurante e com qual função (somente leitura)." />
        {basic.ok ? (
          <TeamReadOnly members={basic.members} currentUserId={user.id} />
        ) : (
          <Alert tone="danger" title="Não foi possível carregar a equipe">
            {basic.message}
          </Alert>
        )}
      </>
    );
  }

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
