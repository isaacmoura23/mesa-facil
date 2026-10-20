import "server-only";
import { cache } from "react";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { LOAD_ERROR } from "./errors";
import {
  isRec,
  toAudit,
  toPlan,
  toSession,
  toSettings,
  toSubscription,
  toTicket,
  unwrapPage,
  str,

  type Rec,
} from "./normalize";
import type {
  AuditEntry,
  AuditFilters,
  Cursor,
  PageResult,
  PlanRow,
  PlatformSettings,
  RestaurantOption,
  SessionRow,
  SubscriptionRow,
  TicketRow,
} from "./types";

export const PAGE_SIZE = 25;

/** Papel do administrador (a autoridade final é sempre o banco). */
export const getPlatformAccess = cache(async (nextPath: string) => {
  await requirePlatformAdmin(nextPath);
  const supabase = await createClient();
  const { data } = await supabase.rpc("is_platform_superadmin");
  return { superadmin: data === true };
});

async function rpcPage<T>(
  name: string,
  args: Record<string, unknown>,
  map: (row: Rec) => T | null,
): Promise<PageResult<T>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) return { ok: false, message: LOAD_ERROR };
  const page = unwrapPage(data);
  if (!page) return { ok: false, message: LOAD_ERROR };
  const rows: T[] = [];
  for (const row of page.rows) {
    const item = map(row);
    if (item) rows.push(item);
  }
  return { ok: true, rows, nextCursor: page.nextCursor };
}

export async function fetchPlans(): Promise<{ ok: true; plans: PlanRow[] } | { ok: false; message: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_plans");
  if (error) return { ok: false, message: LOAD_ERROR };
  const page = unwrapPage(data);
  if (!page) return { ok: false, message: LOAD_ERROR };
  const plans: PlanRow[] = [];
  for (const row of page.rows) {
    const plan = toPlan(row);
    if (plan) plans.push(plan);
  }
  return { ok: true, plans };
}

export function fetchSubscriptions(status: string, cursor: Cursor | null): Promise<PageResult<SubscriptionRow>> {
  return rpcPage(
    "platform_list_subscriptions",
    { p_status: status || null, p_cursor: cursor, p_limit: PAGE_SIZE },
    toSubscription,
  );
}

export function fetchTickets(status: string, cursor: Cursor | null): Promise<PageResult<TicketRow>> {
  return rpcPage("platform_list_tickets", { p_status: status || null, p_cursor: cursor, p_limit: PAGE_SIZE }, toTicket);
}

export function fetchSessions(activeOnly: boolean, cursor: Cursor | null): Promise<PageResult<SessionRow>> {
  return rpcPage(
    "platform_list_support_sessions",
    { p_active_only: activeOnly, p_cursor: cursor, p_limit: PAGE_SIZE },
    toSession,
  );
}

export function auditArgs(filters: AuditFilters, cursor: Cursor | null, limit: number): Record<string, unknown> {
  const from = filters.from ? `${filters.from}T00:00:00.000-03:00` : null;
  const to = filters.to ? `${filters.to}T23:59:59.999-03:00` : null;
  return {
    p_actor: filters.actor || null,
    p_action_prefix: filters.prefix || null,
    p_restaurant: filters.restaurant || null,
    p_from: from,
    p_to: to,
    p_cursor: cursor,
    p_limit: limit,
  };
}

export function fetchAudit(
  filters: AuditFilters,
  cursor: Cursor | null,
  limit: number = PAGE_SIZE,
): Promise<PageResult<AuditEntry>> {
  return rpcPage("platform_list_audit_logs", auditArgs(filters, cursor, limit), toAudit);
}

export async function fetchSettings(): Promise<{ ok: true; settings: PlatformSettings } | { ok: false; message: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_get_settings");
  if (error) return { ok: false, message: LOAD_ERROR };
  return { ok: true, settings: toSettings(data) };
}

/** Restaurantes para selects (nome e id apenas; nunca dados operacionais). */
export async function fetchRestaurantOptions(): Promise<RestaurantOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_restaurants", {
    p_search: null,
    p_status: null,
    p_cursor: null,
    p_limit: 100,
  });
  if (error) return [];
  const page = unwrapPage(data);
  if (!page) return [];
  const out: RestaurantOption[] = [];
  for (const row of page.rows) {
    const id = str(row, "id");
    const name = str(row, "name");
    if (id && name) out.push({ id, name });
  }
  return out;
}

export type OverviewResult = { ok: true; data: Rec } | { ok: false; code: "expired" | "error"; message: string };

export async function fetchSupportOverview(sessionId: string): Promise<OverviewResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_support_overview", { p_session: sessionId });
  if (error) {
    if (/SESSION_|SUPPORT_SESSION|FORBIDDEN/.test(error.message ?? "")) {
      return { ok: false, code: "expired", message: "Esta sessão de suporte expirou, foi encerrada ou não pertence a você." };
    }
    return { ok: false, code: "error", message: LOAD_ERROR };
  }
  if (!isRec(data)) return { ok: false, code: "error", message: LOAD_ERROR };
  return { ok: true, data };
}

