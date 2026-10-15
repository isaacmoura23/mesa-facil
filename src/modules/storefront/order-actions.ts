"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { getPublicEnvStatus } from "@/lib/env";
import { beginOrderAttempt, checkTrackRateLimit } from "@/modules/orders-server/limits";
import { GENERIC_ORDER_ERROR, orderErrorMessage } from "@/modules/orders-server/messages";
import {
  idempotencyKeySchema,
  isPublicCode,
  type OrderErrorItem,
  type PaymentMethod,
} from "@/modules/orders-server/schemas";
import { submitPublicOrder, trackOrder } from "@/modules/orders-server/service";
import type { TrackResult } from "@/modules/orders-server/tracking";
import { clientIp } from "@/modules/public-api/rate-limit";
import {
  cartQuoteInputSchema,
  checkoutFormSchema,
  fieldErrorsFrom,
  type CheckoutFieldErrors,
} from "./checkout-schema";
import { normalizeSlug } from "./data";
import { changeForCents, paymentFormSchema, type PaymentFieldErrors } from "./order-checkout";

/**
 * Server Actions de pedido da vitrine padrão. Mesma lógica da API pública
 * (`src/modules/orders-server`); a validação do cliente é só conveniência.
 */

export type CreateOrderResult =
  | { status: "created"; publicCode: string; orderNumber: number }
  | { status: "invalid"; fieldErrors: CheckoutFieldErrors; paymentErrors: PaymentFieldErrors }
  | { status: "rejected"; errors: OrderErrorItem[] }
  | { status: "rate_limited"; message: string; retryAfterSeconds: number }
  | { status: "conflict" | "not_found" | "error"; message: string };

const actionInputSchema = z.object({
  slug: z.string().min(1).max(63),
  form: z.unknown(),
  payment: z.unknown(),
  items: cartQuoteInputSchema.shape.items,
  idempotencyKey: idempotencyKeySchema,
});

const GENERIC: CreateOrderResult = { status: "error", message: GENERIC_ORDER_ERROR };

/** Cria o pedido. Nunca devolve ids internos; erros de regra vêm por código. */
export async function createOrderAction(input: unknown): Promise<CreateOrderResult> {
  const base = actionInputSchema.safeParse(input);
  if (!base.success) return GENERIC;
  const slug = normalizeSlug(base.data.slug);
  if (!slug || !getPublicEnvStatus().ok) return GENERIC;

  const form = checkoutFormSchema.safeParse(base.data.form);
  const payment = paymentFormSchema.safeParse(base.data.payment);
  if (!form.success || !payment.success) {
    return {
      status: "invalid",
      fieldErrors: form.success ? {} : fieldErrorsFrom(form.error),
      paymentErrors: payment.success ? {} : paymentErrorsFrom(payment.error),
    };
  }

  const attempt = beginOrderAttempt(clientIp(await headers()), slug);
  if (!attempt.allowed) {
    return {
      status: "rate_limited",
      message: "Muitos pedidos enviados em pouco tempo. Aguarde alguns minutos e tente novamente.",
      retryAfterSeconds: attempt.retryAfterSeconds,
    };
  }

  const f = form.data;
  const delivery = f.fulfillment === "DELIVERY";
  const result = await submitPublicOrder(
    {
      fulfillmentType: f.fulfillment,
      items: base.data.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        modifierIds: item.modifierIds,
        notes: item.notes || null,
      })),
      customer: { name: f.name, phone: f.phone, email: f.email || null },
      address: delivery
        ? {
            street: f.street,
            number: f.number,
            neighborhood: f.neighborhood,
            city: f.city,
            postalCode: f.postalCode || null,
            complement: f.complement || null,
            instructions: f.instructions || null,
          }
        : null,
      deliveryZoneId: delivery ? f.zoneId : null,
      notes: f.notes || null,
      payment: {
        method: payment.data.method as PaymentMethod,
        changeForCents: changeForCents(payment.data),
      },
      idempotencyKey: base.data.idempotencyKey,
    },
    { slug, source: "storefront" },
  );
  attempt.finish(result.status === "created" && !result.order.idempotentReplay);

  switch (result.status) {
    case "created":
      return {
        status: "created",
        publicCode: result.order.publicCode,
        orderNumber: result.order.orderNumber,
      };
    case "rejected":
      return { status: "rejected", errors: result.errors };
    case "conflict":
      return { status: "conflict", message: orderErrorMessage("IDEMPOTENCY_CONFLICT") };
    case "not_found":
      return { status: "not_found", message: "Restaurante não encontrado." };
    case "invalid":
      return {
        status: "invalid",
        fieldErrors: {},
        paymentErrors: {},
      };
    default:
      return GENERIC;
  }
}

function paymentErrorsFrom(error: z.ZodError): PaymentFieldErrors {
  const out: PaymentFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if ((key === "method" || key === "changeFor") && !(key in out)) out[key] = issue.message;
  }
  return out;
}

export type TrackActionResult = TrackResult | { status: "rate_limited"; retryAfterSeconds: number };

/** Acompanhamento para o polling da página do pedido. */
export async function trackOrderAction(slug: string, publicCode: string): Promise<TrackActionResult> {
  const normalized = typeof slug === "string" ? normalizeSlug(slug) : null;
  if (!normalized || !isPublicCode(publicCode) || !getPublicEnvStatus().ok) {
    return { status: "not_found" };
  }
  const limit = checkTrackRateLimit(clientIp(await headers()), normalized);
  if (!limit.allowed) return { status: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
  return trackOrder(normalized, publicCode);
}
