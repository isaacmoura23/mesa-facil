import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { localDateIn } from "./hours";
import {
  exceptionRowSchema,
  hourRowSchema,
  publicPreviewSchema,
  settingsRowSchema,
  zoneRowSchema,
  type SettingsPageData,
} from "./types";

/**
 * Leituras de /app/[slug]/configuracoes com o cliente do usuário (RLS).
 * Colunas listadas explicitamente (nunca `select *` em restaurant_settings,
 * que tem coluna sem grant de leitura). Cada bloco falha isoladamente: vira
 * `null` e a seção correspondente bloqueia a edição.
 */
export async function getSettingsPageData(args: {
  restaurantId: string;
  slug: string;
}): Promise<SettingsPageData> {
  const { restaurantId, slug } = args;
  const supabase = await createClient();

  const [settings, hours, exceptions, zones, restaurant, preview] = await Promise.all([
    supabase
      .from("restaurant_settings")
      .select(
        "accepts_orders, prep_time_minutes, min_order_cents, enabled_fulfillment_types, pickup_instructions, single_tab_per_table",
      )
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    supabase
      .from("business_hours")
      .select("id, weekday, opens_at, closes_at")
      .eq("restaurant_id", restaurantId)
      .order("weekday")
      .order("opens_at"),
    supabase
      .from("business_hour_exceptions")
      .select("id, on_date, is_closed, opens_at, closes_at, description")
      .eq("restaurant_id", restaurantId)
      .order("on_date")
      .limit(500),
    supabase
      .from("delivery_zones")
      .select("id, name, fee_cents, min_order_cents, estimated_minutes, neighborhoods, is_active")
      .eq("restaurant_id", restaurantId)
      .order("name"),
    supabase.from("restaurants").select("timezone").eq("id", restaurantId).maybeSingle(),
    supabase.rpc("public_menu", { p_slug: slug }),
  ]);

  const settingsParsed = settings.error ? null : settingsRowSchema.safeParse(settings.data);
  const hoursParsed = hours.error ? null : z.array(hourRowSchema).safeParse(hours.data ?? []);
  const exceptionsParsed = exceptions.error
    ? null
    : z.array(exceptionRowSchema).safeParse(exceptions.data ?? []);
  const zonesParsed = zones.error ? null : z.array(zoneRowSchema).safeParse(zones.data ?? []);
  const previewParsed = preview.error ? null : publicPreviewSchema.safeParse(preview.data);
  const timezone = restaurant.data?.timezone;

  const safeTimezone = typeof timezone === "string" && timezone !== "" ? timezone : "America/Sao_Paulo";
  return {
    // Linha ausente (restaurante antigo): valores padrão do banco; a ação cria a linha ao salvar.
    settings:
      settings.error || (settings.data !== null && !settingsParsed?.success)
        ? null
        : settings.data === null
          ? {
              accepts_orders: true,
              prep_time_minutes: 30,
              min_order_cents: 0,
              enabled_fulfillment_types: ["DELIVERY", "PICKUP"],
              pickup_instructions: null,
              single_tab_per_table: true,
            }
          : settingsParsed?.success
            ? settingsParsed.data
            : null,
    hours: hoursParsed?.success ? hoursParsed.data : null,
    exceptions: exceptionsParsed?.success ? exceptionsParsed.data : null,
    zones: zonesParsed?.success ? zonesParsed.data : null,
    preview: previewParsed?.success ? previewParsed.data : null,
    timezone: safeTimezone,
    today: localDateIn(safeTimezone),
  };
}
