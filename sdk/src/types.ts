/**
 * Tipos da API pública v1 do MesaFácil (JSON camelCase). Espelham o contrato do
 * servidor: campos novos só são ACRESCENTADOS dentro de /v1.
 */

export type FulfillmentType = "DELIVERY" | "PICKUP" | "DINE_IN";

export type Badge = "NEW" | "POPULAR" | "REGIONAL" | "SWEET" | "SPICY" | "VEGETARIAN" | (string & {});

export type Modifier = {
  id: string;
  name: string;
  /** Pode ser negativo (desconto). */
  priceDeltaCents: number;
  isAvailable: boolean;
};

export type ModifierGroup = {
  id: string;
  name: string;
  minSelections: number;
  /** `null` = sem limite. */
  maxSelections: number | null;
  modifiers: Modifier[];
};

export type Variant = {
  id: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  isDefault: boolean;
};

export type Product = {
  id: string;
  name: string;
  description: string | null;
  /** Com variantes: menor preço entre as variantes disponíveis. */
  priceCents: number;
  /** URL pública absoluta da imagem (ou `null`). */
  imageUrl: string | null;
  isAvailable: boolean;
  badges: Badge[];
  /** Vazio quando o produto não tem variações (use `priceCents`). */
  variants: Variant[];
  modifierGroups: ModifierGroup[];
};

export type Category = {
  id: string;
  name: string;
  description: string | null;
  products: Product[];
};

export type DeliveryZone = {
  id: string;
  name: string;
  feeCents: number;
  minOrderCents: number;
  estimatedMinutes: number | null;
  neighborhoods: string[];
};

export type BusinessHour = {
  /** 0 = domingo ... 6 = sábado. */
  weekday: number;
  /** "HH:MM" no fuso do restaurante. */
  opensAt: string;
  closesAt: string;
};

export type BusinessHourException = {
  /** "AAAA-MM-DD". */
  date: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  description: string | null;
};

export type Contact = {
  whatsapp: string | null;
  phone: string | null;
  addressText: string | null;
};

export type Menu = {
  restaurant: {
    name: string;
    slug: string;
    logoUrl: string | null;
    timezone: string | null;
    contact: Contact | null;
    storefrontUrl: string | null;
  };
  settings: {
    acceptsOrders: boolean;
    prepTimeMinutes: number | null;
    minOrderCents: number;
    fulfillmentTypes: FulfillmentType[];
    pickupInstructions: string | null;
    deliveryZones: DeliveryZone[];
    businessHours: BusinessHour[];
    businessHourExceptions: BusinessHourException[];
  };
  /** Calculado pelo servidor (horários + exceções + fuso do restaurante). */
  isOpenNow: boolean;
  categories: Category[];
};

export type QuoteItemInput = {
  productId: string;
  /** Obrigatório quando o produto tem variantes. */
  variantId?: string | null;
  /** 1 a 99. */
  quantity: number;
  modifierIds?: string[];
  /** Até 500 caracteres. */
  notes?: string | null;
};

export type QuoteInput = {
  fulfillmentType: FulfillmentType;
  /** Até 50 itens. */
  items: QuoteItemInput[];
  /** Exigido quando `fulfillmentType` é DELIVERY. */
  deliveryZoneId?: string | null;
};

export type QuoteError = {
  /** Ex.: RESTAURANT_CLOSED, BELOW_MINIMUM, VARIANT_REQUIRED, ZONE_REQUIRED. */
  code: string;
  /** Índice (base 0) do item em `items`, quando o erro é de um item. */
  itemIndex: number | null;
  /** Mensagem em PT-BR segura para exibir ao cliente. */
  message: string;
};

export type QuoteItem = {
  productId: string;
  name: string;
  variant: { id: string; name: string; priceCents: number } | null;
  unitPriceCents: number;
  quantity: number;
  modifiers: { id: string; name: string; priceDeltaCents: number }[];
  lineTotalCents: number;
};

export type Quote = {
  /** `false` quando há erros; o carrinho NÃO é um pedido e nada é gravado. */
  ok: boolean;
  errors: QuoteError[];
  items: QuoteItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  minimumOrderCents: number;
};

/** Códigos de erro HTTP da API + códigos locais do SDK (status 0). */
export type StorefrontErrorCode =
  | "invalid_request"
  | "restaurant_not_found"
  | "origin_not_allowed"
  | "payload_too_large"
  | "rate_limited"
  | "internal_error"
  | "network_error"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | (string & {});
