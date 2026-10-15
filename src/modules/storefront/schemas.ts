import { z } from "zod";

/**
 * Validação (zod) das respostas das RPCs públicas `public_menu` e
 * `validate_cart`. Formato inesperado é descartado ou neutralizado, nunca
 * confiado: listas descartam apenas os itens inválidos; o objeto raiz inválido
 * vira erro (a página mostra o estado de erro, não dados quebrados).
 */

export const FULFILLMENTS = ["DELIVERY", "PICKUP", "DINE_IN"] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

export const FULFILLMENT_LABELS: Record<Fulfillment, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada",
  DINE_IN: "Consumo no local",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

const uuid = z.string().regex(UUID);
const cents = z.number().int().min(0).max(100_000_000);

// ---------------------------------------------------------------------------
// public_menu
// ---------------------------------------------------------------------------

const modifierSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(200),
  price_delta_cents: z.number().int().min(-100_000_000).max(100_000_000).catch(0),
  is_available: z.boolean().catch(true),
});

const modifierGroupSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(200),
  min_selections: z.number().int().min(0).catch(0),
  max_selections: z.number().int().min(0).nullable().catch(null),
  modifiers: z.array(z.unknown()).catch([]),
});

const variantSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(100),
  price_cents: cents,
  is_available: z.boolean().catch(true),
  is_default: z.boolean().catch(false),
});

const productSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(300),
  description: z.string().nullable().catch(null),
  price_cents: cents,
  image_path: z.string().nullable().catch(null),
  is_available: z.boolean().catch(true),
  // Contrato 2.5: ausentes em respostas antigas => listas vazias.
  badges: z.array(z.unknown()).optional().catch([]),
  variants: z.array(z.unknown()).optional().catch([]),
  modifier_groups: z.array(z.unknown()).catch([]),
});

/** Selos de produto aceitos (valores do CHECK `products_badges_valid`). */
export const MENU_BADGES = ["NEW", "POPULAR", "REGIONAL", "SWEET", "SPICY", "VEGETARIAN"] as const;
export type MenuBadge = (typeof MENU_BADGES)[number];

export const MENU_BADGE_LABELS: Record<MenuBadge, string> = {
  NEW: "Novo",
  POPULAR: "Popular",
  REGIONAL: "Regional",
  SWEET: "Doce",
  SPICY: "Picante",
  VEGETARIAN: "Vegetariano",
};

const categorySchema = z.object({
  // "uncategorized" é um id sintético (itens sem categoria), não um UUID.
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  products: z.array(z.unknown()).catch([]),
});

const zoneSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(200),
  fee_cents: cents.catch(0),
  min_order_cents: cents.catch(0),
  estimated_minutes: z.number().int().positive().nullable().catch(null),
});

const contactSchema = z
  .object({
    whatsapp: z.string().nullable().catch(null),
    phone: z.string().nullable().catch(null),
    address_text: z.string().nullable().catch(null),
  })
  .nullable()
  .catch(null);

const restaurantSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100),
  logo_path: z.string().nullable().catch(null),
  timezone: z.string().nullable().catch(null),
  contact: contactSchema.optional(),
  storefront_url: z.string().nullable().optional().catch(null),
});

const settingsSchema = z
  .object({
    accepts_orders: z.boolean().nullable().catch(null),
    prep_time_minutes: z.number().int().positive().nullable().catch(null),
    min_order_cents: cents.catch(0),
    enabled_fulfillment_types: z.array(z.unknown()).catch([]),
    pickup_instructions: z.string().nullable().catch(null),
    delivery_zones: z.array(z.unknown()).catch([]),
  })
  .partial()
  .catch({});

const menuRootSchema = z.object({
  restaurant: restaurantSchema,
  settings: settingsSchema,
  is_open_now: z.boolean().catch(false),
  categories: z.array(z.unknown()).catch([]),
});

export type MenuModifier = {
  id: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
};

export type MenuModifierGroup = {
  id: string;
  name: string;
  minSelections: number;
  /** null = sem limite. */
  maxSelections: number | null;
  modifiers: MenuModifier[];
};

export type MenuVariant = {
  id: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  isDefault: boolean;
};

export type MenuProduct = {
  id: string;
  name: string;
  description: string | null;
  /**
   * Preço de exibição. Com variantes é o MENOR preço entre as disponíveis
   * ("a partir de"); sem variantes é o preço do produto.
   */
  priceCents: number;
  imagePath: string | null;
  isAvailable: boolean;
  badges: MenuBadge[];
  variants: MenuVariant[];
  modifierGroups: MenuModifierGroup[];
};

/** Contato do restaurante, já saneado para uso em links (campos nulos = ocultos). */
export type RestaurantContact = {
  /** Somente dígitos (com DDI), pronto para `https://wa.me/<dígitos>`. */
  whatsappDigits: string | null;
  /** Texto para exibição. */
  phone: string | null;
  /** Valor para `tel:` (dígitos e `+`). */
  phoneHref: string | null;
  address: string | null;
};

export type MenuCategory = { id: string; name: string; products: MenuProduct[] };

export type DeliveryZone = {
  id: string;
  name: string;
  feeCents: number;
  minOrderCents: number;
  estimatedMinutes: number | null;
};

export type PublicMenu = {
  restaurant: {
    name: string;
    slug: string;
    logoPath: string | null;
    timezone: string | null;
    contact: RestaurantContact | null;
    /** URL https da vitrine personalizada, quando houver. */
    storefrontUrl: string | null;
  };
  settings: {
    acceptsOrders: boolean;
    prepTimeMinutes: number | null;
    minOrderCents: number;
    fulfillmentTypes: Fulfillment[];
    pickupInstructions: string | null;
    deliveryZones: DeliveryZone[];
  };
  isOpenNow: boolean;
  categories: MenuCategory[];
};

function parseList<T>(items: unknown[], parse: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    const value = parse(item);
    if (value) out.push(value);
  }
  return out;
}

function normalizeGroup(raw: unknown): MenuModifierGroup | null {
  const parsed = modifierGroupSchema.safeParse(raw);
  if (!parsed.success) return null;
  const g = parsed.data;
  const modifiers = parseList(g.modifiers, (m) => {
    const p = modifierSchema.safeParse(m);
    return p.success
      ? {
          id: p.data.id,
          name: p.data.name,
          priceDeltaCents: p.data.price_delta_cents,
          isAvailable: p.data.is_available,
        }
      : null;
  });
  const max = g.max_selections === null || g.max_selections === 0 ? null : g.max_selections;
  return {
    id: g.id,
    name: g.name,
    minSelections: g.min_selections,
    maxSelections: max,
    modifiers,
  };
}

function normalizeVariants(raw: unknown[] | undefined): MenuVariant[] {
  const list = parseList(raw ?? [], (v) => {
    const p = variantSchema.safeParse(v);
    return p.success
      ? {
          id: p.data.id,
          name: p.data.name,
          priceCents: p.data.price_cents,
          isAvailable: p.data.is_available,
          isDefault: p.data.is_default,
        }
      : null;
  });
  // No máximo uma variante padrão (a primeira disponível marcada como tal).
  let defaultSeen = false;
  return list.map((v) => {
    if (!v.isDefault) return v;
    if (defaultSeen || !v.isAvailable) return { ...v, isDefault: false };
    defaultSeen = true;
    return v;
  });
}

function normalizeBadges(raw: unknown[] | undefined): MenuBadge[] {
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    if (typeof value === "string") seen.add(value);
  }
  return MENU_BADGES.filter((b) => seen.has(b));
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Saneia o contato: nada de links inventados; nulos e vazios somem. */
function normalizeContact(
  raw: { whatsapp: string | null; phone: string | null; address_text: string | null } | null | undefined,
): RestaurantContact | null {
  if (!raw) return null;
  const wa = raw.whatsapp ? digitsOnly(raw.whatsapp) : "";
  const whatsappDigits = wa.length >= 10 && wa.length <= 15 ? wa : null;
  const phoneText = raw.phone?.trim().slice(0, 30) || null;
  const phoneDigits = phoneText ? digitsOnly(phoneText) : "";
  const phoneHref =
    phoneText && phoneDigits.length >= 4
      ? `${phoneText.startsWith("+") ? "+" : ""}${phoneDigits}`
      : null;
  const address = raw.address_text?.trim().slice(0, 200) || null;
  if (!whatsappDigits && !phoneHref && !address) return null;
  return { whatsappDigits, phone: phoneHref ? phoneText : null, phoneHref, address };
}

/** Só aceita URL https válida (descarta `javascript:`, `http:` e lixo). */
function normalizeStorefrontUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeProduct(raw: unknown): MenuProduct | null {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    id: p.id,
    name: p.name,
    description: p.description?.trim() || null,
    priceCents: p.price_cents,
    imagePath: p.image_path,
    isAvailable: p.is_available,
    badges: normalizeBadges(p.badges),
    variants: normalizeVariants(p.variants),
    modifierGroups: parseList(p.modifier_groups, normalizeGroup),
  };
}

/** Converte o JSON bruto de `public_menu` no modelo da UI, ou null se inválido. */
export function parsePublicMenu(raw: unknown): PublicMenu | null {
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
      logoPath: restaurant.logo_path,
      timezone: restaurant.timezone,
      contact: normalizeContact(restaurant.contact),
      storefrontUrl: normalizeStorefrontUrl(restaurant.storefront_url),
    },
    settings: {
      acceptsOrders: settings.accepts_orders ?? true,
      prepTimeMinutes: settings.prep_time_minutes ?? null,
      minOrderCents: settings.min_order_cents ?? 0,
      fulfillmentTypes,
      pickupInstructions: settings.pickup_instructions?.trim() || null,
      deliveryZones: parseList(settings.delivery_zones ?? [], (z) => {
        const p = zoneSchema.safeParse(z);
        return p.success
          ? {
              id: p.data.id,
              name: p.data.name,
              feeCents: p.data.fee_cents,
              minOrderCents: p.data.min_order_cents,
              estimatedMinutes: p.data.estimated_minutes,
            }
          : null;
      }),
    },
    isOpenNow: is_open_now,
    categories: parseList(categories, (c) => {
      const p = categorySchema.safeParse(c);
      if (!p.success) return null;
      return {
        id: p.data.id,
        name: p.data.name,
        products: parseList(p.data.products, normalizeProduct),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// validate_cart
// ---------------------------------------------------------------------------

const cartErrorSchema = z.object({
  code: z.string().min(1).max(64),
  item_index: z.number().int().min(0).nullable().optional().catch(null),
  message: z.string().max(500).optional().catch(undefined),
});

const cartItemSchema = z.object({
  product_id: uuid,
  name: z.string().max(300).catch(""),
  unit_price_cents: cents.catch(0),
  quantity: z.number().int().min(0).max(1000).catch(0),
  variant: z
    .object({ id: uuid, name: z.string().max(100).catch(""), price_cents: cents.catch(0) })
    .nullable()
    .optional()
    .catch(null),
  modifiers: z
    .array(
      z.object({
        id: uuid,
        name: z.string().max(300).catch(""),
        price_delta_cents: z.number().int().catch(0),
      }),
    )
    .catch([]),
  line_total_cents: cents.catch(0),
});

const validateCartRootSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.unknown()).catch([]),
  items: z.array(z.unknown()).catch([]),
  subtotal_cents: cents.catch(0),
  delivery_fee_cents: cents.catch(0),
  discount_cents: cents.catch(0),
  total_cents: cents.catch(0),
  minimum_order_cents: cents.catch(0),
});

export type CartValidationError = {
  code: string;
  itemIndex: number | null;
};

export type CartValidationItem = {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  variant: { id: string; name: string; priceCents: number } | null;
  modifiers: { id: string; name: string; priceDeltaCents: number }[];
  lineTotalCents: number;
};

export type CartValidation = {
  ok: boolean;
  errors: CartValidationError[];
  items: CartValidationItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  minimumOrderCents: number;
};

export function parseCartValidation(raw: unknown): CartValidation | null {
  const parsed = validateCartRootSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const errors = parseList(d.errors, (e) => {
    const p = cartErrorSchema.safeParse(e);
    // O texto `message` do servidor é descartado de propósito: a UI usa o
    // mapa de códigos em messages.ts (nunca exibe texto cru do banco).
    return p.success ? { code: p.data.code, itemIndex: p.data.item_index ?? null } : null;
  });
  return {
    // Só aceita `ok` se não houver nenhum erro listado.
    ok: d.ok && errors.length === 0,
    errors,
    items: parseList(d.items, (i) => {
      const p = cartItemSchema.safeParse(i);
      return p.success
        ? {
            productId: p.data.product_id,
            name: p.data.name,
            unitPriceCents: p.data.unit_price_cents,
            quantity: p.data.quantity,
            variant: p.data.variant
              ? {
                  id: p.data.variant.id,
                  name: p.data.variant.name,
                  priceCents: p.data.variant.price_cents,
                }
              : null,
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
