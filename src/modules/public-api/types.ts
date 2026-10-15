import type { Fulfillment } from "@/modules/storefront/schemas";

/**
 * Modelo estável (camelCase) da API pública v1. É o contrato com as vitrines
 * externas: só ACRESCENTE campos; nunca renomeie nem remova sem nova versão
 * (/v2). O SDK (`sdk/src/types.ts`) espelha estes tipos.
 */

export type { Fulfillment };

export type ApiModifier = {
  id: string;
  name: string;
  priceDeltaCents: number;
  isAvailable: boolean;
};

export type ApiModifierGroup = {
  id: string;
  name: string;
  minSelections: number;
  /** null = sem limite. */
  maxSelections: number | null;
  modifiers: ApiModifier[];
};

export type ApiVariant = {
  id: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  isDefault: boolean;
};

export type ApiProduct = {
  id: string;
  name: string;
  description: string | null;
  /** Com variantes: menor preço entre as variantes disponíveis ("a partir de"). */
  priceCents: number;
  imageUrl: string | null;
  isAvailable: boolean;
  badges: string[];
  variants: ApiVariant[];
  modifierGroups: ApiModifierGroup[];
};

export type ApiCategory = {
  id: string;
  name: string;
  description: string | null;
  products: ApiProduct[];
};

export type ApiDeliveryZone = {
  id: string;
  name: string;
  feeCents: number;
  minOrderCents: number;
  estimatedMinutes: number | null;
  neighborhoods: string[];
};

export type ApiBusinessHour = {
  /** 0 = domingo ... 6 = sábado. */
  weekday: number;
  /** "HH:MM" no fuso do restaurante. */
  opensAt: string;
  closesAt: string;
};

export type ApiBusinessHourException = {
  /** "AAAA-MM-DD" no fuso do restaurante. */
  date: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  description: string | null;
};

export type ApiContact = {
  whatsapp: string | null;
  phone: string | null;
  addressText: string | null;
};

export type ApiMenu = {
  restaurant: {
    name: string;
    slug: string;
    logoUrl: string | null;
    timezone: string | null;
    contact: ApiContact | null;
    storefrontUrl: string | null;
  };
  settings: {
    acceptsOrders: boolean;
    prepTimeMinutes: number | null;
    minOrderCents: number;
    fulfillmentTypes: Fulfillment[];
    pickupInstructions: string | null;
    deliveryZones: ApiDeliveryZone[];
    businessHours: ApiBusinessHour[];
    businessHourExceptions: ApiBusinessHourException[];
  };
  isOpenNow: boolean;
  categories: ApiCategory[];
};

export type ApiQuoteError = {
  /** Código estável (ex.: RESTAURANT_CLOSED, VARIANT_REQUIRED). */
  code: string;
  /** Índice (base 0) do item em `items` da requisição, quando aplicável. */
  itemIndex: number | null;
  /** Mensagem em PT-BR segura para exibir ao cliente final. */
  message: string;
};

export type ApiQuoteItem = {
  productId: string;
  name: string;
  variant: { id: string; name: string; priceCents: number } | null;
  unitPriceCents: number;
  quantity: number;
  modifiers: { id: string; name: string; priceDeltaCents: number }[];
  lineTotalCents: number;
};

export type ApiQuote = {
  ok: boolean;
  errors: ApiQuoteError[];
  items: ApiQuoteItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  minimumOrderCents: number;
};

export type ApiErrorCode =
  | "invalid_request"
  | "restaurant_not_found"
  | "origin_not_allowed"
  | "payload_too_large"
  | "rate_limited"
  | "internal_error";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: { path: string; message: string }[];
  };
};
