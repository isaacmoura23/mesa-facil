import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createPublicClient } from "@/lib/supabase/server";
import { menuCacheTag } from "@/modules/storefront/data";
import type { QuoteRpcArgs } from "./handlers";

/**
 * Acesso ao Supabase da API pública: SEMPRE o cliente anon sem cookies, só RPCs
 * públicas. Erros do banco viram exceções genéricas (a rota nunca os repassa).
 */

/**
 * `public_menu` bruto, com cache de vida curta e a MESMA tag da vitrine padrão
 * (`/r/[slug]`), então um `revalidateTag(menuCacheTag(slug))` invalida os dois.
 * Devolve null se o restaurante não existe/está inativo. Erros não são cacheados.
 */
export async function fetchMenuRaw(slug: string): Promise<unknown> {
  "use cache";
  cacheTag(menuCacheTag(slug));

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc("public_menu", { p_slug: slug });
  if (error) {
    if (/not_found|restaurant_unavailable/i.test(error.message)) {
      cacheLife({ stale: 0, revalidate: 5, expire: 10 });
      return null;
    }
    throw new Error(`RPC public_menu falhou (${error.code ?? "sem código"})`);
  }
  if (data === null || data === undefined) {
    // "Não encontrado" vive pouco: um restaurante recém-criado/ativado aparece logo.
    cacheLife({ stale: 0, revalidate: 5, expire: 10 });
    return null;
  }
  cacheLife({ stale: 30, revalidate: 30, expire: 300 });
  return data;
}

/** `validate_cart` bruto (sem cache: é a autoridade sobre aberto/fechado e preços). */
export async function fetchQuoteRaw(slug: string, args: QuoteRpcArgs): Promise<unknown> {
  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc("validate_cart", {
    p_slug: slug,
    p_fulfillment: args.fulfillment,
    p_items: args.items,
    p_delivery_zone_id: args.zoneId,
  });
  if (error) throw new Error(`RPC validate_cart falhou (${error.code ?? "sem código"})`);
  return data;
}

/**
 * Origens https permitidas do restaurante (RPC `storefront_origins`, DB-4).
 * Se a RPC ainda não existe (PGRST202), devolve lista vazia: só as origens de
 * desenvolvimento (aplicadas em `cors.ts`) ficam liberadas.
 */
export async function fetchStorefrontOrigins(slug: string): Promise<string[]> {
  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc("storefront_origins", { p_slug: slug });
  if (error) {
    if (error.code === "PGRST202" || /could not find the function/i.test(error.message)) {
      return [];
    }
    throw new Error(`RPC storefront_origins falhou (${error.code ?? "sem código"})`);
  }
  return Array.isArray(data) ? data.filter((o): o is string => typeof o === "string") : [];
}
