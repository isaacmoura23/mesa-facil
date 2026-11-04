"use server";

import { revalidatePath } from "next/cache";
import { getRestaurantProfile } from "@/modules/restaurant-profile/queries";
import { storefrontDataHash } from "./confirmation";
import { getSettingsPageData } from "./queries";
import { authorize, failure } from "./server-context";
import type { ActionResult } from "./types";

/**
 * Confirma os dados que o cardápio mostra. O servidor relê tudo do banco e
 * calcula a impressão digital na hora: o navegador não envia dados nem hash,
 * então não dá para confirmar uma tela desatualizada.
 */
export async function confirmStorefrontDataAction(slug: string): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const [data, profile] = await Promise.all([
    getSettingsPageData({ restaurantId: ctx.restaurantId, slug: ctx.slug }),
    getRestaurantProfile(ctx.restaurantId),
  ]);
  if (!data.settings || !data.hours || !data.exceptions || !data.zones || !profile.contact) {
    return { ok: false, message: "Não foi possível ler todos os dados agora. Atualize a página e tente de novo." };
  }

  const hash = storefrontDataHash({
    settings: data.settings,
    hours: data.hours,
    exceptions: data.exceptions,
    zones: data.zones,
    contact: profile.contact,
    today: data.today,
  });

  const { error } = await ctx.supabase.rpc("confirm_storefront_data", { p_restaurant: ctx.restaurantId, p_hash: hash });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      return { ok: false, message: "A confirmação ainda não está disponível neste ambiente." };
    }
    return failure(error, "Não foi possível confirmar agora.");
  }

  revalidatePath(`/app/${ctx.slug}/configuracoes`);
  return { ok: true, message: "Dados do cardápio confirmados." };
}
