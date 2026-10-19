import "server-only";
import { createClient } from "@/lib/supabase/server";
import { endOfDayIso, prefixForCategory, startOfDayIso } from "./audit";
import {
  auditPayloadSchema,
  teamPayloadSchema,
  type AuditCursor,
  type AuditFilters,
  type AuditResult,
  type TeamResult,
} from "./types";

const TEAM_ERROR = "Não foi possível carregar a equipe agora. Atualize a página ou tente novamente em instantes.";
const AUDIT_ERROR = "Não foi possível carregar o histórico agora. Tente novamente em instantes.";

export const AUDIT_PAGE_SIZE = 25;

/** Equipe via RPC `list_team` (exige `team.manage`; o e-mail só sai por ela). */
export async function getTeam(restaurantId: string): Promise<TeamResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_team", { p_restaurant: restaurantId });
  if (error) return { ok: false, message: TEAM_ERROR };
  const parsed = teamPayloadSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: TEAM_ERROR };
  return { ok: true, members: parsed.data };
}

/** Uma página do histórico (`list_audit_logs`, paginação keyset via `p_before`). */
export async function getAuditPage(
  restaurantId: string,
  filters: AuditFilters,
  before: AuditCursor | null,
): Promise<AuditResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_audit_logs", {
    p_restaurant: restaurantId,
    p_action_prefix: prefixForCategory(filters.category),
    p_from: startOfDayIso(filters.from),
    p_to: endOfDayIso(filters.to),
    p_limit: AUDIT_PAGE_SIZE,
    p_before: before,
  });
  if (error) return { ok: false, message: AUDIT_ERROR };
  const parsed = auditPayloadSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: AUDIT_ERROR };
  return { ok: true, page: parsed.data };
}
