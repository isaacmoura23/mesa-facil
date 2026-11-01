import { z } from "zod";

/**
 * Estado da assinatura e uso do plano (RPC `restaurant_subscription_status`). Este arquivo é PURO
 * (sem Next/Supabase) para ser testado; a leitura fica em `queries.ts`.
 */

export const SUBSCRIPTION_STATES = ["active", "trial", "expired", "past_due", "cancelled", "none"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

const count = z.number().int().min(0).nullish().catch(null);

const statusSchema = z.object({
  state: z.enum(SUBSCRIPTION_STATES).catch("none"),
  blocked: z.boolean().catch(false),
  plan_code: z.string().nullish().catch(null),
  plan_name: z.string().nullish().catch(null),
  trial_ends_at: z.string().nullish().catch(null),
  current_period_end: z.string().nullish().catch(null),
  grace_ends_at: z.string().nullish().catch(null),
  days_left: count,
  limits: z.record(z.string(), z.unknown()).catch({}),
  usage: z
    .object({ members: count, tables: count, products: count })
    .catch({ members: null, tables: null, products: null }),
});

export type LimitKey = "members" | "tables" | "products";

export type PlanUsageRow = {
  key: LimitKey;
  label: string;
  used: number;
  /** `null` = ilimitado. */
  limit: number | null;
  reached: boolean;
};

export type SubscriptionStatus = {
  state: SubscriptionState;
  /** O banco já bloqueia novos pedidos (vencido/cancelado/past_due fora da tolerância). */
  blocked: boolean;
  planName: string | null;
  trialEndsAt: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  daysLeft: number | null;
  usage: PlanUsageRow[];
};

/** Nome do limite em `plans.limits` para cada contador (aceita os dois nomes de produto). */
const LIMIT_FIELDS: Record<LimitKey, readonly string[]> = {
  members: ["max_members"],
  tables: ["max_tables"],
  products: ["max_products", "max_menu_items"],
};

const LIMIT_LABELS: Record<LimitKey, string> = {
  members: "Integrantes da equipe",
  tables: "Mesas",
  products: "Produtos no cardápio",
};

function limitOf(limits: Record<string, unknown>, key: LimitKey): number | null {
  for (const field of LIMIT_FIELDS[key]) {
    if (!Object.hasOwn(limits, field)) continue;
    const value = limits[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return null; // ausente/nulo = ilimitado
}

/** Valida a resposta da RPC. Formato inesperado => `null` (nenhum banner, nunca um aviso errado). */
export function parseSubscriptionStatus(raw: unknown): SubscriptionStatus | null {
  const row: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (row === null || typeof row !== "object") return null;
  const parsed = statusSchema.safeParse(row);
  if (!parsed.success) return null;
  const d = parsed.data;

  const usage = (["members", "tables", "products"] as const).map((key): PlanUsageRow => {
    const used = d.usage[key] ?? 0;
    const limit = limitOf(d.limits, key);
    return { key, label: LIMIT_LABELS[key], used, limit, reached: limit !== null && used >= limit };
  });

  return {
    state: d.state,
    blocked: d.blocked,
    planName: d.plan_name ?? null,
    trialEndsAt: d.trial_ends_at ?? null,
    periodEnd: d.current_period_end ?? null,
    graceEndsAt: d.grace_ends_at ?? null,
    daysLeft: d.days_left ?? null,
    usage,
  };
}

export type PlanBanner = {
  tone: "warning" | "danger" | "info";
  title: string;
  message: string;
};

export const TRIAL_WARNING_DAYS = 7;

/** Banners a exibir (ordem de importância). Função pura. */
export function planBanners(status: SubscriptionStatus | null): PlanBanner[] {
  if (!status) return [];
  const banners: PlanBanner[] = [];
  const contact = "Fale com o suporte da plataforma para regularizar.";

  switch (status.state) {
    case "trial":
      if (status.daysLeft !== null && status.daysLeft <= TRIAL_WARNING_DAYS) {
        banners.push({
          tone: "warning",
          title: status.daysLeft <= 0 ? "Seu período de teste termina hoje" : "Seu período de teste está acabando",
          message:
            status.daysLeft <= 0
              ? `Depois disso os pedidos online serão bloqueados. ${contact}`
              : `Restam ${status.daysLeft} ${status.daysLeft === 1 ? "dia" : "dias"} de teste. Depois disso os pedidos online serão bloqueados. ${contact}`,
        });
      }
      break;
    case "expired":
      banners.push({
        tone: "danger",
        title: "Assinatura vencida",
        message: `Os pedidos online estão bloqueados e a vitrine mostra o restaurante como indisponível. Você ainda consegue consultar pedidos e relatórios. ${contact}`,
      });
      break;
    case "cancelled":
      banners.push({
        tone: "danger",
        title: "Assinatura cancelada",
        message: `Os pedidos online estão bloqueados. Você ainda consegue consultar pedidos e relatórios. ${contact}`,
      });
      break;
    case "past_due":
      banners.push(
        status.blocked
          ? {
              tone: "danger",
              title: "Pagamento em atraso: pedidos bloqueados",
              message: `A tolerância de atraso terminou e os pedidos online estão bloqueados. ${contact}`,
            }
          : {
              tone: "warning",
              title: "Pagamento em atraso",
              message: `Regularize o quanto antes: passada a tolerância, os pedidos online serão bloqueados. ${contact}`,
            },
      );
      break;
    default:
      break;
  }

  const reached = status.usage.filter((row) => row.reached);
  if (reached.length > 0) {
    banners.push({
      tone: "info",
      title: "Limite do plano atingido",
      message: `${reached.map((row) => `${row.label} (${row.used} de ${row.limit})`).join(", ")}. Para adicionar mais, remova itens que não usa ou peça a troca de plano ao suporte.`,
    });
  }
  return banners;
}

export const STATE_LABELS: Record<SubscriptionState, string> = {
  active: "Ativa",
  trial: "Em teste",
  expired: "Vencida",
  past_due: "Pagamento em atraso",
  cancelled: "Cancelada",
  none: "Sem assinatura",
};
