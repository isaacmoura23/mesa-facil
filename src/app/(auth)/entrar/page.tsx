import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Hourglass, MailPlus, Store } from "lucide-react";
import { getPublicEnvStatus } from "@/lib/env";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/guards";
import { homePathFor, ROLE_LABELS, STATUS_LABELS } from "@/lib/auth/permissions";
import { getMyRestaurants, getPendingInvitations, isPlatformAdmin } from "@/lib/auth/rpc";
import type { MyRestaurant } from "@/lib/auth/types";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { AuthShell, AuthSkeleton } from "@/components/auth/auth-shell";
import { RegisterRestaurantForm } from "@/components/auth/register-restaurant-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FlashToast } from "@/components/ui/flash-toast";

export const metadata: Metadata = { title: "Escolher restaurante" };

export default function EnterPage(props: PageProps<"/entrar">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <EnterContent searchParams={props.searchParams} />
    </Suspense>
  );
}

function LogoutButton() {
  return (
    <form action={logoutAction} className="mt-6 flex justify-center">
      <Button type="submit" variant="ghost" size="sm">
        Sair da conta
      </Button>
    </form>
  );
}

/**
 * Roteador pós-login:
 *  - administrador da plataforma             -> /platform/dashboard
 *  - sem convites e um único restaurante ativo -> painel conforme o papel
 *  - convites pendentes                      -> lista com botão "Aceitar"
 *  - vários restaurantes                     -> seletor
 *  - nenhum                                  -> aguardando convite + registrar restaurante
 * Restaurantes `pending` (aguardando aprovação) e `suspended` aparecem sem link.
 */
async function EnterContent({
  searchParams,
}: {
  searchParams: PageProps<"/entrar">["searchParams"];
}) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  const user = await requireUser("/entrar");

  if (await isPlatformAdmin()) redirect("/platform/dashboard");

  const [restaurants, invitations] = await Promise.all([
    getMyRestaurants(),
    getPendingInvitations(),
  ]);

  const [only] = restaurants;
  if (invitations.length === 0 && restaurants.length === 1 && only.status === "active") {
    redirect(homePathFor(only.slug, only.role));
  }

  const params = await searchParams;
  const flash =
    params.registrado === "1"
      ? {
          title: "Restaurante registrado",
          description: "Ele ficará disponível assim que a plataforma o aprovar.",
        }
      : params.convite === "aceito"
        ? { title: "Convite aceito", description: "Você já faz parte do restaurante." }
        : null;

  const hasActive = restaurants.some((item) => item.status === "active");
  const hasSuspended = restaurants.some((item) => item.status === "suspended");

  return (
    <AuthShell size="lg">
      {flash ? <FlashToast title={flash.title} description={flash.description} /> : null}

      {invitations.length > 0 ? (
        <Card aria-labelledby="titulo-convites" className="mb-6">
          <h2 id="titulo-convites" className="flex items-center gap-2 text-lg font-semibold text-fg">
            <MailPlus aria-hidden="true" className="size-5 text-accent-soft-fg" />
            Convites pendentes
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            Aceite para começar a trabalhar no restaurante.
          </p>
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <li
                key={invitation.membership_id}
                className="flex items-start justify-between gap-3 rounded-control border border-line px-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-fg">
                    {invitation.restaurant_name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    Papel: {ROLE_LABELS[invitation.role]}
                  </p>
                </div>
                <AcceptInvitationForm
                  membershipId={invitation.membership_id}
                  restaurantName={invitation.restaurant_name}
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {restaurants.length > 0 ? (
        <Card aria-labelledby="titulo-restaurantes">
          <h1 id="titulo-restaurantes" className="text-2xl font-semibold tracking-tight text-fg">
            {hasActive ? "Escolha o restaurante" : "Aguardando aprovação"}
          </h1>
          <p className="mt-1 mb-5 text-sm text-muted">
            {hasActive
              ? "Selecione onde você quer trabalhar agora."
              : "Seu restaurante foi registrado e aguarda aprovação da plataforma. Você poderá acessá-lo assim que for ativado."}
          </p>
          <ul className="flex flex-col gap-2">
            {restaurants.map((restaurant) => (
              <RestaurantRow key={restaurant.restaurant_id} restaurant={restaurant} />
            ))}
          </ul>
          {hasSuspended ? (
            <Alert tone="warning" className="mt-5">
              Restaurantes suspensos não podem ser acessados. Fale com o suporte da
              plataforma para regularizar.
            </Alert>
          ) : null}
        </Card>
      ) : (
        <>
          {invitations.length === 0 ? (
          <Card aria-labelledby="titulo-aguardando">
            <span
              aria-hidden="true"
              className="mb-4 flex size-11 items-center justify-center rounded-control bg-info-soft text-info-soft-fg"
            >
              <Hourglass className="size-5" />
            </span>
            <h1 id="titulo-aguardando" className="text-2xl font-semibold tracking-tight text-fg">
              Aguardando convite ou ativação
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              A conta {user.email ? <strong className="text-fg">{user.email}</strong> : "atual"}{" "}
              ainda não está vinculada a nenhum restaurante. Se você foi convidado, peça ao
              proprietário para enviar o convite para este e-mail (ele precisa estar
              confirmado). Se o restaurante é seu, registre-o abaixo.
            </p>
          </Card>
          ) : null}

          <Card className={invitations.length === 0 ? "mt-6" : undefined} aria-labelledby="titulo-registrar">
            <h2 id="titulo-registrar" className="text-lg font-semibold text-fg">
              Registrar meu restaurante
            </h2>
            <p className="mt-1 mb-5 text-sm text-muted">
              O restaurante é criado como pendente e passa a funcionar depois de aprovado
              pela plataforma.
            </p>
            <RegisterRestaurantForm />
          </Card>
        </>
      )}
      <LogoutButton />
    </AuthShell>
  );
}

function RestaurantRow({ restaurant }: { restaurant: MyRestaurant }) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted"
      >
        <Store className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg">{restaurant.name}</span>
        <span className="mt-0.5 block text-xs text-muted">{ROLE_LABELS[restaurant.role]}</span>
      </span>
      {restaurant.status !== "active" ? (
        <Badge tone={restaurant.status === "pending" ? "warning" : "danger"}>
          {STATUS_LABELS[restaurant.status]}
        </Badge>
      ) : null}
    </>
  );

  const rowClass =
    "flex min-h-16 items-center gap-3 rounded-control border border-line px-3 py-2";

  if (restaurant.status !== "active") {
    return <li className={`${rowClass} bg-surface-2/50`}>{content}</li>;
  }

  return (
    <li>
      <Link
        href={homePathFor(restaurant.slug, restaurant.role)}
        className={`${rowClass} bg-surface transition-colors hover:bg-surface-2`}
      >
        {content}
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
      </Link>
    </li>
  );
}
