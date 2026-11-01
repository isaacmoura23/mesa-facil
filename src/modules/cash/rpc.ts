import type { AppSupabaseClient } from "@/lib/supabase/types";
import { movementListSchema, requestListSchema, sessionListSchema, summarySchema } from "./types";
import type { CashSummary, MovementKind, MovementRow, RequestRow, SessionRow } from "./types";

/** Erro de uma ação do caixa, com a mensagem em português para a tela. */
export class CashError extends Error {
  constructor(
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** Mensagens das regras do banco (`CODIGO: texto`). O que não for reconhecido vira texto genérico. */
const FRIENDLY: Record<string, string> = {
  SESSION_ALREADY_OPEN: "Já existe um turno aberto.",
  SESSION_NOT_OPEN: "Este turno já foi fechado.",
  REASON_REQUIRED: "Informe o motivo (pelo menos 3 letras).",
  INVALID_AMOUNT: "Informe um valor maior que zero.",
  INVALID_RANGE: "Período inválido.",
  REQUEST_NOT_PENDING: "Este pedido já foi decidido por outra pessoa.",
  SELF_APPROVAL: "Quem pediu a retirada não pode aprová-la. Peça a outro gerente.",
  ALREADY_REVERSED: "Este lançamento já foi estornado.",
  NOT_REVERSIBLE: "Este tipo de lançamento não pode ser estornado.",
  IDEMPOTENCY_CONFLICT: "Esta tentativa já foi usada com outros dados. Atualize a página e tente de novo.",
  FORBIDDEN: "Você não tem permissão para esta ação.",
  UNAUTHENTICATED: "Sua sessão expirou. Entre de novo.",
};

export function parseCashError(error: { message?: string } | null | undefined): CashError {
  const message = error?.message ?? "";
  const code = /^([A-Z_]{4,40})\b/.exec(message)?.[1] ?? null;
  if (code && FRIENDLY[code]) return new CashError(FRIENDLY[code], code);
  if (/permission denied|row-level security/i.test(message)) return new CashError(FRIENDLY.FORBIDDEN, "FORBIDDEN");
  return new CashError("Não foi possível concluir agora. Atualize a página e tente de novo.", code);
}

async function call<T>(supabase: AppSupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw parseCashError(error);
  return data as T;
}

const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}-xxxx`;

export async function loadSummary(supabase: AppSupabaseClient, restaurant: string, from: string, to: string): Promise<CashSummary> {
  const data = await call<unknown>(supabase, "cash_summary", { p_restaurant: restaurant, p_from: from, p_to: to });
  const parsed = summarySchema.safeParse(data);
  if (!parsed.success) throw new CashError("Resposta inesperada do servidor.");
  return parsed.data;
}

export async function loadMovements(
  supabase: AppSupabaseClient,
  restaurant: string,
  from: string,
  to: string,
  kind: MovementKind | null,
): Promise<MovementRow[]> {
  const data = await call<unknown>(supabase, "cash_list", {
    p_restaurant: restaurant, p_from: from, p_to: to, p_kind: kind, p_session: null, p_limit: 200, p_before: null,
  });
  const parsed = movementListSchema.safeParse(data);
  if (!parsed.success) throw new CashError("Resposta inesperada do servidor.");
  return parsed.data;
}

export async function loadRequests(supabase: AppSupabaseClient, restaurant: string, status: string | null, limit = 50): Promise<RequestRow[]> {
  const data = await call<unknown>(supabase, "cash_list_requests", { p_restaurant: restaurant, p_status: status, p_limit: limit });
  const parsed = requestListSchema.safeParse(data);
  if (!parsed.success) throw new CashError("Resposta inesperada do servidor.");
  return parsed.data;
}

export async function loadSessions(supabase: AppSupabaseClient, restaurant: string): Promise<SessionRow[]> {
  const data = await call<unknown>(supabase, "cash_list_sessions", { p_restaurant: restaurant, p_limit: 20 });
  const parsed = sessionListSchema.safeParse(data);
  if (!parsed.success) throw new CashError("Resposta inesperada do servidor.");
  return parsed.data;
}

export const openSession = (s: AppSupabaseClient, restaurant: string, openingCents: number) =>
  call<unknown>(s, "cash_open_session", { p_restaurant: restaurant, p_opening_cents: openingCents });

export const closeSession = (s: AppSupabaseClient, session: string, countedCents: number, notes: string | null) =>
  call<unknown>(s, "cash_close_session", { p_session: session, p_counted_cents: countedCents, p_notes: notes });

/** `key` identifica a tentativa: repetir a mesma tentativa (clique duplo, rede ruim) não duplica o lançamento. */
export const recordMovement = (
  s: AppSupabaseClient, restaurant: string, kind: "SUPPLY" | "EXPENSE", amountCents: number, reason: string | null, key: string = newKey(),
) => call<unknown>(s, "cash_record_movement", { p_restaurant: restaurant, p_kind: kind, p_amount_cents: amountCents, p_reason: reason, p_idempotency_key: key });

export const requestWithdrawal = (
  s: AppSupabaseClient, restaurant: string, amountCents: number, reason: string, key: string = newKey(),
) => call<unknown>(s, "cash_request_withdrawal", { p_restaurant: restaurant, p_amount_cents: amountCents, p_reason: reason, p_idempotency_key: key });

export const withdrawDirect = (
  s: AppSupabaseClient, restaurant: string, amountCents: number, reason: string, key: string = newKey(),
) => call<unknown>(s, "cash_withdraw_direct", { p_restaurant: restaurant, p_amount_cents: amountCents, p_reason: reason, p_idempotency_key: key });

export const decideWithdrawal = (s: AppSupabaseClient, request: string, action: "APPROVE" | "REJECT" | "CANCEL", note: string | null) =>
  call<unknown>(s, "cash_decide_withdrawal", { p_request: request, p_action: action, p_note: note });

export const reverseMovement = (s: AppSupabaseClient, movement: string, reason: string) =>
  call<unknown>(s, "cash_reverse_movement", { p_movement: movement, p_reason: reason });
