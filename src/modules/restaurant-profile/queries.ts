import "server-only";
import { createClient } from "@/lib/supabase/server";
import { contactRowSchema, originsSchema, type RestaurantProfileData } from "./types";

/**
 * Lê o contato e as origens da vitrine com o cliente do usuário (RLS).
 *
 * `storefront_origins` NÃO é legível por SELECT direto (grant por coluna na
 * migração 0113): as colunas são listadas explicitamente (nunca select *) e as
 * origens vêm da RPC `get_storefront_origins`, restrita à equipe.
 */
export async function getRestaurantProfile(restaurantId: string): Promise<RestaurantProfileData> {
  const supabase = await createClient();

  const [settings, origins] = await Promise.all([
    supabase
      .from("restaurant_settings")
      .select("whatsapp, phone, address_text, storefront_url")
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    supabase.rpc("get_storefront_origins", { p_restaurant: restaurantId }),
  ]);

  let contact: RestaurantProfileData["contact"] = null;
  if (!settings.error) {
    if (settings.data === null) {
      contact = { whatsapp: null, phone: null, address_text: null, storefront_url: null };
    } else {
      const parsed = contactRowSchema.safeParse(settings.data);
      if (parsed.success) contact = parsed.data;
    }
  }

  let originList: string[] | null = null;
  if (!origins.error) {
    const parsed = originsSchema.safeParse(origins.data ?? []);
    if (parsed.success) originList = parsed.data;
  }

  return { contact, origins: originList };
}
