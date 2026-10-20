"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { parseToCents } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { buildAuditCsv, CSV_LIMIT } from "./audit-text";
import { errorMessage, failure } from "./errors";
import { fetchAudit, fetchPlans, fetchSessions, fetchSubscriptions, fetchTickets } from "./queries";
import {
  auditFiltersSchema,
  fieldErrorsOf,
  parseFeatureLines,
  planFormSchema,
  sessionIdSchema,
  settingsFormSchema,
  subscriptionFilterSchema,
  subscriptionFormSchema,
  ticketFilterSchema,
  ticketFormSchema,
  type PlanFormInput,
  type SettingsFormInput,
  type SubscriptionFormInput,
  type TicketFormInput,
} from "./schemas";
import type {
  ActionResult,
  AuditEntry,
  AuditFilters,
  Cursor,
  PageResult,
  SessionRow,
  SubscriptionRow,
  TicketRow,
  AuditEntry as Audit,
} from "./types";

/**
 * Server Actions do painel da plataforma. Toda ação exige administrador da
 * plataforma (404 caso contrário) e usa o cliente Supabase DO USUÁRIO: quem
 * decide permissão (superadmin x support) são as RPCs. A checagem de papel
 * feita aqui só melhora a mensagem.
 */

const NOT_CONFIGURED: Extract<ActionResult, { ok: false }> = {
  ok: false,
  message: "O Supabase ainda não está configurado neste ambiente.",
};
const BAD_REQUEST = "Requisição inválida. Atualize a página e tente de novo.";

type Ctx = { supabase: AppSupabaseClient };

async function context(): Promise<Ctx | null> {
  if (!getPublicEnvStatus().ok) return null;
  await requirePlatformAdmin();
  return { supabase: await createClient() };
}

function cursorOf(value: unknown): Cursor | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Cursor) : null;
}

export async function savePlanAction(input: PlanFormInput): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return NOT_CONFIGURED;
  const parsed = planFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const data = parsed.data;
  const priceCents = parseToCents(data.price);
  const features = parseFeatureLines(data.features);
  if (priceCents === null || features === null) return { ok: false, message: BAD_REQUEST };
  const limits: Record<string, number | null> = {};
  for (const key of ["max_members", "max_tables", "max_products"] as const) {
    limits[key] = data[key] === "" ? null : Number(data[key]);
  }
  if (data.id) {
    // O banco substitui `limits` por inteiro: preserva chaves que o formulário não edita.
    const current = await fetchPlans();
    const plan = current.ok ? current.plans.find((item) => item.id === data.id) : undefined;
    for (const [key, value] of Object.entries(plan?.limits ?? {})) {
      if (!(key in limits)) limits[key] = value;
    }
  }
  const { error } = await ctx.supabase.rpc("platform_upsert_plan", {
    p_id: data.id || null,
    p_code: data.code,
    p_name: data.name,
    p_price_cents: priceCents,
    p_limits: limits,
    p_features: features,
    p_is_active: data.isActive,
  });
  if (error) return failure(error);
  revalidatePath("/platform/plans");
  revalidatePath("/platform/subscriptions");
  return { ok: true, message: data.id ? "Plano atualizado" : "Plano criado" };
}

export async function setSubscriptionAction(input: SubscriptionFormInput): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return NOT_CONFIGURED;
  const parsed = subscriptionFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const data = parsed.data;
  const { error } = await ctx.supabase.rpc("platform_set_subscription", {
    p_restaurant: data.restaurant,
    p_plan: data.plan,
    p_status: data.status,
    p_period_end: data.periodEnd ? `${data.periodEnd}T23:59:59-03:00` : null,
    p_note: data.note || null,
  });
  if (error) return failure(error);
  revalidatePath("/platform/subscriptions");
  revalidatePath("/platform/restaurants");
  return { ok: true, message: "Assinatura atualizada" };
}

export async function updateTicketAction(input: TicketFormInput): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return NOT_CONFIGURED;
  const parsed = ticketFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { error } = await ctx.supabase.rpc("platform_update_ticket", {
    p_ticket: parsed.data.id,
    p_status: parsed.data.status,
    p_note: parsed.data.note || null,
  });
  if (error) return failure(error);
  revalidatePath("/platform/support");
  return { ok: true, message: "Ticket atualizado" };
}

export async function closeSessionAction(sessionId: string): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return NOT_CONFIGURED;
  const id = sessionIdSchema.safeParse(sessionId);
  if (!id.success) return { ok: false, message: BAD_REQUEST };
  const { error } = await ctx.supabase.rpc("close_support_session", { p_session: id.data });
  if (error) return failure(error);
  revalidatePath("/platform/support");
  revalidatePath(`/platform/support/${id.data}`);
  return { ok: true, message: "Sessão encerrada" };
}

export async function saveSettingsAction(input: SettingsFormInput, changed: readonly string[]): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return NOT_CONFIGURED;
  const parsed = settingsFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const data = parsed.data;
  const values: Record<string, unknown> = {
    registration_enabled: data.registrationEnabled,
    default_trial_days: Number(data.defaultTrialDays),
    support_email: data.supportEmail,
    maintenance_message: data.maintenanceMessage === "" ? null : data.maintenanceMessage,
  };
  const keys = Object.keys(values).filter((key) => changed.includes(key));
  if (keys.length === 0) return { ok: true, message: "Nada para salvar" };
  for (const key of keys) {
    const { error } = await ctx.supabase.rpc("platform_set_setting", { p_key: key, p_value: values[key] });
    if (error) return { ok: false, message: errorMessage(error) };
  }
  revalidatePath("/platform/settings");
  return { ok: true, message: "Configurações salvas" };
}

export async function loadSubscriptionsAction(status: string, cursor: unknown): Promise<PageResult<SubscriptionRow>> {
  if (!(await context())) return NOT_CONFIGURED;
  const filter = subscriptionFilterSchema.safeParse(status);
  if (!filter.success) return { ok: false, message: BAD_REQUEST };
  return fetchSubscriptions(filter.data, cursorOf(cursor));
}

export async function loadTicketsAction(status: string, cursor: unknown): Promise<PageResult<TicketRow>> {
  if (!(await context())) return NOT_CONFIGURED;
  const filter = ticketFilterSchema.safeParse(status);
  if (!filter.success) return { ok: false, message: BAD_REQUEST };
  return fetchTickets(filter.data, cursorOf(cursor));
}

export async function loadSessionsAction(activeOnly: boolean, cursor: unknown): Promise<PageResult<SessionRow>> {
  if (!(await context())) return NOT_CONFIGURED;
  return fetchSessions(activeOnly === true, cursorOf(cursor));
}

export async function loadAuditAction(filters: AuditFilters, cursor: unknown): Promise<PageResult<AuditEntry>> {
  if (!(await context())) return NOT_CONFIGURED;
  const parsed = auditFiltersSchema.safeParse(filters);
  if (!parsed.success) return { ok: false, message: BAD_REQUEST };
  return fetchAudit(parsed.data, cursorOf(cursor));
}

export async function exportAuditCsvAction(
  filters: AuditFilters,
): Promise<{ ok: true; csv: string; count: number; truncated: boolean } | { ok: false; message: string }> {
  if (!(await context())) return NOT_CONFIGURED;
  const parsed = auditFiltersSchema.safeParse(filters);
  if (!parsed.success) return { ok: false, message: BAD_REQUEST };
  const rows: Audit[] = [];
  let cursor: Cursor | null = null;
  let truncated = false;
  for (let guard = 0; guard < 60; guard += 1) {
    const page: PageResult<AuditEntry> = await fetchAudit(parsed.data, cursor, 200);
    if (!page.ok) return { ok: false, message: page.message };
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (rows.length >= CSV_LIMIT) {
      truncated = cursor !== null || rows.length > CSV_LIMIT;
      rows.length = Math.min(rows.length, CSV_LIMIT);
      break;
    }
    if (!cursor || page.rows.length === 0) break;
  }
  return { ok: true, csv: buildAuditCsv(rows, truncated), count: rows.length, truncated };
}
