import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { getPublicEnvStatus } from "@/lib/env";
import { createPublicClient } from "@/lib/supabase/server";
import { SLUG_PATTERN } from "@/lib/validation/auth";
import { parsePublicMenu, type PublicMenu } from "./schemas";

/** Tag de cache do cardápio de um restaurante (para `revalidateTag` futuro). */
export function menuCacheTag(slug: string): string {
  return `storefront:menu:${slug}`;
}

/** Normaliza o slug da URL; retorna null se não puder ser um slug válido. */
export function normalizeSlug(raw: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return null;
  }
  return value.length <= 63 && SLUG_PATTERN.test(value) ? value : null;
}

/**
 * Cardápio público via RPC `public_menu` (cliente anon, sem cookies).
 *
 * Cache: `use cache` com vida curta (stale 30s no cliente, revalida em 60s,
 * expira em 5min) e tag por slug. O conteúdo é idêntico para todos os
 * visitantes, então pode ser compartilhado; `is_open_now` pode ficar até ~1min
 * defasado, o que é apenas informativo: o `validate_cart` (sem cache) é a
 * autoridade sobre aberto/fechado. Erros não são cacheados (a exceção sobe).
 */
async function fetchPublicMenu(slug: string): Promise<PublicMenu | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag(menuCacheTag(slug));

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc("public_menu", { p_slug: slug });
  if (error) {
    if (/not_found|restaurant_unavailable/i.test(error.message)) return null;
    throw new Error(`RPC public_menu falhou: ${error.message}`);
  }
  if (data === null || data === undefined) return null;
  // A RPC pode devolver o jsonb direto ou embrulhado em lista.
  const raw: unknown = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;

  const menu = parsePublicMenu(raw);
  if (!menu) throw new Error("RPC public_menu devolveu um formato inesperado.");
  return menu;
}

/**
 * Retorna o cardápio do restaurante ou null (slug inválido, inexistente ou
 * inativo). Lança se o Supabase não estiver configurado ou a RPC falhar.
 */
export async function getPublicMenu(rawSlug: string): Promise<PublicMenu | null> {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;
  if (!getPublicEnvStatus().ok) throw new Error("Supabase não configurado.");
  return fetchPublicMenu(slug);
}
