import { describe, expect, it } from "vitest";
import {
  normalizeMenu,
  normalizeQuote,
  quoteRequestSchema,
  toRpcItems,
} from "../../src/modules/public-api/schemas";
import type { ApiMenu, ApiQuote } from "../../src/modules/public-api/types";
import type { Menu as SdkMenu, Quote as SdkQuote } from "../../sdk/src/types";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const imageUrl = (p: string | null | undefined) => (p ? `https://cdn.test/${p}` : null);

/** Saída da `public_menu` atual (migração 112): sem variants/badges/contact/storefront_url. */
function legacyMenu() {
  return {
    restaurant: { id: U(1), name: "DEMO A", slug: "demo-a", logo_path: "restaurants/x/logo/l.png", timezone: "America/Sao_Paulo" },
    settings: {
      accepts_orders: true,
      prep_time_minutes: 30,
      min_order_cents: 1000,
      enabled_fulfillment_types: ["DELIVERY", "PICKUP", "NOPE", "PICKUP"],
      pickup_instructions: "  Balcão  ",
      business_hours: [{ weekday: 1, opens_at: "11:00", closes_at: "23:00" }, { weekday: 9, opens_at: "x", closes_at: "y" }],
      business_hour_exceptions: [{ on_date: "2026-12-25", is_closed: true, opens_at: null, closes_at: null, description: "Natal" }],
      delivery_zones: [{ id: U(2), name: "Centro", fee_cents: 500, min_order_cents: 1500, estimated_minutes: 40, neighborhoods: ["Centro", 7] }],
    },
    is_open_now: true,
    categories: [
      {
        id: U(3), name: "Lanches", description: null, sort_order: 0,
        products: [
          {
            id: U(4), name: "X-Burger", description: " bom ", price_cents: 2500, image_path: "restaurants/x/products/a.png", is_available: true,
            modifier_groups: [
              { id: U(5), name: "Adicionais", min_selections: 0, max_selections: 0, modifiers: [
                { id: U(6), name: "Bacon", price_delta_cents: 500, is_available: true },
                { id: "invalido", name: "Quebrado", price_delta_cents: 1, is_available: true },
              ] },
            ],
          },
          { id: "quebrado", name: "Produto ruim", price_cents: 1 },
        ],
      },
      { id: "uncategorized", name: "Outros", description: null, products: [] },
    ],
  };
}

describe("normalizeMenu", () => {
  it("converte para camelCase e usa defaults quando faltam os campos da DB-4", () => {
    const menu = normalizeMenu(legacyMenu(), { imageUrl })!;
    expect(menu).not.toBeNull();
    expect(menu.restaurant).toEqual({
      name: "DEMO A",
      slug: "demo-a",
      logoUrl: "https://cdn.test/restaurants/x/logo/l.png",
      timezone: "America/Sao_Paulo",
      contact: null,
      storefrontUrl: null,
    });
    expect(menu.settings.fulfillmentTypes).toEqual(["DELIVERY", "PICKUP"]);
    expect(menu.settings.pickupInstructions).toBe("Balcão");
    expect(menu.settings.deliveryZones).toEqual([
      { id: U(2), name: "Centro", feeCents: 500, minOrderCents: 1500, estimatedMinutes: 40, neighborhoods: ["Centro"] },
    ]);
    expect(menu.settings.businessHours).toEqual([{ weekday: 1, opensAt: "11:00", closesAt: "23:00" }]);
    expect(menu.settings.businessHourExceptions).toEqual([
      { date: "2026-12-25", isClosed: true, opensAt: null, closesAt: null, description: "Natal" },
    ]);
    expect(menu.isOpenNow).toBe(true);

    const [lanches, outros] = menu.categories;
    expect(outros.id).toBe("uncategorized");
    // produto inválido descartado, os demais preservados
    expect(lanches.products).toHaveLength(1);
    const p = lanches.products[0];
    expect(p).toMatchObject({
      id: U(4),
      name: "X-Burger",
      description: "bom",
      priceCents: 2500,
      imageUrl: "https://cdn.test/restaurants/x/products/a.png",
      badges: [],
      variants: [],
    });
    // max_selections 0 = sem limite -> null; modificador inválido descartado
    expect(p.modifierGroups).toEqual([
      {
        id: U(5), name: "Adicionais", minSelections: 0, maxSelections: null,
        modifiers: [{ id: U(6), name: "Bacon", priceDeltaCents: 500, isAvailable: true }],
      },
    ]);
  });

  it("lê variants, badges, contact e storefront_url quando a DB-4 existir", () => {
    const raw = legacyMenu();
    Object.assign(raw.restaurant, {
      contact: { whatsapp: "+5511999999999", phone: null, address_text: " Rua A, 1 " },
      storefront_url: "https://la-pastelaria.vercel.app",
    });
    Object.assign(raw.categories[0].products[0], {
      price_cents: 1800,
      badges: ["POPULAR", "NEW", "POPULAR", "minusculo", 3],
      variants: [
        { id: U(7), name: "P", price_cents: 1800, is_available: true, is_default: true },
        { id: U(8), name: "G", price_cents: 2800, is_available: false, is_default: false },
        { id: "x", name: "ruim", price_cents: 1, is_available: true, is_default: false },
      ],
    });
    const menu = normalizeMenu(raw, { imageUrl })!;
    expect(menu.restaurant.contact).toEqual({ whatsapp: "+5511999999999", phone: null, addressText: "Rua A, 1" });
    expect(menu.restaurant.storefrontUrl).toBe("https://la-pastelaria.vercel.app/");
    const p = menu.categories[0].products[0];
    expect(p.badges).toEqual(["POPULAR", "NEW"]);
    expect(p.variants).toEqual([
      { id: U(7), name: "P", priceCents: 1800, isAvailable: true, isDefault: true },
      { id: U(8), name: "G", priceCents: 2800, isAvailable: false, isDefault: false },
    ]);
  });

  it("contact com tudo nulo vira null e storefront_url não-http é descartada", () => {
    const raw = legacyMenu();
    Object.assign(raw.restaurant, {
      contact: { whatsapp: null, phone: " ", address_text: null },
      storefront_url: "javascript:alert(1)",
    });
    const menu = normalizeMenu(raw, { imageUrl })!;
    expect(menu.restaurant.contact).toBeNull();
    expect(menu.restaurant.storefrontUrl).toBeNull();
  });

  it("raiz inválida => null", () => {
    expect(normalizeMenu(null, { imageUrl })).toBeNull();
    expect(normalizeMenu({ foo: 1 }, { imageUrl })).toBeNull();
    expect(normalizeMenu("x", { imageUrl })).toBeNull();
  });

  it("o resultado é atribuível aos tipos do SDK (contrato em sincronia)", () => {
    const menu: ApiMenu = normalizeMenu(legacyMenu(), { imageUrl })!;
    const sdk: SdkMenu = menu;
    expect(sdk.restaurant.slug).toBe("demo-a");
  });
});

function rawQuote() {
  return {
    ok: false,
    errors: [
      { code: "BELOW_MINIMUM", item_index: null, message: "texto cru do banco: relation foo" },
      { code: "VARIANT_REQUIRED", item_index: 0 },
      { code: "algo estranho!", item_index: 1 },
    ],
    items: [
      {
        product_id: U(4), name: "X-Burger", unit_price_cents: 2500, quantity: 2,
        variant: { id: U(7), name: "G", price_cents: 2500 },
        modifiers: [{ id: U(6), name: "Bacon", price_delta_cents: 500 }],
        line_total_cents: 6000,
      },
      { product_id: "ruim" },
    ],
    subtotal_cents: 6000, delivery_fee_cents: 500, discount_cents: 0, total_cents: 6500, minimum_order_cents: 1500,
  };
}

describe("normalizeQuote", () => {
  it("camelCase, mensagens do mapa de códigos e nunca o texto cru do banco", () => {
    const quote = normalizeQuote(rawQuote())!;
    expect(quote.ok).toBe(false);
    expect(quote.errors).toEqual([
      { code: "BELOW_MINIMUM", itemIndex: null, message: "O valor dos itens está abaixo do pedido mínimo." },
      { code: "VARIANT_REQUIRED", itemIndex: 0, message: "Escolha o tamanho/variação deste item." },
      { code: "UNKNOWN", itemIndex: 1, message: expect.stringContaining("Não foi possível") },
    ]);
    expect(JSON.stringify(quote)).not.toContain("relation foo");
    expect(quote.items).toEqual([
      {
        productId: U(4), name: "X-Burger", unitPriceCents: 2500, quantity: 2,
        variant: { id: U(7), name: "G", priceCents: 2500 },
        modifiers: [{ id: U(6), name: "Bacon", priceDeltaCents: 500 }],
        lineTotalCents: 6000,
      },
    ]);
    expect(quote).toMatchObject({ subtotalCents: 6000, deliveryFeeCents: 500, totalCents: 6500, minimumOrderCents: 1500 });
  });

  it("variant ausente (migração antiga) vira null e ok exige zero erros", () => {
    const raw = { ...rawQuote(), ok: true, errors: [{ code: "EMPTY_CART" }] };
    delete (raw.items[0] as { variant?: unknown }).variant;
    const quote = normalizeQuote(raw)!;
    expect(quote.items[0].variant).toBeNull();
    expect(quote.ok).toBe(false);
  });

  it("raiz inválida => null; atribuível ao tipo do SDK", () => {
    expect(normalizeQuote(null)).toBeNull();
    expect(normalizeQuote({ ok: "sim" })).toBeNull();
    const q: ApiQuote = normalizeQuote(rawQuote())!;
    const sdk: SdkQuote = q;
    expect(sdk.errors).toHaveLength(3);
  });
});

describe("quoteRequestSchema / toRpcItems", () => {
  const base = { fulfillmentType: "PICKUP", items: [{ productId: U(4), quantity: 1 }] };

  it("aceita o corpo mínimo e aplica defaults", () => {
    const r = quoteRequestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.items[0].modifierIds).toEqual([]);
  });

  it("aceita carrinho vazio (o servidor responde EMPTY_CART)", () => {
    expect(quoteRequestSchema.safeParse({ ...base, items: [] }).success).toBe(true);
  });

  it("rejeita quantidade fora de 1–99, ids inválidos, fulfillment e excesso de itens", () => {
    const bad = (x: unknown) => quoteRequestSchema.safeParse(x).success;
    expect(bad({ ...base, items: [{ productId: U(4), quantity: 0 }] })).toBe(false);
    expect(bad({ ...base, items: [{ productId: U(4), quantity: 100 }] })).toBe(false);
    expect(bad({ ...base, items: [{ productId: U(4), quantity: 1.5 }] })).toBe(false);
    expect(bad({ ...base, items: [{ productId: "abc", quantity: 1 }] })).toBe(false);
    expect(bad({ ...base, items: [{ productId: U(4), quantity: 1, modifierIds: ["x"] }] })).toBe(false);
    expect(bad({ ...base, items: [{ productId: U(4), quantity: 1, variantId: "x" }] })).toBe(false);
    expect(bad({ ...base, fulfillmentType: "DRIVE" })).toBe(false);
    expect(bad({ ...base, deliveryZoneId: "x" })).toBe(false);
    expect(bad({ items: base.items })).toBe(false);
    expect(bad({ ...base, items: Array.from({ length: 51 }, () => ({ productId: U(4), quantity: 1 })) })).toBe(false);
    expect(bad({ ...base, items: Array.from({ length: 50 }, () => ({ productId: U(4), quantity: 1 })) })).toBe(true);
  });

  it("notes <= 500", () => {
    const item = (notes: string) => ({ ...base, items: [{ productId: U(4), quantity: 1, notes }] });
    expect(quoteRequestSchema.safeParse(item("a".repeat(500))).success).toBe(true);
    expect(quoteRequestSchema.safeParse(item("a".repeat(501))).success).toBe(false);
  });

  it("toRpcItems envia só campos conhecidos (ignora preço enviado pelo cliente)", () => {
    const parsed = quoteRequestSchema.parse({
      fulfillmentType: "DELIVERY",
      items: [
        { productId: U(4), variantId: U(7), quantity: 2, modifierIds: [U(6)], notes: "  sem sal ", priceCents: 1 },
        { productId: U(5), quantity: 1, notes: "   " },
      ],
    });
    expect(toRpcItems(parsed.items)).toEqual([
      { product_id: U(4), variant_id: U(7), quantity: 2, modifier_ids: [U(6)], notes: "sem sal" },
      { product_id: U(5), quantity: 1, modifier_ids: [] },
    ]);
  });
});
