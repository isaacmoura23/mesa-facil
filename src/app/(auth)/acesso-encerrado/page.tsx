import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LogOut } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/guards";
import { getMyRevokedRestaurants } from "@/lib/auth/rpc";

export const metadata: Metadata = { title: "Acesso encerrado" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Explica a quem teve o acesso revogado o que aconteceu. O vínculo é conferido de novo aqui (o `?r=` é só uma
 * dica de qual restaurante); sem acesso revogado a essa conta, a página não existe (404).
 */
export default async function AccessEndedPage(props: PageProps<"/acesso-encerrado">) {
  await requireUser("/acesso-encerrado");
  const params = await props.searchParams;
  const slug = first(params.r)?.trim().toLowerCase();
  const revoked = await getMyRevokedRestaurants();
  const restaurant = (slug ? revoked.find((item) => item.slug === slug) : undefined) ?? revoked[0];
  if (!restaurant) notFound();

  return (
    <AuthShell>
      <EmptyState
        icon={<LogOut />}
        title="Seu acesso a este restaurante foi encerrado"
        description={`Você não faz mais parte da equipe de ${restaurant.name}. Se isso foi um engano, peça ao responsável para te convidar de novo.`}
        action={
          <form action={logoutAction}>
            <Button type="submit">Sair da conta</Button>
          </form>
        }
      />
    </AuthShell>
  );
}
