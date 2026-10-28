"use server";

import { z } from "zod";
import { localDateIn, intervalKey, type WeekHours } from "./hours";
import {
  acceptsOrdersSchema,
  exceptionSchema,
  fieldErrorsOf,
  idOnlySchema,
  rulesSchema,
  weekSchema,
  zoneSchema,
  zoneToggleSchema,
  type RulesInput,
} from "./schemas";
import {
  authorize,
  failure,
  LIVE_CHANGE_WARNING,
  revalidateSettings,
  type Context,
} from "./server-context";
import type { ActionResult } from "./types";

const NOT_FOUND = "Não encontramos este registro. Atualize a página e tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora.";

function invalid(error: z.ZodError): ActionResult {
  return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(error) };
}

// ---------------------------------------------------------------------------
// restaurant_settings
// ---------------------------------------------------------------------------

type SettingsPatch = Record<string, string | number | boolean | string[] | null>;

/** UPDATE da linha 1:1; se ela não existir (restaurante antigo), cria. */
async function writeSettings(ctx: Context, patch: SettingsPatch): Promise<ActionResult | null> {
  const { data, error } = await ctx.supabase
    .from("restaurant_settings")
    .update(patch)
    .eq("restaurant_id", ctx.restaurantId)
    .select("restaurant_id");
  if (error) return failure(error, SAVE_ERROR);
  if (data && data.length > 0) return null;

  const { error: insertError } = await ctx.supabase
    .from("restaurant_settings")
    .insert({ restaurant_id: ctx.restaurantId, ...patch });
  return insertError ? failure(insertError, SAVE_ERROR) : null;
}

export async function saveAcceptsOrdersAction(slug: string, input: { acceptsOrders: boolean }): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = acceptsOrdersSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const problem = await writeSettings(auth.ctx, { accepts_orders: parsed.data.acceptsOrders });
  if (problem) return problem;

  revalidateSettings(auth.ctx);
  return {
    ok: true,
    message: parsed.data.acceptsOrders ? "Pedidos online reabertos." : "Pedidos online pausados.",
    warning: LIVE_CHANGE_WARNING,
  };
}

export async function saveRulesAction(slug: string, input: RulesInput): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { fulfillmentTypes, prepMinutes, minOrder, pickupInstructions, singleTabPerTable } = parsed.data;

  const problem = await writeSettings(auth.ctx, {
    enabled_fulfillment_types: fulfillmentTypes,
    prep_time_minutes: prepMinutes,
    min_order_cents: minOrder,
    pickup_instructions: pickupInstructions,
    single_tab_per_table: singleTabPerTable,
  });
  if (problem) return problem;

  revalidateSettings(auth.ctx);
  return { ok: true, message: "Regras de atendimento atualizadas.", warning: LIVE_CHANGE_WARNING };
}

// ---------------------------------------------------------------------------
// business_hours
// ---------------------------------------------------------------------------

const hourDbRowSchema = z.object({
  id: z.string(),
  weekday: z.number().int(),
  opens_at: z.string(),
  closes_at: z.string(),
});

export async function saveWeekHoursAction(slug: string, input: WeekHours): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;
  const parsed = weekSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Horários inválidos." };
  }
  const week = parsed.data;

  // Caminho atômico (Fase 8): uma RPC substitui a grade inteira numa transação.
  const rows = week.flatMap((intervals, weekday) =>
    intervals.map((interval) => ({ weekday, opens_at: interval.opens, closes_at: interval.closes })),
  );
  const atomic = await ctx.supabase.rpc("save_business_hours", { p_restaurant: ctx.restaurantId, p_hours: rows });
  if (!atomic.error) {
    revalidateSettings(ctx);
    return { ok: true, message: "Horários de funcionamento atualizados.", warning: LIVE_CHANGE_WARNING };
  }
  // Banco ainda sem a RPC (migração 0132 pendente): usa o salvamento por diferença antigo.
  if (atomic.error.code !== "PGRST202" && atomic.error.code !== "42883") {
    if (atomic.error.message.includes("INVALID_BUSINESS_HOURS")) {
      return { ok: false, message: "Horários inválidos. Revise os intervalos e tente de novo." };
    }
    return failure(atomic.error, SAVE_ERROR);
  }

  const current = await ctx.supabase
    .from("business_hours")
    .select("id, weekday, opens_at, closes_at")
    .eq("restaurant_id", ctx.restaurantId);
  const currentRows = z.array(hourDbRowSchema).safeParse(current.data ?? []);
  if (current.error || !currentRows.success) return failure(current.error, SAVE_ERROR);

  const wanted = new Map<string, { weekday: number; opens: string; closes: string }>();
  for (const [weekday, intervals] of week.entries()) {
    for (const interval of intervals) {
      wanted.set(intervalKey(weekday, interval), { weekday, ...interval });
    }
  }

  const keep = new Set<string>();
  const toDelete: z.infer<typeof hourDbRowSchema>[] = [];
  for (const row of currentRows.data) {
    const key = intervalKey(row.weekday, { opens: row.opens_at.slice(0, 5), closes: row.closes_at.slice(0, 5) });
    if (wanted.has(key) && !keep.has(key)) keep.add(key);
    else toDelete.push(row);
  }
  const toInsert = [...wanted.entries()]
    .filter(([key]) => !keep.has(key))
    .map(([, value]) => ({
      restaurant_id: ctx.restaurantId,
      weekday: value.weekday,
      opens_at: value.opens,
      closes_at: value.closes,
    }));

  if (toDelete.length > 0) {
    const { error } = await ctx.supabase
      .from("business_hours")
      .delete()
      .eq("restaurant_id", ctx.restaurantId)
      .in(
        "id",
        toDelete.map((row) => row.id),
      );
    if (error) return failure(error, SAVE_ERROR);
  }
  if (toInsert.length > 0) {
    const { error } = await ctx.supabase.from("business_hours").insert(toInsert);
    if (error) {
      // Desfaz a remoção para não deixar o restaurante sem horário por falha parcial.
      if (toDelete.length > 0) {
        await ctx.supabase.from("business_hours").insert(
          toDelete.map((row) => ({
            id: row.id,
            restaurant_id: ctx.restaurantId,
            weekday: row.weekday,
            opens_at: row.opens_at,
            closes_at: row.closes_at,
          })),
        );
      }
      return failure(error, SAVE_ERROR);
    }
  }

  revalidateSettings(ctx);
  return { ok: true, message: "Horários de funcionamento atualizados.", warning: LIVE_CHANGE_WARNING };
}

// ---------------------------------------------------------------------------
// business_hour_exceptions
// ---------------------------------------------------------------------------

export async function saveExceptionAction(
  slug: string,
  input: z.input<typeof exceptionSchema>,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;
  const parsed = exceptionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const value = parsed.data;

  const fields = {
    is_closed: value.isClosed,
    opens_at: value.opensAt,
    closes_at: value.closesAt,
    description: value.description,
  };

  if (value.id) {
    // A data não muda na edição (para outra data, exclua e crie de novo).
    const { data, error } = await ctx.supabase
      .from("business_hour_exceptions")
      .update(fields)
      .eq("restaurant_id", ctx.restaurantId)
      .eq("id", value.id)
      .select("id");
    if (error) return failure(error, SAVE_ERROR);
    if (!data?.length) return { ok: false, message: NOT_FOUND };
  } else {
    const tz = await ctx.supabase.from("restaurants").select("timezone").eq("id", ctx.restaurantId).maybeSingle();
    const timezone = typeof tz.data?.timezone === "string" ? tz.data.timezone : "America/Sao_Paulo";
    if (value.onDate < localDateIn(timezone)) {
      return {
        ok: false,
        message: "Escolha uma data de hoje em diante.",
        fieldErrors: { onDate: "Escolha uma data de hoje em diante." },
      };
    }
    const { error } = await ctx.supabase
      .from("business_hour_exceptions")
      .insert({ restaurant_id: ctx.restaurantId, on_date: value.onDate, ...fields });
    if (error) {
      const result = failure(error, SAVE_ERROR);
      return error.code === "23505" ? { ...result, fieldErrors: { onDate: result.message } } : result;
    }
  }

  revalidateSettings(ctx);
  return { ok: true, message: "Exceção salva.", warning: LIVE_CHANGE_WARNING };
}

export async function deleteExceptionAction(slug: string, input: { id: string }): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = idOnlySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_FOUND };

  const { data, error } = await auth.ctx.supabase
    .from("business_hour_exceptions")
    .delete()
    .eq("restaurant_id", auth.ctx.restaurantId)
    .eq("id", parsed.data.id)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir agora.");
  if (!data?.length) return { ok: false, message: NOT_FOUND };

  revalidateSettings(auth.ctx);
  return { ok: true, message: "Exceção excluída.", warning: LIVE_CHANGE_WARNING };
}

// ---------------------------------------------------------------------------
// delivery_zones
// ---------------------------------------------------------------------------

export async function saveZoneAction(slug: string, input: z.input<typeof zoneSchema>): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;
  const parsed = zoneSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const value = parsed.data;

  const fields = {
    name: value.name,
    fee_cents: value.fee,
    min_order_cents: value.minOrder,
    estimated_minutes: value.estimatedMinutes,
    neighborhoods: value.neighborhoods,
    is_active: value.isActive,
  };

  if (value.id) {
    const { data, error } = await ctx.supabase
      .from("delivery_zones")
      .update(fields)
      .eq("restaurant_id", ctx.restaurantId)
      .eq("id", value.id)
      .select("id");
    if (error) return failure(error, SAVE_ERROR);
    if (!data?.length) return { ok: false, message: NOT_FOUND };
  } else {
    const { error } = await ctx.supabase
      .from("delivery_zones")
      .insert({ restaurant_id: ctx.restaurantId, ...fields });
    if (error) return failure(error, SAVE_ERROR);
  }

  revalidateSettings(ctx);
  return { ok: true, message: value.id ? "Região atualizada." : "Região criada.", warning: LIVE_CHANGE_WARNING };
}

export async function setZoneActiveAction(
  slug: string,
  input: { id: string; isActive: boolean },
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = zoneToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_FOUND };

  const { data, error } = await auth.ctx.supabase
    .from("delivery_zones")
    .update({ is_active: parsed.data.isActive })
    .eq("restaurant_id", auth.ctx.restaurantId)
    .eq("id", parsed.data.id)
    .select("id");
  if (error) return failure(error, SAVE_ERROR);
  if (!data?.length) return { ok: false, message: NOT_FOUND };

  revalidateSettings(auth.ctx);
  return {
    ok: true,
    message: parsed.data.isActive ? "Região ativada." : "Região inativada.",
    warning: LIVE_CHANGE_WARNING,
  };
}

export async function deleteZoneAction(slug: string, input: { id: string }): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = idOnlySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_FOUND };

  const { data, error } = await auth.ctx.supabase
    .from("delivery_zones")
    .delete()
    .eq("restaurant_id", auth.ctx.restaurantId)
    .eq("id", parsed.data.id)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir agora.");
  if (!data?.length) return { ok: false, message: NOT_FOUND };

  revalidateSettings(auth.ctx);
  return {
    ok: true,
    message: "Região excluída.",
    warning: "Os pedidos antigos guardam a taxa e a região como foram feitos e não são alterados.",
  };
}
