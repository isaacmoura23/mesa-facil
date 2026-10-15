/**
 * Tipos manuais das respostas das RPCs (docs/CONTRACT.md).
 *
 * PONTO DE INTEGRAÇÃO: quando `database.types.ts` for gerado, estes tipos
 * podem ser derivados de `Database["public"]["Functions"]`. Os schemas zod em
 * `rpc.ts` continuam validando em runtime o que o banco devolve.
 */

export const RESTAURANT_ROLES = [
  "owner",
  "manager",
  "cashier",
  "kitchen",
  "waiter",
] as const;
export type RestaurantRole = (typeof RESTAURANT_ROLES)[number];

export const RESTAURANT_STATUSES = ["pending", "active", "suspended"] as const;
export type RestaurantStatus = (typeof RESTAURANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ["invited", "active", "revoked"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const PLATFORM_ADMIN_ROLES = ["superadmin", "support"] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export const PERMISSIONS = [
  "orders.view",
  "orders.create",
  "orders.accept",
  "orders.reject",
  "orders.update_status",
  "orders.cancel",
  "menu.manage",
  "tables.view",
  "tables.manage",
  "tables.operate",
  "tabs.view",
  "tabs.manage",
  "payments.record",
  "print.request",
  "reports.view",
  "team.manage",
  "restaurant.settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Linha de `my_restaurants()`. */
export type MyRestaurant = {
  restaurant_id: string;
  slug: string;
  name: string;
  role: RestaurantRole;
  status: RestaurantStatus;
};

/** Linha de `my_pending_invitations()`. */
export type PendingInvitation = {
  membership_id: string;
  restaurant_id: string;
  restaurant_name: string;
  role: RestaurantRole;
  invited_at: string;
};

/** Linha de `resolve_restaurant_by_slug(p_slug)` (apenas restaurantes ativos). */
export type PublicRestaurant = {
  id: string;
  slug: string;
  name: string;
  status: RestaurantStatus;
  logo_path: string | null;
};

/** Usuário autenticado, derivado de claims verificadas (getClaims). */
export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type AppArea = "app" | "operacao";
