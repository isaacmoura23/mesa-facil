/** Tipos compartilhados do painel da plataforma (PLAT-B). */

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export type Cursor = Record<string, unknown>;

export type PageResult<T> =
  | { ok: true; rows: T[]; nextCursor: Cursor | null }
  | { ok: false; message: string };

export type SubscriptionStatus = "trial" | "active" | "past_due" | "cancelled";

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  limits: Record<string, number | null>;
  features: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
  subscriptionsTotal: number;
};

export type SubscriptionRow = {
  key: string;
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string | null;
  planId: string | null;
  planName: string | null;
  status: SubscriptionStatus | null;
  periodEnd: string | null;
  trialEndsAt: string | null;
};

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type TicketRow = {
  id: string;
  subject: string;
  body: string | null;
  status: TicketStatus;
  restaurantName: string | null;
  openedByName: string | null;
  note: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SessionRow = {
  id: string;
  restaurantId: string | null;
  restaurantName: string;
  adminName: string | null;
  isMine: boolean;
  reason: string;
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  /** Calculado pelo banco no momento da consulta. */
  active: boolean;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  actorName: string | null;
  actorId: string | null;
  restaurantName: string | null;
  action: string;
  metadata: Record<string, unknown>;
};

export type AuditFilters = {
  actor: string;
  prefix: string;
  restaurant: string;
  from: string;
  to: string;
};

export type PlatformSettings = {
  registrationEnabled: boolean;
  defaultTrialDays: number;
  supportEmail: string;
  maintenanceMessage: string;
};

export type RestaurantOption = { id: string; name: string };
