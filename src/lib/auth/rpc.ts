import "server-only";
import { cache } from "react";
import { z } from "zod";
import { createClient, createPublicClient } from "@/lib/supabase/server";
import {
  RESTAURANT_ROLES,
  RESTAURANT_STATUSES,
  type MyRestaurant,
  type PendingInvitation,
  type PublicRestaurant,
} from "./types";

/**
 * Camada fina sobre as RPCs do contrato. Cada resposta é validada com zod:
 * dados fora do formato esperado são descartados (nunca concedem acesso).
 * As leituras são memoizadas por requisição com `React.cache`.
 *
 * Assinaturas esperadas no banco (schema public):
 *   is_platform_admin() returns boolean
 *   my_restaurants() returns table(restaurant_id uuid, slug text, name text,
 *                                  role restaurant_role, status restaurant_status)
 *   my_permissions(rid uuid) returns text[]
 *   resolve_restaurant_by_slug(p_slug text) returns (id, slug, name, status, logo_path)
 *   my_pending_invitations() returns table(membership_id uuid, restaurant_id uuid,
 *                                          restaurant_name text, role restaurant_role, invited_at timestamptz)
 *   accept_invitation(p_membership uuid) returns void   (ver actions.ts)
 *   register_restaurant(p_name text, p_slug text)
 */

const myRestaurantSchema = z.object({
  restaurant_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string(),
  role: z.enum(RESTAURANT_ROLES),
  status: z.enum(RESTAURANT_STATUSES),
});

const pendingInvitationSchema = z.object({
  membership_id: z.string().min(1),
  restaurant_id: z.string().min(1),
  restaurant_name: z.string(),
  role: z.enum(RESTAURANT_ROLES),
  invited_at: z.string(),
});

const publicRestaurantSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string(),
  status: z.enum(RESTAURANT_STATUSES),
  logo_path: z.string().nullable().optional(),
});

function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) throw new Error(`RPC is_platform_admin falhou: ${error.message}`);
  return data === true;
});

export const getMyRestaurants = cache(async (): Promise<MyRestaurant[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_restaurants");
  if (error) throw new Error(`RPC my_restaurants falhou: ${error.message}`);
  if (!Array.isArray(data)) return [];

  const restaurants: MyRestaurant[] = [];
  for (const row of data) {
    const parsed = myRestaurantSchema.safeParse(row);
    if (parsed.success) restaurants.push(parsed.data);
    else console.warn("my_restaurants: linha ignorada por formato inesperado");
  }
  return restaurants;
});

export const getPendingInvitations = cache(
  async (): Promise<PendingInvitation[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("my_pending_invitations");
    if (error) {
      throw new Error(`RPC my_pending_invitations falhou: ${error.message}`);
    }
    if (!Array.isArray(data)) return [];
    const invitations: PendingInvitation[] = [];
    for (const row of data) {
      const parsed = pendingInvitationSchema.safeParse(row);
      if (parsed.success) invitations.push(parsed.data);
    }
    return invitations;
  },
);

export const getMyPermissions = cache(
  async (restaurantId: string): Promise<string[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("my_permissions", {
      rid: restaurantId,
    });
    if (error) throw new Error(`RPC my_permissions falhou: ${error.message}`);
    const parsed = z.array(z.string()).safeParse(data ?? []);
    return parsed.success ? parsed.data : [];
  },
);

/** Resolve um restaurante ativo pelo slug (uso público, sem sessão). */
export async function resolveRestaurantBySlug(
  slug: string,
): Promise<PublicRestaurant | null> {
  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc("resolve_restaurant_by_slug", {
    p_slug: slug,
  });
  if (error) {
    throw new Error(`RPC resolve_restaurant_by_slug falhou: ${error.message}`);
  }
  const row = firstRow(data);
  if (!row) return null;
  const parsed = publicRestaurantSchema.safeParse(row);
  if (!parsed.success) return null;
  return { ...parsed.data, logo_path: parsed.data.logo_path ?? null };
}
