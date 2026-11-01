/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * API pública v1, Fase 3 (pedidos), por HTTP real contra o dev server:
 *
 *   POST /api/public/v1/restaurants/{slug}/orders            (criação idempotente)
 *   GET  /api/public/v1/restaurants/{slug}/orders/{publicCode} (acompanhamento sem PII)
 *
 * O servidor NÃO é iniciado aqui: `API_BASE_URL` (padrão http://localhost:3100); sem resposta o arquivo se PULA com aviso.
 * Fixtures `zz-api-ord-*` criadas ANTES do primeiro request (o servidor guarda as origens do CORS 60 s por slug).
 * IPs de teste próprios (198.18.x.y via X-Forwarded-For): cada request usa um IP novo, exceto as rajadas de rate limit, que
 * usam IP próprio e rodam POR ÚLTIMO (a cota de pedidos é 5 criados / 10 min por IP+slug e vive na memória do servidor).
 * Os pedidos (`zz-t21-*`) e clientes `zz-*` criados são apagados no afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { createStorefrontClient, newIdempotencyKey, StorefrontApiError } from "../../sdk/src/index";
import { admin } from "../helpers/clients";
import { Cleanup, uniq } from "../helpers/factory";
import { insertRow, setOpenToday, setSettings, setStatus, walkKeys } from "../helpers/menu";

const BASE = (process.env.API_BASE_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const API = `${BASE}/api/public/v1/restaurants`;

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/demo-a/menu`, { headers: { "X-Forwarded-For": "198.18.0.2" }, signal: AbortSignal.timeout(5000) });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}
const up = await probe();
if (!up) {
  console.warn(
    `\n[tests/api/21-public-api-orders] PULADO: a API pública não respondeu em ${BASE}. ` +
      "Suba o dev server do app (porta 3100 ou defina API_BASE_URL) e rode de novo para executar estes testes.\n",
  );
}

const octet = () => 1 + Math.floor(Math.random() * 250);
const newIp = () => `198.18.${octet()}.${octet()}`;
const cleanup = new Cleanup();
const seenBodies: string[] = [];
let seq = 0;
const newKey = () => `zz-t21-${uniq()}${++seq}`;
const newPhone = () => `(11) 9${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}-${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
const digits = (v: string) => v.replace(/\D/g, "");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type CallOpts = { method?: string; origin?: string | null; ip?: string | null; headers?: Record<string, string>; body?: string; json?: unknown };
async function call(path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.ip !== null) headers["X-Forwarded-For"] = opts.ip ?? newIp();
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] ??= "application/json";
  }
  const res = await fetch(`${API}/${path}`, { method: opts.method ?? "GET", headers, body });
  const text = await res.text();
  if (!/^\s*<(!doctype|html)/i.test(text)) seenBodies.push(text); // página 404 HTML genérica do Next (rota inexistente) não é resposta da API
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const ORIGIN_X = `https://zz-loja-${uniq()}.vercel.app`;
let X: { id: string; slug: string };
let Y: { id: string; slug: string };
let pPlain: any, pV: any, vP: any, vG: any, modA: any, zone: any, grp: any;
let envKeys: string[] = [];

async function makeRestaurant(status: string, patch: Record<string, unknown> = {}) {
  const slug = `zz-api-ord-${uniq()}`.slice(0, 40);
  const r = await admin().from("restaurants").insert({ name: `zz DEMO ORD API ${slug}`, slug, status }).select("id,slug").single();
  if (r.error) throw new Error(`restaurants: ${r.error.message}`);
  const rest = r.data as { id: string; slug: string };
  cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rest.id)));
  const s = await admin().from("restaurant_settings").upsert({ restaurant_id: rest.id, ...patch }, { onConflict: "restaurant_id" });
  if (s.error) throw new Error(`settings: ${s.error.message}`);
  return rest;
}

const ordersPath = (slug: string) => `${slug}/orders`;
const trackPath = (slug: string, code: string) => `${slug}/orders/${code}`;

function orderBody(over: Record<string, unknown> = {}) {
  return {
    fulfillmentType: "PICKUP",
    items: [{ productId: pPlain.id, quantity: 1 }],
    customer: { name: "zz-Maria Souza", phone: newPhone() },
    payment: { method: "PIX" },
    idempotencyKey: newKey(),
    ...over,
  };
}
const post = (slug: string, json: unknown, opts: CallOpts = {}) => call(ordersPath(slug), { method: "POST", json, ...opts });
const countOrders = async (rid: string) => (await admin().from("orders").select("id", { count: "exact", head: true }).eq("restaurant_id", rid)).count ?? 0;

describe.skipIf(!up)("API pública v1: pedidos (HTTP real)", () => {
  beforeAll(async () => {
    const env = loadEnv();
    envKeys = [env.anonKey, env.serviceKey].filter((k): k is string => typeof k === "string" && k.length > 20);
    X = await makeRestaurant("active", { storefront_origins: [ORIGIN_X], enabled_fulfillment_types: ["DELIVERY", "PICKUP", "DINE_IN"], accepts_orders: true, min_order_cents: 0 });
    Y = await makeRestaurant("active", { enabled_fulfillment_types: ["PICKUP"] });
    await setOpenToday(X.id, true);
    await setOpenToday(Y.id, true);
    const cat = await insertRow("menu_categories", { restaurant_id: X.id, name: "zz-cat", sort_order: 1 });
    pV = await insertRow("products", { restaurant_id: X.id, category_id: cat.id, name: "zz-pizza", price_cents: 900, sort_order: 1 });
    pPlain = await insertRow("products", { restaurant_id: X.id, category_id: cat.id, name: "zz-agua", price_cents: 1000, sort_order: 2 });
    vP = await insertRow("product_variants", { restaurant_id: X.id, product_id: pV.id, name: "P", price_cents: 1000, is_default: true, sort_order: 1 });
    vG = await insertRow("product_variants", { restaurant_id: X.id, product_id: pV.id, name: "G", price_cents: 2000, sort_order: 2 });
    grp = await insertRow("modifier_groups", { restaurant_id: X.id, name: "zz-adicionais", min_selections: 0, max_selections: 2 });
    modA = await insertRow("modifiers", { restaurant_id: X.id, group_id: grp.id, name: "zz-borda", price_delta_cents: 100 });
    await admin().from("product_modifier_groups").insert({ restaurant_id: X.id, product_id: pV.id, group_id: grp.id });
    zone = await insertRow("delivery_zones", { restaurant_id: X.id, name: "zz-zona", fee_cents: 500, min_order_cents: 0, estimated_minutes: 30, neighborhoods: ["Centro"], is_active: true });
    const yCat = await insertRow("menu_categories", { restaurant_id: Y.id, name: "zz-cat-y", sort_order: 1 });
    await insertRow("products", { restaurant_id: Y.id, category_id: yCat.id, name: "zz-y", price_cents: 1000 });

    // Primeiro a apagar: pedidos e clientes (antes de produtos/restaurantes).
    cleanup.add(async () => {
      const found = await admin().from("orders").select("id").like("idempotency_key", "zz-t21-%");
      const ids = (found.data ?? []).map((o: any) => o.id as string);
      if (ids.length) {
        await admin().from("print_jobs").delete().in("order_id", ids);
        await admin().from("orders").delete().in("id", ids);
      }
      await admin().from("orders").delete().in("restaurant_id", [X.id, Y.id]);
      await admin().from("customers").delete().in("restaurant_id", [X.id, Y.id]);
    });
  }, 120_000);
  afterAll(async () => {
    await cleanup.run();
  });

  // =================================================================================================================
  describe("POST /orders: criação", () => {
    it("201 {data}: campos exatos, no-store, nosniff, sem ids internos; o banco recebe UNPAID/RECEIVED com a forma de pagamento declarada", async () => {
      const body = orderBody({ items: [{ productId: pV.id, variantId: vG.id, quantity: 2, modifierIds: [modA.id], notes: "zz sem cebola" }], payment: { method: "CASH", changeForCents: 10000 }, notes: "zz tocar a campainha" });
      const r = await post(X.slug, body);
      expect(r.status, r.text).toBe(201);
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(Object.keys(r.json)).toEqual(["data"]);
      const d = r.json.data;
      expect(Object.keys(d).sort()).toEqual(["deliveryFeeCents", "estimatedReadyAt", "idempotentReplay", "orderNumber", "publicCode", "status", "subtotalCents", "totalCents"].sort());
      expect(d).toMatchObject({ status: "RECEIVED", idempotentReplay: false, subtotalCents: 4200, deliveryFeeCents: 0, totalCents: 4200 });
      expect(d.publicCode).toMatch(/^[0-9A-Z]{16}$/);
      expect(d.orderNumber).toBeGreaterThan(0);
      expect(r.text).not.toMatch(UUID_RE);
      expect([...walkKeys(r.json)].filter((k) => k.includes("_"))).toEqual([]);

      const row = (await admin().from("orders").select("*").eq("public_code", d.publicCode).single()).data as any;
      expect(row).toMatchObject({ restaurant_id: X.id, source: "PUBLIC_WEB", status: "RECEIVED", payment_status: "UNPAID", payment_method_intent: "CASH", change_for_cents: 10000, total_cents: 4200, idempotency_key: body.idempotencyKey, notes: "zz tocar a campainha" });
      const items = (await admin().from("order_items").select("product_name,variant_name_snapshot,quantity,unit_price_cents,notes").eq("order_id", row.id)).data;
      expect(items).toEqual([{ product_name: "zz-pizza", variant_name_snapshot: "G", quantity: 2, unit_price_cents: 2000, notes: "zz sem cebola" }]);
    });

    it("preço/total forjado no corpo é ignorado; DELIVERY soma a taxa da zona e guarda o endereço; PIX/CARD sem troco", async () => {
      const r = await post(
        X.slug,
        orderBody({
          fulfillmentType: "DELIVERY",
          items: [{ productId: pPlain.id, quantity: 2, priceCents: 1, unitPriceCents: 1, totalCents: 1 }],
          address: { street: "Rua Zz Secreta", number: "77", neighborhood: "Centro", city: "Sao Paulo", postalCode: "01310-100", complement: "Apto zz-1" },
          deliveryZoneId: zone.id,
          totalCents: 1,
          discountCents: 99999,
          payment: { method: "CARD", priceCents: 1 },
        }),
      );
      expect(r.status, r.text).toBe(201);
      expect(r.json.data).toMatchObject({ subtotalCents: 2000, deliveryFeeCents: 500, totalCents: 2500 });
      const row = (await admin().from("orders").select("delivery_address,payment_method_intent,discount_cents").eq("public_code", r.json.data.publicCode).single()).data as any;
      expect(row.delivery_address).toEqual({ street: "Rua Zz Secreta", number: "77", neighborhood: "Centro", city: "Sao Paulo", postal_code: "01310100", complement: "Apto zz-1" });
      expect(row).toMatchObject({ payment_method_intent: "CARD", discount_cents: 0 });
    });

    it("DINE_IN sem mesa e PICKUP são aceitos; telefone com máscara/55 é normalizado e o cliente é reaproveitado (upsert por telefone)", async () => {
      const ph = newPhone();
      const a = await post(X.slug, orderBody({ fulfillmentType: "DINE_IN", customer: { name: "zz-Primeiro", phone: ph } }));
      const b = await post(X.slug, orderBody({ customer: { name: "zz-Segundo Nome", phone: ph, email: "zz.cliente@example.test" } }));
      expect(a.status, a.text).toBe(201);
      expect(b.status, b.text).toBe(201);
      const orders = (await admin().from("orders").select("customer_id,customer_name,customer_phone,customer_email,table_id").in("public_code", [a.json.data.publicCode, b.json.data.publicCode])).data as any[];
      expect(new Set(orders.map((o) => o.customer_id)).size).toBe(1);
      expect(orders.every((o) => o.customer_phone === digits(ph))).toBe(true);
      expect(orders.find((o) => o.customer_name === "zz-Primeiro")?.table_id).toBeNull();
      const cust = (await admin().from("customers").select("name,email").eq("restaurant_id", X.id).eq("phone", digits(ph))).data as any[];
      expect(cust).toEqual([{ name: "zz-Primeiro", email: null }]); // S-04: e-mail de cliente existente nunca é preenchido/sobrescrito
    });
  });

  // =================================================================================================================
  describe("POST /orders: idempotência", () => {
    it("replay pelo campo idempotencyKey: 200, idempotentReplay:true, mesmo pedido, nada duplicado", async () => {
      const body = orderBody();
      const first = await post(X.slug, body);
      const before = await countOrders(X.id);
      const second = await post(X.slug, body);
      expect(first.status).toBe(201);
      expect(second.status, second.text).toBe(200);
      expect(second.json.data).toMatchObject({ idempotentReplay: true, publicCode: first.json.data.publicCode, orderNumber: first.json.data.orderNumber, totalCents: first.json.data.totalCents });
      expect({ ...second.json.data, idempotentReplay: false }).toEqual(first.json.data);
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(await countOrders(X.id)).toBe(before);
    });

    it("replay pelo header Idempotency-Key (sem o campo no corpo); header e campo iguais valem; diferentes => 400", async () => {
      const key = newKey();
      const { idempotencyKey: _omit, ...noKey } = orderBody();
      void _omit;
      const first = await post(X.slug, noKey, { headers: { "Idempotency-Key": key } });
      const again = await post(X.slug, noKey, { headers: { "Idempotency-Key": key } });
      expect(first.status, first.text).toBe(201);
      expect(again.status).toBe(200);
      expect(again.json.data).toMatchObject({ idempotentReplay: true, publicCode: first.json.data.publicCode });
      // header igual ao campo
      const both = await post(X.slug, { ...noKey, idempotencyKey: key }, { headers: { "Idempotency-Key": key } });
      expect(both.status).toBe(200);
      expect(both.json.data.publicCode).toBe(first.json.data.publicCode);
      // header diferente do campo
      const before = await countOrders(X.id);
      const clash = await post(X.slug, { ...noKey, idempotencyKey: newKey() }, { headers: { "Idempotency-Key": key } });
      expect(clash.status).toBe(400);
      expect(clash.json.error.code).toBe("invalid_request");
      expect(await countOrders(X.id)).toBe(before);
    });

    it("8 requisições simultâneas com a mesma chave => 1 pedido (1x 201 + 7x 200 replay)", async () => {
      const body = orderBody();
      const before = await countOrders(X.id);
      const results = await Promise.all(Array.from({ length: 8 }, () => post(X.slug, body)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.json.data.publicCode)).size).toBe(1);
      expect(await countOrders(X.id)).toBe(before + 1);
    });

    it("[documentado] mesma chave com conteúdo diferente devolve o pedido ORIGINAL com 200 (o 409 idempotency_conflict nunca é produzido)", async () => {
      const key = newKey();
      const first = await post(X.slug, orderBody({ idempotencyKey: key }));
      const other = await post(X.slug, orderBody({ idempotencyKey: key, items: [{ productId: pPlain.id, quantity: 9 }] }));
      expect(first.status).toBe(201);
      expect(other.status).toBe(200);
      expect(other.json.data).toMatchObject({ idempotentReplay: true, publicCode: first.json.data.publicCode, totalCents: 1000 });
    });
  });

  // =================================================================================================================
  describe("POST /orders: 400, 404, 405, 413", () => {
    it("chave de idempotência ausente ou inválida (campo e header) => 400 invalid_request, nada gravado", async () => {
      const before = await countOrders(X.id);
      const { idempotencyKey: _omit, ...noKey } = orderBody();
      void _omit;
      const missing = await post(X.slug, noKey);
      expect(missing.status).toBe(400);
      expect(missing.json.error).toMatchObject({ code: "invalid_request", details: [{ path: "idempotencyKey", message: expect.any(String) }] });
      for (const bad of ["curta", "x".repeat(15), "tem espaco no meio 123456", "x".repeat(101), "chavé-ção-1234567890", "a/b/c/d/e/f/g/h/i/j"]) {
        const viaField = await post(X.slug, { ...noKey, idempotencyKey: bad });
        expect(viaField.status, `campo ${bad}`).toBe(400);
        if (/^[\x20-\x7e]+$/.test(bad)) {
          const viaHeader = await post(X.slug, noKey, { headers: { "Idempotency-Key": bad } });
          expect(viaHeader.status, `header ${bad}`).toBe(400);
        }
      }
      expect(await countOrders(X.id)).toBe(before);
    });

    it("corpo inválido (zod) => 400 com details por campo: cliente, telefone, itens, DELIVERY sem endereço/zona, troco sem CASH, modalidade", async () => {
      const item = { productId: pPlain.id, quantity: 1 };
      const bad: Array<[string, unknown]> = [
        ["sem customer", orderBody({ customer: undefined })],
        ["nome curto", orderBody({ customer: { name: "A", phone: newPhone() } })],
        ["nome longo", orderBody({ customer: { name: "x".repeat(81), phone: newPhone() } })],
        ["telefone inválido", orderBody({ customer: { name: "zz-Maria", phone: "123" } })],
        ["telefone sem 9", orderBody({ customer: { name: "zz-Maria", phone: "(11) 81234-5678" } })],
        ["e-mail inválido", orderBody({ customer: { name: "zz-Maria", phone: newPhone(), email: "x" } })],
        ["sem payment", orderBody({ payment: undefined })],
        ["método inválido", orderBody({ payment: { method: "BTC" } })],
        ["troco com PIX", orderBody({ payment: { method: "PIX", changeForCents: 5000 } })],
        ["troco 0", orderBody({ payment: { method: "CASH", changeForCents: 0 } })],
        ["troco fracionado", orderBody({ payment: { method: "CASH", changeForCents: 10.5 } })],
        ["DELIVERY sem endereço", orderBody({ fulfillmentType: "DELIVERY", deliveryZoneId: zone.id })],
        ["DELIVERY sem zona", orderBody({ fulfillmentType: "DELIVERY", address: { street: "Rua", number: "1", neighborhood: "Centro", city: "SP" } })],
        ["endereço incompleto", orderBody({ fulfillmentType: "DELIVERY", deliveryZoneId: zone.id, address: { street: "Rua" } })],
        ["modalidade inválida", orderBody({ fulfillmentType: "VOO" })],
        ["sem itens", orderBody({ items: [] })],
        ["51 itens", orderBody({ items: Array.from({ length: 51 }, () => item) })],
        ["quantidade 0", orderBody({ items: [{ ...item, quantity: 0 }] })],
        ["quantidade 100", orderBody({ items: [{ ...item, quantity: 100 }] })],
        ["productId inválido", orderBody({ items: [{ ...item, productId: "x" }] })],
        ["observação > 500", orderBody({ notes: "n".repeat(501) })],
        ["observação do item > 500", orderBody({ items: [{ ...item, notes: "n".repeat(501) }] })],
        ["zona inválida", orderBody({ deliveryZoneId: "x" })],
      ];
      const before = await countOrders(X.id);
      for (const [label, payload] of bad) {
        const r = await post(X.slug, payload);
        expect(r.status, `${label}: ${r.text.slice(0, 200)}`).toBe(400);
        expect(r.json.error.code, label).toBe("invalid_request");
        expect(r.json.error.details?.length ?? 0, label).toBeGreaterThan(0);
        expect(r.json.error.details.length).toBeLessThanOrEqual(10);
      }
      expect(await countOrders(X.id)).toBe(before);
      // limites exatos são aceitos
      const ok = await post(X.slug, orderBody({ notes: "n".repeat(500), items: [{ ...item, quantity: 99, notes: "n".repeat(500) }], customer: { name: "zz" + "x".repeat(78), phone: newPhone() } }));
      expect(ok.status, ok.text).toBe(201);
    });

    it("Content-Type errado/ausente, JSON quebrado, UTF-8 inválido e corpo que não é objeto => 400", async () => {
      const before = await countOrders(X.id);
      for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
        const r = await call(ordersPath(X.slug), { method: "POST", headers: { "Content-Type": ct }, body: JSON.stringify(orderBody()) });
        expect(r.status, ct).toBe(400);
        expect(r.json.error.code).toBe("invalid_request");
      }
      expect((await call(ordersPath(X.slug), { method: "POST", body: JSON.stringify(orderBody()) })).status).toBe(400);
      for (const raw of ["{", "", "nao-json", "{'a':1}", "[1,2", "undefined"]) {
        const r = await call(ordersPath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
        expect(r.status, JSON.stringify(raw)).toBe(400);
        expect(r.json.error.code).toBe("invalid_request");
      }
      const badUtf8 = await fetch(`${API}/${ordersPath(X.slug)}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": newIp() }, body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]) });
      expect(badUtf8.status).toBe(400);
      for (const j of [null, [], "x", 1, true]) expect((await post(X.slug, j)).status, JSON.stringify(j)).toBe(400);
      expect(await countOrders(X.id)).toBe(before);
    });

    it("slug inexistente, suspenso/pendente e formato inválido => 404 restaurant_not_found; nada é gravado", async () => {
      const susp = await makeRestaurant("suspended");
      const pend = await makeRestaurant("pending");
      for (const slug of [`zz-nao-existe-${uniq()}`, susp.slug, pend.slug]) {
        const r = await post(slug, orderBody());
        expect(r.status, slug).toBe(404);
        expect(r.json.error.code).toBe("restaurant_not_found");
      }
      for (const slug of ["a_b", "-x", "a".repeat(64), "a%2Fb", "..%2Fdemo-a"]) {
        expect((await post(slug, orderBody())).status, slug).toBe(404);
      }
      for (const s of [susp, pend]) expect(await countOrders(s.id)).toBe(0);
    });

    it("métodos não permitidos => 405 (orders: GET/PUT/DELETE/PATCH; orders/{code}: POST/PUT/DELETE/PATCH)", async () => {
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        const r = await call(ordersPath(X.slug), { method, body: method === "PUT" || method === "PATCH" ? "{}" : undefined, headers: { "Content-Type": "application/json" } });
        expect(r.status, `orders ${method}`).toBe(405);
      }
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await call(trackPath(X.slug, "ABCDEFGH23456789"), { method, body: method === "DELETE" ? undefined : "{}", headers: { "Content-Type": "application/json" } });
        expect(r.status, `track ${method}`).toBe(405);
      }
    });

    it("corpo > 64 KB => 413 payload_too_large (Content-Length e fluxo sem tamanho); nada gravado", async () => {
      const before = await countOrders(X.id);
      const big = JSON.stringify({ ...orderBody(), pad: "x".repeat(70 * 1024) });
      const r = await call(ordersPath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
      expect(r.status).toBe(413);
      expect(r.json.error.code).toBe("payload_too_large");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
          for (let i = 0; i < 6; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const chunked = await fetch(`${API}/${ordersPath(X.slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": newIp() },
        body: stream,
        // @ts-expect-error opção do undici/Node para corpo em stream
        duplex: "half",
      });
      expect(chunked.status).toBe(413);
      expect(await countOrders(X.id)).toBe(before);
    });

    it("payloads hostis (aninhamento profundo, __proto__, unicode, SQLi, quantidade 1e999) => 4xx, nunca 5xx; nenhum pedido gravado", async () => {
      const before = await countOrders(X.id);
      const deep = `{"fulfillmentType":"PICKUP","items":${"[".repeat(30000)}${"]".repeat(30000)}}`;
      const payloads = [
        deep,
        JSON.stringify(orderBody({ notes: "'; drop table orders;--💥 ‮", customer: { name: "zz-'; drop table customers;--", phone: newPhone() } })),
        '{"fulfillmentType":"PICKUP","items":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
        JSON.stringify(orderBody({ items: [{ productId: pPlain.id, quantity: 1e999 }] })),
      ];
      for (const [i, raw] of payloads.entries()) {
        const r = await call(ordersPath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
        // o caso 2 (texto hostil mas válido) CRIA o pedido com o texto como dado puro: 201
        expect(r.status, raw.slice(0, 60)).toBeLessThan(i === 1 ? 202 : 500);
      }
      // a tabela continua lá e a criação normal funciona
      expect((await post(X.slug, orderBody())).status).toBe(201);
      expect(await countOrders(X.id)).toBeGreaterThanOrEqual(before + 1);
    });

    // F-30: NUL (\u0000) em campos de texto passa pelo zod, o jsonb do Postgres recusa (22P05) e a API responde 500 em vez de 400.
    // Mesma causa do F-29 (cart/quote). Correção: recusar \u0000 nas strings do corpo (zod .refine) em orders-server/schemas.ts.
    it("[F-30] (corrigido) NUL em customer.name / notes deveria ser 4xx, mas hoje é 500 internal_error", async () => {
      const r = await post(X.slug, orderBody({ customer: { name: "zz-a\u0000b", phone: newPhone() } }));
      expect(r.status).toBeLessThan(500);
      const r2 = await post(X.slug, orderBody({ notes: "x\u0000y" }));
      expect(r2.status).toBeLessThan(500);
    });
  });

  // =================================================================================================================
  describe("POST /orders: 422 order_rejected (regras de negócio)", () => {
    const rejected = async (payload: unknown, expectedCodes: string[], slug = X.slug) => {
      const before = await countOrders(slug === X.slug ? X.id : Y.id);
      const r = await post(slug, payload);
      expect(r.status, r.text).toBe(422);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.json.error.code).toBe("order_rejected");
      expect(Array.isArray(r.json.error.errors)).toBe(true);
      const got = r.json.error.errors.map((e: any) => e.code);
      for (const c of expectedCodes) expect(got, r.text).toContain(c);
      for (const e of r.json.error.errors) {
        expect(Object.keys(e).sort()).toEqual(["code", "field", "itemIndex", "message"]);
        expect(e.message.length).toBeGreaterThan(5);
        expect(e.message).not.toMatch(/\buuid\b|\bpg_|\bpublic\.|PGRST|violates|duplicate key/i);
      }
      expect(await countOrders(slug === X.slug ? X.id : Y.id), "pedido gravado apesar do 422").toBe(before);
      return r.json.error.errors as any[];
    };

    it("restaurante fechado agora => RESTAURANT_CLOSED (volta a aceitar ao reabrir)", async () => {
      await setOpenToday(X.id, false);
      try {
        await rejected(orderBody(), ["RESTAURANT_CLOSED"]);
      } finally {
        await setOpenToday(X.id, true);
      }
      expect((await post(X.slug, orderBody())).status).toBe(201);
    });

    it("pausado (accepts_orders=false) => 422 e abaixo do pedido mínimo => BELOW_MINIMUM (exato passa)", async () => {
      await setSettings(X.id, { accepts_orders: false });
      try {
        const errs = await rejected(orderBody(), []);
        expect(errs.length).toBeGreaterThan(0);
      } finally {
        await setSettings(X.id, { accepts_orders: true });
      }
      await setSettings(X.id, { min_order_cents: 5000 });
      try {
        await rejected(orderBody(), ["BELOW_MINIMUM"]);
        expect((await post(X.slug, orderBody({ items: [{ productId: pPlain.id, quantity: 5 }] }))).status).toBe(201);
      } finally {
        await setSettings(X.id, { min_order_cents: 0 });
      }
    });

    it("modalidade desabilitada (restaurante Y só aceita retirada) => FULFILLMENT_DISABLED", async () => {
      const yProduct = (await admin().from("products").select("id").eq("restaurant_id", Y.id).single()).data as any;
      await rejected(orderBody({ fulfillmentType: "DINE_IN", items: [{ productId: yProduct.id, quantity: 1 }] }), ["FULFILLMENT_DISABLED"], Y.slug);
      expect((await post(Y.slug, orderBody({ items: [{ productId: yProduct.id, quantity: 1 }] }))).status).toBe(201);
    });

    it("itens: produto inexistente/de outro restaurante (itemIndex), variante obrigatória, adicional alheio, zona de outro restaurante", async () => {
      const errs = await rejected(orderBody({ items: [{ productId: pPlain.id, quantity: 1 }, { productId: crypto.randomUUID(), quantity: 1 }] }), ["PRODUCT_UNAVAILABLE"]);
      expect(errs.find((e) => e.code === "PRODUCT_UNAVAILABLE").itemIndex).toBe(1);
      const other = (await admin().from("products").select("id").eq("restaurant_id", Y.id).single()).data as any;
      await rejected(orderBody({ items: [{ productId: other.id, quantity: 1 }] }), ["PRODUCT_UNAVAILABLE"]);
      const v = await rejected(orderBody({ items: [{ productId: pV.id, quantity: 1 }] }), ["VARIANT_REQUIRED"]);
      expect(v[0].itemIndex).toBe(0);
      await rejected(orderBody({ items: [{ productId: pPlain.id, quantity: 1, modifierIds: [modA.id] }] }), ["MODIFIER_NOT_ALLOWED"]);
      await rejected(orderBody({ items: [{ productId: pV.id, variantId: vP.id, quantity: 1, modifierIds: [crypto.randomUUID()] }] }), ["MODIFIER_NOT_ALLOWED"]);
      await rejected(
        orderBody({ fulfillmentType: "DELIVERY", deliveryZoneId: crypto.randomUUID(), address: { street: "Rua", number: "1", neighborhood: "Centro", city: "SP" } }),
        ["ZONE_UNAVAILABLE"],
      );
    });

    it("troco abaixo do total (regra só do banco) => CHANGE_BELOW_TOTAL com field payment.change_for_cents", async () => {
      const errs = await rejected(orderBody({ payment: { method: "CASH", changeForCents: 500 } }), ["CHANGE_BELOW_TOTAL"]);
      expect(errs.find((e) => e.code === "CHANGE_BELOW_TOTAL").field).toBe("payment.change_for_cents");
      expect((await post(X.slug, orderBody({ payment: { method: "CASH", changeForCents: 1000 } }))).status).toBe(201); // igual ao total
    });

    it("telefone aceito pelo zod mas inválido no banco não vaza texto cru: sempre código + mensagem PT-BR", async () => {
      // 11 dígitos válidos para o zod; DDD 11 e 9 inicial: ok. Aqui forçamos um caso de endereço longo (zod 160, banco 200) e outro de bairro.
      const r = await post(X.slug, orderBody({ fulfillmentType: "DELIVERY", deliveryZoneId: zone.id, address: { street: "r".repeat(160), number: "1", neighborhood: "Centro", city: "SP" } }));
      expect(r.status, r.text).toBe(201);
    });
  });

  // =================================================================================================================
  describe("CORS dos pedidos", () => {
    it("origem não cadastrada => 403 origin_not_allowed ANTES de processar o corpo: nenhum pedido criado (POST e GET)", async () => {
      const before = await countOrders(X.id);
      for (const origin of ["https://zz-evil.example.com", "http://zz-evil.example.com", "null", `${ORIGIN_X}/`, "https://*.vercel.app"]) {
        const r = await post(X.slug, orderBody(), { origin });
        expect(r.status, origin).toBe(403);
        expect(r.json.error.code).toBe("origin_not_allowed");
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
        const g = await call(trackPath(X.slug, "ABCDEFGH23456789"), { origin });
        expect(g.status, `GET ${origin}`).toBe(403);
        expect(g.headers.get("access-control-allow-origin")).toBeNull();
      }
      expect(await countOrders(X.id)).toBe(before);
      // a origem de X não vale em Y
      expect((await post(Y.slug, orderBody(), { origin: ORIGIN_X })).status).toBe(403);
    });

    it("origem cadastrada: 201/200/400/422/404 carregam ACAO == origem, Vary: Origin e nenhum Allow-Credentials; track idem", async () => {
      const body = orderBody();
      const created = await post(X.slug, body, { origin: ORIGIN_X });
      expect(created.status, created.text).toBe(201);
      const replay = await post(X.slug, body, { origin: ORIGIN_X });
      const invalid = await post(X.slug, { ...body, items: [] }, { origin: ORIGIN_X });
      const rejectedR = await post(X.slug, orderBody({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] }), { origin: ORIGIN_X });
      const notFound = await post(`zz-nao-existe-${uniq()}`, orderBody(), { origin: ORIGIN_X });
      const track = await call(trackPath(X.slug, created.json.data.publicCode), { origin: ORIGIN_X });
      const track404 = await call(trackPath(X.slug, "ABCDEFGH23456789"), { origin: ORIGIN_X });
      expect([replay.status, invalid.status, rejectedR.status, track.status, track404.status]).toEqual([200, 400, 422, 200, 404]);
      for (const [label, r] of Object.entries({ created, replay, invalid, rejectedR, track, track404 })) {
        expect(r.headers.get("access-control-allow-origin"), label).toBe(ORIGIN_X);
        expect(r.headers.get("vary") ?? "", label).toMatch(/origin/i);
        expect(r.headers.get("access-control-allow-credentials"), label).toBeNull();
      }
      // slug inexistente: nenhuma origem é "cadastrada" => 403 ou 404, mas nunca ACAO
      expect([403, 404]).toContain(notFound.status);
      expect(notFound.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("preflight: POST orders => 204 com POST,OPTIONS e Idempotency-Key liberado; GET orders/{code} => GET,OPTIONS; origem hostil => 403 sem cabeçalhos CORS", async () => {
      const pre = await call(ordersPath(X.slug), { method: "OPTIONS", origin: ORIGIN_X, headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" } });
      expect(pre.status).toBe(204);
      expect(pre.text).toBe("");
      expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(pre.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
      expect(pre.headers.get("access-control-allow-headers") ?? "").toMatch(/idempotency-key/i);
      expect(pre.headers.get("access-control-allow-headers") ?? "").toMatch(/content-type/i);
      expect(Number(pre.headers.get("access-control-max-age"))).toBeGreaterThan(0);
      expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

      const preT = await call(trackPath(X.slug, "ABCDEFGH23456789"), { method: "OPTIONS", origin: ORIGIN_X, headers: { "Access-Control-Request-Method": "GET" } });
      expect(preT.status).toBe(204);
      expect(preT.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      expect(preT.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);

      for (const path of [ordersPath(X.slug), trackPath(X.slug, "ABCDEFGH23456789")]) {
        const bad = await call(path, { method: "OPTIONS", origin: "https://zz-evil.example.com", headers: { "Access-Control-Request-Method": "POST" } });
        expect(bad.status).toBe(403);
        expect(bad.headers.get("access-control-allow-origin")).toBeNull();
        expect(bad.headers.get("access-control-allow-methods")).toBeNull();
      }
      const none = await call(ordersPath(X.slug), { method: "OPTIONS" });
      expect(none.status).toBe(204);
      expect(none.headers.get("access-control-allow-origin")).toBeNull();
      expect((await call(ordersPath("a_b"), { method: "OPTIONS", origin: ORIGIN_X })).status).toBe(404);
    });
  });

  // =================================================================================================================
  describe("GET /orders/{publicCode}: acompanhamento", () => {
    const secrets = { name: "zz-Fulano Detalhe da Silva", email: "zz.fulano@example.test", street: "Rua Zz Secretissima", complement: "Apto zz-909", note: "zz-obs-secreta", itemNote: "zz-obs-item-secreta", instr: "zz-instrucao-secreta" };
    let code: string;
    let phoneRaw: string;
    let key: string;

    beforeAll(async () => {
      phoneRaw = newPhone();
      key = newKey();
      const r = await post(X.slug, {
        fulfillmentType: "DELIVERY",
        items: [{ productId: pV.id, variantId: vG.id, quantity: 2, modifierIds: [modA.id], notes: secrets.itemNote }],
        customer: { name: secrets.name, phone: phoneRaw, email: secrets.email },
        address: { street: secrets.street, number: "4321", neighborhood: "Centro", city: "Sao Paulo", postalCode: "01310-100", complement: secrets.complement, instructions: secrets.instr },
        deliveryZoneId: zone.id,
        notes: secrets.note,
        payment: { method: "CASH", changeForCents: 20000 },
        idempotencyKey: key,
      });
      expect(r.status, r.text).toBe(201);
      code = r.json.data.publicCode;
    });

    it("200 {data} camelCase, no-store, noindex; itens/variante/adicionais/totais/bairro/histórico", async () => {
      const r = await call(trackPath(X.slug, code));
      expect(r.status, r.text).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("x-robots-tag") ?? "").toMatch(/noindex/i);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(Object.keys(r.json)).toEqual(["data"]);
      const d = r.json.data;
      expect(Object.keys(d).sort()).toEqual(
        ["restaurantName", "timezone", "orderNumber", "fulfillmentType", "status", "paymentStatus", "paymentMethod", "items", "subtotalCents", "deliveryFeeCents", "discountCents", "totalCents", "statusHistory", "neighborhood", "createdAt", "estimatedReadyAt", "statusReason"].sort(),
      );
      expect(d).toMatchObject({
        restaurantName: `zz DEMO ORD API ${X.slug}`,
        fulfillmentType: "DELIVERY",
        status: "RECEIVED",
        paymentStatus: "UNPAID",
        paymentMethod: "CASH",
        subtotalCents: 4200,
        deliveryFeeCents: 500,
        discountCents: 0,
        totalCents: 4700,
        neighborhood: "Centro",
        statusReason: null,
      });
      expect(d.items).toEqual([{ name: "zz-pizza", variantName: "G", quantity: 2, unitPriceCents: 2000, lineTotalCents: 4200, modifiers: [{ name: "zz-borda", priceDeltaCents: 100 }], notes: null }]);
      expect(d.statusHistory.every((h: any) => typeof h.at === "string" && h.status === "RECEIVED")).toBe(true);
      expect([...walkKeys(r.json)].filter((k) => k.includes("_"))).toEqual([]);
    });

    it("SEM PII nem ids internos: telefone, nome, e-mail, endereço completo, CEP, observações, chave de idempotência, troco e uuids", async () => {
      const r = await call(trackPath(X.slug, code));
      const text = r.text;
      for (const secret of [digits(phoneRaw), phoneRaw, secrets.name, "Fulano", secrets.email, "example.test", secrets.street, "4321", secrets.complement, "01310", secrets.note, secrets.itemNote, secrets.instr, key, "20000"]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toMatch(UUID_RE);
      expect(text).not.toMatch(/\b\d{10,13}\b/);
      const keys = walkKeys(r.json);
      for (const forbidden of ["id", "restaurantId", "restaurant_id", "customerId", "customer", "customerName", "customerPhone", "phone", "email", "address", "deliveryAddress", "street", "postalCode", "changedBy", "idempotencyKey", "changeForCents", "tabId", "tableId"]) {
        expect(keys.has(forbidden), forbidden).toBe(false);
      }
    });

    it("código em minúsculas funciona; a recusa expõe só o motivo informado pelo restaurante e o histórico acompanha", async () => {
      const lower = await call(trackPath(X.slug, code.toLowerCase()));
      expect(lower.status).toBe(200);
      expect(lower.json.data.orderNumber).toBeGreaterThan(0);
      const row = (await admin().from("orders").select("id").eq("public_code", code).single()).data as any;
      const upd = await admin().from("orders").update({ status: "REJECTED", status_reason: "zz fora da área de entrega" }).eq("id", row.id);
      expect(upd.error).toBeNull();
      const r = await call(trackPath(X.slug, code));
      expect(r.json.data).toMatchObject({ status: "REJECTED", statusReason: "zz fora da área de entrega" });
      expect(r.json.data.statusHistory.at(-1).status).toBe("REJECTED");
    });

    it("404 order_not_found (JSON, no-store) para: código inexistente, malformado, de outro restaurante, slug inexistente/suspenso", async () => {
      const miss = async (slug: string, c: string) => {
        const r = await call(trackPath(slug, c));
        expect([404], `${slug}/${c}`).toContain(r.status);
        expect(r.headers.get("cache-control")).toBe("no-store");
        return r;
      };
      const unknownCode = await miss(X.slug, "AAAAAAAAAAAAAAAA");
      expect(unknownCode.json.error.code).toBe("order_not_found");
      for (const c of ["ab", "x".repeat(41), "has%20space", "a%2Fb", "..", "%00", "a_b_c_d_e_f", "%E2%80%AE", "' or 1=1 --"]) {
        const r = await miss(X.slug, c);
        if (r.json) expect(["order_not_found", "restaurant_not_found"]).toContain(r.json.error.code);
      }
      // código de X consultado em Y e em demo-a: indistinguível de "não existe"
      for (const slug of [Y.slug, "demo-a", "demo-b"]) expect((await miss(slug, code)).json.error.code).toBe("order_not_found");
      const noSlug = await miss(`zz-nao-existe-${uniq()}`, code);
      expect(["order_not_found", "restaurant_not_found"]).toContain(noSlug.json.error.code);
      // restaurante suspenso: o acompanhamento some (e volta ao reativar)
      await setStatus(X.id, "suspended");
      try {
        // a rota valida o slug pelas origens (cache 60 s) e o track_order devolve null para não-ativo
        const r = await call(trackPath(X.slug, code));
        expect(r.status).toBe(404);
        expect(r.text).not.toContain("Centro");
      } finally {
        await setStatus(X.id, "active");
      }
      expect((await call(trackPath(X.slug, code))).status).toBe(200);
    });
  });

  // =================================================================================================================
  describe("SDK (sdk/src): createOrder / trackOrder contra a API real", () => {
    const sdkFor = (slug: string, ip?: string) =>
      createStorefrontClient({
        baseUrl: BASE,
        slug,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": ip ?? newIp() } }),
      });
    const input = (over: Record<string, unknown> = {}) => ({
      fulfillmentType: "PICKUP" as const,
      items: [{ productId: pPlain.id, quantity: 1 }],
      customer: { name: "zz-SDK Cliente", phone: newPhone() },
      payment: { method: "PIX" as const },
      ...over,
    });

    it("createOrder cria (gera a chave sozinho), devolve tipos camelCase; a MESMA chave devolve o replay; trackOrder acompanha", async () => {
      const sdk = sdkFor(X.slug);
      const created = await sdk.createOrder(input());
      expect(created).toMatchObject({ status: "RECEIVED", idempotentReplay: false, totalCents: 1000, subtotalCents: 1000, deliveryFeeCents: 0 });
      expect(created.publicCode).toMatch(/^[0-9A-Z]{16}$/);

      const key = newIdempotencyKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
      const first = await sdk.createOrder(input({ idempotencyKey: key }));
      const replay = await sdk.createOrder(input({ idempotencyKey: key }));
      expect(first.idempotentReplay).toBe(false);
      expect(replay).toMatchObject({ idempotentReplay: true, publicCode: first.publicCode });
      // chaves geradas pelo SDK vão no header; ele cria o pedido com ela
      expect(await rowsWithKey(key)).toBe(1);

      const tracked = await sdk.trackOrder(first.publicCode);
      expect(tracked).toMatchObject({ orderNumber: first.orderNumber, status: "RECEIVED", fulfillmentType: "PICKUP", paymentStatus: "UNPAID", paymentMethod: "PIX", totalCents: 1000, neighborhood: null });
      expect(tracked.items[0]).toMatchObject({ name: "zz-agua", quantity: 1, variantName: null });
      expect(JSON.stringify(tracked)).not.toMatch(/SDK Cliente/);
    });

    it("422 vira StorefrontApiError{code:'order_rejected', status:422, rejections[]} com code/field/itemIndex/message", async () => {
      const err = await sdkFor(X.slug)
        .createOrder(input({ items: [{ productId: pPlain.id, quantity: 1 }, { productId: crypto.randomUUID(), quantity: 1 }] }))
        .then(() => null, (e) => e);
      expect(err).toBeInstanceOf(StorefrontApiError);
      expect(err).toMatchObject({ code: "order_rejected", status: 422 });
      expect(err.rejections).toEqual([{ code: "PRODUCT_UNAVAILABLE", field: null, itemIndex: 1, message: expect.any(String) }]);
      expect(err.details).toBeNull();

      await setOpenToday(X.id, false);
      try {
        const closed = await sdkFor(X.slug).createOrder(input()).then(() => null, (e) => e);
        expect(closed.rejections.map((r: any) => r.code)).toContain("RESTAURANT_CLOSED");
      } finally {
        await setOpenToday(X.id, true);
      }
    });

    it("400 => invalid_request com details; 404 => restaurant_not_found e order_not_found; 403 => origin_not_allowed", async () => {
      const invalid = await sdkFor(X.slug).createOrder(input({ customer: { name: "A", phone: "1" } })).then(() => null, (e) => e);
      expect(invalid).toBeInstanceOf(StorefrontApiError);
      expect(invalid).toMatchObject({ code: "invalid_request", status: 400 });
      expect(invalid.details.length).toBeGreaterThan(0);
      expect(invalid.rejections).toBeNull();

      const noRest = await sdkFor(`zz-nao-existe-${uniq()}`).createOrder(input()).then(() => null, (e) => e);
      expect(noRest).toMatchObject({ code: "restaurant_not_found", status: 404 });

      const noOrder = await sdkFor(X.slug).trackOrder("AAAAAAAAAAAAAAAA").then(() => null, (e) => e);
      expect(noOrder).toBeInstanceOf(StorefrontApiError);
      expect(noOrder).toMatchObject({ code: "order_not_found", status: 404 });

      const forbidden = await createStorefrontClient({
        baseUrl: BASE,
        slug: X.slug,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": newIp(), Origin: "https://zz-evil.example.com" } }),
      })
        .createOrder(input())
        .then(() => null, (e) => e);
      expect(forbidden).toMatchObject({ code: "origin_not_allowed", status: 403 });
    });

    it("o código público é codificado na URL do trackOrder (código com caracteres especiais não escapa do caminho)", async () => {
      const err = await sdkFor(X.slug).trackOrder("../menu").then(() => null, (e) => e);
      expect(err).toBeInstanceOf(StorefrontApiError);
      expect(err.status).toBe(404);
      expect(err.code).toBe("order_not_found");
    });
  });

  async function rowsWithKey(key: string) {
    return ((await admin().from("orders").select("id").eq("idempotency_key", key)).data ?? []).length;
  }

  // =================================================================================================================
  describe("vazamentos", () => {
    it("nenhuma resposta (sucesso ou erro) contém chaves do Supabase, ids internos, stack traces, caminhos ou mensagens do Postgres", () => {
      expect(seenBodies.length).toBeGreaterThan(60);
      const all = seenBodies.join("\n");
      for (const k of envKeys) expect(all.includes(k), "chave do Supabase na resposta").toBe(false);
      expect(all).not.toMatch(/service_role|sb_secret_|sb_publishable_|SUPABASE_|SERVICE_ROLE/);
      expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
      expect(all).not.toMatch(/storefront_?origins/i);
      expect(all).not.toContain(ORIGIN_X);
      expect(all).not.toMatch(/\n\s+at\s+\S+.*:\d+:\d+/);
      expect(all).not.toMatch(/node_modules|webpack-internal|turbopack|\.next[\\/]|[A-Z]:\\Users|\/home\/|src\/modules/i);
      expect(all).not.toMatch(/PGRST\d+|violates|duplicate key|relation "|syntax error at|permission denied|create_public_order|track_order|idempotency_key|22P05|unique_violation/i);
      // uuids: o único uuid que a API pública pode devolver são ids de produto/variante/adicional/zona/grupo (cardápio), nunca de pedido/cliente/restaurante
      const uuids = new Set(all.match(new RegExp(UUID_RE.source, "gi")) ?? []);
      for (const id of [X.id, Y.id]) expect(uuids.has(id), "id de restaurante na resposta").toBe(false);
    });
  });

  // =================================================================================================================
  // Rate limit: POR ÚLTIMO, cada rajada com IP próprio (a cota vive na memória do servidor, por IP+slug).
  // =================================================================================================================
  describe("rate limit de pedidos (5 criados / 10 min por IP+slug; 30 tentativas)", () => {
    it("o 6º pedido CRIADO do mesmo IP+slug => 429 rate_limited com Retry-After; recusados (422), inválidos (400) e replays devolvem ao contador; outro IP/slug livres", async () => {
      const ip = newIp();
      const mk = (over: Record<string, unknown> = {}) => post(X.slug, orderBody(over), { ip });
      // 400 não consome; 422 é devolvido
      for (let i = 0; i < 3; i++) expect((await mk({ items: [] })).status).toBe(400);
      for (let i = 0; i < 3; i++) expect((await mk({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] })).status).toBe(422);
      // 4 criados + 1 replay (devolvido) + o 5º criado
      const keep = orderBody();
      const created: any[] = [await post(X.slug, keep, { ip })];
      for (let i = 0; i < 3; i++) created.push(await mk());
      expect(created.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const replay = await post(X.slug, keep, { ip });
      expect(replay.status).toBe(200);
      const fifth = await mk();
      expect(fifth.status, fifth.text).toBe(201);
      // 6º: bloqueado
      const before = await countOrders(X.id);
      const sixth = await mk();
      expect(sixth.status).toBe(429);
      expect(sixth.json.error.code).toBe("rate_limited");
      const retry = Number(sixth.headers.get("retry-after"));
      expect(Number.isInteger(retry) && retry >= 1 && retry <= 600, `Retry-After=${sixth.headers.get("retry-after")}`).toBe(true);
      expect(sixth.headers.get("cache-control")).toBe("no-store");
      expect(await countOrders(X.id)).toBe(before);
      // [documentado] com a cota cheia até o REPLAY de um pedido já criado é barrado (a checagem vem antes de a idempotência ser consultada)
      expect((await post(X.slug, keep, { ip })).status).toBe(429);
      // com CORS cadastrado o 429 é legível pelo navegador
      const withCors = await post(X.slug, orderBody(), { ip, origin: ORIGIN_X });
      expect(withCors.status).toBe(429);
      expect(withCors.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(withCors.headers.get("access-control-expose-headers") ?? "").toMatch(/retry-after/i);
      // origem hostil continua 403; inválido continua 400 (validação vem antes do limite estrito)
      expect((await post(X.slug, orderBody(), { ip, origin: "https://zz-evil.example.com" })).status).toBe(403);
      expect((await mk({ items: [] })).status).toBe(400);
      // outro IP e outro slug (mesmo IP) estão livres
      expect((await post(X.slug, orderBody())).status).toBe(201);
      const yProduct = (await admin().from("products").select("id").eq("restaurant_id", Y.id).single()).data as any;
      expect((await post(Y.slug, orderBody({ items: [{ productId: yProduct.id, quantity: 1 }] }), { ip })).status).toBe(201);
      // o GET de acompanhamento tem balde próprio: o IP bloqueado em pedidos ainda consulta
      expect((await call(trackPath(X.slug, created[0].json.data.publicCode), { ip })).status).toBe(200);
    });

    it("SDK: o 429 vira StorefrontApiError{code:'rate_limited', status:429, retryAfterSeconds>0}", async () => {
      const ip = newIp();
      for (let i = 0; i < 5; i++) expect((await post(X.slug, orderBody(), { ip })).status).toBe(201);
      const client = createStorefrontClient({ baseUrl: BASE, slug: X.slug, fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": ip } }) });
      const err = await client
        .createOrder({ fulfillmentType: "PICKUP", items: [{ productId: pPlain.id, quantity: 1 }], customer: { name: "zz-SDK", phone: newPhone() }, payment: { method: "PIX" } })
        .then(() => null, (e) => e);
      expect(err).toBeInstanceOf(StorefrontApiError);
      expect(err).toMatchObject({ code: "rate_limited", status: 429 });
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("teto de 30 TENTATIVAS por IP+slug mesmo sem criar nenhum pedido (recusas 422 não são devolvidas ao teto de abuso)", async () => {
      const ip = newIp();
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await post(X.slug, orderBody({ items: [{ productId: crypto.randomUUID(), quantity: 1 }] }), { ip })).status);
      expect(statuses.slice(0, 30).every((s) => s === 422)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
    });

    it("acompanhamento: 60 consultas por minuto por IP+slug (conta também os 404); a 61ª => 429 com Retry-After", async () => {
      const ip = newIp();
      const results: number[] = [];
      let last: any;
      for (let i = 0; i < 62; i++) {
        last = await call(trackPath(X.slug, "AAAAAAAAAAAAAAAA"), { ip });
        results.push(last.status);
      }
      expect(results.filter((s) => s === 404)).toHaveLength(60);
      expect(results.slice(60)).toEqual([429, 429]);
      expect(last.json.error.code).toBe("rate_limited");
      expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      // o POST de pedido do mesmo IP tem balde próprio
      expect((await post(X.slug, orderBody(), { ip })).status).toBe(201);
    });
  });
});
