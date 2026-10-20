import { z } from "zod";
import { RESTAURANT_STATUSES } from "@/lib/auth/types";

/** Resultado padrão das Server Actions da plataforma. */
export type ActionResult =
  | { ok: true; message?: string; data?: { sessionId?: string } }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

const text = z.string().nullish().transform((value) => value ?? null);
const count = z.coerce.number().nullish().transform((value) => value ?? 0);

/** `platform_dashboard()`: somente agregados. */
export const dashboardSchema = z.object({
  restaurants: z.object({
    total: count,
    pending: count,
    active: count,
    suspended: count,
    new_30d: count,
  }),
  subscriptions: z.object({
    active: count,
    trial: count,
    past_due: count,
    cancelled: count,
  }),
  mrr_cents: count,
  orders_30d: count,
  tickets_open: count,
  support_sessions_active: count,
});
export type DashboardData = z.infer<typeof dashboardSchema>;

export const restaurantStatusSchema = z.enum(RESTAURANT_STATUSES);

export const listRowSchema = z.object({
  id: z.string().min(1),
  slug: z.string(),
  name: z.string(),
  status: restaurantStatusSchema,
  created_at: text,
  plan_name: text,
  subscription_status: text,
  members_count: count,
  owner_name: text,
  owner_email: text,
});
export type RestaurantRow = z.infer<typeof listRowSchema>;

export const cursorSchema = z.record(z.string(), z.unknown());
export type Cursor = z.infer<typeof cursorSchema>;

export const listPayloadSchema = z.object({
  rows: z.array(listRowSchema),
  next_cursor: cursorSchema.nullish().transform((value) => value ?? null),
});
export type RestaurantPage = z.infer<typeof listPayloadSchema>;

const memberSchema = z
  .object({
    role: text,
    status: text,
    full_name: text,
    name: text,
    email: text,
    invited_email: text,
  })
  .transform((m) => ({
    role: m.role,
    status: m.status,
    name: m.full_name ?? m.name,
    email: m.email ?? m.invited_email,
  }));
export type DetailMember = z.output<typeof memberSchema>;

const auditSchema = z.object({
  id: z.coerce.string().nullish().transform((value) => value ?? null),
  created_at: text,
  action: z.string(),
  actor_name: text,
  metadata: z.record(z.string(), z.unknown()).nullish().transform((value) => value ?? {}),
});
export type DetailAudit = z.output<typeof auditSchema>;

const subscriptionSchema = z
  .object({
    plan_name: text,
    plan_code: text,
    price_cents: z.coerce.number().nullish().transform((value) => value ?? null),
    status: text,
    current_period_end: text,
    trial_ends_at: text,
    period_end: text,
    note: text,
  })
  .transform((s) => ({
    plan_name: s.plan_name,
    price_cents: s.price_cents,
    status: s.status,
    period_end: s.current_period_end ?? s.period_end,
    trial_ends_at: s.trial_ends_at,
    note: s.note,
  }));

const restaurantMetaSchema = z.object({
  id: z.string().min(1),
  slug: z.string(),
  name: z.string(),
  status: restaurantStatusSchema,
  created_at: text,
  owner_name: text,
  owner_email: text,
});

/** `platform_get_restaurant(p_restaurant)`. */
export const detailSchema = z.object({
  restaurant: restaurantMetaSchema,
  subscription: subscriptionSchema.nullish().transform((value) => value ?? null),
  team: z.array(memberSchema).nullish().transform((value) => value ?? []),
  audit: z.array(auditSchema).nullish().transform((value) => value ?? []),
});
export type RestaurantDetail = z.output<typeof detailSchema>;
