import { z } from "zod";
import { hasControlChars } from "@/lib/validation/text";
import { CART_ERROR_MESSAGES, GENERIC_CART_ERROR } from "@/modules/storefront/messages";
import { FULFILLMENTS, isUuid, type Fulfillment } from "@/modules/storefront/schemas";
import type {
  ApiBusinessHour,
  ApiBusinessHourException,
  ApiContact,
  ApiMenu,
  ApiModifierGroup,
  ApiProduct,
  ApiQuote,
  ApiVariant,
} from "./types";

/**
 * Parse (zod) das saídas das RPCs `public_menu` / `validate_cart` e conversão
 * para o modelo camelCase da API v1. Mesma filosofia do módulo storefront:
 * listas descartam só os itens inválidos; a raiz inválida vira `null` (a rota
 * responde 500 genérico, nunca dados quebrados).
 *
 * Campos que a migração DB-4 acrescenta (variants, badges, contact,
 * storefront_url, variant) são OPCIONAIS aqui: ausentes viram [] / null.
 */

const uuid = z.string().refine(isUuid, "uuid inválido");
const cents = z.number().int().min(0).max(100_000_000);
const text = (max: number) => z.string().max(max);
const nullableText = z.string().nullable().catch(null);

function parseList<T>(items: unknown[], parse: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    const value = parse(item);
    if (value) out.push(value);
  }
  return out;
}

const trimmedOrNull = (value: string | null | undefined): string | null => {
  const t = value?.trim();
  return t ? t : null;
};

// ---------------------------------------------------------------------------
// public_menu
// ---------------------------------------------------------------------------

const modifierSchema = z.object({
  id: uuid,
  name: text(200).min(1),
  price_delta_cents: z.number().int().min(-100_000_000).max(100_000_000).catch(0),
  is_available: z.boolean().catch(true),
});

const modifierGroupSchema = z.object({
  id: uuid,
  name: text(200).min(1),
  min_selections: z.number().int().min(0).catch(0),
  max_selections: z.number().int().min(0).nullable().catch(null),
  modifiers: z.array(z.unknown()).catch([]),
});

const variantSchema = z.object({
  id: uuid,
  name: text(200).min(1),
  price_cents: cents,
  is_available: z.boolean().catch(true),
  is_default: z.boolean().catch(false),
});

const productSchema = z.object({
  id: uuid,
  name: text(300).min(1),
  description: nullableText,
  price_cents: cents,
  image_path: nullableText,
  is_available: z.boolean().catch(true),
  badges: z.array(z.unknown()).catch([]),
  variants: z.array(z.unknown()).catch([]),
  modifier_groups: z.array(z.unknown()).catch([]),
});

const categorySchema = z.object({
  // "uncategorized" é um id sintético (itens sem categoria), não um UUID.
  id: z.string().min(1).max(64),
  name: text(200).min(1),
  description: nullableText,
  products: z.array(z.unknown()).catch([]),
});

const zoneSchema = z.object({
  id: uuid,
  name: text(200).min(1),
  fee_cents: cents.catch(0),
  min_order_cents: cents.catch(0),
  estimated_minutes: z.number().int().positive().nullable().catch(null),
  neighborhoods: z.array(z.unknown()).catch([]),
});

const hourSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  opens_at: z.string().regex(/^\d{2}:\d{2}$/),
  closes_at: z.string().regex(/^\d{2}:\d{2}$/),
});

const exceptionSchema = z.object({
  on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  is_closed: z.boolean().catch(false),
  opens_at: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
  closes_at: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
  description: nullableText,
});

const contactSchema = z.object({
  whatsapp: nullableText,
  phone: nullableText,
  address_text: nullableText,
});

const restaurantSchema = z.object({
  name: text(200).min(1),
  slug: text(100).min(1),
  logo_path: nullableText,
  timezone: nullableText,
  contact: z.unknown().catch(null),
  storefront_url: nullableText,
});

const settingsSchema = z
  .object({
    accepts_orders: z.boolean().nullable().catch(null),
    prep_time_minutes: z.number().int().positive().nullable().catch(null),
    min_order_cents: cents.catch(0),
    enabled_fulfillment_types: z.array(z.unknown()).catch([]),
    pickup_instructions: nullableText,
    delivery_zones: z.array(z.unknown()).catch([]),
    business_hours: z.array(z.unknown()).catch([]),
    business_hour_exceptions: z.array(z.unknown()).catch([]),
  })
  .partial()
  .catch({});

const menuRootSchema = z.object({
  restaurant: restaurantSchema,
  settings: settingsSchema,
  is_open_now: z.boolean().catch(false),
  categories: z.array(z.unknown()).catch([]),
});

export type NormalizeMenuOptions = {
  /** Converte `image_path` em URL pública absoluta (injetável para testes). */
  imageUrl: (path: string | null | undefined) => string | null;
};

const BADGE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

function normalizeContact(raw: unknown): ApiContact | null {
  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c: ApiContact = {
    whatsapp: trimmedOrNull(parsed.data.whatsapp),
    phone: trimmedOrNull(parsed.data.phone),
    addressText: trimmedOrNull(parsed.data.address_text),
  };
  return c.whatsapp || c.phone || c.addressText ? c : null;
}

function normalizeStorefrontUrl(raw: string | null): string | null {
  const value = trimmedOrNull(raw);
  if (!value || value.length > 300) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeGroup(raw: unknown): ApiModifierGroup | null {
  const parsed = modifierGroupSchema.safeParse(raw);
  if (!parsed.success) return null;
  const g = parsed.data;
  return {
    id: g.id,
    name: g.name,
    minSelections: g.min_selections,
    maxSelections: g.max_selections === null || g.max_selections === 0 ? null : g.max_selections,
    modifiers: parseList(g.modifiers, (m) => {
      const p = modifierSchema.safeParse(m);
      return p.success
        ? {
            id: p.data.id,
            name: p.data.name,
            priceDeltaCents: p.data.price_delta_cents,
            isAvailable: p.data.is_available,
          }
        : null;
    }),
  };
}

function normalizeVariant(raw: unknown): ApiVariant | null {
  const p = variantSchema.safeParse(raw);
  return p.success
    ? {
        id: p.data.id,
        name: p.data.name,
        priceCents: p.data.price_cents,
        isAvailable: p.data.is_available,
        isDefault: p.data.is_default,
      }
    : null;
}

function normalizeProduct(raw: unknown, opts: NormalizeMenuOptions): ApiProduct | null {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const badges = Array.from(
    new Set(
      p.badges.filter((b): b is string => typeof b === "string" && BADGE_PATTERN.test(b)),
    ),
  );
  return {
    id: p.id,
    name: p.name,
    description: trimmedOrNull(p.description),
    priceCents: p.price_cents,
    imageUrl: opts.imageUrl(p.image_path),
    isAvailable: p.is_available,
    badges,
    variants: parseList(p.variants, normalizeVariant),
    modifierGroups: parseList(p.modifier_groups, normalizeGroup),
  };
}

/** Converte o JSON bruto de `public_menu` no modelo da API, ou null se inválido. */
export function normalizeMenu(raw: unknown, opts: NormalizeMenuOptions): ApiMenu | null {
  const parsed = menuRootSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { restaurant, settings, is_open_now, categories } = parsed.data;

  const fulfillmentTypes = Array.from(
    new Set(
      (settings.enabled_fulfillment_types ?? []).filter(
        (value): value is Fulfillment =>
          typeof value === "string" && (FULFILLMENTS as readonly string[]).includes(value),
      ),
    ),
  );

  return {
    restaurant: {
      name: restaurant.name,
      slug: restaurant.slug,
      logoUrl: opts.imageUrl(restaurant.logo_path),
      timezone: restaurant.timezone,
      contact: normalizeContact(restaurant.contact),
      storefrontUrl: normalizeStorefrontUrl(restaurant.storefront_url),
    },
    settings: {
      acceptsOrders: settings.accepts_orders ?? true,
      prepTimeMinutes: settings.prep_time_minutes ?? null,
      minOrderCents: settings.min_order_cents ?? 0,
      fulfillmentTypes,
      pickupInstructions: trimmedOrNull(settings.pickup_instructions),
      deliveryZones: parseList(settings.delivery_zones ?? [], (z) => {
        const p = zoneSchema.safeParse(z);
        return p.success
          ? {
              id: p.data.id,
              name: p.data.name,
              feeCents: p.data.fee_cents,
              minOrderCents: p.data.min_order_cents,
              estimatedMinutes: p.data.estimated_minutes,
              neighborhoods: p.data.neighborhoods.filter(
                (n): n is string => typeof n === "string" && n.length > 0 && n.length <= 200,
              ),
            }
          : null;
      }),
      businessHours: parseList(settings.business_hours ?? [], (h): ApiBusinessHour | null => {
        const p = hourSchema.safeParse(h);
        return p.success
          ? { weekday: p.data.weekday, opensAt: p.data.opens_at, closesAt: p.data.closes_at }
          : null;
      }),
      businessHourExceptions: parseList(
        settings.business_hour_exceptions ?? [],
        (e): ApiBusinessHourException | null => {
          const p = exceptionSchema.safeParse(e);
          return p.success
            ? {
                date: p.data.on_date,
                isClosed: p.data.is_closed,
                opensAt: p.data.opens_at,
                closesAt: p.data.closes_at,
                description: trimmedOrNull(p.data.description),
              }
            : null;
        },
      ),
    },
    isOpenNow: is_open_now,
    categories: parseList(categories, (c) => {
      const p = categorySchema.safeParse(c);
      if (!p.success) return null;
      return {
        id: p.data.id,
        name: p.data.name,
        description: trimmedOrNull(p.data.description),
        products: parseList(p.data.products, (item) => normalizeProduct(item, opts)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// validate_cart
// ---------------------------------------------------------------------------

/** Mensagens PT-BR por código (storefront + códigos acrescentados pela DB-4). */
export const QUOTE_ERROR_MESSAGES: Record<string, string> = {
  ...CART_ERROR_MESSAGES,
  VARIANT_REQUIRED: "Escolha o tamanho/variação deste item.",
  VARIANT_UNAVAILABLE: "A variação escolhida não está mais disponível. Escolha outra.",
  VARIANT_NOT_ALLOWED: "A variação escolhida não pertence a este item. Remova o item e adicione de novo.",
  TOO_MANY_ITEMS: "O pedido tem itens demais.",
  NOTES_TOO_LONG: "A observação deste item é longa demais.",
};

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const quoteErrorSchema = z.object({
  code: z.string().min(1).max(64),
  item_index: z.number().int().min(0).nullable().optional().catch(null),
});

const quoteItemSchema = z.object({
  product_id: uuid,
  name: text(300).catch(""),
  variant: z
    .object({ id: uuid, name: text(200).catch(""), price_cents: cents.catch(0) })
    .nullable()
    .catch(null),
  unit_price_cents: cents.catch(0),
  quantity: z.number().int().min(0).max(1000).catch(0),
  modifiers: z
    .array(
      z.object({
        id: uuid,
        name: text(300).catch(""),
        price_delta_cents: z.number().int().catch(0),
      }),
    )
    .catch([]),
  line_total_cents: cents.catch(0),
});

const quoteRootSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.unknown()).catch([]),
  items: z.array(z.unknown()).catch([]),
  subtotal_cents: cents.catch(0),
  delivery_fee_cents: cents.catch(0),
  discount_cents: cents.catch(0),
  total_cents: cents.catch(0),
  minimum_order_cents: cents.catch(0),
});

/**
 * Converte o JSON de `validate_cart`. O texto `message` do banco é descartado
 * de propósito; a mensagem vem do mapa de códigos (nunca texto cru do servidor).
 */
export function normalizeQuote(raw: unknown): ApiQuote | null {
  const parsed = quoteRootSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const errors = parseList(d.errors, (e) => {
    const p = quoteErrorSchema.safeParse(e);
    if (!p.success) return null;
    const code = ERROR_CODE_PATTERN.test(p.data.code) ? p.data.code : "UNKNOWN";
    return {
      code,
      itemIndex: p.data.item_index ?? null,
      message: QUOTE_ERROR_MESSAGES[code] ?? GENERIC_CART_ERROR,
    };
  });
  return {
    ok: d.ok && errors.length === 0,
    errors,
    items: parseList(d.items, (i) => {
      const p = quoteItemSchema.safeParse(i);
      return p.success
        ? {
            productId: p.data.product_id,
            name: p.data.name,
            variant: p.data.variant
              ? {
                  id: p.data.variant.id,
                  name: p.data.variant.name,
                  priceCents: p.data.variant.price_cents,
                }
              : null,
            unitPriceCents: p.data.unit_price_cents,
            quantity: p.data.quantity,
            modifiers: p.data.modifiers.map((m) => ({
              id: m.id,
              name: m.name,
              priceDeltaCents: m.price_delta_cents,
            })),
            lineTotalCents: p.data.line_total_cents,
          }
        : null;
    }),
    subtotalCents: d.subtotal_cents,
    deliveryFeeCents: d.delivery_fee_cents,
    discountCents: d.discount_cents,
    totalCents: d.total_cents,
    minimumOrderCents: d.minimum_order_cents,
  };
}

// ---------------------------------------------------------------------------
// Corpo de POST .../cart/quote
// ---------------------------------------------------------------------------

export const MAX_QUOTE_ITEMS = 50;
export const MAX_MODIFIERS_PER_ITEM = 50;
export const MAX_NOTES_LENGTH = 500;

const quoteRequestItemSchema = z.object({
  productId: uuid,
  variantId: uuid.nullish(),
  quantity: z.number().int().min(1).max(99),
  modifierIds: z.array(uuid).max(MAX_MODIFIERS_PER_ITEM).default([]),
  notes: z
    .string()
    .max(MAX_NOTES_LENGTH)
    .refine((v) => !hasControlChars(v), "Texto com caracteres inválidos.")
    .nullish(),
});

export const quoteRequestSchema = z.object({
  fulfillmentType: z.enum(FULFILLMENTS),
  items: z.array(quoteRequestItemSchema).max(MAX_QUOTE_ITEMS),
  deliveryZoneId: uuid.nullish(),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

/** Itens no formato esperado por `validate_cart` (snake_case). */
export function toRpcItems(items: QuoteRequest["items"]) {
  return items.map((item) => {
    const notes = item.notes?.trim();
    return {
      product_id: item.productId,
      ...(item.variantId ? { variant_id: item.variantId } : {}),
      quantity: item.quantity,
      modifier_ids: item.modifierIds,
      ...(notes ? { notes } : {}),
    };
  });
}
