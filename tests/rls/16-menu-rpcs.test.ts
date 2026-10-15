/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 2 — RPCs de cardápio (migração 0112), exercitadas como o navegador faz: cliente anon / usuário logado.
 *
 *   public_menu(p_slug)                       -> JSON público, só ativos, ordenado, sem campos internos
 *   validate_cart(slug, fulfillment, items, zone) -> reprecifica no servidor, nunca grava, nunca estoura 500
 *   reorder_menu(restaurant, kind, ids)       -> menu.manage, atômico, auditado
 *
 * O service role só monta fixtures ("zz-") e confere o estado real do banco.
 * O horário de funcionamento é controlado por uma EXCEÇÃO do dia (setOpenToday) para o teste não depender da hora.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { admin, anon, as, rawRest, userId, world } from "../helpers/clients";
import { expectDenied, expectRule, rows } from "../helpers/expect";
import { Cleanup } from "../helpers/factory";
import {
  BASE_FULFILLMENT,
  clearTodayException,
  insertRow,
  makeMenuFixture,
  setOpenToday,
  setSettings,
  setStatus,
  walkKeys,
  type MenuFixture,
} from "../helpers/menu";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;

const ERROR_CODES = [
  "RESTAURANT_UNAVAILABLE",
  "RESTAURANT_CLOSED",
  "FULFILLMENT_DISABLED",
  "PRODUCT_UNAVAILABLE",
  "MODIFIER_UNAVAILABLE",
  "MODIFIER_NOT_ALLOWED",
  "MODIFIER_GROUP_MIN",
  "MODIFIER_GROUP_MAX",
  "INVALID_QUANTITY",
  "BELOW_MINIMUM",
  "ZONE_REQUIRED",
  "ZONE_UNAVAILABLE",
  "EMPTY_CART",
  "TOO_MANY_ITEMS",
  "NOTES_TOO_LONG",
];

beforeAll(async () => {
  await setOpenToday(A().id, true);
  await setOpenToday(B().id, true);
});
afterAll(async () => {
  await clearTodayException(A().id);
  await clearTodayException(B().id);
  await setSettings(A().id, { accepts_orders: true, min_order_cents: 0, enabled_fulfillment_types: BASE_FULFILLMENT });
  await setStatus(A().id, "active");
});

// =====================================================================================================
// public_menu
// =====================================================================================================
const menu = async (slug: string | null, client = anon()) => {
  const res = await client.rpc("public_menu", { p_slug: slug });
  expect(res.error, res.error ? `${res.error.code}: ${res.error.message}` : "").toBeNull();
  return res.data as any;
};

const INTERNAL_KEYS = [
  "restaurant_id",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
  "status",
  "single_tab_per_table",
  "is_active",
  "postal_code_prefixes",
  "qr_token",
  "email",
  // "phone" só é interno FORA de restaurant.contact (Etapa 2.5: contato público do restaurante); ver teste abaixo.
  "owner_id",
  "storefront_origins",
  "plan_id",
  "subscription",
  "membership",
];

describe("public_menu — restaurante demo (estado base do seed)", () => {
  it("demo-a devolve só ativos, na ordem do sort_order, com a estrutura do contrato", async () => {
    const m = await menu("demo-a");
    expect(m.restaurant).toMatchObject({ id: A().id, name: "DEMO Restaurante A", slug: "demo-a", logo_path: null, timezone: "America/Sao_Paulo" });
    expect(Object.keys(m).sort()).toEqual(["categories", "is_open_now", "restaurant", "settings"]);
    expect(Object.keys(m.restaurant).sort()).toEqual(["contact", "id", "logo_path", "name", "slug", "storefront_url", "timezone"]);
    expect(Object.keys(m.settings).sort()).toEqual([
      "accepts_orders",
      "business_hour_exceptions",
      "business_hours",
      "delivery_zones",
      "enabled_fulfillment_types",
      "min_order_cents",
      "pickup_instructions",
      "prep_time_minutes",
    ]);
    expect(m.settings).toMatchObject({ accepts_orders: true, min_order_cents: 0, prep_time_minutes: 30 });
    expect([...m.settings.enabled_fulfillment_types].sort()).toEqual(["DELIVERY", "DINE_IN", "PICKUP"]);
    expect(m.is_open_now).toBe(true); // exceção de hoje 00:00–23:59:59

    // categorias ativas, ordenadas; "Outros" sintética por último; categoria oculta ausente
    expect(m.categories.map((c: any) => c.name)).toEqual(["DEMO Lanches", "DEMO Bebidas", "Outros"]);
    expect(m.categories.map((c: any) => c.sort_order)).toEqual([1, 2, 2147483647]);
    expect(JSON.stringify(m)).not.toContain("Oculto");

    const [lanches, bebidas, outros] = m.categories;
    expect(lanches.products.map((p: any) => p.name)).toEqual(["DEMO X-Burger A"]);
    expect(bebidas.products).toEqual([]);
    expect(outros.products.map((p: any) => p.name)).toEqual(["DEMO Refrigerante A"]);

    const burger = lanches.products[0];
    expect(burger).toMatchObject({ id: A().productId, price_cents: 2500, is_available: true, image_path: null });
    expect(Object.keys(burger).sort()).toEqual(["badges", "description", "id", "image_path", "is_available", "modifier_groups", "name", "price_cents", "variants"]);
    expect(burger.modifier_groups).toHaveLength(1);
    expect(burger.modifier_groups[0]).toMatchObject({ id: A().modifierGroupId, name: "DEMO Adicionais", min_selections: 0, max_selections: 3 });
    expect(burger.modifier_groups[0].modifiers.map((x: any) => [x.name, x.price_delta_cents, x.is_available])).toEqual([
      ["DEMO Bacon", 500, true],
      ["DEMO Queijo extra", 400, true],
    ]);
    expect(Object.keys(burger.modifier_groups[0].modifiers[0]).sort()).toEqual(["id", "is_available", "name", "price_delta_cents"]);
  });

  it("produto sem categoria vai para a categoria sintética 'Outros' (id 'uncategorized'), sem description fantasma", async () => {
    const m = await menu("demo-a");
    const outros = m.categories.at(-1);
    expect(outros).toMatchObject({ id: "uncategorized", name: "Outros", description: null });
    expect(outros.products[0]).toMatchObject({ name: "DEMO Refrigerante A", price_cents: 600, modifier_groups: [] });
  });

  it("zonas: só as ativas, apenas campos públicos; horários no formato HH:MM", async () => {
    const m = await menu("demo-a");
    expect(m.settings.delivery_zones).toHaveLength(1);
    expect(m.settings.delivery_zones[0]).toEqual({ id: A().deliveryZoneId, name: "DEMO Centro", fee_cents: 500, min_order_cents: 1500, estimated_minutes: 40, neighborhoods: ["Centro"] });
    expect(m.settings.business_hours).toHaveLength(7);
    for (const h of m.settings.business_hours) {
      expect(h.opens_at).toMatch(/^\d\d:\d\d$/);
      expect(h.closes_at).toMatch(/^\d\d:\d\d$/);
    }
    expect(m.settings.business_hours.map((h: any) => h.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("nenhum campo interno vaza (created_by, status, single_tab_per_table, restaurant_id...)", async () => {
    const m = await menu("demo-a");
    const keys = walkKeys(m);
    for (const k of INTERNAL_KEYS) expect(keys.has(k), `campo interno exposto: ${k}`).toBe(false);
    // `phone` é público apenas em restaurant.contact (telefone do estabelecimento); em qualquer outro lugar seria PII de cliente/equipe.
    const { restaurant, ...rest } = m;
    expect(walkKeys(rest).has("phone"), "phone fora de restaurant.contact").toBe(false);
    expect(Object.keys(restaurant).filter((k) => k !== "contact").includes("phone")).toBe(false);
    expect(Object.keys(restaurant.contact).sort()).toEqual(["address_text", "phone", "whatsapp"]);
  });

  it("isolamento: nada de B em A (e nada de A em B)", async () => {
    const a = JSON.stringify(await menu("demo-a"));
    const b = JSON.stringify(await menu("demo-b"));
    const bIds = [B().id, B().productId, B().hiddenProductId, B().categoryId, B().modifierGroupId, B().modifierId, B().deliveryZoneId];
    const aIds = [A().id, A().productId, A().hiddenProductId, A().categoryId, A().modifierGroupId, A().modifierId, A().deliveryZoneId];
    for (const id of bIds) expect(a, `id de B em A: ${id}`).not.toContain(id);
    for (const id of aIds) expect(b, `id de A em B: ${id}`).not.toContain(id);
    expect(a).not.toMatch(/demo-b|Restaurante B|X-Burger B|Refrigerante B/);
    expect(b).not.toMatch(/demo-a|Restaurante A|X-Burger A|Refrigerante A/);
    expect(JSON.parse(b).restaurant.id).toBe(B().id);
  });

  it("determinístico/idempotente; anônimo e logados (de A, de B, sem vínculo) recebem exatamente o mesmo", async () => {
    const first = await menu("demo-a");
    expect(await menu("demo-a")).toEqual(first);
    for (const who of ["ownerA", "waiterB", "plain", "superadmin"] as const) expect(await menu("demo-a", as(who))).toEqual(first);
  });

  it("slug é normalizado (caixa/espaços); inexistente, vazio, nulo e SQL-ish => null (sem erro)", async () => {
    const canonical = await menu("demo-a");
    expect(await menu("  DEMO-A  ")).toEqual(canonical);
    for (const slug of [null, "", "   ", "nao-existe", "demo-a-", "demo-", "%", "_", "demo-a%", "demo-a' or '1'='1", "demo-a'; drop table restaurants;--", "x".repeat(5000), "../demo-a"]) {
      expect(await menu(slug), `slug ${JSON.stringify(slug)?.slice(0, 40)}`).toBeNull();
    }
  });

  it("restaurante suspenso ou pendente => null (indistinguível de inexistente); ao reativar volta", async () => {
    try {
      for (const status of ["suspended", "pending"]) {
        await setStatus(A().id, status);
        expect(await menu("demo-a"), status).toBeNull();
        expect(await menu("demo-a", as("ownerA")), `${status} (dono)`).toBeNull();
      }
    } finally {
      await setStatus(A().id, "active");
    }
    expect((await menu("demo-a"))?.restaurant?.id).toBe(A().id);
  });
});

describe("public_menu — inativos, indisponíveis e ordenação", () => {
  const cleanup = new Cleanup();
  let F: MenuFixture;
  let catFirst: any;
  let catA: any;
  let catB: any;
  beforeAll(async () => {
    F = await makeMenuFixture(cleanup, A().id);
    // mesma ordem => desempate por nome; e uma categoria com sort_order negativo fica antes de todas
    catFirst = await insertRow("menu_categories", { restaurant_id: A().id, name: "zz-cat-primeira", sort_order: -1 });
    catB = await insertRow("menu_categories", { restaurant_id: A().id, name: "zz-cat-b", sort_order: 60 });
    catA = await insertRow("menu_categories", { restaurant_id: A().id, name: "zz-cat-a", sort_order: 60 });
    await insertRow("products", { restaurant_id: A().id, category_id: catFirst.id, name: "zz-prod-desempate-2", price_cents: 1, sort_order: 5 });
    await insertRow("products", { restaurant_id: A().id, category_id: catFirst.id, name: "zz-prod-desempate-1", price_cents: 1, sort_order: 5 });
    await insertRow("products", { restaurant_id: A().id, category_id: catFirst.id, name: "zz-prod-primeiro", price_cents: 1, sort_order: -3 });
    cleanup.add(async () => void (await admin().from("menu_categories").delete().in("id", [catFirst.id, catA.id, catB.id])));
  });
  afterAll(async () => cleanup.run());

  it("categoria inativa some com TODOS os seus produtos; produto inativo some; indisponível aparece marcado", async () => {
    const m = await menu("demo-a");
    const text = JSON.stringify(m);
    expect(text).not.toContain(F.pOffCat.id);
    expect(text).not.toContain(F.pInactive.id);
    expect(text).not.toContain(F.pOffCat.name);
    const cat = m.categories.find((c: any) => c.id === F.category.id);
    expect(cat.products.map((p: any) => p.name)).toEqual([F.pPlain.name, F.pGrp.name, F.pGinact.name, F.pUnavail.name]);
    expect(cat.products.find((p: any) => p.id === F.pUnavail.id).is_available).toBe(false);
    expect(cat.products.find((p: any) => p.id === F.pPlain.id).is_available).toBe(true);
  });

  it("adicional inativo e grupo inativo não aparecem; adicional indisponível aparece marcado; ordem por sort_order", async () => {
    const m = await menu("demo-a");
    const text = JSON.stringify(m);
    expect(text).not.toContain(F.m4.id); // adicional inativo
    expect(text).not.toContain(F.m5.id); // adicional (ativo) de grupo inativo
    expect(text).not.toContain(F.g2.id); // grupo inativo
    expect(text).not.toContain(F.gOther.id); // grupo sem vínculo com produto algum
    expect(text).not.toContain(F.m7.id);
    const prod = m.categories.flatMap((c: any) => c.products).find((p: any) => p.id === F.pGrp.id);
    expect(prod.modifier_groups).toHaveLength(1);
    expect(prod.modifier_groups[0]).toMatchObject({ id: F.g1.id, min_selections: 1, max_selections: 2 });
    expect(prod.modifier_groups[0].modifiers.map((x: any) => [x.id, x.is_available])).toEqual([
      [F.m1.id, true],
      [F.m2.id, true],
      [F.m6.id, true],
      [F.m3.id, false],
    ]);
    const ginact = m.categories.flatMap((c: any) => c.products).find((p: any) => p.id === F.pGinact.id);
    expect(ginact.modifier_groups).toEqual([]);
  });

  it("categorias: sort_order (negativo primeiro), empate desempata por nome, 'Outros' sempre por último", async () => {
    const names = (await menu("demo-a")).categories.map((c: any) => c.name);
    expect(names[0]).toBe("zz-cat-primeira");
    expect(names.slice(1)).toEqual(["DEMO Lanches", "DEMO Bebidas", F.category.name, "zz-cat-a", "zz-cat-b", "Outros"]);
  });

  it("produtos: sort_order, empate por nome", async () => {
    const m = await menu("demo-a");
    const cat = m.categories.find((c: any) => c.id === catFirst.id);
    expect(cat.products.map((p: any) => p.name)).toEqual(["zz-prod-primeiro", "zz-prod-desempate-1", "zz-prod-desempate-2"]);
  });

  it("reordenar no banco muda a ordem pública (prova que lê do banco, sem cache)", async () => {
    await admin().from("menu_categories").update({ sort_order: -2 }).eq("id", catA.id);
    expect((await menu("demo-a")).categories[0].name).toBe("zz-cat-a");
  });
});

// =====================================================================================================
// validate_cart
// =====================================================================================================
interface Cart {
  ok: boolean;
  errors: { code: string; item_index?: number; message: string; group_id?: string }[];
  items: any[];
  subtotal_cents: number;
  delivery_fee_cents: number;
  discount_cents: number;
  total_cents: number;
  minimum_order_cents: number;
}

const validate = async (slug: string | null, fulfillment: string | null, items: unknown, zone: string | null = null, client = anon()): Promise<Cart> => {
  const res = await client.rpc("validate_cart", { p_slug: slug, p_fulfillment: fulfillment, p_items: items, p_delivery_zone_id: zone });
  expect(res.error, res.error ? `${res.error.code}: ${res.error.message}` : "").toBeNull();
  return res.data as Cart;
};
const codes = (c: Cart) => c.errors.map((e) => e.code);
const line = (product_id: string, quantity: number, modifier_ids: string[] = [], extra: Record<string, unknown> = {}) => ({ product_id, quantity, modifier_ids, ...extra });

describe("validate_cart — cálculo e imunidade a preço forjado", () => {
  const cleanup = new Cleanup();
  let F: MenuFixture;
  beforeAll(async () => {
    F = await makeMenuFixture(cleanup, A().id);
  });
  afterAll(async () => cleanup.run());

  it("carrinho válido (seed): recalcula do banco e devolve a estrutura do contrato", async () => {
    const c = await validate("demo-a", "PICKUP", [line(A().productId, 2, [A().modifierId], { notes: "  sem cebola " })]);
    expect(c.ok).toBe(true);
    expect(c.errors).toEqual([]);
    expect(Object.keys(c).sort()).toEqual(["delivery_fee_cents", "discount_cents", "errors", "items", "minimum_order_cents", "ok", "subtotal_cents", "total_cents"]);
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({
      product_id: A().productId,
      name: "DEMO X-Burger A",
      unit_price_cents: 2500,
      quantity: 2,
      modifiers_cents: 500,
      line_total_cents: 6000,
      notes: "sem cebola",
    });
    expect(c.items[0].modifiers).toEqual([expect.objectContaining({ id: A().modifierId, name: "DEMO Bacon", price_delta_cents: 500 })]);
    expect(c).toMatchObject({ subtotal_cents: 6000, delivery_fee_cents: 0, discount_cents: 0, total_cents: 6000, minimum_order_cents: 0 });
  });

  it("preço forjado no JSON (price_cents, unit_price_cents, total_cents, line_total_cents, price_delta_cents...) é ignorado", async () => {
    const forged = {
      product_id: A().productId,
      quantity: 1,
      modifier_ids: [A().modifierId],
      price_cents: 1,
      unit_price_cents: 1,
      total_cents: 1,
      subtotal_cents: 1,
      line_total_cents: 1,
      price: 0.01,
      modifiers_cents: -100000,
      delivery_fee_cents: -500,
      discount_cents: 999999,
      name: "GRATIS",
    };
    const c = await validate("demo-a", "PICKUP", [forged]);
    expect(c.ok).toBe(true);
    expect(c.items[0]).toMatchObject({ name: "DEMO X-Burger A", unit_price_cents: 2500, modifiers_cents: 500, line_total_cents: 3000 });
    expect(c).toMatchObject({ subtotal_cents: 3000, total_cents: 3000, discount_cents: 0, delivery_fee_cents: 0 });
    // adicional como objeto com preço forjado: não é um id => rejeitado, nunca usado
    const obj = await validate("demo-a", "PICKUP", [line(A().productId, 1, [{ id: A().modifierId, price_delta_cents: 0 } as never])]);
    expect(obj.ok).toBe(false);
    expect(codes(obj)).toContain("MODIFIER_NOT_ALLOWED");
  });

  it("vários itens e adicionais: soma = Σ (preço + adicionais) × quantidade", async () => {
    const c = await validate("demo-a", "PICKUP", [
      line(A().productId, 3, [A().modifierId]),
      line(F.pGrp.id, 2, [F.m1.id, F.m2.id]),
      line(F.pPlain.id, 99),
    ]);
    expect(c.ok, JSON.stringify(c.errors)).toBe(true);
    expect(c.items.map((i) => i.line_total_cents)).toEqual([9000, 2600, 99000]);
    expect(c.subtotal_cents).toBe(9000 + 2600 + 99000);
    expect(c.total_cents).toBe(c.subtotal_cents);
  });

  it("slug normalizado (maiúsculas/espaços) e modalidade case-insensitive", async () => {
    const c = await validate("  DEMO-A ", " pickup ", [line(A().productId, 1)]);
    expect(c.ok).toBe(true);
  });

  it("PICKUP e DINE_IN ignoram a zona (mesmo uma zona de B ou inexistente) e têm taxa 0", async () => {
    for (const f of ["PICKUP", "DINE_IN"]) {
      for (const zone of [null, A().deliveryZoneId, B().deliveryZoneId, crypto.randomUUID()]) {
        const c = await validate("demo-a", f, [line(A().productId, 1)], zone);
        expect(c.ok, `${f} zona=${zone} ${JSON.stringify(c.errors)}`).toBe(true);
        expect(c.delivery_fee_cents).toBe(0);
        expect(c.total_cents).toBe(2500);
      }
    }
  });

  it("DELIVERY soma a taxa da zona ao total; discount sempre 0", async () => {
    const c = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId);
    expect(c.ok, JSON.stringify(c.errors)).toBe(true);
    expect(c).toMatchObject({ subtotal_cents: 2500, delivery_fee_cents: 500, discount_cents: 0, total_cents: 3000, minimum_order_cents: 1500 });
  });

  it("mínimo efetivo = maior entre settings e zona (DELIVERY); PICKUP usa só o de settings", async () => {
    try {
      // settings < zona (1500) => 1500
      await setSettings(A().id, { min_order_cents: 1000 });
      const d1 = await validate("demo-a", "DELIVERY", [line(F.pPlain.id, 1)], A().deliveryZoneId); // 1000 < 1500
      expect(d1.minimum_order_cents).toBe(1500);
      expect(codes(d1)).toEqual(["BELOW_MINIMUM"]);
      // settings > zona => settings
      await setSettings(A().id, { min_order_cents: 3000 });
      const d2 = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId); // 2500 < 3000
      expect(d2.minimum_order_cents).toBe(3000);
      expect(codes(d2)).toEqual(["BELOW_MINIMUM"]);
      const p = await validate("demo-a", "PICKUP", [line(A().productId, 1)]);
      expect(p.minimum_order_cents).toBe(3000);
      expect(codes(p)).toEqual(["BELOW_MINIMUM"]);
      // exatamente no mínimo passa
      const eq = await validate("demo-a", "PICKUP", [line(A().productId, 1, [A().modifierId])]); // 3000
      expect(eq.ok).toBe(true);
      // pickup com settings 1000 não herda os 1500 da zona
      await setSettings(A().id, { min_order_cents: 1000 });
      const p2 = await validate("demo-a", "PICKUP", [line(F.pPlain.id, 1)]);
      expect(p2.ok).toBe(true);
      expect(p2.minimum_order_cents).toBe(1000);
    } finally {
      await setSettings(A().id, { min_order_cents: 0 });
    }
  });

  it("o mínimo vale pelo subtotal (a taxa de entrega não ajuda a alcançá-lo)", async () => {
    try {
      await setSettings(A().id, { min_order_cents: 3000 });
      const c = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId); // 2500 + 500 de taxa = 3000, mas subtotal 2500
      expect(codes(c)).toContain("BELOW_MINIMUM");
    } finally {
      await setSettings(A().id, { min_order_cents: 0 });
    }
  });

  it("preço lido do banco: mudar o preço do produto muda o total na hora (prova que não há cache/JSON confiado)", async () => {
    const before = await validate("demo-a", "PICKUP", [line(F.pPlain.id, 2)]);
    expect(before.total_cents).toBe(2000);
    await admin().from("products").update({ price_cents: 1234 }).eq("id", F.pPlain.id);
    const after = await validate("demo-a", "PICKUP", [line(F.pPlain.id, 2)]);
    expect(after.total_cents).toBe(2468);
    expect(after.items[0].unit_price_cents).toBe(1234);
    // adicional também
    await admin().from("modifiers").update({ price_delta_cents: 777 }).eq("id", F.m1.id);
    const mod = await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id])]);
    expect(mod.total_cents).toBe(1000 + 777);
    // zona também
    await admin().from("delivery_zones").update({ fee_cents: 321 }).eq("id", A().deliveryZoneId);
    try {
      const z = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId);
      expect(z.delivery_fee_cents).toBe(321);
      expect(z.total_cents).toBe(2821);
    } finally {
      await admin().from("delivery_zones").update({ fee_cents: 500 }).eq("id", A().deliveryZoneId);
    }
  });

  it("produto de valor extremo não estoura: 2.147.483.647 × 99 cabe no total (bigint)", async () => {
    await admin().from("products").update({ price_cents: 2147483647 }).eq("id", F.pPlain.id);
    const c = await validate("demo-a", "PICKUP", [line(F.pPlain.id, 99)]);
    expect(c.ok).toBe(true);
    expect(c.total_cents).toBe(2147483647 * 99);
  });

  it("determinístico/idempotente: chamar duas vezes (e em paralelo) devolve exatamente o mesmo", async () => {
    const items = [line(A().productId, 2, [A().modifierId]), line(F.pGrp.id, 1, [F.m1.id])];
    const first = await validate("demo-a", "DELIVERY", items, A().deliveryZoneId);
    expect(await validate("demo-a", "DELIVERY", items, A().deliveryZoneId)).toEqual(first);
    const par = await Promise.all(Array.from({ length: 15 }, () => validate("demo-a", "DELIVERY", items, A().deliveryZoneId)));
    for (const r of par) expect(r).toEqual(first);
    // usuário logado recebe o mesmo que o anônimo
    expect(await validate("demo-a", "DELIVERY", items, A().deliveryZoneId, as("waiterB"))).toEqual(first);
  });

  it("mesmo produto em duas linhas é aceito e somado; observação é normalizada (espaços) e vazia vira null", async () => {
    const c = await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: "   " }), line(A().productId, 1, [], { notes: null }), line(A().productId, 1, [], { notes: " ok " })]);
    expect(c.ok).toBe(true);
    expect(c.items.map((i) => i.notes)).toEqual([null, null, "ok"]);
    expect(c.subtotal_cents).toBe(7500);
  });
});

describe("validate_cart — códigos de erro do contrato", () => {
  const cleanup = new Cleanup();
  let F: MenuFixture;
  beforeAll(async () => {
    F = await makeMenuFixture(cleanup, A().id);
  });
  afterAll(async () => cleanup.run());

  const only = (c: Cart, code: string, idx?: number) => {
    expect(c.ok).toBe(false);
    expect(codes(c)).toEqual([code]);
    if (idx !== undefined) expect(c.errors[0].item_index).toBe(idx);
    for (const e of c.errors) expect(typeof e.message).toBe("string");
  };

  it("RESTAURANT_UNAVAILABLE: slug inexistente, suspenso, pendente e sem aceitar pedidos", async () => {
    const none = await validate("nao-existe", "PICKUP", [line(A().productId, 1)]);
    expect(none).toMatchObject({ ok: false, items: [], subtotal_cents: 0, delivery_fee_cents: 0, total_cents: 0, minimum_order_cents: 0 });
    expect(codes(none)).toEqual(["RESTAURANT_UNAVAILABLE"]);
    expect(codes(await validate(null, "PICKUP", [line(A().productId, 1)]))).toEqual(["RESTAURANT_UNAVAILABLE"]);
    try {
      for (const status of ["suspended", "pending"]) {
        await setStatus(A().id, status);
        const c = await validate("demo-a", "PICKUP", [line(A().productId, 1)]);
        expect(codes(c), status).toEqual(["RESTAURANT_UNAVAILABLE"]);
        expect(c.items).toEqual([]);
      }
    } finally {
      await setStatus(A().id, "active");
    }
    try {
      await setSettings(A().id, { accepts_orders: false });
      const c = await validate("demo-a", "PICKUP", [line(A().productId, 1)]);
      expect(c.ok).toBe(false);
      expect(codes(c)).toContain("RESTAURANT_UNAVAILABLE");
    } finally {
      await setSettings(A().id, { accepts_orders: true });
    }
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1)])).ok).toBe(true);
  });

  it("RESTAURANT_CLOSED: exceção de hoje fechada; depois de restaurar volta a aceitar", async () => {
    try {
      await setOpenToday(A().id, false);
      const c = await validate("demo-a", "PICKUP", [line(A().productId, 1)]);
      only(c, "RESTAURANT_CLOSED");
      expect((await menu("demo-a")).is_open_now).toBe(false);
    } finally {
      await setOpenToday(A().id, true);
    }
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1)])).ok).toBe(true);
    expect((await menu("demo-a")).is_open_now).toBe(true);
  });

  it("RESTAURANT_CLOSED: sem nenhum horário cadastrado => fechado; a exceção 'aberto' substitui a grade", async () => {
    // exceção de hoje removida + grade vazia (apagada e restaurada) => fechado
    const saved = rows(await admin().from("business_hours").select("*").eq("restaurant_id", A().id)); // com id: preserva world().businessHourId
    try {
      await clearTodayException(A().id);
      await admin().from("business_hours").delete().eq("restaurant_id", A().id);
      expect(codes(await validate("demo-a", "PICKUP", [line(A().productId, 1)]))).toEqual(["RESTAURANT_CLOSED"]);
      // exceção aberta substitui (mesmo sem grade)
      await setOpenToday(A().id, true);
      expect((await validate("demo-a", "PICKUP", [line(A().productId, 1)])).ok).toBe(true);
    } finally {
      await admin().from("business_hours").delete().eq("restaurant_id", A().id);
      await admin().from("business_hours").insert(saved);
      await setOpenToday(A().id, true);
    }
  });

  it("FULFILLMENT_DISABLED: modalidade desligada, inválida, vazia ou nula", async () => {
    try {
      await setSettings(A().id, { enabled_fulfillment_types: ["PICKUP"] });
      const d = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId);
      only(d, "FULFILLMENT_DISABLED");
      only(await validate("demo-a", "DINE_IN", [line(A().productId, 1)]), "FULFILLMENT_DISABLED");
      expect((await validate("demo-a", "PICKUP", [line(A().productId, 1)])).ok).toBe(true);
    } finally {
      await setSettings(A().id, { enabled_fulfillment_types: BASE_FULFILLMENT });
    }
    for (const f of ["FOO", "", "  ", null, "PICKUP; DROP TABLE orders", "DELIVERY,PICKUP", "x".repeat(2000)]) {
      const c = await validate("demo-a", f, [line(A().productId, 1)]);
      only(c, "FULFILLMENT_DISABLED");
    }
  });

  it("PRODUCT_UNAVAILABLE: produto de B em A, inexistente, id malformado, inativo, indisponível, categoria inativa, item não-objeto", async () => {
    const bad: unknown[] = [
      line(B().productId, 1), // outro restaurante
      line(crypto.randomUUID(), 1),
      line("nao-e-uuid", 1),
      line(F.pInactive.id, 1),
      line(F.pUnavail.id, 1),
      line(F.pOffCat.id, 1),
      line(A().hiddenProductId, 1),
      { quantity: 1 }, // sem product_id
      { product_id: 123, quantity: 1 },
      "texto",
      42,
      null,
      [],
    ];
    const c = await validate("demo-a", "PICKUP", bad);
    expect(c.ok).toBe(false);
    expect(c.items).toEqual([]);
    expect(c.errors.filter((e) => e.code === "PRODUCT_UNAVAILABLE").map((e) => e.item_index)).toEqual(bad.map((_, i) => i));
    // cada um individualmente também
    for (let i = 0; i < bad.length; i++) {
      const one = await validate("demo-a", "PICKUP", [bad[i]]);
      only(one, "PRODUCT_UNAVAILABLE", 0);
    }
    // a mensagem não revela o motivo (produto de B == inexistente)
    const b = await validate("demo-a", "PICKUP", [line(B().productId, 1)]);
    const none = await validate("demo-a", "PICKUP", [line(crypto.randomUUID(), 1)]);
    expect(b).toEqual(none);
  });

  it("produto de A em B também é indisponível (simétrico)", async () => {
    const c = await validate("demo-b", "PICKUP", [line(A().productId, 1)]);
    only(c, "PRODUCT_UNAVAILABLE", 0);
  });

  it("MODIFIER_UNAVAILABLE: adicional indisponível, inativo ou de grupo inativo", async () => {
    only(await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id, F.m3.id])]), "MODIFIER_UNAVAILABLE", 0); // is_available=false
    only(await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id, F.m4.id])]), "MODIFIER_UNAVAILABLE", 0); // is_active=false
    only(await validate("demo-a", "PICKUP", [line(F.pGinact.id, 1, [F.m5.id])]), "MODIFIER_UNAVAILABLE", 0); // grupo inativo
  });

  it("MODIFIER_NOT_ALLOWED: adicional de B, de grupo não vinculado, de outro produto, duplicado, malformado, não-array", async () => {
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [B().modifierId])]), "MODIFIER_NOT_ALLOWED", 0); // de B
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [F.m7.id])]), "MODIFIER_NOT_ALLOWED", 0); // grupo não vinculado ao produto
    only(await validate("demo-a", "PICKUP", [line(F.pPlain.id, 1, [F.m1.id])]), "MODIFIER_NOT_ALLOWED", 0); // adicional de outro produto
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [crypto.randomUUID()])]), "MODIFIER_NOT_ALLOWED", 0); // inexistente
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, ["lixo"])]), "MODIFIER_NOT_ALLOWED", 0);
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [A().modifierId, A().modifierId])]), "MODIFIER_NOT_ALLOWED", 0); // repetido
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [1 as never])]), "MODIFIER_NOT_ALLOWED", 0);
    only(await validate("demo-a", "PICKUP", [{ product_id: A().productId, quantity: 1, modifier_ids: "abc" }]), "MODIFIER_NOT_ALLOWED", 0);
    only(await validate("demo-a", "PICKUP", [{ product_id: A().productId, quantity: 1, modifier_ids: { a: 1 } }]), "MODIFIER_NOT_ALLOWED", 0);
    // ausente/nulo = sem adicionais (aceito)
    expect((await validate("demo-a", "PICKUP", [{ product_id: A().productId, quantity: 1 }])).ok).toBe(true);
    expect((await validate("demo-a", "PICKUP", [{ product_id: A().productId, quantity: 1, modifier_ids: null }])).ok).toBe(true);
  });

  it("MODIFIER_GROUP_MIN / MODIFIER_GROUP_MAX (com group_id)", async () => {
    const none = await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [])]); // min 1
    only(none, "MODIFIER_GROUP_MIN", 0);
    expect(none.errors[0].group_id).toBe(F.g1.id);
    const over = await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id, F.m2.id, F.m6.id])]); // max 2
    only(over, "MODIFIER_GROUP_MAX", 0);
    expect(over.errors[0].group_id).toBe(F.g1.id);
    const ok1 = await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id])]);
    expect(ok1.ok).toBe(true);
    expect(ok1.total_cents).toBe(1100);
    const ok2 = await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, [F.m1.id, F.m2.id])]);
    expect(ok2.total_cents).toBe(1300);
    // mais de 50 ids de adicional na mesma linha => MAX (sem processar todos)
    const many = Array.from({ length: 51 }, () => crypto.randomUUID());
    expect(codes(await validate("demo-a", "PICKUP", [line(F.pGrp.id, 1, many)]))).toContain("MODIFIER_GROUP_MAX");
    // seed: grupo 0..3 — 4 escolhas passam do máximo; 3 passam
    const q = (await admin().from("modifiers").select("id").eq("group_id", A().modifierGroupId)).data!.map((r: any) => r.id);
    expect(q).toHaveLength(2);
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1, q)])).ok).toBe(true);
  });

  it("INVALID_QUANTITY: 0, 100, -1, 1.5, '2', null, ausente, objeto, 2.0, 1e2, 1e20", async () => {
    for (const q of [0, 100, -1, 1.5, "2", null, undefined, {}, [], true, 2.0, 1e2, 1e20, 0.5, -0.0001, "abc"]) {
      const item: Record<string, unknown> = { product_id: A().productId, modifier_ids: [] };
      if (q !== undefined) item.quantity = q;
      const c = await validate("demo-a", "PICKUP", [item]);
      // 2.0 serializa como 2 em JSON => válido; os demais devem falhar
      if (q === 2.0) expect(c.ok).toBe(true);
      else only(c, "INVALID_QUANTITY", 0);
    }
    // fronteiras válidas
    for (const q of [1, 2, 98, 99]) expect((await validate("demo-a", "PICKUP", [line(A().productId, q)])).ok, `q=${q}`).toBe(true);
  });

  it("BELOW_MINIMUM (settings)", async () => {
    try {
      await setSettings(A().id, { min_order_cents: 5000 });
      const c = await validate("demo-a", "PICKUP", [line(A().productId, 1)]);
      only(c, "BELOW_MINIMUM");
      expect(c.minimum_order_cents).toBe(5000);
      expect(c.subtotal_cents).toBe(2500);
      expect(c.errors[0].message).toContain("50,00");
      expect((await validate("demo-a", "PICKUP", [line(A().productId, 2)])).ok).toBe(true); // 5000 == mínimo
    } finally {
      await setSettings(A().id, { min_order_cents: 0 });
    }
  });

  it("BELOW_MINIMUM não é emitido quando há linhas inválidas (subtotal parcial enganaria o cliente)", async () => {
    try {
      await setSettings(A().id, { min_order_cents: 5000 });
      const c = await validate("demo-a", "PICKUP", [line(A().productId, 1), line(B().productId, 1)]);
      expect(codes(c)).toEqual(["PRODUCT_UNAVAILABLE"]);
    } finally {
      await setSettings(A().id, { min_order_cents: 0 });
    }
  });

  it("ZONE_REQUIRED (DELIVERY sem zona) e ZONE_UNAVAILABLE (zona de B, inativa, inexistente)", async () => {
    only(await validate("demo-a", "DELIVERY", [line(A().productId, 1)], null), "ZONE_REQUIRED");
    const inactive = (await admin().from("delivery_zones").select("id").eq("restaurant_id", A().id).eq("is_active", false).single()).data!.id;
    for (const zone of [B().deliveryZoneId, inactive, crypto.randomUUID()]) {
      const c = await validate("demo-a", "DELIVERY", [line(A().productId, 1)], zone);
      only(c, "ZONE_UNAVAILABLE");
      expect(c.delivery_fee_cents).toBe(0);
    }
    // zona de A em B
    only(await validate("demo-b", "DELIVERY", [line(B().productId, 1)], A().deliveryZoneId), "ZONE_UNAVAILABLE");
  });

  it("EMPTY_CART: [], null, objeto, texto, número, booleano", async () => {
    for (const items of [[], null, {}, "abc", 7, true, { 0: {} }]) {
      const c = await validate("demo-a", "PICKUP", items);
      only(c, "EMPTY_CART");
      expect(c).toMatchObject({ items: [], subtotal_cents: 0, total_cents: 0 });
    }
  });

  it("TOO_MANY_ITEMS: 51 linhas; 50 passam", async () => {
    const mk = (n: number) => Array.from({ length: n }, () => line(F.pPlain.id, 1));
    only(await validate("demo-a", "PICKUP", mk(51)), "TOO_MANY_ITEMS");
    const ok = await validate("demo-a", "PICKUP", mk(50));
    expect(ok.ok, JSON.stringify(ok.errors)).toBe(true);
    expect(ok.items).toHaveLength(50);
    // 500 linhas também só devolve o erro (não processa)
    const huge = await validate("demo-a", "PICKUP", mk(500));
    only(huge, "TOO_MANY_ITEMS");
    expect(huge.items).toEqual([]);
  });

  it("NOTES_TOO_LONG: 501 caracteres (emoji conta como 1); 500 passam; não-string é rejeitado; null aceito", async () => {
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: "x".repeat(501) })]), "NOTES_TOO_LONG", 0);
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: "x".repeat(500) })])).ok).toBe(true);
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: "😀".repeat(500) })])).ok).toBe(true);
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: "😀".repeat(501) })]), "NOTES_TOO_LONG", 0);
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: 123 })]), "NOTES_TOO_LONG", 0);
    only(await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: { a: 1 } })]), "NOTES_TOO_LONG", 0);
    expect((await validate("demo-a", "PICKUP", [line(A().productId, 1, [], { notes: null })])).ok).toBe(true);
  });

  it("erros múltiplos voltam juntos (restaurante fechado + entrega sem zona + linhas ruins), com item_index 0-based", async () => {
    try {
      await setOpenToday(A().id, false);
      const c = await validate("demo-a", "DELIVERY", [
        line("lixo", 1), // 0 PRODUCT_UNAVAILABLE
        line(A().productId, 0), // 1 INVALID_QUANTITY
        line(F.pGrp.id, 1, []), // 2 MODIFIER_GROUP_MIN
        line(A().productId, 1, [B().modifierId], { notes: "x".repeat(600) }), // 3 MODIFIER_NOT_ALLOWED + NOTES_TOO_LONG
        line(A().productId, 1), // 4 válida => entra em items
      ]);
      expect(c.ok).toBe(false);
      const got = c.errors.map((e) => `${e.code}${e.item_index !== undefined ? `@${e.item_index}` : ""}`).sort();
      expect(got).toEqual(
        ["MODIFIER_GROUP_MIN@2", "MODIFIER_NOT_ALLOWED@3", "INVALID_QUANTITY@1", "NOTES_TOO_LONG@3", "PRODUCT_UNAVAILABLE@0", "RESTAURANT_CLOSED", "ZONE_REQUIRED"].sort(),
      );
      // só a linha 4 foi precificada
      expect(c.items.map((i) => i.product_id)).toEqual([A().productId]);
      expect(c.subtotal_cents).toBe(2500);
    } finally {
      await setOpenToday(A().id, true);
    }
  });

  it("todo código emitido pertence ao conjunto documentado (contrato + TOO_MANY_ITEMS/NOTES_TOO_LONG)", async () => {
    const c = await validate("demo-a", "FOO", [line("lixo", 0, ["x"], { notes: 1 })]);
    for (const e of c.errors) expect(ERROR_CODES).toContain(e.code);
  });
});

describe("validate_cart — entradas maliciosas nunca geram erro 500", () => {
  const url = () => `${loadEnv().url}/rest/v1/rpc/validate_cart`;
  const post = async (bodyText: string) => {
    const env = loadEnv();
    const res = await fetch(url(), {
      method: "POST",
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}`, "Content-Type": "application/json" },
      body: bodyText,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* corpo não-JSON */
    }
    return { status: res.status, json, text };
  };
  const body = (items: string, extra: { slug?: string; f?: string; zone?: string } = {}) =>
    `{"p_slug":${JSON.stringify(extra.slug ?? "demo-a")},"p_fulfillment":${JSON.stringify(extra.f ?? "PICKUP")},"p_items":${items},"p_delivery_zone_id":${extra.zone ?? "null"}}`;

  const PID = () => A().productId;
  const MID = () => A().modifierId;
  const evil = "'; DROP TABLE public.orders; --";

  const payloads: [string, () => string][] = [
    ["items null", () => body("null")],
    ["items objeto", () => body('{"product_id":"x"}')],
    ["items string", () => body('"abc"')],
    ["items número", () => body("123")],
    ["items booleano", () => body("true")],
    ["[null]", () => body("[null]")],
    ["[[]]", () => body("[[]]")],
    ["[[[[]]]]", () => body("[[[[[[[[]]]]]]]]")],
    ["[{}]", () => body("[{}]")],
    ["tudo null", () => body('[{"product_id":null,"quantity":null,"modifier_ids":null,"notes":null}]')],
    ["product_id objeto (NoSQL-ish)", () => body('[{"product_id":{"$ne":null},"quantity":1}]')],
    ["product_id array", () => body(`[{"product_id":["${PID()}"],"quantity":1}]`)],
    ["product_id SQLi", () => body(`[{"product_id":${JSON.stringify(evil)},"quantity":1}]`)],
    ["product_id com aspas", () => body(`[{"product_id":"${PID()}' OR '1'='1","quantity":1}]`)],
    ["product_id uuid + sufixo", () => body(`[{"product_id":"${PID()}zz","quantity":1}]`)],
    ["product_id uuid com quebra de linha", () => body(`[{"product_id":"${PID()}\\n","quantity":1}]`)],
    ["product_id uuid maiúsculo (válido)", () => body(`[{"product_id":"${PID().toUpperCase()}","quantity":1}]`)],
    ["product_id gigante", () => body(`[{"product_id":"${"a".repeat(100000)}","quantity":1}]`)],
    ["quantity 1e999", () => body(`[{"product_id":"${PID()}","quantity":1e999}]`)],
    ["quantity -1e999", () => body(`[{"product_id":"${PID()}","quantity":-1e999}]`)],
    ["quantity 99999999999999999999", () => body(`[{"product_id":"${PID()}","quantity":99999999999999999999}]`)],
    ["quantity 0.1e1", () => body(`[{"product_id":"${PID()}","quantity":0.1e1}]`)],
    ["quantity string numérica", () => body(`[{"product_id":"${PID()}","quantity":"1"}]`)],
    ["modifier_ids SQLi", () => body(`[{"product_id":"${PID()}","quantity":1,"modifier_ids":[${JSON.stringify(evil)}]}]`)],
    ["modifier_ids aninhado", () => body(`[{"product_id":"${PID()}","quantity":1,"modifier_ids":[["${MID()}"]]}]`)],
    ["modifier_ids objetos", () => body(`[{"product_id":"${PID()}","quantity":1,"modifier_ids":[{"id":"${MID()}"}]}]`)],
    ["modifier_ids com 5000 ids", () => body(`[{"product_id":"${PID()}","quantity":1,"modifier_ids":[${Array.from({ length: 5000 }, () => `"${MID()}"`).join(",")}]}]`)],
    ["modifier_ids null no meio", () => body(`[{"product_id":"${PID()}","quantity":1,"modifier_ids":[null,"${MID()}"]}]`)],
    ["notes SQLi", () => body(`[{"product_id":"${PID()}","quantity":1,"notes":${JSON.stringify(evil)}}]`)],
    ["notes unicode (RTL, zero-width, emoji)", () => body(`[{"product_id":"${PID()}","quantity":1,"notes":"\\u202e\\u200b\\ud83d\\ude00 ação"}]`)],
    ["notes com surrogate solto", () => body(`[{"product_id":"${PID()}","quantity":1,"notes":"\\ud83d"}]`)],
    ["notes com \\u0000", () => body(`[{"product_id":"${PID()}","quantity":1,"notes":"a\\u0000b"}]`)],
    ["notes array", () => body(`[{"product_id":"${PID()}","quantity":1,"notes":["a"]}]`)],
    ["chaves proto/constructor", () => body(`[{"__proto__":{"price_cents":1},"constructor":{"x":1},"product_id":"${PID()}","quantity":1}]`)],
    ["chave duplicada (última vale)", () => body(`[{"product_id":"${PID()}","quantity":1,"quantity":0}]`)],
    ["aninhamento profundo (item)", () => body(`[{"product_id":"${PID()}","quantity":1,"x":${"[".repeat(1500)}${"]".repeat(1500)}}]`)],
    ["slug SQLi", () => body("[]", { slug: `${evil}` })],
    ["slug com \\u0000", () => body("[]", { slug: "demo\u0000a" })],
    ["slug gigante", () => body("[]", { slug: "z".repeat(200000) })],
    ["fulfillment SQLi", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: evil })],
    ["fulfillment unicode", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "ＰＩＣＫＵＰ" })],
    ["fulfillment com \\u0000", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "PICKUP\u0000" })],
    ["zona malformada", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "DELIVERY", zone: '"não-é-uuid"' })],
    ["zona objeto", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "DELIVERY", zone: "{}" })],
    ["zona número", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "DELIVERY", zone: "7" })],
    ["zona SQLi", () => body(`[{"product_id":"${PID()}","quantity":1}]`, { f: "DELIVERY", zone: JSON.stringify(evil) })],
  ];

  let before: Record<string, number>;
  const TABLES = ["orders", "order_items", "order_item_modifiers", "customers", "customer_addresses", "payments", "tabs", "audit_logs", "print_jobs"];
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (await admin().from(t).select("*", { count: "exact", head: true })).count ?? -1;
    return out;
  };
  beforeAll(async () => {
    before = await counts();
  });

  for (const [name, make] of payloads) {
    it(`não responde 5xx: ${name}`, async () => {
      const r = await post(make());
      expect(r.status, `HTTP ${r.status}: ${r.text.slice(0, 300)}`).toBeLessThan(500);
      if (r.status === 200) {
        // sempre estruturado: ok=false com erros nomeados, OU (payload do tipo "válido") ok=true com totais coerentes
        expect(typeof r.json?.ok).toBe("boolean");
        expect(Array.isArray(r.json.errors)).toBe(true);
        expect(Array.isArray(r.json.items)).toBe(true);
        for (const e of r.json.errors) expect(ERROR_CODES).toContain(e.code);
        expect(r.json.total_cents).toBe(r.json.subtotal_cents + r.json.delivery_fee_cents - r.json.discount_cents);
        if (!r.json.ok) expect(r.json.errors.length).toBeGreaterThan(0);
        // preço nunca vem do payload
        for (const i of r.json.items) expect([2500, 3000]).toContain(i.line_total_cents / i.quantity);
      } else {
        // rejeição na borda (4xx): erro de tipo/JSON, nunca detalhe interno
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.text).not.toMatch(/stack|trace|at\s+\S+\s+\(|pg_catalog|app_private/i);
      }
    });
  }

  it("payloads 'válidos' do grupo acima não gravam nada (orders, itens, clientes, pagamentos, comandas, auditoria)", async () => {
    expect(await counts()).toEqual(before);
  });

  it("p_items 'forjado' com price_cents ainda é recalculado (via REST cru)", async () => {
    const r = await post(body(`[{"product_id":"${PID()}","quantity":1,"price_cents":1,"unit_price_cents":1,"total_cents":1}]`));
    expect(r.status).toBe(200);
    expect(r.json.items[0].unit_price_cents).toBe(2500);
    expect(r.json.total_cents).toBe(2500);
  });

  it("chamada sem corpo / corpo inválido / parâmetro faltando => 4xx (nunca 5xx)", async () => {
    for (const text of ["", "{", "null", "[]", "{}", '{"p_slug":"demo-a"}', '{"p_slug":"demo-a","p_fulfillment":"PICKUP"}', '{"p_items":[]}']) {
      const r = await post(text);
      expect(r.status, `${JSON.stringify(text)} -> ${r.status} ${r.text.slice(0, 200)}`).toBeLessThan(500);
    }
  });

  it("sem apikey (vira anon) responde como anon; JWT forjado => 401 (nunca 5xx)", async () => {
    const noKey = await fetch(url(), { method: "POST", headers: { "Content-Type": "application/json" }, body: body("[]") });
    expect(noKey.status).toBeLessThan(500);
    const forged = await rawRest("/rest/v1/rpc/validate_cart", { method: "POST", token: "eyJhbGciOiJIUzI1NiJ9.e30.forjado", body: { p_slug: "demo-a", p_fulfillment: "PICKUP", p_items: [] } });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(forged.status).toBeLessThan(500);
  });

  // F-16: o parser de jsonb do Postgres estoura a pilha com ~100 mil níveis de aninhamento ([[[[...]]]]) e o PostgREST
  // devolve 500 (54001 max_stack_depth). Vale para QUALQUER RPC/insert com jsonb (não é falha da lógica de validate_cart) e
  // não derruba nada (o Postgres aborta só a requisição); mitigação: limite de tamanho de corpo no gateway/CDN.
  it.fails("[F-16] aninhamento extremo (100 mil níveis) deveria ser 4xx, mas o Postgres/PostgREST responde 500 (54001)", async () => {
    const deep = `[{"x":${"[".repeat(100000)}${"]".repeat(100000)}}]`;
    const r = await post(body(deep));
    expect(r.status).toBeLessThan(500);
  });

  // F-21 (corrigido na mig. 0113): antes, 50 linhas × 50 ids de adicional aleatórios => 2.500 consultas e 2.500 erros na resposta
  // (~0,9 s e centenas de KB por chamada). Agora: teto TOTAL de 200 ids de adicionais (TOO_MANY_MODIFIERS, nenhuma linha processada)
  // e no máximo 50 erros + TOO_MANY_ERRORS.
  it("[F-21] pior caso 50×50 ids de adicional: resposta curta com TOO_MANY_MODIFIERS e nenhuma linha processada", async () => {
    const worst = Array.from({ length: 50 }, () => ({ product_id: PID(), quantity: 1, modifier_ids: Array.from({ length: 50 }, () => crypto.randomUUID()) }));
    const t0 = Date.now();
    const r = await post(body(JSON.stringify(worst)));
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors.map((e: any) => e.code)).toEqual(["TOO_MANY_MODIFIERS"]);
    expect(r.json.items).toEqual([]);
    expect(r.json.errors.length).toBeLessThanOrEqual(100);
    expect(elapsed, "pior caso deveria ser barato agora").toBeLessThan(5000);
  });

  it("[F-21] exatamente 200 ids de adicional no carrinho é aceito pelo teto (201 => TOO_MANY_MODIFIERS)", async () => {
    const mk = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    const at = [{ product_id: PID(), quantity: 1, modifier_ids: mk(50) }, { product_id: PID(), quantity: 1, modifier_ids: mk(50) }, { product_id: PID(), quantity: 1, modifier_ids: mk(50) }, { product_id: PID(), quantity: 1, modifier_ids: mk(50) }];
    const r200 = await post(body(JSON.stringify(at)));
    expect(r200.json.errors.map((e: any) => e.code)).not.toContain("TOO_MANY_MODIFIERS");
    const over = [...at, { product_id: PID(), quantity: 1, modifier_ids: mk(1) }];
    const r201 = await post(body(JSON.stringify(over)));
    expect(r201.json.errors.map((e: any) => e.code)).toEqual(["TOO_MANY_MODIFIERS"]);
  });

  it("[F-21] erros acumulados são cortados em 50 + TOO_MANY_ERRORS (último), com item_index dos primeiros", async () => {
    // 50 linhas, cada uma com 2 erros (quantidade inválida + produto inexistente) => 100 erros brutos
    const many = Array.from({ length: 50 }, () => ({ product_id: crypto.randomUUID(), quantity: 0, modifier_ids: [] }));
    const r = await post(body(JSON.stringify(many)));
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    const errs = r.json.errors as any[];
    expect(errs.length).toBeLessThanOrEqual(51);
    expect(errs.at(-1).code).toBe("TOO_MANY_ERRORS");
    expect(errs.slice(0, -1).every((e) => e.code !== "TOO_MANY_ERRORS")).toBe(true);
    expect(errs.slice(0, -1)).toHaveLength(50);
  });

  it("depois de toda a bateria: contagens de tabelas idênticas (validate_cart não grava nada)", async () => {
    expect(await counts()).toEqual(before);
  });
});

describe("validate_cart — não grava nada (contagem antes/depois)", () => {
  const cleanup = new Cleanup();
  let F: MenuFixture;
  beforeAll(async () => {
    F = await makeMenuFixture(cleanup, A().id);
  });
  afterAll(async () => cleanup.run());

  it("chamadas válidas, inválidas e concorrentes não alteram orders/customers/itens/auditoria/contadores", async () => {
    const TABLES = ["orders", "order_items", "order_item_modifiers", "order_counters", "order_status_history", "customers", "customer_addresses", "payments", "tabs", "audit_logs", "print_jobs"];
    const snap = async () => {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = (await admin().from(t).select("*", { count: "exact", head: true })).count ?? -1;
      return out;
    };
    const before = await snap();
    const calls: Promise<Cart>[] = [];
    for (let i = 0; i < 12; i++) {
      calls.push(validate("demo-a", "PICKUP", [line(A().productId, 1 + (i % 3), [A().modifierId], { notes: `n${i}` })]));
      calls.push(validate("demo-a", "DELIVERY", [line(F.pGrp.id, 1)], A().deliveryZoneId)); // erro
      calls.push(validate("demo-a", "DELIVERY", [line(A().productId, 1)], A().deliveryZoneId, as("waiterA")));
      calls.push(validate("nao-existe", "PICKUP", []));
    }
    await Promise.all(calls);
    expect(await snap()).toEqual(before);
  });

  it("clientes: nome/telefone não existem no contrato de entrada e nada é criado em customers", async () => {
    const c0 = (await admin().from("customers").select("*", { count: "exact", head: true }).eq("restaurant_id", A().id)).count;
    await validate("demo-a", "PICKUP", [{ ...line(A().productId, 1), customer: { name: "zz-hacker", phone: "11900000000" } }]);
    const c1 = (await admin().from("customers").select("*", { count: "exact", head: true }).eq("restaurant_id", A().id)).count;
    expect(c1).toBe(c0);
  });
});

// =====================================================================================================
// reorder_menu
// =====================================================================================================
type Kind = "category" | "product" | "modifier_group" | "modifier";
const TABLE_OF: Record<Kind, string> = { category: "menu_categories", product: "products", modifier_group: "modifier_groups", modifier: "modifiers" };
const KINDS = Object.keys(TABLE_OF) as Kind[];

describe("reorder_menu", () => {
  const cleanup = new Cleanup();
  const ids = {} as Record<Kind, string[]>; // 3 entidades efêmeras de A por espécie
  let bId: Record<Kind, string>; // 1 entidade do seed de B por espécie
  let seededOrder: Record<Kind, Record<string, number>>; // sort_order do seed de A (não pode mudar)

  const reorder = (who: Parameters<typeof as>[0], rid: string | null, kind: string | null, list: string[] | null) =>
    as(who).rpc("reorder_menu", { p_restaurant: rid, p_kind: kind, p_ids: list });
  const sortOf = async (kind: Kind, list: string[]) => {
    const res = await admin().from(TABLE_OF[kind]).select("id,sort_order").in("id", list);
    const m = new Map(rows(res).map((r) => [r.id as string, r.sort_order as number]));
    return list.map((id) => m.get(id));
  };
  const orderedByDb = async (kind: Kind, list: string[]) => {
    const res = await admin().from(TABLE_OF[kind]).select("id,sort_order").in("id", list).order("sort_order", { ascending: true });
    return rows(res).map((r) => r.id as string);
  };
  const auditCount = async () =>
    (await admin().from("audit_logs").select("*", { count: "exact", head: true }).eq("restaurant_id", A().id).eq("action", "menu.reordered")).count ?? 0;
  const snapshotSeed = async () => {
    const out = {} as Record<Kind, Record<string, number>>;
    for (const k of KINDS) {
      const res = await admin().from(TABLE_OF[k]).select("id,sort_order").eq("restaurant_id", A().id).not("name", "like", "zz-%");
      out[k] = Object.fromEntries(rows(res).map((r) => [r.id, r.sort_order]));
    }
    return out;
  };

  beforeAll(async () => {
    const a = admin();
    const t = Math.random().toString(36).slice(2, 6);
    const mk = async (table: string, extra: Record<string, unknown>, n: number) => {
      const out: string[] = [];
      for (let i = 1; i <= n; i++) out.push((await insertRow(table, { restaurant_id: A().id, name: `zz-ro-${t}-${i}`, sort_order: 100 + i, ...extra })).id);
      return out;
    };
    ids.category = await mk("menu_categories", {}, 3);
    ids.product = await mk("products", { price_cents: 100 }, 3);
    ids.modifier_group = await mk("modifier_groups", {}, 3);
    const gm = await insertRow("modifier_groups", { restaurant_id: A().id, name: `zz-ro-${t}-gm`, sort_order: 200 });
    ids.modifier = await mk("modifiers", { group_id: gm.id }, 3);
    cleanup.add(async () => {
      await a.from("menu_categories").delete().eq("restaurant_id", A().id).like("name", "zz-%");
      await a.from("products").delete().eq("restaurant_id", A().id).like("name", "zz-%");
      await a.from("modifier_groups").delete().eq("restaurant_id", A().id).like("name", "zz-%");
    });
    bId = {
      category: B().categoryId,
      product: B().productId,
      modifier_group: B().modifierGroupId,
      modifier: B().modifierId,
    };
    seededOrder = await snapshotSeed();
  });
  afterAll(async () => {
    await cleanup.run();
    await setStatus(A().id, "active");
  });

  it("owner e manager de A reordenam as 4 espécies: sort_order = posição (base 0), retorno {ok, kind, count}", async () => {
    for (const who of ["ownerA", "managerA"] as const) {
      for (const kind of KINDS) {
        const [x, y, z] = ids[kind];
        const order = who === "ownerA" ? [z, x, y] : [y, z, x];
        const res = await reorder(who, A().id, kind, order);
        expect(res.error, `${who}/${kind}: ${res.error?.message}`).toBeNull();
        expect(res.data).toEqual({ ok: true, kind, count: 3 });
        expect(await sortOf(kind, order)).toEqual([0, 1, 2]);
        expect(await orderedByDb(kind, ids[kind])).toEqual(order);
      }
    }
  });

  it("o seed (itens que não vieram na lista) não é tocado pela lista parcial", async () => {
    expect(await snapshotSeed()).toEqual(seededOrder);
  });

  it("lista de 1 item é válida (vira sort_order 0) e idempotente: repetir não muda nada", async () => {
    const one = await reorder("ownerA", A().id, "product", [ids.product[1]]);
    expect(one.data).toEqual({ ok: true, kind: "product", count: 1 });
    expect((await sortOf("product", [ids.product[1]]))[0]).toBe(0);
    const o = [ids.category[0], ids.category[1], ids.category[2]];
    expect((await reorder("ownerA", A().id, "category", o)).error).toBeNull();
    expect((await reorder("ownerA", A().id, "category", o)).error).toBeNull();
    expect(await sortOf("category", o)).toEqual([0, 1, 2]);
  });

  it("reordenação se reflete no cardápio público (categorias, produtos)", async () => {
    // ativa uma categoria efêmera e confere a ordem pública
    const [c1, c2, c3] = ids.category;
    await admin().from("products").update({ category_id: c1 }).eq("id", ids.product[0]);
    expect((await reorder("ownerA", A().id, "category", [c3, c2, c1])).error).toBeNull();
    const names = (await menu("demo-a")).categories.map((c: any) => c.id);
    expect(names.indexOf(c3)).toBeLessThan(names.indexOf(c2));
    expect(names.indexOf(c2)).toBeLessThan(names.indexOf(c1));
    await admin().from("products").update({ category_id: null }).eq("id", ids.product[0]);
  });

  it("sem permissão (garçom/caixa/cozinha de A, dono/gerente de B, sem vínculo, suporte/superadmin sem sessão) => forbidden e nada muda", async () => {
    const audits = await auditCount();
    for (const who of ["waiterA", "waiter2A", "cashierA", "kitchenA", "ownerB", "managerB", "cashierB", "plain", "support", "superadmin"] as const) {
      for (const kind of KINDS) {
        const list = [...ids[kind]].reverse();
        const res = await reorder(who, A().id, kind, list);
        expectDenied(res, /forbidden|42501/);
        expect(res.data).toBeNull();
      }
    }
    expect(await auditCount()).toBe(audits);
    expect(await snapshotSeed()).toEqual(seededOrder);
  });

  it("anon não executa a RPC (permission denied no EXECUTE)", async () => {
    const res = await anon().rpc("reorder_menu", { p_restaurant: A().id, p_kind: "category", p_ids: ids.category });
    expectDenied(res, /permission denied|42501/);
  });

  it("dono de A não reordena o cardápio de B (nem com ids de B, nem com ids de A apontando para B)", async () => {
    for (const who of ["ownerA", "managerA"] as const) {
      for (const kind of KINDS) {
        expectDenied(await reorder(who, B().id, kind, [bId[kind]]), /forbidden|42501/);
        expectDenied(await reorder(who, B().id, kind, ids[kind]), /forbidden|42501/);
      }
    }
  });

  it("dono de B com restaurante B mas ids de A => invalid_ids (id de outro tenant nunca é aceito)", async () => {
    for (const kind of KINDS) {
      expectRule(await reorder("ownerB", B().id, kind, [bId[kind], ids[kind][0]]), /invalid_ids/);
      expectRule(await reorder("ownerB", B().id, kind, ids[kind]), /invalid_ids/);
    }
    // e o contrário: dono de A com um id de B misturado
    for (const kind of KINDS) expectRule(await reorder("ownerA", A().id, kind, [ids[kind][0], bId[kind]]), /invalid_ids/);
    expect(await sortOf("product", ids.product)).not.toContain(undefined);
  });

  it("invalid_ids: vazia, nula, duplicada, id inexistente, espécie trocada, > 1000", async () => {
    const [x, y] = ids.category;
    const cases: [string, string[] | null][] = [
      ["vazia", []],
      ["nula", null],
      ["duplicada", [x, y, x]],
      ["inexistente", [x, crypto.randomUUID()]],
      ["só inexistentes", [crypto.randomUUID()]],
      ["espécie trocada (ids de produto como categoria)", ids.product],
      ["maior que 1000", Array.from({ length: 1001 }, () => crypto.randomUUID())],
    ];
    for (const [name, list] of cases) {
      const res = await reorder("ownerA", A().id, "category", list);
      expectRule(res, /invalid_ids/);
      expect(res.error?.code, name).toBe("22023");
    }
    // grupo de adicionais x adicional trocados
    expectRule(await reorder("ownerA", A().id, "modifier", ids.modifier_group), /invalid_ids/);
    expectRule(await reorder("ownerA", A().id, "modifier_group", ids.modifier), /invalid_ids/);
    // nada mudou
    expect(await snapshotSeed()).toEqual(seededOrder);
  });

  it("invalid_kind: espécie desconhecida, vazia, nula, com plural/maiúscula/SQLi (e antes da checagem de permissão)", async () => {
    for (const kind of ["foo", "", "categories", "Category", "PRODUCT", "category; drop table products", "menu_categories", "products", "modifiers", "pg_catalog.pg_class", null]) {
      const res = await reorder("ownerA", A().id, kind, ids.category);
      expectRule(res, /invalid_kind/);
      expect(res.error?.code).toBe("22023");
    }
    // espécie inválida vence a falta de permissão (não revela nada sobre permissão)
    expectRule(await reorder("waiterA", A().id, "foo", ids.category), /invalid_kind/);
  });

  it("restaurante nulo ou inexistente => forbidden (não vaza a existência de restaurantes)", async () => {
    expectDenied(await reorder("ownerA", null, "category", ids.category), /forbidden|42501/);
    expectDenied(await reorder("ownerA", crypto.randomUUID(), "category", ids.category), /forbidden|42501/);
  });

  it("restaurante suspenso: nem o dono reordena; ao reativar volta a funcionar", async () => {
    try {
      await setStatus(A().id, "suspended");
      expectDenied(await reorder("ownerA", A().id, "category", ids.category), /forbidden|42501/);
    } finally {
      await setStatus(A().id, "active");
    }
    expect((await reorder("ownerA", A().id, "category", ids.category)).error).toBeNull();
  });

  it("grava audit_logs 'menu.reordered' (ator, restaurante, espécie, contagem e ids); tentativa negada não grava", async () => {
    const list = [ids.product[2], ids.product[0], ids.product[1]];
    const n0 = await auditCount();
    const res = await reorder("managerA", A().id, "product", list);
    expect(res.error).toBeNull();
    expect(await auditCount()).toBe(n0 + 1);
    const last = rows(
      await admin().from("audit_logs").select("*").eq("restaurant_id", A().id).eq("action", "menu.reordered").order("created_at", { ascending: false }).limit(1),
    )[0];
    expect(last.actor_id).toBe(userId("managerA"));
    expect(last.resource_type).toBe("product");
    expect(last.metadata).toMatchObject({ kind: "product", count: 3, ids: list });
    // falha não audita
    await reorder("waiterA", A().id, "product", list);
    await reorder("managerA", A().id, "product", [list[0], list[0]]);
    expect(await auditCount()).toBe(n0 + 1);
  });

  it("concorrência: reorders simultâneos da mesma espécie não dão deadlock e o resultado é uma das listas inteiras (nunca mistura)", async () => {
    for (const kind of KINDS) {
      const fwd = [...ids[kind]];
      const rev = [...ids[kind]].reverse();
      for (let round = 0; round < 3; round++) {
        const calls = Array.from({ length: 8 }, (_, i) => reorder(i % 2 ? "managerA" : "ownerA", A().id, kind, i % 3 === 0 ? rev : fwd));
        const results = await Promise.all(calls);
        for (const r of results) expect(r.error, `${kind} rodada ${round}: ${r.error?.code} ${r.error?.message}`).toBeNull();
        const final = await orderedByDb(kind, ids[kind]);
        expect([fwd.join(), rev.join()], `${kind}: ordem final misturada`).toContain(final.join());
        expect(await sortOf(kind, final)).toEqual([0, 1, 2]);
      }
    }
  });

  it("concorrência cruzada: 4 espécies de dois usuários ao mesmo tempo, sem erro", async () => {
    const calls: ReturnType<typeof reorder>[] = [];
    for (let i = 0; i < 4; i++) for (const kind of KINDS) calls.push(reorder(i % 2 ? "managerA" : "ownerA", A().id, kind, i % 2 ? [...ids[kind]].reverse() : ids[kind]));
    for (const r of await Promise.all(calls)) expect(r.error, `${r.error?.code} ${r.error?.message}`).toBeNull();
  });

  it("concorrência com escrita normal (update de produto) não bloqueia nem falha", async () => {
    const calls: PromiseLike<{ error: unknown }>[] = [];
    for (let i = 0; i < 6; i++) {
      calls.push(reorder("ownerA", A().id, "product", i % 2 ? ids.product : [...ids.product].reverse()));
      calls.push(as("managerA").from("products").update({ description: `zz-d${i}` }).eq("id", ids.product[i % 3]).select("id"));
    }
    for (const r of await Promise.all(calls)) expect((r as any).error).toBeNull();
  });

  it("ao final o seed está intacto (ordem original preservada) — as efêmeras são removidas no afterAll", async () => {
    expect(await snapshotSeed()).toEqual(seededOrder);
  });
});


// =====================================================================================================
// Contrato RPC real x parsers do app (src/modules/storefront): o que o servidor devolve é o que a vitrine entende
// =====================================================================================================
describe("contrato: respostas REAIS das RPCs são aceitas pelos parsers da vitrine", () => {
  it("public_menu -> parsePublicMenu preserva restaurante, categorias, produtos, grupos, adicionais e zonas", async () => {
    const { parsePublicMenu } = await import("../../src/modules/storefront/schemas");
    const raw = await menu("demo-a");
    const parsed = parsePublicMenu(raw)!;
    expect(parsed).not.toBeNull();
    expect(parsed.restaurant.slug).toBe("demo-a");
    expect(parsed.isOpenNow).toBe(true);
    expect(parsed.categories.map((c) => c.name)).toEqual(raw.categories.map((c: any) => c.name));
    expect(parsed.categories.flatMap((c) => c.products).map((p) => p.id)).toEqual(raw.categories.flatMap((c: any) => c.products).map((p: any) => p.id));
    const burger = parsed.categories.flatMap((c) => c.products).find((p) => p.id === A().productId)!;
    expect(burger.priceCents).toBe(2500);
    expect(burger.modifierGroups[0].modifiers.map((m) => m.priceDeltaCents)).toEqual([500, 400]);
    expect(parsed.settings.fulfillmentTypes.sort()).toEqual(["DELIVERY", "DINE_IN", "PICKUP"]);
    expect(parsed.settings.deliveryZones).toEqual([{ id: A().deliveryZoneId, name: "DEMO Centro", feeCents: 500, minOrderCents: 1500, estimatedMinutes: 40 }]);
  });

  it("validate_cart (válido e com erros) -> parseCartValidation; a action monta p_items como o servidor espera", async () => {
    const { parseCartValidation } = await import("../../src/modules/storefront/schemas");
    const { cartErrorMessage, GENERIC_CART_ERROR } = await import("../../src/modules/storefront/messages");
    const { cartQuoteInputSchema } = await import("../../src/modules/storefront/checkout-schema");
    const { toCheckoutItems } = await import("../../src/modules/storefront/cart");

    const lines = [
      { id: "l1", productId: A().productId, variantId: null, quantity: 2, modifierIds: [A().modifierId], notes: " sem cebola ", snapshot: { name: "x", variantName: null, unitPriceCents: 1, imagePath: null, modifiers: [] } },
    ];
    const quoteInput = cartQuoteInputSchema.parse({ slug: "demo-a", fulfillment: "DELIVERY", zoneId: A().deliveryZoneId, items: toCheckoutItems(lines) });
    const items = quoteInput.items.map((i) => ({ product_id: i.productId, ...(i.variantId ? { variant_id: i.variantId } : {}), quantity: i.quantity, modifier_ids: i.modifierIds, ...(i.notes ? { notes: i.notes } : {}) }));
    const ok = parseCartValidation(await validate("demo-a", "DELIVERY", items, A().deliveryZoneId))!;
    expect(ok.ok).toBe(true);
    expect(ok).toMatchObject({ subtotalCents: 6000, deliveryFeeCents: 500, totalCents: 6500, minimumOrderCents: 1500 });
    expect(ok.items[0]).toMatchObject({ productId: A().productId, quantity: 2, unitPriceCents: 2500, lineTotalCents: 6000 });

    const bad = parseCartValidation(await validate("demo-a", "DELIVERY", [line(B().productId, 1)], null))!;
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.code).sort()).toEqual(["PRODUCT_UNAVAILABLE", "ZONE_REQUIRED"]);
    expect(bad.errors.find((e) => e.code === "PRODUCT_UNAVAILABLE")!.itemIndex).toBe(0);
    for (const e of bad.errors) expect(cartErrorMessage(e.code)).not.toBe(GENERIC_CART_ERROR);
  });

  it("[F-23] todo código de erro que o banco pode emitir (13 do contrato + 2 da 0112 + 5 da 0113) tem mensagem no app", async () => {
    const { CART_ERROR_MESSAGES } = await import("../../src/modules/storefront/messages");
    const mapped = Object.keys(CART_ERROR_MESSAGES).sort();
    const all = [...ERROR_CODES, "VARIANT_REQUIRED", "VARIANT_NOT_ALLOWED", "VARIANT_UNAVAILABLE", "TOO_MANY_MODIFIERS", "TOO_MANY_ERRORS"];
    expect(mapped).toEqual(all.sort());
  });

  it("limites do cliente (50 linhas, 99 unidades) são os limites do servidor: um carrinho no teto do app é aceito", async () => {
    const { MAX_LINES, MAX_QUANTITY } = await import("../../src/modules/storefront/cart");
    const c = await validate("demo-a", "PICKUP", Array.from({ length: MAX_LINES }, () => line(A().productId, MAX_QUANTITY)));
    expect(c.ok, JSON.stringify(c.errors)).toBe(true);
    expect(codes(await validate("demo-a", "PICKUP", Array.from({ length: MAX_LINES + 1 }, () => line(A().productId, 1))))).toEqual(["TOO_MANY_ITEMS"]);
    expect(codes(await validate("demo-a", "PICKUP", [line(A().productId, MAX_QUANTITY + 1)]))).toEqual(["INVALID_QUANTITY"]);
  });
});
