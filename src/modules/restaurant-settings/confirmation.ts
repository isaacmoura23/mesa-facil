import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { ContactRow } from "@/modules/restaurant-profile/types";
import type { ExceptionRow, HourRow, SettingsRow, ZoneRow } from "./types";

/**
 * Confirmação dos dados do cardápio. A "impressão digital" resume só o que o
 * cliente vê e o dono controla; se algo mudar depois da confirmação, ela deixa
 * de bater e a tela pede nova confirmação. Vale só para o futuro: exceções
 * passadas não entram, para a confirmação não vencer sozinha.
 */
export type ConfirmationInput = {
  settings: SettingsRow;
  hours: HourRow[];
  exceptions: ExceptionRow[];
  zones: ZoneRow[];
  contact: ContactRow;
  today: string;
};

export function storefrontDataHash(input: ConfirmationInput): string {
  const { settings, hours, exceptions, zones, contact, today } = input;
  const snapshot = {
    accepts_orders: settings.accepts_orders,
    fulfillment: [...settings.enabled_fulfillment_types].sort(),
    min_order_cents: settings.min_order_cents,
    prep_time_minutes: settings.prep_time_minutes,
    hours: hours
      .map((row) => [row.weekday, row.opens_at.slice(0, 5), row.closes_at.slice(0, 5)])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    exceptions: exceptions
      .filter((exception) => exception.on_date >= today)
      .map((exception) => [
        exception.on_date,
        exception.is_closed,
        exception.opens_at?.slice(0, 5) ?? null,
        exception.closes_at?.slice(0, 5) ?? null,
        exception.description ?? null,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    zones: zones
      .filter((zone) => zone.is_active)
      .map((zone) => [zone.name, zone.fee_cents, zone.min_order_cents, zone.estimated_minutes])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    contact: [contact.whatsapp, contact.address_text, contact.storefront_notice],
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export type ConfirmationState =
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "current"; confirmedAt: string }
  | { kind: "outdated"; confirmedAt: string };

const rowSchema = z.object({ confirmed_at: z.string(), data_hash: z.string() });

/** Lê a confirmação atual. Antes da migração 0140 (ou em erro de leitura) devolve `unavailable`. */
export async function getConfirmationState(restaurantId: string, currentHash: string | null): Promise<ConfirmationState> {
  if (currentHash === null) return { kind: "unavailable" };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("storefront_confirmations")
    .select("confirmed_at, data_hash")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (error) return { kind: "unavailable" };
  if (data === null) return { kind: "none" };
  const parsed = rowSchema.safeParse(data);
  if (!parsed.success) return { kind: "unavailable" };
  return parsed.data.data_hash === currentHash
    ? { kind: "current", confirmedAt: parsed.data.confirmed_at }
    : { kind: "outdated", confirmedAt: parsed.data.confirmed_at };
}
