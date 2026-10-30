import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { getPublicEnvStatus } from "@/lib/env";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { ROLE_LABELS, areaHomePath, homePathFor } from "@/lib/auth/permissions";
import type { AppArea } from "@/lib/auth/types";
import { buildAppNav, buildOperacaoNav } from "@/config/navigation";
import { buttonStyles } from "@/components/ui/button";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { RestaurantSwitcher } from "./restaurant-switcher";
import { NavBadgesProvider } from "./nav-badges-provider";
import { ShellFrame } from "./shell-frame";
import { UserMenu } from "./user-menu";

type RestaurantAreaShellProps = {
  area: AppArea;
  params: Promise<{ slug: string }>;
  children: ReactNode;
};

const AREA_LABEL: Record<AppArea, string> = {
  app: "Gestão",
  operacao: "Operação",
};

/**
 * Layout autenticado de /app/[slug] e /operacao/[slug]. A autorização vem de
 * `requireRestaurantAccess` (membership + permissões), nunca do slug sozinho.
 * Deve ser renderizado dentro de <Suspense> (lê cookies e params).
 */
export async function RestaurantAreaShell({
  area,
  params,
  children,
}: RestaurantAreaShellProps) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area });
  const { restaurant, role } = access;

  const nav =
    area === "app"
      ? buildAppNav(restaurant.slug, access.canAny)
      : buildOperacaoNav(restaurant.slug, access.canAny);

  const otherArea: AppArea = area === "app" ? "operacao" : "app";
  const switcherItems = access.restaurants
    .filter((item) => item.status === "active")
    .map((item) => ({
      slug: item.slug,
      name: item.name,
      href: homePathFor(item.slug, item.role),
    }));

  // Selos de contagem só aparecem para quem pode agir sobre o que é contado (já filtrado no menu).
  const badgeKeys = [...new Set(nav.flatMap((entry) => (entry.badge ? [entry.badge] : [])))];

  return (
    <NavBadgesProvider restaurantId={restaurant.restaurant_id} keys={badgeKeys}>
    <ShellFrame
      areaLabel={AREA_LABEL[area]}
      nav={nav}
      headerStart={
        <RestaurantSwitcher
          currentSlug={restaurant.slug}
          currentName={restaurant.name}
          items={switcherItems}
        />
      }
      headerEnd={
        <UserMenu
          name={access.user.name}
          email={access.user.email}
          caption={`Papel: ${ROLE_LABELS[role]}`}
        />
      }
      navFooter={
        access.canEnter(otherArea) ? (
          <Link
            href={areaHomePath(restaurant.slug, otherArea)}
            className={buttonStyles({ variant: "secondary", size: "sm", fullWidth: true })}
          >
            <ArrowLeftRight aria-hidden="true" className="size-4" />
            Ir para {AREA_LABEL[otherArea]}
          </Link>
        ) : undefined
      }
    >
      {children}
    </ShellFrame>
    </NavBadgesProvider>
  );
}
