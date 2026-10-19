import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_TIMEZONE, type ResolvedPeriod } from "@/lib/period";
import type { ReportGroup, ReportKey } from "./catalog";
import { failureFrom, loadFailure, type Result } from "./errors";
import { reportResponseSchema, type ReportData } from "./schemas";

const timezoneRowSchema = z.object({ timezone: z.string().nullable() });

/** Fuso do restaurante (RLS: só membros leem). Cai no padrão se ausente. */
export async function getRestaurantTimezone(restaurantId: string): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("timezone")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) return DEFAULT_TIMEZONE;
  const parsed = timezoneRowSchema.safeParse(data);
  return parsed.success && parsed.data.timezone ? parsed.data.timezone : DEFAULT_TIMEZONE;
}

/**
 * Executa um relatório pela RPC `restaurant_report`. O restaurante vem do guard;
 * a permissão (`reports.view`) é revalidada dentro do banco.
 */
export async function fetchReport(
  restaurantId: string,
  report: ReportKey,
  period: ResolvedPeriod,
  group: ReportGroup,
): Promise<Result<ReportData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("restaurant_report", {
    p_restaurant: restaurantId,
    p_report: report,
    p_from: period.fromIso,
    p_to: period.toIso,
    p_group: group,
  });
  if (error) return failureFrom(error);
  const parsed = reportResponseSchema.safeParse(data);
  if (!parsed.success) return loadFailure();
  return { ok: true, data: parsed.data };
}
