import { z } from "zod";
import { MEMBERSHIP_STATUSES, PERMISSIONS, RESTAURANT_ROLES } from "@/lib/auth/types";
import type { MembershipStatus, Permission, RestaurantRole } from "@/lib/auth/types";

/** Resultado padrão das Server Actions de equipe (mesmo formato do cardápio). */
export type ActionResult =
  | { ok: true; message?: string; warning?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

const nullableText = z.string().nullish().transform((value) => value ?? null);

const overrideSchema = z.object({
  permission: z.string(),
  granted: z.boolean(),
});

/** Linha de `list_team` (docs/CONTRACT.md, Fase 5). */
export const teamMemberSchema = z.object({
  membership_id: z.string().min(1),
  user_id: nullableText,
  full_name: nullableText,
  email: nullableText,
  invited_email: nullableText,
  role: z.enum(RESTAURANT_ROLES),
  status: z.enum(MEMBERSHIP_STATUSES),
  permissions: z.array(z.string()).nullish().transform((value) => value ?? []),
  overrides: z.array(overrideSchema).nullish().transform((value) => value ?? []),
  created_at: nullableText,
  last_sign_in_at: nullableText,
});

export type TeamMember = z.infer<typeof teamMemberSchema>;

/** `list_team` devolve a lista direta ou embrulhada; aceitamos as duas formas. */
export const teamPayloadSchema = z.union([
  z.array(teamMemberSchema),
  z.object({ members: z.array(teamMemberSchema) }).transform((value) => value.members),
  z.object({ rows: z.array(teamMemberSchema) }).transform((value) => value.rows),
  z.object({ team: z.array(teamMemberSchema) }).transform((value) => value.team),
]);

export const auditRowSchema = z.object({
  id: z.string().min(1),
  created_at: z.string(),
  actor_id: nullableText,
  actor_name: nullableText,
  action: z.string(),
  resource_type: nullableText,
  resource_id: nullableText,
  metadata: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((value) => value ?? {}),
});

export type AuditRow = z.infer<typeof auditRowSchema>;

/** Cursor keyset opaco: o servidor devolve e a gente apenas reenvia. */
export const auditCursorSchema = z.record(z.string(), z.unknown());
export type AuditCursor = z.infer<typeof auditCursorSchema>;

export const auditPayloadSchema = z.object({
  rows: z.array(auditRowSchema),
  next_cursor: auditCursorSchema.nullish().transform((value) => value ?? null),
});

export type AuditPage = z.infer<typeof auditPayloadSchema>;

export type AuditFilters = {
  /** Chave de `AUDIT_CATEGORIES` ("" = todas). */
  category: string;
  /** AAAA-MM-DD (fuso do restaurante) ou "". */
  from: string;
  to: string;
};

export type TeamResult =
  | { ok: true; members: TeamMember[] }
  | { ok: false; message: string };

export type AuditResult =
  | { ok: true; page: AuditPage }
  | { ok: false; message: string };

export type { MembershipStatus, Permission, RestaurantRole };
export { PERMISSIONS };

/** Funções que podem ser atribuídas por convite (nunca `owner`). */
export const ASSIGNABLE_ROLES = ["manager", "cashier", "kitchen", "waiter"] as const satisfies readonly RestaurantRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
