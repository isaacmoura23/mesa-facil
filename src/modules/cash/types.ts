import { z } from "zod";

/** Tipos e leitura segura das respostas das RPCs do caixa (migração 0135). Nada vem direto do banco para a tela sem passar por aqui. */

export const MOVEMENT_KINDS = ["SUPPLY", "EXPENSE", "WITHDRAWAL", "SALE", "REVERSAL"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const KIND_LABELS: Record<MovementKind, string> = {
  SUPPLY: "Entrada",
  EXPENSE: "Saída",
  WITHDRAWAL: "Retirada",
  SALE: "Venda em dinheiro",
  REVERSAL: "Estorno",
};

const cents = z.number().int();

export const openSessionSchema = z.object({
  id: z.string(),
  opened_at: z.string(),
  opening_cents: cents,
  expected_cents: cents,
});

export const summarySchema = z.object({
  in_cents: cents,
  out_cents: cents,
  net_cents: cents,
  sales_count: cents,
  tendered_cents: cents,
  change_given_cents: cents,
  by_kind: z.record(z.string(), z.object({ count: cents, amount_cents: cents })).catch({}),
  open_session: openSessionSchema.nullable(),
  pending_withdrawals: cents,
});
export type CashSummary = z.infer<typeof summarySchema>;

export const movementRowSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  kind: z.enum(MOVEMENT_KINDS),
  direction: z.enum(["IN", "OUT"]),
  amount_cents: cents,
  tendered_cents: cents.nullable(),
  change_cents: cents.nullable(),
  reason: z.string().nullable(),
  payment_id: z.string().nullable(),
  reverses: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  actor_name: z.string(),
  order_number: z.number().int().nullable(),
  tab_label: z.string().nullable(),
  reversed: z.boolean(),
});
export type MovementRow = z.infer<typeof movementRowSchema>;

export const REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export const STATUS_LABELS: Record<(typeof REQUEST_STATUSES)[number], string> = {
  PENDING: "Aguardando o gerente",
  APPROVED: "Aprovada",
  REJECTED: "Recusada",
  CANCELLED: "Cancelada",
};

export const requestRowSchema = z.object({
  id: z.string(),
  amount_cents: cents,
  reason: z.string(),
  status: z.enum(REQUEST_STATUSES),
  requested_by: z.string().nullable(),
  requested_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_note: z.string().nullable(),
  requested_by_name: z.string(),
  decided_by_name: z.string().nullable(),
});
export type RequestRow = z.infer<typeof requestRowSchema>;

export const sessionRowSchema = z.object({
  id: z.string(),
  status: z.enum(["OPEN", "CLOSED"]),
  opening_cents: cents,
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  counted_cents: cents.nullable(),
  difference_cents: cents.nullable(),
  expected_cents: cents.nullable(),
  notes: z.string().nullable(),
  opened_by_name: z.string(),
  closed_by_name: z.string().nullable(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

export const movementListSchema = z.array(movementRowSchema);
export const requestListSchema = z.array(requestRowSchema);
export const sessionListSchema = z.array(sessionRowSchema);
