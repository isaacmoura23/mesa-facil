/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { MAX_LINES, MAX_NOTES } from "../../src/modules/storefront/cart";
import {
  EMPTY_CHECKOUT_FORM,
  cartQuoteInputSchema,
  checkoutFormSchema,
  fieldErrorsFrom,
  fulfillmentNeedsAddress,
} from "../../src/modules/storefront/checkout-schema";
import { FULFILLMENTS, isUuid, parseCartValidation, parsePublicMenu } from "../../src/modules/storefront/schemas";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const menuJson = (over: Record<string, unknown> = {}) => ({
  restaurant: { id: U(1), name: "DEMO A", slug: "demo-a", logo_path: null, timezone: "America/Sao_Paulo" },
  settings: {
    accepts_orders: true,
    prep_time_minutes: 30,
    min_order_cents: 0,
    enabled_fulfillment_types: ["DELIVERY", "PICKUP", "DINE_IN"],
    pickup_instructions: null,
    business_hours: [],
    business_hour_exceptions: [],
    delivery_zones: [{ id: U(9), name: "Centro", fee_cents: 500, min_order_cents: 1500, estimated_minutes: 40, neighborhoods: ["Centro"] }],
  },
  is_open_now: true,
  categories: [
    {
      id: U(2),
      name: "Lanches",
      description: null,
      sort_order: 1,
      products: [
        {
          id: U(3),
          name: "X-Burger",
          description: "  bom  ",
          price_cents: 2500,
          image_path: null,
          is_available: true,
          modifier_groups: [
            { id: U(4), name: "Adicionais", min_selections: 0, max_selections: 3, modifiers: [{ id: U(5), name: "Bacon", price_delta_cents: 500, is_available: true }] },
          ],
        },
      ],
    },
    { id: "uncategorized", name: "Outros", description: null, sort_order: 2147483647, products: [] },
  ],
  ...over,
});

describe("parsePublicMenu", () => {
  it("converte o JSON de public_menu no modelo da UI", () => {
    const m = parsePublicMenu(menuJson())!;
    expect(m.restaurant).toEqual({ name: "DEMO A", slug: "demo-a", logoPath: null, timezone: "America/Sao_Paulo", contact: null, storefrontUrl: null });
    expect(m.isOpenNow).toBe(true);
    expect(m.settings).toMatchObject({ acceptsOrders: true, prepTimeMinutes: 30, minOrderCents: 0, pickupInstructions: null });
    expect(m.settings.fulfillmentTypes).toEqual(["DELIVERY", "PICKUP", "DINE_IN"]);
    expect(m.settings.deliveryZones).toEqual([{ id: U(9), name: "Centro", feeCents: 500, minOrderCents: 1500, estimatedMinutes: 40 }]);
    expect(m.categories.map((c) => c.id)).toEqual([U(2), "uncategorized"]);
    const p = m.categories[0].products[0];
    expect(p).toMatchObject({ name: "X-Burger", description: "bom", priceCents: 2500, isAvailable: true });
    expect(p.modifierGroups[0]).toMatchObject({ minSelections: 0, maxSelections: 3 });
    expect(p.modifierGroups[0].modifiers[0]).toEqual({ id: U(5), name: "Bacon", priceDeltaCents: 500, isAvailable: true });
    // Etapa 2.5: respostas sem os campos novos => listas vazias (compatível com JSON antigo)
    expect(p.badges).toEqual([]);
    expect(p.variants).toEqual([]);
  });

  it("Etapa 2.5: badges, variants, contact e storefront_url são convertidos e saneados", () => {
    const json: any = menuJson();
    json.restaurant.contact = { whatsapp: "+55 (11) 99999-0000", phone: "(11) 4000-1234", address_text: "  Rua Zz, 10 " };
    json.restaurant.storefront_url = "https://la-pastelaria.vercel.app/";
    const prod = json.categories[0].products[0];
    prod.price_cents = 1000;
    prod.badges = ["SPICY", "NEW", "NEW", "FOO", 7, "new"];
    prod.variants = [
      { id: U(11), name: " P ", price_cents: 1000, is_available: true, is_default: true },
      { id: U(12), name: "G", price_cents: 2000, is_available: true, is_default: true }, // 2ª "padrão" é rebaixada
      { id: U(13), name: "XG", price_cents: 800, is_available: false, is_default: false },
      { id: "nao-uuid", name: "ruim", price_cents: 1 },
      { id: U(14), name: "", price_cents: 1 },
      { id: U(15), name: "neg", price_cents: -1 },
      null,
    ];
    const m = parsePublicMenu(json)!;
    expect(m.restaurant.contact).toEqual({ whatsappDigits: "5511999990000", phone: "(11) 4000-1234", phoneHref: "1140001234", address: "Rua Zz, 10" });
    expect(m.restaurant.storefrontUrl).toBe("https://la-pastelaria.vercel.app/");
    const p = m.categories[0].products[0];
    expect(p.badges).toEqual(["NEW", "SPICY"]); // só valores conhecidos, sem repetição, na ordem canônica
    expect(p.variants.map((v) => [v.name, v.priceCents, v.isAvailable, v.isDefault])).toEqual([
      ["P", 1000, true, true],
      ["G", 2000, true, false],
      ["XG", 800, false, false],
    ]);
    expect(p.priceCents).toBe(1000);
  });

  it("Etapa 2.5: contact vazio/estranho => null; URL não-https ou lixo => null; whatsapp inválido é descartado do contato", () => {
    const withRestaurant = (over: Record<string, unknown>) => {
      const json: any = menuJson();
      Object.assign(json.restaurant, over);
      return parsePublicMenu(json)!.restaurant;
    };
    expect(withRestaurant({ contact: { whatsapp: null, phone: null, address_text: null } }).contact).toBeNull();
    expect(withRestaurant({ contact: "lixo" }).contact).toBeNull();
    expect(withRestaurant({ contact: { whatsapp: "123", phone: null, address_text: null } }).contact).toBeNull();
    expect(withRestaurant({ contact: { whatsapp: "123", phone: "(11) 4000-1234", address_text: null } }).contact).toMatchObject({ whatsappDigits: null, phone: "(11) 4000-1234" });
    for (const url of ["http://a.com", "javascript:alert(1)", "lixo", "", null, 5]) expect(withRestaurant({ storefront_url: url }).storefrontUrl, String(url)).toBeNull();
  });

  it("raiz inválida => null (a página mostra o estado de erro, nunca dados quebrados)", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, { restaurant: null }, menuJson({ restaurant: { name: "", slug: "a" } }), menuJson({ restaurant: { name: "x" } })]) {
      expect(parsePublicMenu(bad)).toBeNull();
    }
  });

  it("itens inválidos dentro das listas são descartados sem derrubar o resto", () => {
    const json: any = menuJson();
    json.categories.push({ id: "", name: "sem id", products: [] }, null, "x", { id: U(7), name: "", products: [] });
    json.categories[0].products.push({ id: "nao-uuid", name: "ruim", price_cents: 1 }, { id: U(8), name: "preço negativo", price_cents: -1 }, { id: U(10), name: "ok", price_cents: 100 });
    json.categories[0].products[0].modifier_groups.push({ id: "x" }, null);
    json.categories[0].products[0].modifier_groups[0].modifiers.push({ id: "x", name: "ruim" });
    const m = parsePublicMenu(json)!;
    expect(m.categories.map((c) => c.name)).toEqual(["Lanches", "Outros"]);
    expect(m.categories[0].products.map((p) => p.name)).toEqual(["X-Burger", "ok"]);
    expect(m.categories[0].products[0].modifierGroups).toHaveLength(1);
    expect(m.categories[0].products[0].modifierGroups[0].modifiers).toHaveLength(1);
  });

  it("max_selections 0/nulo = sem limite; modalidades desconhecidas/repetidas são filtradas; textos ausentes viram null", () => {
    const json: any = menuJson();
    json.categories[0].products[0].modifier_groups[0].max_selections = 0;
    json.settings.enabled_fulfillment_types = ["PICKUP", "PICKUP", "VOO", 7, null, "DINE_IN", "delivery"];
    json.settings.pickup_instructions = "   ";
    const m = parsePublicMenu(json)!;
    expect(m.categories[0].products[0].modifierGroups[0].maxSelections).toBeNull();
    expect(m.settings.fulfillmentTypes).toEqual(["PICKUP", "DINE_IN"]);
    expect(m.settings.pickupInstructions).toBeNull();
  });

  it("settings ausente/estranho cai em padrões seguros", () => {
    const m = parsePublicMenu(menuJson({ settings: "lixo", is_open_now: "talvez" }))!;
    expect(m.settings.fulfillmentTypes).toEqual([]);
    expect(m.settings.deliveryZones).toEqual([]);
    expect(m.isOpenNow).toBe(false);
  });

  it("não propaga campos internos que por acaso venham no JSON", () => {
    const json: any = menuJson();
    json.restaurant.created_by = "x";
    json.categories[0].products[0].created_by = "x";
    json.categories[0].products[0].is_active = true;
    const text = JSON.stringify(parsePublicMenu(json));
    expect(text).not.toMatch(/created_by|is_active/);
  });
});

const cartJson = (over: Record<string, unknown> = {}) => ({
  ok: true,
  errors: [],
  items: [{ product_id: U(3), name: "X-Burger", variant: null, unit_price_cents: 2500, quantity: 2, modifiers: [{ id: U(5), name: "Bacon", price_delta_cents: 500 }], modifiers_cents: 500, notes: null, line_total_cents: 6000 }],
  subtotal_cents: 6000,
  delivery_fee_cents: 0,
  discount_cents: 0,
  total_cents: 6000,
  minimum_order_cents: 0,
  ...over,
});

describe("parseCartValidation", () => {
  it("converte a resposta de validate_cart", () => {
    expect(parseCartValidation(cartJson())).toEqual({
      ok: true,
      errors: [],
      items: [{ productId: U(3), name: "X-Burger", variant: null, unitPriceCents: 2500, quantity: 2, modifiers: [{ id: U(5), name: "Bacon", priceDeltaCents: 500 }], lineTotalCents: 6000 }],
      subtotalCents: 6000,
      deliveryFeeCents: 0,
      discountCents: 0,
      totalCents: 6000,
      minimumOrderCents: 0,
    });
  });

  it("Etapa 2.5: item com variant{id,name,price_cents} vira variant{id,name,priceCents}; variant malformada vira null", () => {
    const base = (cartJson().items as any[])[0];
    const ok = parseCartValidation(cartJson({ items: [{ ...base, variant: { id: U(11), name: "G", price_cents: 2000 } }] }))!;
    expect(ok.items[0].variant).toEqual({ id: U(11), name: "G", priceCents: 2000 });
    for (const bad of [{ id: "x", name: "G", price_cents: 1 }, "G", 5, []]) {
      expect(parseCartValidation(cartJson({ items: [{ ...base, variant: bad }] }))!.items[0].variant, JSON.stringify(bad)).toBeNull();
    }
    expect(parseCartValidation(cartJson({ items: [{ ...base, variant: undefined }] }))!.items[0].variant).toBeNull();
  });

  it("erros: o texto do servidor é descartado; item_index nulo/ausente vira null; lixo na lista é ignorado", () => {
    const v = parseCartValidation(
      cartJson({ ok: false, errors: [{ code: "PRODUCT_UNAVAILABLE", item_index: 2, message: "texto do banco" }, { code: "BELOW_MINIMUM" }, { code: "" }, null, "x", { code: "X".repeat(65) }] }),
    )!;
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([
      { code: "PRODUCT_UNAVAILABLE", itemIndex: 2 },
      { code: "BELOW_MINIMUM", itemIndex: null },
    ]);
    expect(JSON.stringify(v)).not.toContain("texto do banco");
  });

  it("ok=true com erros listados NÃO é aceito como ok (defesa contra resposta incoerente)", () => {
    expect(parseCartValidation(cartJson({ ok: true, errors: [{ code: "RESTAURANT_CLOSED" }] }))!.ok).toBe(false);
  });

  it("raiz inválida => null; números inválidos viram 0 (nunca NaN/negativo)", () => {
    for (const bad of [null, undefined, "x", [], {}, { errors: [] }, cartJson({ ok: "sim" })]) expect(parseCartValidation(bad)).toBeNull();
    const v = parseCartValidation(cartJson({ subtotal_cents: -5, total_cents: "9", delivery_fee_cents: 1.5, minimum_order_cents: null }))!;
    expect([v.subtotalCents, v.totalCents, v.deliveryFeeCents, v.minimumOrderCents]).toEqual([0, 0, 0, 0]);
  });

  it("itens sem product_id uuid válido são descartados", () => {
    const v = parseCartValidation(cartJson({ items: [{ product_id: "x", unit_price_cents: 1 }, ...(cartJson().items as unknown[])] }))!;
    expect(v.items).toHaveLength(1);
  });
});

describe("checkoutFormSchema", () => {
  const pickup = { ...EMPTY_CHECKOUT_FORM, fulfillment: "PICKUP" as const, name: "Maria Silva", phone: "(11) 91234-5678" };
  const delivery = { ...pickup, fulfillment: "DELIVERY" as const, zoneId: U(9), street: "Rua A", number: "10", neighborhood: "Centro", city: "São Paulo", postalCode: "01310-100" };

  it("retirada: nome e telefone bastam", () => {
    expect(checkoutFormSchema.safeParse(pickup).success).toBe(true);
    expect(checkoutFormSchema.safeParse({ ...pickup, fulfillment: "DINE_IN" }).success).toBe(true);
  });

  it("nome curto/longo, telefone inválido e e-mail inválido são recusados com mensagem por campo", () => {
    const r = checkoutFormSchema.safeParse({ ...pickup, name: "A", phone: "123", email: "nao-e-email" });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrorsFrom(r.error)).sort()).toEqual(["email", "name", "phone"]);
    expect(checkoutFormSchema.safeParse({ ...pickup, name: "x".repeat(121) }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ ...pickup, email: "ok@example.test" }).success).toBe(true);
    expect(checkoutFormSchema.safeParse({ ...pickup, email: `${"a".repeat(250)}@example.test` }).success).toBe(false);
  });

  it("entrega exige endereço completo, CEP de 8 dígitos e região (uuid)", () => {
    expect(checkoutFormSchema.safeParse(delivery).success).toBe(true);
    const r = checkoutFormSchema.safeParse({ ...delivery, street: "", number: "", neighborhood: "", city: "", postalCode: "123", zoneId: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrorsFrom(r.error)).sort()).toEqual(["city", "neighborhood", "number", "postalCode", "street", "zoneId"]);
    expect(checkoutFormSchema.safeParse({ ...delivery, zoneId: "nao-uuid" }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ ...delivery, street: "r".repeat(161) }).success).toBe(false);
  });

  it("modalidade inválida e campos longos de observação/instruções são recusados", () => {
    expect(checkoutFormSchema.safeParse({ ...pickup, fulfillment: "VOO" }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ ...pickup, notes: "n".repeat(501) }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ ...pickup, instructions: "n".repeat(301) }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ ...pickup, notes: "n".repeat(500) }).success).toBe(true);
  });

  it("fulfillmentNeedsAddress só para DELIVERY; FULFILLMENTS bate com o enum do banco", () => {
    expect(FULFILLMENTS).toEqual(["DELIVERY", "PICKUP", "DINE_IN"]);
    expect(FULFILLMENTS.filter(fulfillmentNeedsAddress)).toEqual(["DELIVERY"]);
  });
});

describe("cartQuoteInputSchema (entrada da action de conferência)", () => {
  const item = { productId: U(3), quantity: 1, modifierIds: [], notes: "" };
  const base = { slug: "demo-a", fulfillment: "PICKUP" as const, zoneId: null, items: [item] };

  it("aceita entrada válida e zona vazia/nula", () => {
    expect(cartQuoteInputSchema.safeParse(base).success).toBe(true);
    expect(cartQuoteInputSchema.safeParse({ ...base, zoneId: "" }).success).toBe(true);
    expect(cartQuoteInputSchema.safeParse({ ...base, zoneId: U(9) }).success).toBe(true);
  });

  it("limites: 50 linhas, quantidade 1..99 inteira, observação até 300, uuids válidos", () => {
    expect(cartQuoteInputSchema.safeParse({ ...base, items: Array.from({ length: MAX_LINES }, () => item) }).success).toBe(true);
    expect(cartQuoteInputSchema.safeParse({ ...base, items: Array.from({ length: MAX_LINES + 1 }, () => item) }).success).toBe(false);
    for (const quantity of [0, 100, -1, 1.5, "2", null]) expect(cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, quantity }] }).success, String(quantity)).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, notes: "n".repeat(MAX_NOTES + 1) }] }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, productId: "x" }] }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, modifierIds: ["x"] }] }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, modifierIds: Array.from({ length: 61 }, () => U(5)) }] }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, zoneId: "nao-uuid" }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, slug: "" }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, slug: "x".repeat(64) }).success).toBe(false);
    expect(cartQuoteInputSchema.safeParse({ ...base, fulfillment: "VOO" }).success).toBe(false);
  });

  it("nenhum campo de preço é aceito/propagado na entrada da action (zod remove chaves extras)", () => {
    const r = cartQuoteInputSchema.safeParse({ ...base, items: [{ ...item, price_cents: 1, unitPriceCents: 1, total: 0 }], total_cents: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(JSON.stringify(r.data)).not.toMatch(/price|total/i);
  });

  it("isUuid", () => {
    expect(isUuid(U(1))).toBe(true);
    expect(isUuid(U(1).toUpperCase())).toBe(true);
    for (const v of ["", "x", null, undefined, 1, `${U(1)} `, `${U(1)}\n`]) expect(isUuid(v)).toBe(false);
  });
});
