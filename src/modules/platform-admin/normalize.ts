import type {
  AuditEntry,
  Cursor,
  PlanRow,
  PlatformSettings,
  SessionRow,
  SubscriptionRow,
  SubscriptionStatus,
  TicketRow,
  TicketStatus,
} from "./types";

/**
 * Normalização tolerante das respostas das RPCs: aceita variações de nome de
 * campo e descarta o que não for reconhecível, sem lançar. Nunca repassa
 * objetos crus para a UI.
 */

export type Rec = Record<string, unknown>;

export function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(row: Rec, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export function num(row: Rec, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function bool(row: Rec, ...keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof row[key] === "boolean") return row[key] as boolean;
  }
  return null;
}

/** `{rows, next_cursor}` ou lista direta. */
export function unwrapPage(data: unknown): { rows: Rec[]; nextCursor: Cursor | null } | null {
  let rawRows: unknown;
  let cursor: unknown = null;
  if (Array.isArray(data)) rawRows = data;
  else if (isRec(data)) {
    rawRows = data.rows ?? data.items ?? data.data;
    cursor = data.next_cursor ?? null;
  } else return null;
  if (!Array.isArray(rawRows)) return null;
  return { rows: rawRows.filter(isRec), nextCursor: isRec(cursor) ? cursor : null };
}

export function normalizeSubscriptionStatus(value: string | null): SubscriptionStatus | null {
  switch (value) {
    case "trial":
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

export function normalizeTicketStatus(value: string | null): TicketStatus {
  return value === "in_progress" || value === "resolved" || value === "closed" ? value : "open";
}

export function toPlan(row: Rec): PlanRow | null {
  const id = str(row, "id");
  const code = str(row, "code");
  if (!id || !code) return null;
  const limits: Record<string, number | null> = {};
  if (isRec(row.limits)) {
    for (const [key, value] of Object.entries(row.limits)) {
      if (typeof value === "number" || value === null) limits[key] = value;
    }
  }
  return {
    id,
    code,
    name: str(row, "name") ?? code,
    priceCents: num(row, "price_cents") ?? 0,
    limits,
    features: isRec(row.features) ? row.features : {},
    isActive: bool(row, "is_active") ?? true,
    sortOrder: num(row, "sort_order") ?? 0,
    subscriptionsTotal: num(row, "subscriptions_total") ?? 0,
  };
}

export function toSubscription(row: Rec): SubscriptionRow | null {
  const restaurantId = str(row, "restaurant_id");
  if (!restaurantId) return null;
  return {
    key: str(row, "id", "subscription_id") ?? restaurantId,
    restaurantId,
    restaurantName: str(row, "restaurant_name", "name") ?? "Restaurante",
    restaurantSlug: str(row, "restaurant_slug", "slug"),
    planId: str(row, "plan_id"),
    planName: str(row, "plan_name"),
    status: normalizeSubscriptionStatus(str(row, "status", "subscription_status")),
    periodEnd: str(row, "current_period_end", "period_end"),
    trialEndsAt: str(row, "trial_ends_at"),
  };
}

export function toTicket(row: Rec): TicketRow | null {
  const id = str(row, "id", "ticket_id");
  if (!id) return null;
  return {
    id,
    subject: str(row, "subject") ?? "(sem assunto)",
    body: str(row, "body"),
    status: normalizeTicketStatus(str(row, "status")),
    restaurantName: str(row, "restaurant_name"),
    openedByName: str(row, "opened_by_name", "opened_by_email", "author_name"),
    note: str(row, "note", "internal_note"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export function toSession(row: Rec): SessionRow | null {
  const id = str(row, "id", "session_id");
  if (!id) return null;
  return {
    id,
    restaurantId: str(row, "restaurant_id"),
    restaurantName: str(row, "restaurant_name") ?? "Restaurante",
    adminName: str(row, "admin_name", "admin_email", "actor_name"),
    isMine: bool(row, "is_mine", "mine") ?? false,
    reason: str(row, "reason") ?? "",
    startedAt: str(row, "started_at"),
    expiresAt: str(row, "expires_at"),
    endedAt: str(row, "ended_at"),
    active: bool(row, "active") ?? false,
  };
}

export function toAudit(row: Rec): AuditEntry | null {
  const id = str(row, "id");
  const createdAt = str(row, "created_at");
  const action = str(row, "action");
  if (!id || !createdAt || !action) return null;
  return {
    id,
    createdAt,
    actorId: str(row, "actor_id"),
    actorName: str(row, "actor_name", "actor_email"),
    restaurantName: str(row, "restaurant_name"),
    action,
    metadata: isRec(row.metadata) ? row.metadata : {},
  };
}

/** `platform_get_settings` pode devolver objeto chave->valor ou lista {key,value}. */
export function toSettings(data: unknown): PlatformSettings {
  const map: Rec = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (isRec(item) && typeof item.key === "string") map[item.key] = item.value;
    }
  } else if (isRec(data)) {
    Object.assign(map, isRec(data.settings) ? data.settings : data);
  }
  const trial = map.default_trial_days;
  return {
    registrationEnabled: map.registration_enabled !== false,
    defaultTrialDays: typeof trial === "number" ? trial : 14,
    supportEmail: typeof map.support_email === "string" ? map.support_email : "",
    maintenanceMessage: typeof map.maintenance_message === "string" ? map.maintenance_message : "",
  };
}
