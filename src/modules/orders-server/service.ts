import "server-only";
import { z } from "zod";
import { CAPTCHA_MESSAGES, verifyCaptcha } from "@/lib/captcha/turnstile";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPublicClient } from "@/lib/supabase/server";
import { normalizeSlug } from "@/modules/storefront/data";
import { orderErrorMessage } from "./messages";
import {
  isPublicCode,
  orderSubmissionSchema,
  phoneDigits,
  type OrderErrorItem,
  type OrderSubmission,
  type SubmitOrderResult,
} from "./schemas";
import { parseTrackedOrder, type TrackResult } from "./tracking";

/**
 * Serviço de pedidos (SERVIDOR). Reutilizado pela Server Action da vitrine
 * padrão e pela API pública. Regras:
 * - `create_public_order` só existe para service_role: o cliente admin NUNCA
 *   sai deste arquivo e só recebe dados já validados por zod;
 * - o resultado nunca contém IDs internos nem texto cru do banco;
 * - rate limit e checagem de origem ficam com quem chama (ver limits.ts).
 */

export type OrderContext = {
  /** Slug da URL (é normalizado aqui). */
  slug: string;
  source: "storefront" | "api";
  /** IP do cliente (já confiável) para o Turnstile. */
  ip?: string;
};

const created = z.object({
  ok: z.literal(true),
  public_code: z.string().regex(/^[A-Za-z0-9-]{3,40}$/),
  order_number: z.coerce.number().int().min(0),
  status: z.string().max(40),
  total_cents: z.number().int().min(0),
  subtotal_cents: z.number().int().min(0).catch(0),
  delivery_fee_cents: z.number().int().min(0).catch(0),
  estimated_ready_at: z.string().max(40).nullish().catch(null),
  idempotent_replay: z.boolean().catch(false),
});

const rejected = z.object({
  ok: z.literal(false),
  errors: z.array(z.unknown()).catch([]),
});

const errorItem = z.object({
  code: z.string().min(1).max(64),
  field: z.string().max(80).nullish().catch(null),
  item_index: z.number().int().min(0).nullish().catch(null),
});

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function parseErrors(list: unknown[]): OrderErrorItem[] {
  const out: OrderErrorItem[] = [];
  for (const entry of list.slice(0, 50)) {
    const p = errorItem.safeParse(entry);
    if (!p.success) continue;
    const code = CODE_PATTERN.test(p.data.code) ? p.data.code : "UNKNOWN";
    out.push({
      code,
      field: p.data.field ?? null,
      itemIndex: p.data.item_index ?? null,
      message: orderErrorMessage(code),
    });
  }
  return out;
}

function log(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[orders-server] ${scope}:`, detail);
}

/** O restaurante existe e está ativo? (RPC pública; em dúvida, assume que existe.) */
async function restaurantExists(slug: string): Promise<boolean> {
  try {
    const { data, error } = await createPublicClient().rpc("public_menu", { p_slug: slug });
    if (error) return !/not_found|restaurant_unavailable/i.test(error.message);
    const raw: unknown = Array.isArray(data) ? data[0] : data;
    return raw !== null && raw !== undefined && Object.keys(raw as object).length > 0;
  } catch {
    return true;
  }
}

/** Valida a entrada e chama `create_public_order`. Nunca lança. */
export async function submitPublicOrder(
  input: unknown,
  ctx: OrderContext,
): Promise<SubmitOrderResult> {
  const slug = normalizeSlug(ctx.slug);
  if (!slug) return { status: "not_found" };

  const parsed = orderSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join("."),
        message: i.message.slice(0, 200),
      })),
    };
  }
  const o: OrderSubmission = parsed.data;

  const captcha = await verifyCaptcha(o.captchaToken, ctx.ip);
  if (!captcha.ok) {
    return { status: "captcha", reason: captcha.reason, message: CAPTCHA_MESSAGES[captcha.reason] };
  }
  const email = o.customer.email?.trim();
  const delivery = o.fulfillmentType === "DELIVERY";

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("create_public_order", {
      p_slug: slug,
      p_fulfillment: o.fulfillmentType,
      p_items: o.items.map((item) => {
        const notes = item.notes?.trim();
        return {
          product_id: item.productId,
          ...(item.variantId ? { variant_id: item.variantId } : {}),
          quantity: item.quantity,
          modifier_ids: item.modifierIds,
          ...(notes ? { notes } : {}),
        };
      }),
      p_customer: {
        name: o.customer.name,
        phone: phoneDigits(o.customer.phone),
        ...(email ? { email } : {}),
      },
      p_address:
        delivery && o.address
          ? {
              street: o.address.street,
              number: o.address.number,
              neighborhood: o.address.neighborhood,
              city: o.address.city,
              ...(o.address.postalCode ? { postal_code: phoneDigits(o.address.postalCode) } : {}),
              ...(o.address.complement?.trim() ? { complement: o.address.complement.trim() } : {}),
              ...(o.address.instructions?.trim()
                ? { instructions: o.address.instructions.trim() }
                : {}),
            }
          : null,
      p_delivery_zone_id: delivery ? (o.deliveryZoneId ?? null) : null,
      p_notes: o.notes?.trim() || null,
      p_idempotency_key: o.idempotencyKey,
      p_payment: {
        method: o.payment.method,
        ...(o.payment.method === "CASH" && o.payment.changeForCents
          ? { change_for_cents: o.payment.changeForCents }
          : {}),
      },
    });

    if (error) {
      log(`create_public_order (${ctx.source})`, `${error.code ?? "?"} ${error.message}`);
      if (/idempotency/i.test(error.message) && /conflict/i.test(error.message)) {
        return { status: "conflict" };
      }
      if (/restaurant_not_found|restaurant_unavailable/i.test(error.message)) {
        return { status: "not_found" };
      }
      for (const code of ["SUBSCRIPTION_INACTIVE", "RATE_LIMITED"]) {
        if (error.message.includes(code)) {
          return { status: "rejected", errors: [{ code, field: null, itemIndex: null, message: orderErrorMessage(code) }] };
        }
      }
      return { status: "error" };
    }

    const raw: unknown = Array.isArray(data) ? data[0] : data;
    const ok = created.safeParse(raw);
    if (ok.success) {
      const d = ok.data;
      return {
        status: "created",
        order: {
          publicCode: d.public_code,
          orderNumber: d.order_number,
          status: d.status,
          totalCents: d.total_cents,
          subtotalCents: d.subtotal_cents,
          deliveryFeeCents: d.delivery_fee_cents,
          estimatedReadyAt: d.estimated_ready_at ?? null,
          idempotentReplay: d.idempotent_replay,
        },
      };
    }
    const no = rejected.safeParse(raw);
    if (no.success) {
      const errors = parseErrors(no.data.errors);
      if (errors.some((e) => e.code === "IDEMPOTENCY_CONFLICT")) return { status: "conflict" };
      // Slug inexistente/inativo e restaurante pausado dão o mesmo código: só o primeiro é 404.
      if (errors.length === 1 && errors[0].code === "RESTAURANT_UNAVAILABLE" && !(await restaurantExists(slug))) {
        return { status: "not_found" };
      }
      return {
        status: "rejected",
        errors:
          errors.length > 0
            ? errors
            : [{ code: "UNKNOWN", field: null, itemIndex: null, message: orderErrorMessage("UNKNOWN") }],
      };
    }
    log(`create_public_order (${ctx.source})`, "formato inesperado");
    return { status: "error" };
  } catch (error) {
    log(`create_public_order (${ctx.source})`, error);
    return { status: "error" };
  }
}

/** Acompanhamento por código público (RPC anon `track_order`). Nunca lança. */
export async function trackOrder(rawSlug: string, publicCode: string): Promise<TrackResult> {
  const slug = normalizeSlug(rawSlug);
  if (!slug || !isPublicCode(publicCode)) return { status: "not_found" };
  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase.rpc("track_order", {
      p_slug: slug,
      p_public_code: publicCode,
    });
    if (error) {
      log("track_order", `${error.code ?? "?"} ${error.message}`);
      return { status: "error" };
    }
    const raw: unknown = Array.isArray(data) ? data[0] : data;
    if (raw === null || raw === undefined) return { status: "not_found" };
    if (typeof raw === "object" && Object.keys(raw as object).length === 0) {
      return { status: "not_found" };
    }
    const order = parseTrackedOrder(raw);
    if (!order) {
      log("track_order", "formato inesperado");
      return { status: "error" };
    }
    return { status: "ok", order };
  } catch (error) {
    log("track_order", error);
    return { status: "error" };
  }
}
