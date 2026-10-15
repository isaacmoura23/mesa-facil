/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 3 (migs. 0114-0116): create_public_order, track_order, transition_order_status, request_print, mark_print_job.
 *
 *  - create_public_order só existe para service_role (cliente `admin()`); anon/authenticated reais NÃO a executam.
 *  - As validações de negócio rodam num restaurante EFÊMERO (`zz-ord-*`, aberto "hoje" por exceção de horário), que pode
 *    ser fechado/pausado/reconfigurado sem tocar nos DEMO. Os testes de papéis (transição, impressão, Realtime) precisam da
 *    equipe real e usam o DEMO A (abre "hoje" por exceção `zz-` e remove ao final).
 *  - Todos os pedidos criados têm idempotency_key `zz-t20-*` e são apagados (com clientes `zz-*`) no `afterAll`.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, admin, as, realtimeAs, world } from "../helpers/clients";
import { expectDenied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, uniq, waitFor } from "../helpers/factory";
import { BASE_FULFILLMENT, clearTodayException, insertRow, makeMenuFixture, setOpenToday, setSettings, setStatus, walkKeys, type MenuFixture } from "../helpers/menu";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();

let Z: { id: string; slug: string };
let fxZ: MenuFixture;
let fxA: MenuFixture;
let pPizza: any, vP: any, vG: any, zoneZ: any;
let seq = 0;

const key = () => `zz-t20-${uniq()}-${++seq}`;
const phone = () => `119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function args(over: Record<string, unknown> = {}, slug = Z.slug, product: any = fxZ.pPlain) {
  return {
    p_slug: slug,
    p_fulfillment: "PICKUP",
    p_items: [{ product_id: product.id, quantity: 1, modifier_ids: [] }],
    p_customer: { name: "zz-Maria Souza", phone: phone(), email: null },
    p_address: null,
    p_delivery_zone_id: null,
    p_notes: null,
    p_idempotency_key: key(),
    p_payment: { method: "PIX" },
    ...over,
  };
}
const create = (over: Record<string, unknown> = {}, slug = Z.slug, product: any = fxZ.pPlain) => admin().rpc("create_public_order", args(over, slug, product));
const codes = (r: { data: any }) => ((r.data?.errors ?? []) as any[]).map((e) => e.code);
const addr = (over: Record<string, unknown> = {}) => ({ street: "Rua Zz Secreta", number: "77", neighborhood: "Centro", city: "Sao Paulo", ...over });

async function ordersCount(rid: string) {
  const r = await admin().from("orders").select("id", { count: "exact", head: true }).eq("restaurant_id", rid);
  return r.count ?? 0;
}
async function orderByKey(k: string) {
  const r = await admin().from("orders").select("*").eq("idempotency_key", k).single();
  if (r.error) throw new Error(`orderByKey: ${r.error.message}`);
  return r.data as any;
}
/** Cria um pedido válido no DEMO A (PICKUP/DELIVERY/DINE_IN) e devolve linha do banco + recibo. */
async function newOrderA(fulfillment: "PICKUP" | "DELIVERY" | "DINE_IN" = "PICKUP", over: Record<string, unknown> = {}) {
  const k = key();
  const extra: Record<string, unknown> = {};
  if (fulfillment === "DELIVERY") {
    extra.p_address = addr();
    extra.p_delivery_zone_id = zoneA.id;
  }
  const r = await create({ p_fulfillment: fulfillment, p_idempotency_key: k, p_customer: { name: "zz-Joao Pedro Silva", phone: phone(), email: "zz.joao@example.test" }, ...extra, ...over }, A().slug, fxA.pPlain);
  expect(r.error, JSON.stringify(r.error)).toBeNull();
  expect(r.data.ok, JSON.stringify(r.data)).toBe(true);
  return { row: await orderByKey(k), receipt: r.data as any, key: k };
}
let zoneA: any;
const cashierTo = (id: string, to: string, reason?: string) => as("cashierA").rpc("transition_order_status", { p_order: id, p_to: to, p_reason: reason ?? null });

beforeAll(async () => {
  // ---- restaurante efêmero ----
  const slug = `zz-ord-${uniq()}`.slice(0, 40);
  const r = await admin().from("restaurants").insert({ name: `zz DEMO ORD ${slug}`, slug, status: "active" }).select("id,slug").single();
  if (r.error) throw new Error(`restaurants: ${r.error.message}`);
  Z = r.data as any;
  cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", Z.id)));
  await admin().from("restaurant_settings").upsert({ restaurant_id: Z.id, accepts_orders: true, min_order_cents: 0, enabled_fulfillment_types: BASE_FULFILLMENT }, { onConflict: "restaurant_id" });
  await setOpenToday(Z.id, true);
  fxZ = await makeMenuFixture(cleanup, Z.id);
  pPizza = await insertRow("products", { restaurant_id: Z.id, category_id: fxZ.category.id, name: `zz-pizza-${uniq()}`, price_cents: 900, sort_order: 9 });
  vP = await insertRow("product_variants", { restaurant_id: Z.id, product_id: pPizza.id, name: "P", price_cents: 1000, is_default: true, sort_order: 1 });
  vG = await insertRow("product_variants", { restaurant_id: Z.id, product_id: pPizza.id, name: "G", price_cents: 2000, sort_order: 2 });
  await admin().from("product_modifier_groups").insert({ restaurant_id: Z.id, product_id: pPizza.id, group_id: fxZ.g1.id });
  zoneZ = await insertRow("delivery_zones", { restaurant_id: Z.id, name: "zz-zona", fee_cents: 500, min_order_cents: 0, estimated_minutes: 30, neighborhoods: ["Centro"], is_active: true });

  // ---- DEMO A (equipe real) ----
  await setOpenToday(A().id, true);
  cleanup.add(async () => clearTodayException(A().id));
  fxA = await makeMenuFixture(cleanup, A().id);
  zoneA = await insertRow("delivery_zones", { restaurant_id: A().id, name: `zz-zona-${uniq()}`, fee_cents: 500, min_order_cents: 0, estimated_minutes: 30, neighborhoods: ["Centro"], is_active: true });
  cleanup.add(async () => void (await admin().from("delivery_zones").delete().eq("id", zoneA.id)));

  // Registrada por ÚLTIMO => executada por PRIMEIRO: apaga pedidos/impressões/clientes antes de produtos/zonas/restaurante.
  cleanup.add(async () => {
    const orders = await admin().from("orders").select("id").like("idempotency_key", "zz-t20-%");
    const ids = rows(orders).map((o) => o.id as string);
    if (ids.length) {
      await admin().from("print_jobs").delete().in("order_id", ids);
      await admin().from("payments").delete().in("order_id", ids);
      await admin().from("orders").delete().in("id", ids);
    }
    await admin().from("orders").delete().in("restaurant_id", [Z.id]);
    await admin().from("customers").delete().in("restaurant_id", [A().id, Z.id]).like("name", "zz-%");
  });
}, 120_000);

afterAll(async () => {
  await cleanup.run();
});

// =====================================================================================================================
describe("create_public_order: permissão de execução", () => {
  it("anon e authenticated (dono, caixa, plain) NÃO executam create_public_order; nada é gravado", async () => {
    const before = await ordersCount(Z.id);
    const a = args();
    for (const client of [anon(), as("ownerA"), as("cashierA"), as("plain"), as("superadmin")]) {
      expectDenied(await client.rpc("create_public_order", a), /42501|permission denied/i);
    }
    expect(await ordersCount(Z.id)).toBe(before);
    expect(rows(await admin().from("orders").select("id").eq("idempotency_key", a.p_idempotency_key))).toHaveLength(0);
  });
});

describe("create_public_order: criação válida (service role)", () => {
  it("PICKUP: status RECEIVED, UNPAID, public_code de 16 chars, totais = price_cart, sem ids internos no recibo", async () => {
    const items = [{ product_id: fxZ.pGrp.id, quantity: 2, modifier_ids: [fxZ.m1.id], notes: "zz sem cebola" }];
    const quote = await anon().rpc("validate_cart", { p_slug: Z.slug, p_fulfillment: "PICKUP", p_items: items });
    expect(quote.data.ok, JSON.stringify(quote.data)).toBe(true);

    const k = key();
    const r = await create({ p_items: items, p_idempotency_key: k, p_payment: { method: "CASH" }, p_notes: "zz observação\ncom quebra" });
    expectOk(r);
    const d = r.data;
    expect(d).toMatchObject({
      ok: true,
      idempotent_replay: false,
      status: "RECEIVED",
      fulfillment_type: "PICKUP",
      payment_status: "UNPAID",
      payment_method: "CASH",
      change_for_cents: null,
      subtotal_cents: quote.data.subtotal_cents,
      delivery_fee_cents: quote.data.delivery_fee_cents,
      discount_cents: quote.data.discount_cents,
      total_cents: quote.data.total_cents,
    });
    expect(d.total_cents).toBe(2200); // 2 x (R$ 10,00 + R$ 1,00)
    expect(d.public_code).toMatch(/^[0-9A-Z]{16}$/);
    expect(d.order_number).toBeGreaterThan(0);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ quantity: 2, unit_price_cents: 1000, modifiers_cents: 100, line_total_cents: 2200, notes: "zz sem cebola" });
    expect(d.items[0].modifiers).toEqual([{ name: fxZ.m1.name, group_name: fxZ.g1.name, price_delta_cents: 100, quantity: 1 }]);
    // sem ids internos nem PII
    const text = JSON.stringify(d);
    expect(text).not.toMatch(UUID_RE);
    for (const k2 of ["id", "customer_id", "restaurant_id", "customer_phone", "customer_email", "customer_name", "delivery_address"]) expect(walkKeys(d).has(k2), k2).toBe(false);

    const row = await orderByKey(k);
    expect(row).toMatchObject({
      restaurant_id: Z.id,
      source: "PUBLIC_WEB",
      status: "RECEIVED",
      payment_status: "UNPAID",
      payment_method_intent: "CASH",
      change_for_cents: null,
      table_id: null,
      tab_id: null,
      notes: "zz observação\ncom quebra",
      public_code: d.public_code,
      total_cents: 2200,
    });
    expect(row.customer_id).toBeTruthy();
    expect(row.estimated_ready_at).toBeTruthy();
  });

  it("DELIVERY: taxa da zona somada, endereço em snapshot (sem nulos), pedido sem mesa", async () => {
    const k = key();
    const r = await create({
      p_fulfillment: "DELIVERY",
      p_address: addr({ complement: "Apto zz-909", postal_code: "01310100", instructions: null }),
      p_delivery_zone_id: zoneZ.id,
      p_idempotency_key: k,
    });
    expectOk(r);
    expect(r.data).toMatchObject({ ok: true, fulfillment_type: "DELIVERY", subtotal_cents: 1000, delivery_fee_cents: 500, total_cents: 1500 });
    const row = await orderByKey(k);
    expect(row.delivery_address).toEqual({ street: "Rua Zz Secreta", number: "77", neighborhood: "Centro", city: "Sao Paulo", complement: "Apto zz-909", postal_code: "01310100" });
  });

  it("DINE_IN sem mesa é aceito quando a modalidade está habilitada (table_id nulo); endereço enviado é ignorado fora de DELIVERY", async () => {
    const k = key();
    const r = await create({ p_fulfillment: "DINE_IN", p_idempotency_key: k, p_address: addr() });
    expectOk(r);
    expect(r.data).toMatchObject({ ok: true, fulfillment_type: "DINE_IN", delivery_fee_cents: 0 });
    const row = await orderByKey(k);
    expect(row.table_id).toBeNull();
    expect(row.delivery_address).toBeNull();
    // PICKUP também ignora endereço
    const k2 = key();
    expect((await create({ p_idempotency_key: k2, p_address: addr() })).data.ok).toBe(true);
    expect((await orderByKey(k2)).delivery_address).toBeNull();
  });

  it("snapshots de produto, variante e adicionais: editar o cardápio depois não altera o pedido nem o acompanhamento", async () => {
    const k = key();
    const r = await create({
      p_items: [{ product_id: pPizza.id, variant_id: vG.id, quantity: 1, modifier_ids: [fxZ.m1.id, fxZ.m2.id] }],
      p_idempotency_key: k,
    });
    expectOk(r);
    expect(r.data.items[0]).toMatchObject({ name: pPizza.name, variant_name: "G", unit_price_cents: 2000, modifiers_cents: 300, line_total_cents: 2300 });
    expect(r.data.items[0].modifiers.map((m: any) => m.name).sort()).toEqual([fxZ.m1.name, fxZ.m2.name].sort());
    const code = r.data.public_code;

    // renomeia/reprecifica tudo
    await admin().from("products").update({ name: "zz-RENOMEADO", price_cents: 1 }).eq("id", pPizza.id);
    await admin().from("product_variants").update({ name: "XG", price_cents: 1 }).eq("id", vG.id);
    await admin().from("modifiers").update({ name: "zz-novo-nome", price_delta_cents: 9999 }).eq("id", fxZ.m1.id);
    try {
      const t = await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: code });
      expect(t.data.items[0]).toMatchObject({ name: pPizza.name, variant_name: "G", unit_price_cents: 2000, modifiers_cents: 300, line_total_cents: 2300 });
      expect(t.data.items[0].modifiers.map((m: any) => m.name)).toContain(fxZ.m1.name);
      expect(t.data.total_cents).toBe(2300);
      const row = await orderByKey(k);
      const oi = rows(await admin().from("order_items").select("product_name,variant_name_snapshot,unit_price_cents").eq("order_id", row.id));
      expect(oi).toEqual([{ product_name: pPizza.name, variant_name_snapshot: "G", unit_price_cents: 2000 }]);
    } finally {
      await admin().from("products").update({ name: pPizza.name, price_cents: 900 }).eq("id", pPizza.id);
      await admin().from("product_variants").update({ name: "G", price_cents: 2000 }).eq("id", vG.id);
      await admin().from("modifiers").update({ name: fxZ.m1.name, price_delta_cents: 100 }).eq("id", fxZ.m1.id);
    }
  });

  it("preço/total forjado em qualquer lugar do JSON é ignorado (o servidor recalcula)", async () => {
    const r = await create({
      p_items: [{ product_id: fxZ.pPlain.id, quantity: 2, modifier_ids: [], price_cents: 1, unit_price_cents: 1, line_total_cents: 1, total_cents: 1, name: "zz-grátis" }],
      p_customer: { name: "zz-Forjador", phone: phone(), total_cents: 1 },
      p_payment: { method: "PIX", total_cents: 1, amount_cents: 1, discount_cents: 99999 },
    });
    expectOk(r);
    expect(r.data).toMatchObject({ ok: true, subtotal_cents: 2000, discount_cents: 0, total_cents: 2000 });
    expect(r.data.items[0]).toMatchObject({ unit_price_cents: 1000, line_total_cents: 2000 });
    expect(r.data.items[0].name).not.toBe("zz-grátis");
  });

  it("troco: CASH com troco >= total é aceito (igual ao total também); gravado em change_for_cents", async () => {
    for (const change of [1000, 5000]) {
      const k = key();
      const r = await create({ p_payment: { method: "CASH", change_for_cents: change }, p_idempotency_key: k });
      expectOk(r);
      expect(r.data).toMatchObject({ ok: true, payment_method: "CASH", change_for_cents: change });
      expect(await orderByKey(k)).toMatchObject({ payment_method_intent: "CASH", change_for_cents: change });
    }
    // método em minúsculas e change nulo explícito
    const r = await create({ p_payment: { method: "card", change_for_cents: null } });
    expect(r.data).toMatchObject({ ok: true, payment_method: "CARD", change_for_cents: null });
  });
});

describe("create_public_order: recusas de negócio (ok:false) não gravam nada", () => {
  const rejects = async (over: Record<string, unknown>, expected: string | string[], slug = Z.slug) => {
    const before = await ordersCount(Z.id);
    const customersBefore = (await admin().from("customers").select("id", { count: "exact", head: true }).eq("restaurant_id", Z.id)).count;
    const k = key();
    const r = await create({ p_idempotency_key: k, ...over }, slug);
    expectOk(r);
    expect(r.data.ok, JSON.stringify(r.data)).toBe(false);
    for (const c of Array.isArray(expected) ? expected : [expected]) expect(codes(r), JSON.stringify(r.data.errors)).toContain(c);
    for (const e of r.data.errors) {
      expect(typeof e.message).toBe("string");
      expect(JSON.stringify(e)).not.toMatch(/PGRST|pg_|public\./);
    }
    expect(await ordersCount(Z.id), "pedido gravado apesar do erro").toBe(before);
    expect((await admin().from("customers").select("id", { count: "exact", head: true }).eq("restaurant_id", Z.id)).count, "cliente gravado apesar do erro").toBe(customersBefore);
    expect(rows(await admin().from("orders").select("id").eq("idempotency_key", k))).toHaveLength(0);
    return r;
  };

  it("carrinho inválido: vazio, produto inexistente/inativo/de outro restaurante, quantidade 0/100, adicional alheio, variante obrigatória", async () => {
    await rejects({ p_items: [] }, "EMPTY_CART");
    await rejects({ p_items: [{ product_id: crypto.randomUUID(), quantity: 1 }] }, "PRODUCT_UNAVAILABLE");
    await rejects({ p_items: [{ product_id: fxZ.pInactive.id, quantity: 1 }] }, "PRODUCT_UNAVAILABLE");
    await rejects({ p_items: [{ product_id: B().productId, quantity: 1 }] }, "PRODUCT_UNAVAILABLE");
    await rejects({ p_items: [{ product_id: fxZ.pPlain.id, quantity: 0 }] }, "INVALID_QUANTITY");
    await rejects({ p_items: [{ product_id: fxZ.pPlain.id, quantity: 100 }] }, "INVALID_QUANTITY");
    await rejects({ p_items: [{ product_id: fxZ.pPlain.id, quantity: 1, modifier_ids: [fxZ.m7.id] }] }, "MODIFIER_NOT_ALLOWED");
    await rejects({ p_items: [{ product_id: pPizza.id, quantity: 1 }] }, "VARIANT_REQUIRED");
    await rejects({ p_items: [{ product_id: fxZ.pGrp.id, quantity: 1 }] }, "MODIFIER_GROUP_MIN");
    const idx = await rejects({ p_items: [{ product_id: fxZ.pPlain.id, quantity: 1 }, { product_id: crypto.randomUUID(), quantity: 1 }] }, "PRODUCT_UNAVAILABLE");
    expect(idx.data.errors.find((e: any) => e.code === "PRODUCT_UNAVAILABLE").item_index).toBe(1);
  });

  it("restaurante: inexistente, suspenso, pausado (accepts_orders=false) e fechado agora", async () => {
    // inexistente: nem sequer valida o resto
    const none = await create({}, `zz-nao-existe-${uniq()}`);
    expect(none.data).toMatchObject({ ok: false });
    expect(codes(none)).toEqual(["RESTAURANT_UNAVAILABLE"]);
    // pausado
    await setSettings(Z.id, { accepts_orders: false });
    try {
      const paused = await rejects({}, []);
      expect(codes(paused).some((c) => ["RESTAURANT_UNAVAILABLE", "RESTAURANT_CLOSED"].includes(c)), JSON.stringify(paused.data.errors)).toBe(true);
    } finally {
      await setSettings(Z.id, { accepts_orders: true });
    }
    // fechado
    await setOpenToday(Z.id, false);
    try {
      await rejects({}, "RESTAURANT_CLOSED");
    } finally {
      await setOpenToday(Z.id, true);
    }
    // suspenso
    await setStatus(Z.id, "suspended");
    try {
      const r = await create();
      expect(codes(r)).toEqual(["RESTAURANT_UNAVAILABLE"]);
    } finally {
      await setStatus(Z.id, "active");
    }
    expect((await create()).data.ok).toBe(true); // tudo restaurado
  });

  it("modalidade desabilitada, zona obrigatória/indisponível e abaixo do mínimo", async () => {
    await setSettings(Z.id, { enabled_fulfillment_types: ["PICKUP"] });
    try {
      await rejects({ p_fulfillment: "DINE_IN" }, "FULFILLMENT_DISABLED");
      await rejects({ p_fulfillment: "DELIVERY", p_address: addr(), p_delivery_zone_id: zoneZ.id }, "FULFILLMENT_DISABLED");
      await rejects({ p_fulfillment: "VOO" }, "FULFILLMENT_DISABLED");
      await rejects({ p_fulfillment: "" }, "FULFILLMENT_DISABLED");
    } finally {
      await setSettings(Z.id, { enabled_fulfillment_types: BASE_FULFILLMENT });
    }
    await rejects({ p_fulfillment: "DELIVERY", p_address: addr() }, "ZONE_REQUIRED");
    await rejects({ p_fulfillment: "DELIVERY", p_address: addr(), p_delivery_zone_id: crypto.randomUUID() }, "ZONE_UNAVAILABLE");
    await rejects({ p_fulfillment: "DELIVERY", p_address: addr(), p_delivery_zone_id: A().deliveryZoneId }, "ZONE_UNAVAILABLE"); // zona de outro restaurante

    await setSettings(Z.id, { min_order_cents: 5000 });
    try {
      await rejects({}, "BELOW_MINIMUM");
      // exatamente no mínimo passa
      const ok = await create({ p_items: [{ product_id: fxZ.pPlain.id, quantity: 5 }] });
      expect(ok.data.ok, JSON.stringify(ok.data)).toBe(true);
    } finally {
      await setSettings(Z.id, { min_order_cents: 0 });
    }
  });

  it("validação do cliente: nome, telefone e e-mail (códigos próprios, com field)", async () => {
    const cust = (over: Record<string, unknown>) => ({ name: "zz-Maria", phone: phone(), ...over });
    for (const name of [null, "", " ", "A", "x".repeat(81), "zz\u0001nome", { a: 1 }, ["a"], true]) {
      const r = await rejects({ p_customer: cust({ name }) }, "INVALID_CUSTOMER_NAME");
      expect(r.data.errors.find((e: any) => e.code === "INVALID_CUSTOMER_NAME").field).toBe("customer.name");
    }
    expect((await create({ p_customer: cust({ name: "zz" }) })).data.ok).toBe(true); // 2 caracteres: limite inferior
    expect((await create({ p_customer: cust({ name: "zz" + "x".repeat(78) }) })).data.ok).toBe(true); // 80: limite superior
    for (const ph of [null, "", "abc", "123456789", "1".repeat(14), "(11) 9123-45", "+55 (11) 91234-5678 ramal 9", "1".repeat(31), "11;91234567", { a: 1 }, true]) {
      const r = await rejects({ p_customer: cust({ phone: ph }) }, "INVALID_CUSTOMER_PHONE");
      expect(r.data.errors.find((e: any) => e.code === "INVALID_CUSTOMER_PHONE").field).toBe("customer.phone");
    }
    for (const email of ["x", "a@b", "a b@c.com", "a@@c.com", "@c.com", "a@c.", `${"a".repeat(250)}@c.com`, { a: 1 }, true, "a@c.com\u0007"]) {
      await rejects({ p_customer: cust({ email }) }, "INVALID_CUSTOMER_EMAIL");
    }
    await rejects({ p_customer: null }, "INVALID_CUSTOMER");
    await rejects({ p_customer: "texto" }, "INVALID_CUSTOMER");
    await rejects({ p_customer: [1] }, "INVALID_CUSTOMER");
    // vários erros juntos
    const multi = await rejects({ p_customer: { name: "A", phone: "1", email: "x" } }, ["INVALID_CUSTOMER_NAME", "INVALID_CUSTOMER_PHONE", "INVALID_CUSTOMER_EMAIL"]);
    expect(multi.data.errors.length).toBeGreaterThanOrEqual(3);
    // e-mail opcional e normalizado
    const k = key();
    expect((await create({ p_customer: cust({ email: "  ZZ.Maria@Example.TEST " }), p_idempotency_key: k })).data.ok).toBe(true);
    expect((await orderByKey(k)).customer_email).toBe("zz.maria@example.test");
  });

  it("validação do endereço em DELIVERY: obrigatório, completo e válido", async () => {
    const delivery = { p_fulfillment: "DELIVERY", p_delivery_zone_id: zoneZ.id };
    for (const p_address of [null, "texto", [1]]) {
      const r = await rejects({ ...delivery, p_address }, "ADDRESS_REQUIRED");
      expect(r.data.errors.find((e: any) => e.code === "ADDRESS_REQUIRED").field).toBe("address");
    }
    const inc = await rejects({ ...delivery, p_address: { street: "Rua A" } }, "ADDRESS_INCOMPLETE");
    expect(inc.data.errors.filter((e: any) => e.code === "ADDRESS_INCOMPLETE").map((e: any) => e.field).sort()).toEqual(["address.city", "address.neighborhood", "address.number"]);
    await rejects({ ...delivery, p_address: addr({ street: "  " }) }, "ADDRESS_INCOMPLETE");
    const invalid: Array<[string, unknown]> = [
      ["street", "r".repeat(201)],
      ["number", "9".repeat(21)],
      ["neighborhood", "b".repeat(121)],
      ["city", "c".repeat(121)],
      ["postal_code", "1".repeat(13)],
      ["complement", "x".repeat(121)],
      ["instructions", "i".repeat(201)],
      ["street", "Rua\u0001Controle"],
      ["city", { a: 1 }],
      ["complement", ["x"]],
    ];
    for (const [field, value] of invalid) {
      const r = await rejects({ ...delivery, p_address: addr({ [field]: value }) }, "ADDRESS_INVALID");
      expect(r.data.errors.find((e: any) => e.code === "ADDRESS_INVALID").field, field).toBe(`address.${field}`);
    }
    // limites exatos passam
    const ok = await create({ ...delivery, p_address: addr({ street: "r".repeat(200), number: "9".repeat(20), neighborhood: "b".repeat(120), instructions: "i".repeat(200) }) });
    expect(ok.data.ok, JSON.stringify(ok.data)).toBe(true);
  });

  it("observações: > 500 caracteres ou caractere de controle => INVALID_NOTES; \\n e \\t são aceitos", async () => {
    await rejects({ p_notes: "n".repeat(501) }, "INVALID_NOTES");
    await rejects({ p_notes: "ctrl\u0001x" }, "INVALID_NOTES");
    await rejects({ p_notes: "del\u007fx" }, "INVALID_NOTES");
    const ok = await create({ p_notes: `${"n".repeat(498)}\n\t`.trim() + "n" });
    expect(ok.data.ok).toBe(true);
    expect((await create({ p_notes: "linha1\nlinha2\tcoluna" })).data.ok).toBe(true);
    // só espaços vira nulo
    const k = key();
    expect((await create({ p_notes: "    ", p_idempotency_key: k })).data.ok).toBe(true);
    expect((await orderByKey(k)).notes).toBeNull();
  });

  it("pagamento: método inválido/ausente, troco sem CASH, troco inválido e troco abaixo do total", async () => {
    for (const p_payment of [null, "CASH", [], {}, { method: "BTC" }, { method: "" }, { method: null }, { method: { a: 1 } }, { change_for_cents: 5000 }]) {
      const r = await rejects({ p_payment }, "INVALID_PAYMENT_METHOD");
      expect(r.data.errors.find((e: any) => e.code === "INVALID_PAYMENT_METHOD").field).toBe("payment.method");
    }
    for (const method of ["PIX", "CARD"]) await rejects({ p_payment: { method, change_for_cents: 5000 } }, "CHANGE_NOT_ALLOWED");
    for (const change_for_cents of [0, -5, 1.5, "5000", true, 10 ** 10, { a: 1 }, [5000]]) {
      await rejects({ p_payment: { method: "CASH", change_for_cents } }, "INVALID_CHANGE");
    }
    const below = await rejects({ p_payment: { method: "CASH", change_for_cents: 999 } }, "CHANGE_BELOW_TOTAL");
    expect(below.data.errors.find((e: any) => e.code === "CHANGE_BELOW_TOTAL").field).toBe("payment.change_for_cents");
    // com carrinho inválido o CHANGE_BELOW_TOTAL não é avaliado (sem total)
    const noTotal = await rejects({ p_items: [], p_payment: { method: "CASH", change_for_cents: 1 } }, "EMPTY_CART");
    expect(codes(noTotal)).not.toContain("CHANGE_BELOW_TOTAL");
  });

  it("chave de idempotência: obrigatória, ASCII visível, 8 a 200 caracteres (INVALID_IDEMPOTENCY_KEY)", async () => {
    for (const k of [null, "", "curta", "1234567", "tem espaco 12345", "tab\t12345678", "chavé-ção-123", "x".repeat(201), "emoji-😀-12345"]) {
      const r = await rejects({ p_idempotency_key: k }, "INVALID_IDEMPOTENCY_KEY");
      expect(codes(r)).toEqual(["INVALID_IDEMPOTENCY_KEY"]);
      expect(r.data.errors[0].field).toBe("idempotency_key");
    }
    for (const k of ["zz-t20-8chars", `zz-t20-${"x".repeat(193)}`, "zz-t20-!#$%&'()*+,-./:;<=>?@[]^_`{|}~"]) {
      const r = await create({ p_idempotency_key: k });
      expect(r.data.ok, k.slice(0, 20)).toBe(true);
    }
  });
});

describe("create_public_order: idempotência e clientes", () => {
  it("sequencial: repetir a chave devolve o MESMO pedido (idempotent_replay:true) sem duplicar itens, clientes ou número", async () => {
    const k = key();
    const over = { p_idempotency_key: k, p_items: [{ product_id: fxZ.pGrp.id, quantity: 1, modifier_ids: [fxZ.m1.id] }] };
    const first = await create(over);
    const second = await create(over);
    const third = await create(over);
    expect(first.data).toMatchObject({ ok: true, idempotent_replay: false });
    for (const r of [second, third]) expect(r.data).toMatchObject({ ok: true, idempotent_replay: true, public_code: first.data.public_code, order_number: first.data.order_number, total_cents: first.data.total_cents });
    expect({ ...second.data, idempotent_replay: false }).toEqual(first.data);
    const o = await orderByKey(k);
    expect(rows(await admin().from("order_items").select("id").eq("order_id", o.id))).toHaveLength(1);
    expect(rows(await admin().from("orders").select("id").eq("idempotency_key", k))).toHaveLength(1);
  });

  it("o replay continua valendo com o restaurante fechado ou pausado (o pedido já existe), mas não com restaurante suspenso", async () => {
    const k = key();
    const first = await create({ p_idempotency_key: k });
    expect(first.data.ok).toBe(true);
    await setOpenToday(Z.id, false);
    await setSettings(Z.id, { accepts_orders: false });
    try {
      const replay = await create({ p_idempotency_key: k });
      expect(replay.data).toMatchObject({ ok: true, idempotent_replay: true, public_code: first.data.public_code });
      // chave NOVA continua recusada
      expect((await create()).data.ok).toBe(false);
    } finally {
      await setOpenToday(Z.id, true);
      await setSettings(Z.id, { accepts_orders: true });
    }
    await setStatus(Z.id, "suspended");
    try {
      expect(codes(await create({ p_idempotency_key: k }))).toEqual(["RESTAURANT_UNAVAILABLE"]);
    } finally {
      await setStatus(Z.id, "active");
    }
  });

  it("a chave é por restaurante: a mesma chave em outro restaurante cria outro pedido", async () => {
    const k = key();
    const z = await create({ p_idempotency_key: k });
    const a = await create({ p_idempotency_key: k }, A().slug, fxA.pPlain);
    expect(z.data).toMatchObject({ ok: true, idempotent_replay: false });
    expect(a.data).toMatchObject({ ok: true, idempotent_replay: false });
    expect(a.data.public_code).not.toBe(z.data.public_code);
    expect(rows(await admin().from("orders").select("restaurant_id").eq("idempotency_key", k)).map((r) => r.restaurant_id).sort()).toEqual([A().id, Z.id].sort());
  });

  it("[documentado] mesma chave com CONTEÚDO diferente devolve o pedido original (não há IDEMPOTENCY_CONFLICT no banco)", async () => {
    const k = key();
    const first = await create({ p_idempotency_key: k, p_items: [{ product_id: fxZ.pPlain.id, quantity: 1 }] });
    const other = await create({ p_idempotency_key: k, p_items: [{ product_id: fxZ.pPlain.id, quantity: 9 }], p_customer: { name: "zz-Outra Pessoa", phone: phone() } });
    expect(other.data).toMatchObject({ ok: true, idempotent_replay: true, public_code: first.data.public_code, total_cents: 1000 });
  });

  it("concorrente: 8 chamadas simultâneas com a mesma chave => 1 pedido; 1 criação + 7 replays, todos com o mesmo código", async () => {
    for (let round = 0; round < 2; round++) {
      const k = key();
      const over = { p_idempotency_key: k };
      const before = await ordersCount(Z.id);
      const results = await Promise.all(Array.from({ length: 8 }, () => create(over)));
      for (const r of results) expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(results.every((r) => r.data.ok)).toBe(true);
      expect(results.filter((r) => r.data.idempotent_replay === false)).toHaveLength(1);
      expect(results.filter((r) => r.data.idempotent_replay === true)).toHaveLength(7);
      expect(new Set(results.map((r) => r.data.public_code)).size).toBe(1);
      expect(new Set(results.map((r) => r.data.order_number)).size).toBe(1);
      expect(await ordersCount(Z.id)).toBe(before + 1);
      const o = await orderByKey(k);
      expect(rows(await admin().from("order_items").select("id").eq("order_id", o.id))).toHaveLength(1);
    }
  });

  it("concorrente com chaves diferentes: números de pedido únicos e sequenciais, códigos públicos distintos", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => create()));
    expect(results.every((r) => r.data?.ok)).toBe(true);
    expect(new Set(results.map((r) => r.data.order_number)).size).toBe(6);
    expect(new Set(results.map((r) => r.data.public_code)).size).toBe(6);
  });

  it("clientes: upsert por telefone normalizado (prefixo 55 removido), nome nunca sobrescrito, e-mail só preenchido se vazio", async () => {
    const local = phone(); // 11 dígitos
    const mask = `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    const k1 = key();
    const k2 = key();
    const k3 = key();
    const r1 = await create({ p_idempotency_key: k1, p_customer: { name: "zz-Primeiro Nome", phone: mask } });
    const r2 = await create({ p_idempotency_key: k2, p_customer: { name: "zz-Nome Trocado", phone: `+55 ${mask}`, email: "zz.primeiro@example.test" } });
    const r3 = await create({ p_idempotency_key: k3, p_customer: { name: "zz-Outro Nome", phone: `55${local}`, email: "zz.outro@example.test" } });
    for (const r of [r1, r2, r3]) expect(r.data.ok, JSON.stringify(r.data)).toBe(true);
    const cs = rows(await admin().from("customers").select("*").eq("restaurant_id", Z.id).eq("phone", local));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ name: "zz-Primeiro Nome", phone: local, email: "zz.primeiro@example.test" });
    // os 3 pedidos apontam para o mesmo cliente, mas cada um guarda o SEU snapshot de nome/telefone/e-mail
    const [o1, o2, o3] = [await orderByKey(k1), await orderByKey(k2), await orderByKey(k3)];
    expect(new Set([o1.customer_id, o2.customer_id, o3.customer_id]).size).toBe(1);
    expect(o1.customer_id).toBe(cs[0].id);
    expect([o1.customer_name, o2.customer_name, o3.customer_name]).toEqual(["zz-Primeiro Nome", "zz-Nome Trocado", "zz-Outro Nome"]);
    expect([o1.customer_phone, o2.customer_phone, o3.customer_phone]).toEqual([local, local, local]);
    expect([o1.customer_email, o2.customer_email, o3.customer_email]).toEqual([null, "zz.primeiro@example.test", "zz.outro@example.test"]);

    // 12 dígitos com 55 (fixo): 55 + 10 dígitos => remove o 55; 10 dígitos que COMEÇAM com 55 (DDD 55) ficam como estão
    const fixed = `113${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`; // 10 dígitos
    const k4 = key();
    await create({ p_idempotency_key: k4, p_customer: { name: "zz-Fixo", phone: `55${fixed}` } });
    expect((await orderByKey(k4)).customer_phone).toBe(fixed);
    const ddd55 = `553${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const k5 = key();
    await create({ p_idempotency_key: k5, p_customer: { name: "zz-Santa Maria", phone: ddd55 } });
    expect((await orderByKey(k5)).customer_phone).toBe(ddd55);
  });

  it("mesmo telefone em restaurantes diferentes gera clientes diferentes (isolamento do upsert)", async () => {
    const ph = phone();
    const kz = key();
    const ka = key();
    await create({ p_idempotency_key: kz, p_customer: { name: "zz-Cliente Z", phone: ph } });
    await create({ p_idempotency_key: ka, p_customer: { name: "zz-Cliente A", phone: ph } }, A().slug, fxA.pPlain);
    const [oz, oa] = [await orderByKey(kz), await orderByKey(ka)];
    expect(oz.customer_id).not.toBe(oa.customer_id);
    expect((await admin().from("customers").select("restaurant_id,name").eq("id", oa.customer_id).single()).data).toMatchObject({ restaurant_id: A().id, name: "zz-Cliente A" });
  });
});

describe("CHECKs de payment_method_intent / change_for_cents", () => {
  it("authenticated com permissão (caixa/gerente) NÃO altera essas colunas por UPDATE direto (grant por coluna)", async () => {
    const { row } = await newOrderA("PICKUP", { p_payment: { method: "CASH", change_for_cents: 5000 } });
    for (const who of ["cashierA", "managerA", "ownerA"] as const) {
      for (const patch of [{ payment_method_intent: "PIX" }, { change_for_cents: 9999 }, { payment_method_intent: "BTC" }, { change_for_cents: -1 }, { payment_status: "PAID" }]) {
        expectDenied(await as(who).from("orders").update(patch).eq("id", row.id).select("id"));
      }
    }
    expect(await orderByKey(row.idempotency_key)).toMatchObject({ payment_method_intent: "CASH", change_for_cents: 5000, payment_status: "UNPAID" });
  });

  it("o próprio banco recusa (mesmo para service role): método fora de CASH/PIX/CARD, troco <= 0, troco sem CASH e troco abaixo do total", async () => {
    const { row } = await newOrderA("PICKUP", { p_payment: { method: "CASH", change_for_cents: 5000 } });
    const upd = (patch: Record<string, unknown>) => admin().from("orders").update(patch).eq("id", row.id);
    expect((await upd({ payment_method_intent: "BTC" })).error?.code).toBe("23514");
    expect((await upd({ change_for_cents: 0 })).error?.code).toBe("23514");
    expect((await upd({ change_for_cents: -1 })).error?.code).toBe("23514");
    expect((await upd({ change_for_cents: row.total_cents - 1 })).error?.code).toBe("23514");
    expect((await upd({ payment_method_intent: "PIX" })).error?.code).toBe("23514"); // troco 5000 com PIX
    // combinações válidas passam
    expect((await upd({ payment_method_intent: "PIX", change_for_cents: null })).error).toBeNull();
    expect((await upd({ payment_method_intent: "CASH", change_for_cents: row.total_cents })).error).toBeNull();
    expect(await orderByKey(row.idempotency_key)).toMatchObject({ payment_method_intent: "CASH", change_for_cents: row.total_cents });
  });
});

// =====================================================================================================================
describe("track_order (anon e authenticated)", () => {
  const PII = {
    name: "zz-Fulano Detalhe da Silva",
    email: "zz.fulano.detalhe@example.test",
    complement: "Apto zz-909 bloco secreto",
    notes: "zz-obs-secreta-do-pedido",
    itemNotes: "zz-obs-secreta-do-item",
  };
  let code: string;
  let ph: string;
  let k: string;

  beforeAll(async () => {
    ph = phone();
    k = key();
    const r = await create({
      p_fulfillment: "DELIVERY",
      p_idempotency_key: k,
      p_items: [{ product_id: fxZ.pGrp.id, quantity: 2, modifier_ids: [fxZ.m1.id], notes: PII.itemNotes }],
      p_customer: { name: PII.name, phone: ph, email: PII.email },
      p_address: addr({ complement: PII.complement, postal_code: "01310100", instructions: "zz-instrucao-secreta" }),
      p_delivery_zone_id: zoneZ.id,
      p_notes: PII.notes,
      p_payment: { method: "CASH", change_for_cents: 10000 },
    });
    expect(r.data.ok, JSON.stringify(r.data)).toBe(true);
    code = r.data.public_code;
  });

  it("devolve só o necessário: restaurante, status, itens, totais, bairro, histórico; nenhuma PII nem id interno", async () => {
    for (const client of [anon(), as("plain"), as("ownerB")]) {
      const t = await client.rpc("track_order", { p_slug: Z.slug, p_public_code: code });
      expectOk(t);
      const d = t.data;
      expect(Object.keys(d).sort()).toEqual(
        ["restaurant", "public_code", "order_number", "fulfillment_type", "status", "status_message", "payment_status", "payment_method", "items", "subtotal_cents", "delivery_fee_cents", "discount_cents", "total_cents", "neighborhood", "created_at", "estimated_ready_at", "status_history"].sort(),
      );
      expect(d).toMatchObject({
        restaurant: { name: `zz DEMO ORD ${Z.slug}`, slug: Z.slug, timezone: expect.any(String) },
        public_code: code,
        fulfillment_type: "DELIVERY",
        status: "RECEIVED",
        status_message: null,
        payment_status: "UNPAID",
        payment_method: "CASH",
        subtotal_cents: 2200,
        delivery_fee_cents: 500,
        total_cents: 2700,
        neighborhood: "Centro",
      });
      expect(d.items).toHaveLength(1);
      expect(d.items[0]).toMatchObject({ quantity: 2, unit_price_cents: 1000, line_total_cents: 2200, notes: null });
      expect(d.status_history.every((h: any) => Object.keys(h).sort().join() === "at,to_status")).toBe(true);

      const text = JSON.stringify(d);
      expect(text).not.toContain(ph);
      expect(text).not.toContain(PII.name);
      expect(text).not.toContain("Fulano");
      expect(text).not.toContain(PII.email);
      expect(text).not.toMatch(/example\.test|@/);
      for (const secret of ["Rua Zz Secreta", PII.complement, "01310100", "zz-instrucao-secreta", PII.notes, PII.itemNotes, k, "10000"]) expect(text, secret).not.toContain(secret);
      expect(text).not.toMatch(UUID_RE);
      expect(text).not.toMatch(/\b\d{10,13}\b/); // nenhum telefone/CEP
      const keys = walkKeys(d);
      for (const forbidden of ["id", "restaurant_id", "customer_id", "customer_name", "customer_phone", "customer_email", "delivery_address", "changed_by", "idempotency_key", "change_for_cents", "street", "phone", "email", "name_customer"]) {
        expect(keys.has(forbidden), forbidden).toBe(false);
      }
    }
  });

  it("código em minúsculas, com espaços e com O/I/L (Crockford) localiza o mesmo pedido", async () => {
    const lower = await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: code.toLowerCase() });
    expect(lower.data?.public_code).toBe(code);
    const spaced = await anon().rpc("track_order", { p_slug: `  ${Z.slug.toUpperCase()} `, p_public_code: `  ${code.toLowerCase()}  ` });
    expect(spaced.data?.public_code).toBe(code);

    // pedido com código forjado (inserção pelo service role): ZZ0ZZ1ZZ0ZZ1ZZ0Z — O->0, I/L->1
    const crafted = "ZZ0ZZ1ZZ0ZZ1ZZ0Z".slice(0, 16);
    const ins = await admin()
      .from("orders")
      .insert({ restaurant_id: Z.id, fulfillment_type: "PICKUP", status: "RECEIVED", source: "STAFF", subtotal_cents: 1000, total_cents: 1000, customer_name: "zz-codigo", idempotency_key: key(), public_code: crafted })
      .select("id")
      .single();
    expectOk(ins);
    for (const variant of ["ZZOZZ1ZZOZZ1ZZOZ", "zzozzizzozzlzzoz", "ZZ0ZZIZZ0ZZLZZ0Z", "zzOzzIzzOzzLzzOz"]) {
      const t = await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: variant.slice(0, 16) });
      expect(t.data?.public_code, variant).toBe(crafted);
    }
  });

  it("slug errado, código malformado, curto/longo ou inexistente => null (sem erro, sem distinguir os casos)", async () => {
    const miss = async (slug: string | null, c: string | null) => {
      const t = await anon().rpc("track_order", { p_slug: slug, p_public_code: c });
      expect(t.error, `${slug}/${c}: ${JSON.stringify(t.error)}`).toBeNull();
      expect(t.data, `${slug}/${c}`).toBeNull();
    };
    await miss(B().slug, code); // código de Z em outro restaurante
    await miss("demo-a", code);
    await miss(`zz-nao-existe-${uniq()}`, code);
    await miss(null, code);
    await miss(Z.slug, null);
    await miss(Z.slug, "");
    await miss(Z.slug, "ABC");
    await miss(Z.slug, "A".repeat(7));
    await miss(Z.slug, "A".repeat(33));
    await miss(Z.slug, "AAAAAAAAAAAAAAAA"); // formato válido, inexistente
    await miss(Z.slug, code.slice(0, 15));
    await miss(Z.slug, `${code}X`);
    await miss(Z.slug, `${code.slice(0, 8)} ${code.slice(8)}`);
    await miss(Z.slug, "' or 1=1 --");
    await miss(Z.slug, "%");
    await miss(Z.slug, `${code}%`);
    await miss(Z.slug, "____________________");
    await miss(Z.slug, code.slice(0, 8) + "-" + code.slice(8));
    await miss(Z.slug, "😀".repeat(10));
  });

  it("status_message só aparece em REJECTED/CANCELLED; a recusa expõe o motivo e o histórico cresce", async () => {
    const { row, receipt } = await newOrderA("PICKUP");
    const before = await anon().rpc("track_order", { p_slug: A().slug, p_public_code: receipt.public_code });
    expect(before.data).toMatchObject({ status: "RECEIVED", status_message: null });
    expectOk(await cashierTo(row.id, "REJECTED", "zz sem ingredientes"));
    const after = await anon().rpc("track_order", { p_slug: A().slug, p_public_code: receipt.public_code });
    expect(after.data).toMatchObject({ status: "REJECTED", status_message: "zz sem ingredientes" });
    expect(after.data.status_history.map((h: any) => h.to_status).at(-1)).toBe("REJECTED");
    expect(after.data.status_history.length).toBeGreaterThan(before.data.status_history.length);
  });

  it("restaurante suspenso/pendente => null (inclusive para pedidos já existentes); volta ao reativar", async () => {
    expect((await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: code })).data).not.toBeNull();
    for (const status of ["suspended", "pending"]) {
      await setStatus(Z.id, status);
      try {
        const t = await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: code });
        expect(t.error).toBeNull();
        expect(t.data, status).toBeNull();
      } finally {
        await setStatus(Z.id, "active");
      }
    }
    expect((await anon().rpc("track_order", { p_slug: Z.slug, p_public_code: code })).data).not.toBeNull();
  });
});

// =====================================================================================================================
describe("transition_order_status", () => {
  it("caixa aceita (RECEIVED->CONFIRMED) e recusa com motivo; o retorno traz o pedido atualizado e a RPC grava histórico/marcos", async () => {
    const o = await newOrderA("PICKUP");
    const r = await cashierTo(o.row.id, "CONFIRMED");
    expectOk(r);
    expect(r.data).toMatchObject({ ok: true, unchanged: false, order: { id: o.row.id, status: "CONFIRMED", previous_status: "RECEIVED", status_reason: null, order_number: o.row.order_number } });
    expect(r.data.order.confirmed_at).toBeTruthy();
    expect(await orderByKey(o.key)).toMatchObject({ status: "CONFIRMED" });

    const o2 = await newOrderA("DELIVERY");
    const rej = await cashierTo(o2.row.id, "REJECTED", "  zz fora da área  ");
    expectOk(rej);
    expect(rej.data.order).toMatchObject({ status: "REJECTED", status_reason: "zz fora da área" });
    expect(rej.data.order.rejected_at).toBeTruthy();
    const hist = rows(await admin().from("order_status_history").select("to_status").eq("order_id", o2.row.id).order("created_at"));
    expect(hist.map((h) => h.to_status).at(-1)).toBe("REJECTED");
    expect(hist.filter((h) => h.to_status === "REJECTED")).toHaveLength(1);
  });

  it("fluxo completo PICKUP e DELIVERY com os papéis certos (caixa aceita, cozinha prepara, caixa conclui)", async () => {
    const p = await newOrderA("PICKUP");
    expectOk(await cashierTo(p.row.id, "CONFIRMED"));
    expectOk(await as("kitchenA").rpc("transition_order_status", { p_order: p.row.id, p_to: "PREPARING" }));
    expectOk(await as("kitchenA").rpc("transition_order_status", { p_order: p.row.id, p_to: "READY" }));
    const done = await cashierTo(p.row.id, "COMPLETED");
    expect(done.data.order).toMatchObject({ status: "COMPLETED", previous_status: "READY" });
    expect(done.data.order.completed_at).toBeTruthy();

    const d = await newOrderA("DELIVERY");
    for (const [who, to] of [["cashierA", "confirmed"], ["kitchenA", "Preparing"], ["kitchenA", "READY"], ["cashierA", "OUT_FOR_DELIVERY"], ["cashierA", "COMPLETED"]] as const) {
      expectOk(await as(who).rpc("transition_order_status", { p_order: d.row.id, p_to: to }));
    }
    expect((await orderByKey(d.key)).status).toBe("COMPLETED");
    // o acompanhamento público refletiu toda a trilha
    const t = await anon().rpc("track_order", { p_slug: A().slug, p_public_code: d.receipt.public_code });
    const seen = t.data.status_history.map((h: any) => h.to_status);
    for (const s of ["CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"]) expect(seen).toContain(s);
  });

  it("cozinha só prepara: aceitar, recusar e cancelar => FORBIDDEN (nada muda)", async () => {
    const o = await newOrderA("PICKUP");
    const k = (to: string, reason?: string) => as("kitchenA").rpc("transition_order_status", { p_order: o.row.id, p_to: to, p_reason: reason ?? null });
    expectRule(await k("CONFIRMED"), /^FORBIDDEN/);
    expectRule(await k("REJECTED", "zz motivo"), /^FORBIDDEN/);
    expectRule(await k("CANCELLED", "zz motivo"), /^FORBIDDEN/);
    expect((await orderByKey(o.key)).status).toBe("RECEIVED");
    expectOk(await cashierTo(o.row.id, "CONFIRMED"));
    expectOk(await k("PREPARING"));
    expectRule(await k("CANCELLED", "zz motivo"), /^FORBIDDEN/);
    expectOk(await k("READY"));
  });

  it("caixa não cancela (orders.cancel é do gerente); gerente cancela com motivo e o motivo é obrigatório", async () => {
    const o = await newOrderA("PICKUP");
    expectRule(await cashierTo(o.row.id, "CANCELLED", "zz motivo"), /^FORBIDDEN/);
    expectRule(await as("managerA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CANCELLED" }), /REASON_REQUIRED/);
    expectRule(await as("managerA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CANCELLED", p_reason: "   " }), /REASON_REQUIRED/);
    expect((await orderByKey(o.key)).status).toBe("RECEIVED");
    const c = await as("managerA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CANCELLED", p_reason: "zz cliente desistiu" });
    expectOk(c);
    expect(c.data.order).toMatchObject({ status: "CANCELLED", status_reason: "zz cliente desistiu" });
    expect(c.data.order.cancelled_at).toBeTruthy();
    // recusar sem motivo (caixa)
    const o2 = await newOrderA("PICKUP");
    expectRule(await cashierTo(o2.row.id, "REJECTED"), /REASON_REQUIRED/);
    expectRule(await cashierTo(o2.row.id, "REJECTED", ""), /REASON_REQUIRED/);
    expect((await orderByKey(o2.key)).status).toBe("RECEIVED");
  });

  it("dono e garçom (sem permissões de pedido) => FORBIDDEN; estranho, outro restaurante e pedido inexistente => ORDER_NOT_FOUND; anon => sem EXECUTE", async () => {
    const o = await newOrderA("PICKUP");
    const t = (who: "ownerA" | "waiterA" | "plain" | "cashierB" | "managerB" | "ownerB", to = "CONFIRMED") => as(who).rpc("transition_order_status", { p_order: o.row.id, p_to: to });
    expectRule(await t("ownerA"), /^FORBIDDEN/);
    expectRule(await t("ownerA", "CANCELLED"), /^FORBIDDEN/);
    expectRule(await t("waiterA"), /^FORBIDDEN/);
    expectRule(await t("waiterA", "REJECTED"), /^FORBIDDEN/);
    for (const who of ["plain", "cashierB", "managerB", "ownerB"] as const) expectRule(await t(who), /^ORDER_NOT_FOUND/);
    expectRule(await as("cashierA").rpc("transition_order_status", { p_order: crypto.randomUUID(), p_to: "CONFIRMED" }), /^ORDER_NOT_FOUND/);
    // as mensagens de "não existe" e "sem acesso" são idênticas (sem oráculo de existência)
    const stranger = await t("cashierB");
    const ghost = await as("cashierB").rpc("transition_order_status", { p_order: crypto.randomUUID(), p_to: "CONFIRMED" });
    expect(stranger.error?.message).toBe(ghost.error?.message);
    expect(stranger.error?.code).toBe(ghost.error?.code);
    expectDenied(await anon().rpc("transition_order_status", { p_order: o.row.id, p_to: "CONFIRMED" }), /42501|permission denied/i);
    expect(await orderByKey(o.key)).toMatchObject({ status: "RECEIVED" });
  });

  it("cozinha/caixa de OUTRO restaurante não transiciona pedido de A; ownerA não transiciona pedido de B", async () => {
    const bOrder = await makeOrder(cleanup, B().id, { status: "RECEIVED" });
    expectRule(await as("ownerA").rpc("transition_order_status", { p_order: bOrder.id, p_to: "CONFIRMED" }), /^ORDER_NOT_FOUND/);
    expectRule(await as("cashierA").rpc("transition_order_status", { p_order: bOrder.id, p_to: "CONFIRMED" }), /^ORDER_NOT_FOUND/);
    expect((await admin().from("orders").select("status").eq("id", bOrder.id).single()).data?.status).toBe("RECEIVED");
    expectOk(await as("cashierB").rpc("transition_order_status", { p_order: bOrder.id, p_to: "CONFIRMED" })); // controle positivo
  });

  it("estados inválidos: pular etapa, voltar, sair de estado terminal, status desconhecido, modalidade sem OUT_FOR_DELIVERY", async () => {
    const o = await newOrderA("PICKUP");
    const t = (to: any, who = "cashierA" as const) => as(who).rpc("transition_order_status", { p_order: o.row.id, p_to: to, p_reason: "zz" });
    expectRule(await t("PREPARING"), /ORDER_INVALID_TRANSITION/); // pula CONFIRMED
    expectRule(await t("READY"), /ORDER_INVALID_TRANSITION/);
    expectRule(await t("COMPLETED"), /ORDER_INVALID_TRANSITION/);
    expectRule(await t("OUT_FOR_DELIVERY"), /ORDER_INVALID_TRANSITION/); // PICKUP nunca tem entrega
    for (const bad of ["BANANA", "", "received;drop", null, " "]) expectRule(await t(bad), /^INVALID_STATUS/);
    expect((await orderByKey(o.key)).status).toBe("RECEIVED");
    expectOk(await t("CONFIRMED"));
    expectRule(await t("RECEIVED"), /ORDER_INVALID_TRANSITION/); // não volta
    expectRule(await t("REJECTED"), /ORDER_INVALID_TRANSITION/); // recusar só vale em RECEIVED
    // terminal: depois de COMPLETED nada sai
    const done = await newOrderA("PICKUP");
    for (const [who, to] of [["cashierA", "CONFIRMED"], ["kitchenA", "PREPARING"], ["kitchenA", "READY"], ["cashierA", "COMPLETED"]] as const) expectOk(await as(who).rpc("transition_order_status", { p_order: done.row.id, p_to: to }));
    for (const to of ["RECEIVED", "CONFIRMED", "READY", "CANCELLED"]) expectRule(await as("managerA").rpc("transition_order_status", { p_order: done.row.id, p_to: to, p_reason: "zz" }), /ORDER_INVALID_TRANSITION/);
    // pedido rejeitado também é terminal
    const rej = await newOrderA("PICKUP");
    expectOk(await cashierTo(rej.row.id, "REJECTED", "zz"));
    expectRule(await as("managerA").rpc("transition_order_status", { p_order: rej.row.id, p_to: "CONFIRMED" }), /ORDER_INVALID_TRANSITION/);
  });

  it("motivo com mais de 500 caracteres => REASON_TOO_LONG (500 exatos passa); motivo em transição comum é descartado", async () => {
    const o = await newOrderA("PICKUP");
    expectRule(await cashierTo(o.row.id, "REJECTED", "m".repeat(501)), /^REASON_TOO_LONG/);
    expect((await orderByKey(o.key)).status).toBe("RECEIVED");
    const ok = await cashierTo(o.row.id, "REJECTED", "m".repeat(500));
    expectOk(ok);
    expect(ok.data.order.status_reason).toHaveLength(500);
    const o2 = await newOrderA("PICKUP");
    const conf = await cashierTo(o2.row.id, "CONFIRMED", "isto não deve ser guardado");
    expectOk(conf);
    expect(conf.data.order.status_reason).toBeNull();
  });

  it("repetir o mesmo destino é idempotente ({ok:true, unchanged:true}), sem novo histórico; exige a mesma permissão", async () => {
    const o = await newOrderA("PICKUP");
    const first = await cashierTo(o.row.id, "CONFIRMED");
    const again = await cashierTo(o.row.id, "CONFIRMED");
    expect(first.data).toMatchObject({ ok: true, unchanged: false });
    expect(again.data).toMatchObject({ ok: true, unchanged: true, order: { status: "CONFIRMED", previous_status: null } });
    const hist = rows(await admin().from("order_status_history").select("to_status").eq("order_id", o.row.id).eq("to_status", "CONFIRMED"));
    expect(hist).toHaveLength(1);
    // quem não pode aceitar não ganha nada repetindo o destino
    expectRule(await as("waiterA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CONFIRMED" }), /^FORBIDDEN/);
    expectRule(await as("ownerA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CONFIRMED" }), /^FORBIDDEN/);
  });

  it("concorrência: duas transições iguais => 1 aplica e 1 unchanged; aceitar x recusar => exatamente uma vence", async () => {
    const o = await newOrderA("PICKUP");
    const [r1, r2] = await Promise.all([cashierTo(o.row.id, "CONFIRMED"), as("managerA").rpc("transition_order_status", { p_order: o.row.id, p_to: "CONFIRMED" })]);
    expectOk(r1);
    expectOk(r2);
    expect([r1.data.unchanged, r2.data.unchanged].sort()).toEqual([false, true]);
    expect(rows(await admin().from("order_status_history").select("id").eq("order_id", o.row.id).eq("to_status", "CONFIRMED"))).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      const x = await newOrderA("PICKUP");
      const [acc, rej] = await Promise.all([cashierTo(x.row.id, "CONFIRMED"), as("managerA").rpc("transition_order_status", { p_order: x.row.id, p_to: "REJECTED", p_reason: "zz corrida" })]);
      expect([acc.error, rej.error].filter(Boolean)).toHaveLength(1);
      const failed = (acc.error ?? rej.error)!;
      expect(failed.message).toMatch(/^ORDER_INVALID_TRANSITION/);
      const final = (await orderByKey(x.key)).status;
      expect(final).toBe(acc.error ? "REJECTED" : "CONFIRMED");
      expect(rows(await admin().from("order_status_history").select("to_status").eq("order_id", x.row.id).in("to_status", ["CONFIRMED", "REJECTED"]))).toHaveLength(1);
    }
  });

  it("o UPDATE direto de status continua sob a mesma máquina de estados (a RPC não é um atalho): dono não aceita, garçom não aceita", async () => {
    const o = await newOrderA("PICKUP");
    for (const who of ["ownerA", "waiterA"] as const) {
      const r = await as(who).from("orders").update({ status: "CONFIRMED" }).eq("id", o.row.id).select("id");
      if (!r.error) expect(rows(r)).toHaveLength(0);
      else expectDenied(r);
    }
    expect((await orderByKey(o.key)).status).toBe("RECEIVED");
  });
});

// =====================================================================================================================
describe("request_print / mark_print_job", () => {
  const rp = (who: any, order: string, type: any = "KITCHEN_TICKET") => as(who).rpc("request_print", { p_order: order, p_document_type: type });
  const mark = (who: any, job: string, status: any) => as(who).rpc("mark_print_job", { p_job: job, p_status: status });
  const jobRow = async (id: string) => (await admin().from("print_jobs").select("*").eq("id", id).single()).data as any;

  it("cozinha e caixa pedem KITCHEN_TICKET e ORDER_RECEIPT: job REQUESTED do solicitante, payload no retorno = payload gravado, auditoria gravada", async () => {
    const o = await newOrderA("PICKUP");
    let lastJob = "";
    for (const who of ["cashierA", "managerA", "waiterA", "kitchenA"] as const) {
      for (const type of ["KITCHEN_TICKET", "ORDER_RECEIPT"]) {
        const r = await rp(who, o.row.id, type);
        lastJob = r.data?.job_id;
        expectOk(r);
        expect(r.data).toMatchObject({ ok: true, status: "REQUESTED" });
        const job = await jobRow(r.data.job_id);
        expect(job).toMatchObject({ restaurant_id: A().id, order_id: o.row.id, document_type: type, status: "REQUESTED", requested_by: world().users[who].id, printed_at: null, dispatched_at: null });
        expect(job.payload).toEqual(r.data.payload);
        expect(r.data.payload).toMatchObject({ document_type: type, order_number: o.row.order_number, fulfillment_type: "PICKUP", restaurant_name: A().name });
      }
    }
    // tipo em minúsculas é normalizado
    expectOk(await rp("cashierA", o.row.id, " kitchen_ticket "));
    const aud = rows(await admin().from("audit_logs").select("action,resource_type,resource_id,actor_id,metadata").eq("restaurant_id", A().id).eq("action", "print.requested").eq("resource_id", lastJob).limit(1));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ resource_type: "print_job", actor_id: world().users.kitchenA.id, metadata: { order_id: o.row.id, document_type: "ORDER_RECEIPT" } });
  });

  it("KITCHEN_TICKET: itens, adicionais e observações; só o primeiro nome; sem telefone, e-mail, endereço, totais nem pagamento", async () => {
    const ph = phone();
    const o = await newOrderA("DELIVERY", {
      p_items: [{ product_id: fxA.pGrp.id, quantity: 3, modifier_ids: [fxA.m1.id, fxA.m2.id], notes: "zz sem gelo" }],
      p_customer: { name: "zz-Joana Maria Pereira", phone: ph, email: "zz.joana@example.test" },
      p_address: addr({ complement: "Apto zz-404", postal_code: "01310100" }),
      p_notes: "zz tocar a campainha",
      p_payment: { method: "CASH", change_for_cents: 20000 },
    });
    const r = await rp("kitchenA", o.row.id, "KITCHEN_TICKET");
    expectOk(r);
    const p = r.data.payload;
    expect(p).toMatchObject({ customer_first_name: "zz-Joana", notes: "zz tocar a campainha", fulfillment_type: "DELIVERY", table_label: null, tab_label: null });
    expect(p.created_at_local).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ name: fxA.pGrp.name, quantity: 3, notes: "zz sem gelo" });
    expect(p.items[0].modifiers.map((m: any) => m.name).sort()).toEqual([fxA.m1.name, fxA.m2.name].sort());
    const text = JSON.stringify(p);
    for (const secret of [ph, "Pereira", "Maria Pereira", "example.test", "Rua Zz Secreta", "Apto zz-404", "01310100", "Sao Paulo"]) expect(text, secret).not.toContain(secret);
    const keys = walkKeys(p);
    for (const forbidden of ["customer_name", "customer_phone", "customer_email", "delivery_address", "street", "subtotal_cents", "delivery_fee_cents", "discount_cents", "total_cents", "payment_status", "payment_method", "change_for_cents"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(text).not.toMatch(UUID_RE);
    // DINE_IN: sem nome de cliente nenhum
    const dine = await newOrderA("DINE_IN");
    const d = await rp("kitchenA", dine.row.id);
    expect(walkKeys(d.data.payload).has("customer_first_name")).toBe(false);
    expect(JSON.stringify(d.data.payload)).not.toContain("Joao");
  });

  it("[F-34 documentado] o KITCHEN_TICKET não tem totais/pagamento, mas os itens carregam preços unitários e de adicionais (order_items_json é compartilhado com o recibo)", async () => {
    const o = await newOrderA("PICKUP", { p_items: [{ product_id: fxA.pGrp.id, quantity: 2, modifier_ids: [fxA.m1.id] }] });
    const r = await rp("kitchenA", o.row.id, "KITCHEN_TICKET");
    expectOk(r);
    expect(r.data.payload.items[0]).toMatchObject({ unit_price_cents: 1000, modifiers_cents: 100, line_total_cents: 2200 });
    expect(r.data.payload.items[0].modifiers[0]).toMatchObject({ price_delta_cents: 100 });
    for (const k of ["subtotal_cents", "delivery_fee_cents", "discount_cents", "total_cents", "payment_status", "payment_method", "change_for_cents"]) expect(walkKeys(r.data.payload).has(k), k).toBe(false);
  });

  it("ORDER_RECEIPT: nome, totais, pagamento/troco; endereço só em DELIVERY; telefone e e-mail NUNCA", async () => {
    const ph = phone();
    const common = { p_customer: { name: "zz-Carlos Eduardo Lima", phone: ph, email: "zz.carlos@example.test" }, p_payment: { method: "CASH", change_for_cents: 20000 } };
    const del = await newOrderA("DELIVERY", { ...common, p_address: addr({ complement: "Apto zz-808" }) });
    const r = await rp("cashierA", del.row.id, "ORDER_RECEIPT");
    expectOk(r);
    const p = r.data.payload;
    expect(p).toMatchObject({
      document_type: "ORDER_RECEIPT",
      customer_name: "zz-Carlos Eduardo Lima",
      subtotal_cents: 1000,
      delivery_fee_cents: 500,
      discount_cents: 0,
      total_cents: 1500,
      payment_status: "UNPAID",
      payment_method: "CASH",
      change_for_cents: 20000,
      delivery_address: { street: "Rua Zz Secreta", number: "77", neighborhood: "Centro", city: "Sao Paulo", complement: "Apto zz-808" },
    });
    let text = JSON.stringify(p);
    expect(text).not.toContain(ph);
    expect(text).not.toMatch(/example\.test|@/);
    for (const forbidden of ["customer_phone", "customer_email", "phone", "email", "customer_first_name"]) expect(walkKeys(p).has(forbidden), forbidden).toBe(false);

    const pick = await newOrderA("PICKUP", common);
    const r2 = await rp("kitchenA", pick.row.id, "ORDER_RECEIPT");
    expectOk(r2);
    expect(walkKeys(r2.data.payload).has("delivery_address")).toBe(false);
    expect(r2.data.payload).toMatchObject({ customer_name: "zz-Carlos Eduardo Lima", total_cents: 1000, delivery_fee_cents: 0 });
    text = JSON.stringify(r2.data.payload);
    expect(text).not.toContain(ph);
    expect(text).not.toContain("Rua Zz");
    // o tipo pedido define o conteúdo: KITCHEN_TICKET do mesmo pedido NÃO tem o nome completo
    const kt = await rp("kitchenA", del.row.id, "KITCHEN_TICKET");
    expect(JSON.stringify(kt.data.payload)).not.toContain("Eduardo");
  });

  it("negações: dono (sem print.request) FORBIDDEN; estranho/outro restaurante/inexistente ORDER_NOT_FOUND; anon sem EXECUTE; nada gravado", async () => {
    const o = await newOrderA("PICKUP");
    const before = rows(await admin().from("print_jobs").select("id").eq("order_id", o.row.id)).length;
    expectRule(await rp("ownerA", o.row.id), /^FORBIDDEN/);
    expectRule(await rp("ownerA", o.row.id, "ORDER_RECEIPT"), /^FORBIDDEN/);
    for (const who of ["plain", "cashierB", "kitchenB", "managerB", "ownerB"]) expectRule(await rp(who, o.row.id), /^ORDER_NOT_FOUND/);
    expectRule(await rp("cashierA", crypto.randomUUID()), /^ORDER_NOT_FOUND/);
    expectDenied(await anon().rpc("request_print", { p_order: o.row.id, p_document_type: "KITCHEN_TICKET" }), /42501|permission denied/i);
    expect(rows(await admin().from("print_jobs").select("id").eq("order_id", o.row.id))).toHaveLength(before);
  });

  it("sem print.request por override (garçom 2 com a permissão revogada): FORBIDDEN ao pedir e PRINT_JOB_NOT_FOUND ao marcar o próprio job", async () => {
    const membership = world().memberships.waiter2A!;
    const o = await newOrderA("PICKUP");
    const job = await rp("waiter2A", o.row.id);
    expectOk(job); // o garçom tem print.request pela matriz
    const ov = await admin().from("membership_permission_overrides").insert({ membership_id: membership, restaurant_id: A().id, permission_key: "print.request", granted: false });
    expectOk(ov);
    try {
      expectRule(await rp("waiter2A", o.row.id), /^FORBIDDEN/);
      expectRule(await mark("waiter2A", job.data.job_id, "DISPATCHED"), /^PRINT_JOB_NOT_FOUND/);
      expect((await jobRow(job.data.job_id)).status).toBe("REQUESTED");
    } finally {
      await admin().from("membership_permission_overrides").delete().eq("membership_id", membership);
    }
    expectOk(await mark("waiter2A", job.data.job_id, "DISPATCHED")); // restaurada
  });

  it("tipo de documento inválido (PARTIAL_BILL/FINAL_BILL são de comanda, lixo, vazio, nulo) => INVALID_DOCUMENT_TYPE", async () => {
    const o = await newOrderA("PICKUP");
    for (const type of ["PARTIAL_BILL", "FINAL_BILL", "NOPE", "", "  ", null, "KITCHEN_TICKET;", "KITCHEN TICKET"]) {
      expectRule(await rp("cashierA", o.row.id, type), /^INVALID_DOCUMENT_TYPE/);
    }
    expect(rows(await admin().from("print_jobs").select("id").eq("order_id", o.row.id))).toHaveLength(0);
  });

  it("mark_print_job: REQUESTED->DISPATCHED (dispatched_at), repetição idempotente, DISPATCHED->FAILED, e FAILED não volta", async () => {
    const o = await newOrderA("PICKUP");
    const job = (await rp("cashierA", o.row.id)).data.job_id as string;
    const d = await mark("cashierA", job, "DISPATCHED");
    expect(d.data).toMatchObject({ ok: true, unchanged: false, job_id: job, status: "DISPATCHED" });
    const row = await jobRow(job);
    expect(row.status).toBe("DISPATCHED");
    expect(row.dispatched_at).toBeTruthy();
    expect(row.printed_at).toBeNull();
    expect((await mark("cashierA", job, "dispatched")).data).toMatchObject({ ok: true, unchanged: true, status: "DISPATCHED" });
    expect((await mark("cashierA", job, "FAILED")).data).toMatchObject({ ok: true, unchanged: false, status: "FAILED" });
    expect((await mark("cashierA", job, "FAILED")).data).toMatchObject({ unchanged: true });
    expectRule(await mark("cashierA", job, "DISPATCHED"), /^PRINT_INVALID_TRANSITION/);
    expect((await jobRow(job)).status).toBe("FAILED");

    // REQUESTED -> FAILED direto também vale
    const job2 = (await rp("kitchenA", o.row.id)).data.job_id as string;
    expect((await mark("kitchenA", job2, "FAILED")).data).toMatchObject({ ok: true, status: "FAILED" });
  });

  it("mark_print_job nunca define PRINTED nem REQUESTED nem lixo (INVALID_PRINT_STATUS); o job não muda", async () => {
    const o = await newOrderA("PICKUP");
    const job = (await rp("cashierA", o.row.id)).data.job_id as string;
    for (const status of ["PRINTED", "REQUESTED", "CANCELLED", "BANANA", "", null, "PRINTED'; --"]) expectRule(await mark("cashierA", job, status), /^INVALID_PRINT_STATUS/);
    const row = await jobRow(job);
    expect(row).toMatchObject({ status: "REQUESTED", printed_at: null, dispatched_at: null });
    // depois de DISPATCHED continua sem poder virar PRINTED
    await mark("cashierA", job, "DISPATCHED");
    expectRule(await mark("cashierA", job, "PRINTED"), /^INVALID_PRINT_STATUS/);
    expect((await jobRow(job)).printed_at).toBeNull();
  });

  it("mark_print_job só pelo solicitante: outro funcionário do mesmo restaurante, gerente, outro restaurante, anon e job inexistente => PRINT_JOB_NOT_FOUND/sem EXECUTE", async () => {
    const o = await newOrderA("PICKUP");
    const job = (await rp("cashierA", o.row.id)).data.job_id as string;
    for (const who of ["kitchenA", "managerA", "waiterA", "ownerA", "plain", "cashierB", "managerB"]) expectRule(await mark(who, job, "DISPATCHED"), /^PRINT_JOB_NOT_FOUND/);
    expectRule(await mark("cashierA", crypto.randomUUID(), "DISPATCHED"), /^PRINT_JOB_NOT_FOUND/);
    expectDenied(await anon().rpc("mark_print_job", { p_job: job, p_status: "DISPATCHED" }), /42501|permission denied/i);
    expect((await jobRow(job)).status).toBe("REQUESTED");
    expectOk(await mark("cashierA", job, "DISPATCHED")); // controle positivo
  });

  it("leitura: o job aparece para quem tem print.request do restaurante (RLS) e não para B; INSERT/UPDATE/DELETE diretos seguem negados", async () => {
    const o = await newOrderA("PICKUP");
    const job = (await rp("cashierA", o.row.id)).data.job_id as string;
    expect(rows(await as("kitchenA").from("print_jobs").select("id").eq("id", job))).toHaveLength(1);
    expect(rows(await as("cashierB").from("print_jobs").select("id").eq("id", job))).toHaveLength(0);
    expect(rows(await anon().from("print_jobs").select("id").eq("id", job))).toHaveLength(0);
    expectDenied(await as("cashierA").from("print_jobs").update({ status: "PRINTED", printed_at: new Date().toISOString() }).eq("id", job).select("id"));
    expectDenied(await as("cashierA").from("print_jobs").update({ status: "DISPATCHED" }).eq("id", job).select("id"));
    expectDenied(await as("cashierA").from("print_jobs").delete().eq("id", job).select("id"));
    expect((await jobRow(job)).status).toBe("REQUESTED");
  });
});

// =====================================================================================================================
// Realtime: pedido criado pelo servidor chega à equipe do restaurante certo e a ninguém mais.
// =====================================================================================================================
interface Ev {
  eventType: string;
  id?: string;
  restaurant_id?: string;
  status?: string;
}
interface Listener {
  events: Ev[];
  channel: RealtimeChannel;
  down: boolean;
}
const rtChannels: Array<{ client: any; channel: RealtimeChannel }> = [];
let activeListeners: Listener[] = [];

async function listenOrders(client: any): Promise<Listener> {
  const events: Ev[] = [];
  const channel = client.channel(`rt20-${Math.random().toString(36).slice(2)}`);
  channel.on("postgres_changes" as never, { event: "*", schema: "public", table: "orders" } as never, (payload: any) => {
    const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old ?? {};
    events.push({ eventType: payload.eventType, id: row.id, restaurant_id: row.restaurant_id, status: row.status });
  });
  const listener: Listener = { events, channel, down: false };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime não assinou orders em 20s")), 20_000);
    channel.subscribe((status: string, err?: Error) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        listener.down = true;
        clearTimeout(timer);
        reject(new Error(`Realtime ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  rtChannels.push({ client, channel });
  activeListeners.push(listener);
  return listener;
}
async function until(cond: () => boolean, what: string, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      if (activeListeners.some((l) => l.down)) throw new Error(`Realtime reiniciou durante o teste (${what}); será repetido`);
      return cond();
    },
    { timeoutMs, what },
  );
}
const bump = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe("Realtime: pedidos públicos chegam à equipe do restaurante certo", { retry: 3 }, () => {
  afterAll(async () => {
    for (const { client, channel } of rtChannels) await client.removeChannel(channel).catch(() => undefined);
  });

  it("equipe de A recebe INSERT e UPDATE do pedido criado por create_public_order e NÃO recebe os de B (e B não recebe os de A)", async () => {
    activeListeners = [];
    const probeA = await makeOrder(cleanup, A().id);
    const probeB = await makeOrder(cleanup, B().id);
    const [la, lk, lb] = [await listenOrders(realtimeAs("cashierA")), await listenOrders(realtimeAs("kitchenA")), await listenOrders(realtimeAs("ownerB"))];

    // aquecimento: toca as sondas até todo assinante vivo receber algo novo
    const baseline = [la, lk, lb].map((l) => l.events.length);
    const deadline = Date.now() + 60_000;
    for (let round = 1; ; round++) {
      await admin().from("orders").update({ estimated_ready_at: bump(round) }).eq("id", probeA.id);
      await admin().from("orders").update({ estimated_ready_at: bump(round) }).eq("id", probeB.id);
      const ok = await until(() => [la, lk, lb].every((l, i) => l.events.length > baseline[i]), "aquecimento", 2_500).then(
        () => true,
        (e: Error) => {
          if (/reiniciou/.test(e.message)) throw e;
          return false;
        },
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error("Realtime não ficou ativo a tempo");
    }

    // B primeiro (commit anterior), depois A: a sentinela de A fecha a janela de observação
    const orderB = await makeOrder(cleanup, B().id, { status: "RECEIVED" });
    expect((await admin().from("orders").update({ status: "CONFIRMED" }).eq("id", orderB.id)).error).toBeNull();
    const created = await newOrderA("PICKUP");
    const id = created.row.id as string;

    await until(() => la.events.some((e) => e.id === id && e.eventType === "INSERT") && lk.events.some((e) => e.id === id && e.eventType === "INSERT") && lb.events.some((e) => e.id === orderB.id), "INSERT do pedido público");
    const ins = la.events.find((e) => e.id === id && e.eventType === "INSERT")!;
    expect(ins).toMatchObject({ restaurant_id: A().id, status: "RECEIVED" });

    expectOk(await cashierTo(id, "CONFIRMED"));
    await until(() => la.events.some((e) => e.id === id && e.eventType === "UPDATE" && e.status === "CONFIRMED") && lk.events.some((e) => e.id === id && e.eventType === "UPDATE" && e.status === "CONFIRMED"), "UPDATE de status");

    // isolamento: nada de B em A e nada de A em B
    expect(la.events.some((e) => e.id === orderB.id || e.restaurant_id === B().id), "equipe de A recebeu evento de B").toBe(false);
    expect(lk.events.some((e) => e.id === orderB.id || e.restaurant_id === B().id), "cozinha de A recebeu evento de B").toBe(false);
    expect(lb.events.some((e) => e.id === id || e.restaurant_id === A().id), "B recebeu evento de A").toBe(false);
    expect(lb.events.every((e) => e.restaurant_id === B().id)).toBe(true);
  });
});
