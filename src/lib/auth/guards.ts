import "server-only";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "./session";
import { getMyPermissions, getMyRestaurants, isPlatformAdmin } from "./rpc";
import { areaHomePath, canEnterArea, hasAny } from "./permissions";
import type {
  AppArea,
  AuthUser,
  MyRestaurant,
  Permission,
  RestaurantRole,
} from "./types";
import { sanitizeNext } from "@/lib/utils/safe-redirect";

export const NO_ACCESS_PATH = "/sem-acesso";

function loginPath(nextPath?: string): string {
  const next = sanitizeNext(nextPath);
  return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/** Exige sessão válida; caso contrário redireciona para /login?next=. */
export async function requireUser(nextPath?: string): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect(loginPath(nextPath));
  return user;
}

/**
 * Exige administrador da plataforma (RPC `is_platform_admin`). Quem não é
 * administrador recebe 404, para não revelar a existência da área.
 */
export async function requirePlatformAdmin(
  nextPath?: string,
): Promise<AuthUser> {
  const user = await requireUser(nextPath ?? "/platform/dashboard");
  if (!(await isPlatformAdmin())) notFound();
  return user;
}

export type RestaurantAccess = {
  user: AuthUser;
  restaurant: MyRestaurant;
  role: RestaurantRole;
  permissions: ReadonlySet<string>;
  /** Todos os restaurantes do usuário (para o seletor). */
  restaurants: MyRestaurant[];
  can: (permission: Permission) => boolean;
  canAny: (permissions: readonly Permission[]) => boolean;
  /** `true` quando o usuário pode entrar no ambiente informado. */
  canEnter: (area: AppArea) => boolean;
};

export type RestaurantAccessOptions = {
  area: AppArea;
  /** Basta ter UMA das permissões listadas. */
  permission?: Permission | readonly Permission[];
};

/**
 * Resolve o restaurante A PARTIR DAS MEMBERSHIPS DO USUÁRIO (RPC
 * `my_restaurants`); o slug só identifica qual delas. Sem vínculo -> 404.
 * Carrega as permissões efetivas (RPC `my_permissions`) e aplica as regras
 * de ambiente e de página. Em negação redireciona/404, nunca renderiza.
 */
export async function requireRestaurantAccess(
  slug: string,
  options: RestaurantAccessOptions,
): Promise<RestaurantAccess> {
  const normalizedSlug = slug.trim().toLowerCase();
  const user = await requireUser(
    `/${options.area}/${encodeURIComponent(normalizedSlug)}`,
  );

  const restaurants = await getMyRestaurants();
  const restaurant = restaurants.find((item) => item.slug === normalizedSlug);
  if (!restaurant) notFound();

  // Restaurante pendente (aguardando aprovação) ou suspenso: volta ao seletor
  // (/entrar), que explica a situação. Só restaurantes ativos abrem o painel.
  if (restaurant.status !== "active") redirect("/entrar");

  const permissions = new Set(await getMyPermissions(restaurant.restaurant_id));
  const { role } = restaurant;

  const canEnter = (area: AppArea) => canEnterArea(area, role, permissions);

  if (!canEnter(options.area)) {
    const other: AppArea = options.area === "app" ? "operacao" : "app";
    redirect(
      canEnter(other) ? areaHomePath(restaurant.slug, other) : NO_ACCESS_PATH,
    );
  }

  if (options.permission !== undefined) {
    const required: readonly Permission[] =
      typeof options.permission === "string"
        ? [options.permission]
        : options.permission;
    if (!hasAny(permissions, required)) redirect(NO_ACCESS_PATH);
  }

  return {
    user,
    restaurant,
    role,
    permissions,
    restaurants,
    can: (permission) => permissions.has(permission),
    canAny: (list) => hasAny(permissions, list),
    canEnter,
  };
}
