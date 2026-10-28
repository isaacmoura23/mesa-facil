/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * API pública v1 (Etapa 2.5), por HTTP real contra o dev server do coordenador:
 *
 *   GET  /api/public/v1/restaurants/{slug}/menu
 *   POST /api/public/v1/restaurants/{slug}/cart/quote
 *
 * O servidor NÃO é iniciado aqui. `API_BASE_URL` (padrão http://localhost:3100) precisa responder; se não responder,
 * o arquivo inteiro é PULADO com um aviso claro. O Supabase local (mesmo banco do servidor) monta as fixtures via
 * service role.
 *
 * Cuidados com o estado em memória do servidor (documentado):
 *  - cache do cardápio (`use cache`, ~30 s por slug) e cache das origens do CORS (TTL 60 s por slug): por isso as fixtures
 *    ("zz-api-*") são criadas ANTES do primeiro request ao slug e não mudam durante os testes de leitura. O caso "origem
 *    cadastrada" usa um restaurante efêmero em vez do demo-a: configurar o demo-a depois que uma origem hostil já foi
 *    testada nele deixaria `[]` em cache por até 60 s.
 *  - rate limit em memória por IP+slug (menu 120/min, quote 60/min, global 600/min): o IP vem do 1º valor de
 *    `X-Forwarded-For`. Todos os requests deste arquivo usam IPs de teste próprios (198.18.x.y) para não consumir a cota
 *    de outros testes/agentes; a rajada usa um IP só dela.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { createStorefrontClient, formatCents, isOpenNow, lowestPrice, StorefrontApiError } from "../../sdk/src/index";
import { admin, world } from "../helpers/clients";
import { Cleanup, uniq } from "../helpers/factory";
import { insertRow, setOpenToday, walkKeys } from "../helpers/menu";

const BASE = (process.env.API_BASE_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const API = `${BASE}/api/public/v1/restaurants`;

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/demo-a/menu`, { headers: { "X-Forwarded-For": "198.18.0.1" }, signal: AbortSignal.timeout(5000) });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}
const up = await probe();
if (!up) {
  console.warn(
    `\n[tests/api/19-public-api] PULADO: a API pública não respondeu em ${BASE}. ` +
      "Suba o dev server do app (porta 3100 ou defina API_BASE_URL) e rode de novo para executar estes testes.\n",
  );
}

const octet = () => 1 + Math.floor(Math.random() * 250);
const newIp = () => `198.18.${octet()}.${octet()}`;

const cleanup = new Cleanup();
const seenBodies: string[] = [];

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
  seenBodies.push(text);
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* corpo não-JSON (ex.: 405 do Next) */
  }
  return { status: res.status, headers: res.headers, text, json };
}
const menuPath = (slug: string) => `${slug}/menu`;
const quotePath = (slug: string) => `${slug}/cart/quote`;
const quote = (slug: string, json: unknown, opts: CallOpts = {}) => call(quotePath(slug), { method: "POST", json, ...opts });

const ORIGIN_X = `https://zz-loja-${uniq()}.vercel.app`;
const ORIGIN_Y = `https://zz-outra-${uniq()}.example.com`;
let X: { id: string; slug: string };
let Y: { id: string; slug: string };
let pV: any, pPlain: any, vP: any, vG: any, modA: any, zone: any;
let envKeys: string[] = [];
let devMode = true;

async function makeRestaurant(status: string, patch: Record<string, unknown> = {}) {
  const slug = `zz-api-${uniq()}`.slice(0, 40);
  const r = await admin().from("restaurants").insert({ name: `zz DEMO API ${slug}`, slug, status }).select("id,slug").single();
  if (r.error) throw new Error(`restaurants: ${r.error.message}`);
  const rest = r.data as { id: string; slug: string };
  cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rest.id)));
  const s = await admin().from("restaurant_settings").upsert({ restaurant_id: rest.id, ...patch }, { onConflict: "restaurant_id" });
  if (s.error) throw new Error(`settings: ${s.error.message}`);
  return rest;
}

describe.skipIf(!up)("API pública v1 (HTTP real)", () => {
  beforeAll(async () => {
    const env = loadEnv();
    envKeys = [env.anonKey, env.serviceKey].filter((k): k is string => typeof k === "string" && k.length > 20);
    X = await makeRestaurant("active", {
      whatsapp: "+5511999990000",
      phone: "(11) 4000-1234",
      address_text: "Rua Zz, 10 - Centro",
      storefront_url: "https://la-zz.vercel.app/cardapio",
      storefront_origins: [ORIGIN_X],
    });
    Y = await makeRestaurant("active", { storefront_origins: [ORIGIN_Y] });
    await setOpenToday(X.id, true);
    const cat = await insertRow("menu_categories", { restaurant_id: X.id, name: "zz-cat", sort_order: 1 });
    pV = await insertRow("products", { restaurant_id: X.id, category_id: cat.id, name: "zz-pizza", price_cents: 900, sort_order: 1, badges: ["POPULAR", "SPICY"] });
    pPlain = await insertRow("products", { restaurant_id: X.id, category_id: cat.id, name: "zz-agua", price_cents: 1000, sort_order: 2 });
    vP = await insertRow("product_variants", { restaurant_id: X.id, product_id: pV.id, name: "P", price_cents: 1000, is_default: true, sort_order: 1 });
    vG = await insertRow("product_variants", { restaurant_id: X.id, product_id: pV.id, name: "G", price_cents: 2000, sort_order: 2 });
    await insertRow("product_variants", { restaurant_id: X.id, product_id: pV.id, name: "zz-oculta", price_cents: 1, is_active: false });
    const grp = await insertRow("modifier_groups", { restaurant_id: X.id, name: "zz-adicionais", min_selections: 0, max_selections: 2 });
    modA = await insertRow("modifiers", { restaurant_id: X.id, group_id: grp.id, name: "zz-borda", price_delta_cents: 100 });
    await admin().from("product_modifier_groups").insert({ restaurant_id: X.id, product_id: pV.id, group_id: grp.id });
    zone = await insertRow("delivery_zones", { restaurant_id: X.id, name: "zz-zona", fee_cents: 500, min_order_cents: 0, estimated_minutes: 30, neighborhoods: ["Centro"], is_active: true });

    // O servidor está em modo dev? (localhost liberado). Em `next start` os testes de localhost são pulados.
    const probeDev = await call(menuPath("demo-a"), { origin: "http://localhost:5173" });
    devMode = probeDev.status !== 403;
    if (!devMode) console.warn("[tests/api/19-public-api] servidor em modo produção: testes de origens localhost serão pulados.");
  });
  afterAll(async () => {
    await cleanup.run();
  });

  // =================================================================================================================
  // menu
  // =================================================================================================================
  describe("GET /menu", () => {
    it("demo-a: 200, envelope {data}, JSON camelCase, cabeçalhos de cache e segurança", async () => {
      const r = await call(menuPath("demo-a"));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      expect(r.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("vary") ?? "").toMatch(/origin/i);
      expect(r.headers.get("access-control-allow-origin")).toBeNull(); // sem Origin: sem CORS
      expect(Object.keys(r.json)).toEqual(["data"]);
      const d = r.json.data;
      expect(Object.keys(d).sort()).toEqual(["categories", "isOpenNow", "restaurant", "settings"]);
      expect(d.restaurant).toMatchObject({ slug: "demo-a", timezone: "America/Sao_Paulo" });
      expect(Object.keys(d.restaurant).sort()).toEqual(["contact", "logoUrl", "name", "slug", "storefrontUrl", "timezone"]);
      expect(Object.keys(d.settings).sort()).toEqual(["acceptsOrders", "businessHourExceptions", "businessHours", "deliveryZones", "fulfillmentTypes", "minOrderCents", "pickupInstructions", "prepTimeMinutes"]);
      expect(typeof d.isOpenNow).toBe("boolean");
      expect(Array.isArray(d.categories)).toBe(true);
      const snake = [...walkKeys(d)].filter((k) => k.includes("_"));
      expect(snake, `chaves snake_case no JSON: ${snake.join(",")}`).toEqual([]);
    });

    it("restaurante de teste: variants, badges, contact, storefrontUrl, zonas e adicionais no formato do contrato", async () => {
      const r = await call(menuPath(X.slug));
      expect(r.status).toBe(200);
      const d = r.json.data;
      expect(d.restaurant).toEqual({
        name: `zz DEMO API ${X.slug}`,
        slug: X.slug,
        logoUrl: null,
        timezone: "America/Sao_Paulo",
        contact: { whatsapp: "+5511999990000", phone: "(11) 4000-1234", addressText: "Rua Zz, 10 - Centro" },
        storefrontUrl: "https://la-zz.vercel.app/cardapio",
      });
      expect(d.isOpenNow).toBe(true);
      expect(d.settings).toMatchObject({ acceptsOrders: true, minOrderCents: 0 });
      expect([...d.settings.fulfillmentTypes].sort()).toEqual(["DELIVERY", "PICKUP"]);
      expect(d.settings.deliveryZones).toEqual([{ id: zone.id, name: "zz-zona", feeCents: 500, minOrderCents: 0, estimatedMinutes: 30, neighborhoods: ["Centro"] }]);

      const products = d.categories.flatMap((c: any) => c.products);
      const pizza = products.find((p: any) => p.id === pV.id);
      expect(pizza).toMatchObject({ name: "zz-pizza", priceCents: 1000, isAvailable: true, badges: ["POPULAR", "SPICY"] });
      expect(pizza.variants).toEqual([
        { id: vP.id, name: "P", priceCents: 1000, isAvailable: true, isDefault: true },
        { id: vG.id, name: "G", priceCents: 2000, isAvailable: true, isDefault: false },
      ]);
      expect(JSON.stringify(r.json)).not.toContain("zz-oculta"); // variante inativa
      expect(pizza.modifierGroups[0]).toMatchObject({ name: "zz-adicionais", minSelections: 0, maxSelections: 2 });
      expect(pizza.modifierGroups[0].modifiers).toEqual([{ id: modA.id, name: "zz-borda", priceDeltaCents: 100, isAvailable: true }]);
      const agua = products.find((p: any) => p.id === pPlain.id);
      expect(agua).toMatchObject({ priceCents: 1000, badges: [], variants: [], modifierGroups: [] });
      expect([...walkKeys(d)].filter((k) => k.includes("_"))).toEqual([]);
    });

    it("o JSON público nunca contém storefront_origins, as origens cadastradas, nem campos internos", async () => {
      const r = await call(menuPath(X.slug));
      expect(r.text).not.toMatch(/storefront_?origins/i);
      expect(r.text).not.toContain(ORIGIN_X);
      const keys = walkKeys(r.json);
      for (const k of ["restaurantId", "restaurant_id", "createdBy", "created_by", "status", "isActive", "qrToken", "ownerId", "planId", "email"]) {
        expect(keys.has(k), k).toBe(false);
      }
      // 'phone' só dentro de restaurant.contact
      const { restaurant, ...rest } = r.json.data;
      expect(walkKeys(rest).has("phone")).toBe(false);
      expect(Object.keys(restaurant.contact).sort()).toEqual(["addressText", "phone", "whatsapp"]);
    });

    it("slug em maiúsculas é normalizado (DEMO-A)", async () => {
      const r = await call(menuPath("DEMO-A"));
      expect(r.status).toBe(200);
      expect(r.json.data.restaurant.slug).toBe("demo-a");
    });

    it("slug inexistente => 404 restaurant_not_found (JSON, no-store)", async () => {
      const r = await call(menuPath(`zz-nao-existe-${uniq()}`));
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: { code: "restaurant_not_found", message: expect.any(String) } });
      expect(r.headers.get("cache-control")).toBe("no-store");
    });

    it("slug inválido (formato) => 404 sem consultar o banco", async () => {
      for (const slug of ["Inv%C3%A1lido", "a_b", "-x", "x-", "a--b", "a".repeat(64), "a%2Fb", "..%2Fdemo-a", "%20", "x%00y"]) {
        const r = await call(menuPath(slug));
        expect(r.status, slug).toBe(404);
        if (r.json) expect(r.json.error?.code, slug).toBe("restaurant_not_found");
      }
    });

    it("restaurante suspenso ou pendente => 404 (indistinguível de inexistente)", async () => {
      const susp = await makeRestaurant("suspended");
      const pend = await makeRestaurant("pending");
      for (const s of [susp, pend]) {
        const r = await call(menuPath(s.slug));
        expect(r.status, s.slug).toBe(404);
        expect(r.json.error.code).toBe("restaurant_not_found");
      }
    });

    it("métodos não permitidos => 405 (POST, PUT, DELETE, PATCH no menu; GET, PUT, DELETE na cotação)", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expect((await call(menuPath("demo-a"), { method, body: method === "DELETE" ? undefined : "{}", headers: { "Content-Type": "application/json" } })).status, `menu ${method}`).toBe(405);
      }
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        expect((await call(quotePath("demo-a"), { method, body: method === "GET" || method === "DELETE" ? undefined : "{}", headers: { "Content-Type": "application/json" } })).status, `quote ${method}`).toBe(405);
      }
    });
  });

  // =================================================================================================================
  // CORS
  // =================================================================================================================
  describe("CORS por restaurante", () => {
    it("origem https NÃO cadastrada => 403 origin_not_allowed, sem ACAO e sem dados", async () => {
      for (const origin of ["https://zz-evil.example.com", "http://zz-evil.example.com", "https://evil.com:8443"]) {
        for (const slug of ["demo-a", X.slug]) {
          const r = await call(menuPath(slug), { origin });
          expect(r.status, `${origin} @ ${slug}`).toBe(403);
          expect(r.json).toEqual({ error: { code: "origin_not_allowed", message: expect.any(String) } });
          expect(r.headers.get("access-control-allow-origin")).toBeNull();
          expect(r.text).not.toContain("categories");
        }
        const q = await quote(X.slug, { fulfillmentType: "PICKUP", items: [] }, { origin });
        expect(q.status, `quote ${origin}`).toBe(403);
        expect(q.json.error.code).toBe("origin_not_allowed");
      }
    });

    it("origem malformada ('null', com barra final, caminho, curinga, credenciais, espaços) => 403", async () => {
      for (const origin of ["null", `${ORIGIN_X}/`, `${ORIGIN_X}/x`, `${ORIGIN_X}?a=1`, "https://*.vercel.app", "*", `https://u@${ORIGIN_X.slice(8)}`, "javascript:alert(1)", "file://"]) {
        const r = await call(menuPath(X.slug), { origin });
        expect(r.status, JSON.stringify(origin)).toBe(403);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("origem cadastrada em storefront_origins: ACAO == origem, Vary: Origin, sem Allow-Credentials (GET menu e POST quote)", async () => {
      const g = await call(menuPath(X.slug), { origin: ORIGIN_X });
      expect(g.status).toBe(200);
      expect(g.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(g.headers.get("vary") ?? "").toMatch(/origin/i);
      expect(g.headers.get("access-control-allow-credentials")).toBeNull();
      expect(g.headers.get("access-control-expose-headers") ?? "").toMatch(/retry-after/i);
      expect(g.json.data.restaurant.slug).toBe(X.slug);

      const p = await quote(X.slug, { fulfillmentType: "PICKUP", items: [{ productId: pPlain.id, quantity: 1 }] }, { origin: ORIGIN_X });
      expect(p.status).toBe(200);
      expect(p.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(p.headers.get("vary") ?? "").toMatch(/origin/i);
      expect(p.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("a origem exata é obrigatória: http://, outra porta, subdomínio, sufixo e outro caminho de domínio são negados", async () => {
      const host = ORIGIN_X.slice("https://".length);
      for (const origin of [`http://${host}`, `${ORIGIN_X}:8443`, `https://evil.${host}`, `${ORIGIN_X}.evil.com`, `https://${host.toUpperCase()}.evil.com`, `https://x${host}`]) {
        const r = await call(menuPath(X.slug), { origin });
        expect(r.status, origin).toBe(403);
      }
    });

    it("isolamento entre restaurantes: a origem de Y não vale em X (nem no demo-a) e vice-versa", async () => {
      expect((await call(menuPath(X.slug), { origin: ORIGIN_Y })).status).toBe(403);
      expect((await call(menuPath(Y.slug), { origin: ORIGIN_X })).status).toBe(403);
      expect((await call(menuPath("demo-a"), { origin: ORIGIN_X })).status).toBe(403);
      const ok = await call(menuPath(Y.slug), { origin: ORIGIN_Y });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN_Y);
    });

    it("localhost e 127.0.0.1 (qualquer porta) são liberados em desenvolvimento; hosts parecidos não", async (ctx) => {
      if (!devMode) return ctx.skip();
      for (const origin of ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:8080", "https://localhost:8443", "http://localhost"]) {
        const r = await call(menuPath("demo-a"), { origin });
        expect(r.status, origin).toBe(200);
        expect(r.headers.get("access-control-allow-origin"), origin).toBe(origin);
        expect(r.headers.get("access-control-allow-credentials")).toBeNull();
      }
      for (const origin of ["http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://evil-localhost:3000", "http://localhost:5173/", "http://[::1]:3000", "http://0.0.0.0:3000"]) {
        expect((await call(menuPath("demo-a"), { origin })).status, origin).toBe(403);
      }
    });

    it("preflight OPTIONS: 204 sem corpo, com Allow-Methods/Headers/Max-Age e ACAO == origem (menu e quote)", async () => {
      const menu = await call(menuPath(X.slug), { method: "OPTIONS", origin: ORIGIN_X, headers: { "Access-Control-Request-Method": "GET" } });
      expect(menu.status).toBe(204);
      expect(menu.text).toBe("");
      expect(menu.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(menu.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      expect(menu.headers.get("access-control-allow-headers") ?? "").toMatch(/content-type/i);
      expect(Number(menu.headers.get("access-control-max-age"))).toBeGreaterThan(0);
      expect(menu.headers.get("vary") ?? "").toMatch(/origin/i);
      expect(menu.headers.get("access-control-allow-credentials")).toBeNull();

      const q = await call(quotePath(X.slug), { method: "OPTIONS", origin: ORIGIN_X, headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
      expect(q.status).toBe(204);
      expect(q.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(q.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
      expect(q.headers.get("access-control-allow-headers") ?? "").toMatch(/content-type/i);
    });

    it("preflight de origem NÃO cadastrada => 403 sem cabeçalhos CORS; sem Origin => 204 só com Allow", async () => {
      const bad = await call(quotePath(X.slug), { method: "OPTIONS", origin: "https://zz-evil.example.com", headers: { "Access-Control-Request-Method": "POST" } });
      expect(bad.status).toBe(403);
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
      expect(bad.headers.get("access-control-allow-methods")).toBeNull();
      const none = await call(quotePath(X.slug), { method: "OPTIONS" });
      expect(none.status).toBe(204);
      expect(none.headers.get("access-control-allow-origin")).toBeNull();
      expect(none.headers.get("allow") ?? "").toMatch(/POST/);
      // slug inválido no preflight
      expect((await call(quotePath("a_b"), { method: "OPTIONS", origin: ORIGIN_X })).status).toBe(404);
    });

    it("preflight em dev aceita localhost", async (ctx) => {
      if (!devMode) return ctx.skip();
      const r = await call(quotePath("demo-a"), { method: "OPTIONS", origin: "http://localhost:5173", headers: { "Access-Control-Request-Method": "POST" } });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });
  });

  // =================================================================================================================
  // quote
  // =================================================================================================================
  describe("POST /cart/quote", () => {
    const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({ fulfillmentType: "PICKUP", items, ...extra });

    it("cotação válida: 200 {data} camelCase, no-store, preço recalculado no servidor (variante + adicional)", async () => {
      const r = await quote(X.slug, body([{ productId: pV.id, variantId: vG.id, quantity: 2, modifierIds: [modA.id] }]));
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Object.keys(r.json)).toEqual(["data"]);
      const q = r.json.data;
      expect(q.ok, JSON.stringify(q.errors)).toBe(true);
      expect(q.errors).toEqual([]);
      expect(q.items).toEqual([
        {
          productId: pV.id,
          name: "zz-pizza",
          variant: { id: vG.id, name: "G", priceCents: 2000 },
          unitPriceCents: 2000,
          quantity: 2,
          modifiers: [{ id: modA.id, name: "zz-borda", priceDeltaCents: 100 }],
          lineTotalCents: 4200,
        },
      ]);
      expect(q).toMatchObject({ subtotalCents: 4200, deliveryFeeCents: 0, discountCents: 0, totalCents: 4200, minimumOrderCents: 0 });
      expect([...walkKeys(q)].filter((k) => k.includes("_"))).toEqual([]);
    });

    it("produto sem variantes: variant null; entrega soma a taxa da zona", async () => {
      const r = await quote(X.slug, body([{ productId: pPlain.id, quantity: 3 }]));
      expect(r.json.data.items[0]).toMatchObject({ variant: null, unitPriceCents: 1000, lineTotalCents: 3000 });
      const d = await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }], { fulfillmentType: "DELIVERY", deliveryZoneId: zone.id }));
      expect(d.json.data).toMatchObject({ ok: true, subtotalCents: 1000, deliveryFeeCents: 500, totalCents: 1500 });
      const noZone = await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }], { fulfillmentType: "DELIVERY" }));
      expect(noZone.status).toBe(200);
      expect(noZone.json.data.ok).toBe(false);
      expect(noZone.json.data.errors.map((e: any) => e.code)).toEqual(["ZONE_REQUIRED"]);
    });

    it("erros de negócio voltam como 200 com ok=false, código estável, itemIndex e mensagem PT-BR (nunca texto cru do banco)", async () => {
      const cases: Array<[string, unknown[], string]> = [
        ["variante obrigatória", [{ productId: pV.id, quantity: 1 }], "VARIANT_REQUIRED"],
        ["variante de produto sem variantes", [{ productId: pPlain.id, variantId: vP.id, quantity: 1 }], "VARIANT_NOT_ALLOWED"],
        ["variante inexistente", [{ productId: pV.id, variantId: crypto.randomUUID(), quantity: 1 }], "VARIANT_NOT_ALLOWED"],
        ["produto inexistente", [{ productId: crypto.randomUUID(), quantity: 1 }], "PRODUCT_UNAVAILABLE"],
        ["adicional inexistente", [{ productId: pV.id, variantId: vP.id, quantity: 1, modifierIds: [crypto.randomUUID()] }], "MODIFIER_NOT_ALLOWED"],
        ["carrinho vazio", [], "EMPTY_CART"],
      ];
      for (const [label, items, code] of cases) {
        const r = await quote(X.slug, body(items));
        expect(r.status, label).toBe(200);
        expect(r.json.data.ok, label).toBe(false);
        expect(r.json.data.errors[0], label).toMatchObject({ code, message: expect.any(String) });
        expect(r.json.data.errors[0].message.length, label).toBeGreaterThan(5);
        expect(r.json.data.items, label).toEqual([]);
      }
      const idx = await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }, { productId: pV.id, quantity: 1 }]));
      expect(idx.json.data.errors).toEqual([{ code: "VARIANT_REQUIRED", itemIndex: 1, message: expect.any(String) }]);
    });

    it("preço/total forjado no corpo é ignorado (campos extras são descartados pela validação)", async () => {
      const r = await quote(X.slug, body([{ productId: pV.id, variantId: vP.id, quantity: 2, priceCents: 1, unitPriceCents: 1, totalCents: 1, variant: { priceCents: 1 } }], { totalCents: 1, discountCents: 99999 }));
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ ok: true, totalCents: 2000, discountCents: 0 });
    });

    it("limite de custo (F-21) pela API: > 200 adicionais no carrinho => TOO_MANY_MODIFIERS e nenhuma linha processada", async () => {
      const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
      const items = Array.from({ length: 5 }, () => ({ productId: pV.id, variantId: vP.id, quantity: 1, modifierIds: ids(50) }));
      const r = await quote(X.slug, body(items));
      expect(r.status).toBe(200);
      expect(r.json.data.errors.map((e: any) => e.code)).toEqual(["TOO_MANY_MODIFIERS"]);
      expect(r.json.data.items).toEqual([]);
      expect(r.text.length).toBeLessThan(2000);
    });

    it("restaurante fechado agora => RESTAURANT_CLOSED (e volta a aceitar ao reabrir)", async () => {
      await setOpenToday(X.id, false);
      try {
        const r = await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }]));
        expect(r.status).toBe(200);
        expect(r.json.data.errors.map((e: any) => e.code)).toContain("RESTAURANT_CLOSED");
      } finally {
        await setOpenToday(X.id, true);
      }
      expect((await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }]))).json.data.ok).toBe(true);
    });

    it("slug inválido => 404; slug inexistente/suspenso => nenhum dado (404 ou ok=false RESTAURANT_UNAVAILABLE)", async () => {
      expect((await quote("a_b", body([]))).status).toBe(404);
      const susp = await makeRestaurant("suspended");
      for (const slug of [`zz-nao-existe-${uniq()}`, susp.slug]) {
        const r = await quote(slug, body([{ productId: pPlain.id, quantity: 1 }]));
        if (r.status === 404) {
          expect(r.json.error.code).toBe("restaurant_not_found");
        } else {
          expect(r.status).toBe(200);
          expect(r.json.data.ok).toBe(false);
          expect(r.json.data.errors.map((e: any) => e.code)).toEqual(["RESTAURANT_UNAVAILABLE"]);
          expect(r.json.data.items).toEqual([]);
        }
      }
    });

    it("Content-Type errado ou ausente => 400 invalid_request", async () => {
      for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx", "text/json"]) {
        const r = await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": ct }, body: JSON.stringify(body([])) });
        expect(r.status, ct).toBe(400);
        expect(r.json.error.code, ct).toBe("invalid_request");
      }
      const none = await call(quotePath(X.slug), { method: "POST", body: JSON.stringify(body([])) });
      // fetch define text/plain para string sem Content-Type
      expect(none.status).toBe(400);
      // charset é aceito
      const ok = await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body([{ productId: pPlain.id, quantity: 1 }])) });
      expect(ok.status).toBe(200);
    });

    it("JSON inválido, UTF-8 inválido e corpo que não é objeto => 400", async () => {
      for (const raw of ["{", "", "nao-json", "{'a':1}", "[1,2", "undefined"]) {
        const r = await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
        expect(r.status, JSON.stringify(raw)).toBe(400);
        expect(r.json.error.code).toBe("invalid_request");
      }
      const badUtf8 = await fetch(`${API}/${quotePath(X.slug)}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": newIp() }, body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]) });
      expect(badUtf8.status).toBe(400);
      for (const j of [null, [], "x", 1, true]) {
        const r = await quote(X.slug, j);
        expect(r.status, JSON.stringify(j)).toBe(400);
      }
    });

    it("validação (zod): modalidade, itens, quantidade, uuids, observação, zona => 400 com detalhes por campo", async () => {
      const item = { productId: pPlain.id, quantity: 1 };
      const bad: Array<[string, unknown]> = [
        ["modalidade inválida", { fulfillmentType: "VOO", items: [item] }],
        ["modalidade ausente", { items: [item] }],
        ["itens ausente", { fulfillmentType: "PICKUP" }],
        ["itens não é array", { fulfillmentType: "PICKUP", items: "x" }],
        ["51 itens", { fulfillmentType: "PICKUP", items: Array.from({ length: 51 }, () => item) }],
        ["quantidade 0", body([{ ...item, quantity: 0 }])],
        ["quantidade 100", body([{ ...item, quantity: 100 }])],
        ["quantidade fracionada", body([{ ...item, quantity: 1.5 }])],
        ["quantidade string", body([{ ...item, quantity: "2" }])],
        ["productId inválido", body([{ ...item, productId: "nao-uuid" }])],
        ["variantId inválido", body([{ ...item, variantId: "nao-uuid" }])],
        ["modifierIds inválido", body([{ ...item, modifierIds: ["x"] }])],
        ["51 adicionais", body([{ ...item, modifierIds: Array.from({ length: 51 }, () => crypto.randomUUID()) }])],
        ["observação > 500", body([{ ...item, notes: "n".repeat(501) }])],
        ["zona inválida", body([item], { deliveryZoneId: "nao-uuid" })],
      ];
      for (const [label, payload] of bad) {
        const r = await quote(X.slug, payload);
        expect(r.status, label).toBe(400);
        expect(r.json.error.code, label).toBe("invalid_request");
        expect(r.json.error.details?.length ?? 0, label).toBeGreaterThan(0);
        expect(r.json.error.details.length).toBeLessThanOrEqual(10);
      }
      // limites exatos são aceitos
      expect((await quote(X.slug, body([{ ...item, quantity: 99, notes: "n".repeat(500) }]))).status).toBe(200);
      expect((await quote(X.slug, body(Array.from({ length: 50 }, () => item)))).status).toBe(200);
    });

    it("corpo > 64 KB => 413 payload_too_large (com Content-Length e em fluxo sem tamanho declarado)", async () => {
      const big = JSON.stringify({ fulfillmentType: "PICKUP", items: [], pad: "x".repeat(70 * 1024) });
      expect(big.length).toBeGreaterThan(64 * 1024);
      const r = await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
      expect(r.status).toBe(413);
      expect(r.json.error.code).toBe("payload_too_large");
      // exatamente no limite: passa do 413 (a validação pode aceitar ou recusar o campo extra, mas não é 413)
      const edge = JSON.stringify({ fulfillmentType: "PICKUP", items: [], pad: "x".repeat(64 * 1024 - 60) });
      expect(edge.length).toBeLessThanOrEqual(64 * 1024);
      expect((await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: edge })).status).not.toBe(413);
      // fluxo (chunked, sem Content-Length)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
          for (let i = 0; i < 6; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const chunked = await fetch(`${API}/${quotePath(X.slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": newIp() },
        body: stream,
        // @ts-expect-error opção do undici/Node para corpo em stream
        duplex: "half",
      });
      expect(chunked.status).toBe(413);
    });

    it("payloads hostis (aninhamento profundo, unicode, SQLi, __proto__) => 4xx, nunca 5xx", async () => {
      const deep = `{"fulfillmentType":"PICKUP","items":${"[".repeat(30000)}${"]".repeat(30000)}}`;
      const payloads = [
        deep,
        JSON.stringify({ fulfillmentType: "PICKUP", items: [{ productId: pPlain.id, quantity: 1, notes: "'; drop table products;--💥 ‮" }] }),
        '{"fulfillmentType":"PICKUP","items":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
        JSON.stringify({ fulfillmentType: "PICKUP", items: [{ productId: pPlain.id, quantity: 1e999 }] }),
      ];
      for (const raw of payloads) {
        const r = await call(quotePath(X.slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
        expect(r.status, raw.slice(0, 60)).toBeLessThan(500);
      }
      // a poluição de protótipo não aconteceu no servidor: a cotação normal segue funcionando
      expect((await quote(X.slug, body([{ productId: pPlain.id, quantity: 1 }]))).json.data.ok).toBe(true);
    });

    // F-29: um NUL (\u0000) em `notes` passa pelo zod, mas o Postgres rejeita o jsonb (22P05) e a API responde 500 internal_error
    // em vez de 400. Correção: rejeitar \u0000 nas strings do corpo (ex.: .refine(s => !s.includes("\0"))) em schemas.ts.
    it("[F-29] (corrigido) NUL em notes deveria ser 400 invalid_request, mas hoje é 500 internal_error", async () => {
      const r = await quote(X.slug, body([{ productId: pPlain.id, quantity: 1, notes: "x\u0000y" }]));
      expect(r.status).toBeLessThan(500);
    });
  });

  // =================================================================================================================
  // SDK contra o servidor real
  // =================================================================================================================
  describe("SDK (sdk/src) contra a API real", () => {
    const sdkFor = (slug: string, ip?: string) =>
      createStorefrontClient({
        baseUrl: BASE,
        slug,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": ip ?? newIp() } }),
      });

    it("getMenu devolve o cardápio tipado (variantes, selos, contato) e os helpers funcionam com dados reais", async () => {
      const menu = await sdkFor(X.slug).getMenu();
      expect(menu.restaurant).toMatchObject({ slug: X.slug, storefrontUrl: "https://la-zz.vercel.app/cardapio", contact: { phone: "(11) 4000-1234" } });
      const pizza = menu.categories.flatMap((c) => c.products).find((p) => p.id === pV.id)!;
      expect(pizza.badges).toEqual(["POPULAR", "SPICY"]);
      expect(pizza.variants.map((v) => v.name)).toEqual(["P", "G"]);
      expect(lowestPrice(pizza)).toEqual({ cents: 1000, isFrom: true });
      expect(isOpenNow(menu)).toBe(true);
      expect(formatCents(pizza.variants[1].priceCents).replace(/\s/g, " ")).toBe("R$ 20,00");
    });

    it("quoteCart cota com variante e adicional; erros de negócio chegam em quote.errors (sem lançar)", async () => {
      const sdk = sdkFor(X.slug);
      const q = await sdk.quoteCart({ fulfillmentType: "PICKUP", items: [{ productId: pV.id, variantId: vG.id, quantity: 2, modifierIds: [modA.id] }] });
      expect(q.ok).toBe(true);
      expect(q.totalCents).toBe(4200);
      expect(q.items[0].variant).toEqual({ id: vG.id, name: "G", priceCents: 2000 });
      const bad = await sdk.quoteCart({ fulfillmentType: "PICKUP", items: [{ productId: pV.id, quantity: 1 }] });
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]).toMatchObject({ code: "VARIANT_REQUIRED", itemIndex: 0 });
    });

    it("erros HTTP viram StorefrontApiError tipado: 404 restaurant_not_found, 400 invalid_request (com details), 403 origin_not_allowed", async () => {
      const notFound = await sdkFor(`zz-nao-existe-${uniq()}`).getMenu().then(() => null, (e) => e);
      expect(notFound).toBeInstanceOf(StorefrontApiError);
      expect(notFound).toMatchObject({ code: "restaurant_not_found", status: 404 });

      const invalid = await sdkFor(X.slug).quoteCart({ fulfillmentType: "PICKUP", items: [{ productId: "nao-uuid", quantity: 0 }] }).then(() => null, (e) => e);
      expect(invalid).toBeInstanceOf(StorefrontApiError);
      expect(invalid).toMatchObject({ code: "invalid_request", status: 400 });
      expect(invalid.details?.length).toBeGreaterThan(0);

      const forbidden = await createStorefrontClient({
        baseUrl: BASE,
        slug: X.slug,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": newIp(), Origin: "https://zz-evil.example.com" } }),
      })
        .getMenu()
        .then(() => null, (e) => e);
      expect(forbidden).toMatchObject({ code: "origin_not_allowed", status: 403 });
    });

    it("servidor inacessível => network_error (status 0), sem lançar erro genérico", async () => {
      const dead = createStorefrontClient({ baseUrl: "http://127.0.0.1:9", slug: "demo-a", timeoutMs: 3000 });
      const err = await dead.getMenu().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(StorefrontApiError);
      expect(err.status).toBe(0);
      expect(["network_error", "timeout"]).toContain(err.code);
    });
  });

  // =================================================================================================================
  // varredura final: nada sensível em nenhuma resposta recebida neste arquivo
  // =================================================================================================================
  describe("vazamentos", () => {
    it("nenhuma resposta (sucesso ou erro) contém chaves do Supabase, storefront_origins, stack traces ou caminhos internos", () => {
      expect(seenBodies.length).toBeGreaterThan(50);
      const all = seenBodies.join("\n");
      for (const k of envKeys) expect(all.includes(k), "chave do Supabase na resposta").toBe(false);
      expect(all).not.toMatch(/service_role|sb_secret_|sb_publishable_|SUPABASE_|SERVICE_ROLE/);
      expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./); // JWT
      expect(all).not.toMatch(/storefront_?origins/i);
      expect(all).not.toContain(ORIGIN_X);
      expect(all).not.toContain(ORIGIN_Y);
      expect(all).not.toMatch(/\n\s+at\s+\S+.*:\d+:\d+/); // stack trace
      expect(all).not.toMatch(/node_modules|webpack-internal|turbopack|\.next[\\/]|[A-Z]:\\Users|\/home\/|src\/modules/i);
      expect(all).not.toMatch(/PGRST\d+|violates|duplicate key|relation "|syntax error at|permission denied/i); // mensagens do Postgres/PostgREST
      expect(all).not.toMatch(/\bRPC (public_menu|validate_cart|storefront_origins)\b/); // mensagens internas das exceções
    });

    it("o cliente que pede a cotação nunca recebe o texto cru de mensagens do banco (somente mensagens do mapa de códigos)", async () => {
      const r = await quote(X.slug, { fulfillmentType: "PICKUP", items: [{ productId: pV.id, variantId: vP.id, quantity: 1, modifierIds: [crypto.randomUUID()] }] });
      expect(r.status).toBe(200);
      for (const e of r.json.data.errors) {
        expect(e.message).not.toMatch(/\buuid\b|\bpg_|\bpublic\.|PGRST/i);
      }
    });
  });

  // =================================================================================================================
  // rate limit
  // =================================================================================================================
  describe("rate limit (janela deslizante em memória, por IP + slug)", () => {
    // Usa IPs de teste exclusivos desta seção (via X-Forwarded-For) para não consumir a cota de ninguém mais.
    async function burst(n: number, fn: (i: number) => Promise<{ status: number; headers: Headers; json: any }>, concurrency = 20) {
      const out: Array<{ status: number; headers: Headers; json: any }> = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (;;) {
            const i = next++;
            if (i >= n) return;
            out.push(await fn(i));
          }
        }),
      );
      return out;
    }

    it("menu: 120 requisições por minuto por IP+slug; a seguinte => 429 rate_limited com Retry-After; outro IP e outro slug não são afetados", async () => {
      const ip = newIp();
      const results = await burst(130, () => call(menuPath(X.slug), { ip }));
      const ok = results.filter((r) => r.status === 200).length;
      const limited = results.filter((r) => r.status === 429);
      expect(ok).toBe(120);
      expect(limited.length).toBe(10);
      for (const r of limited) {
        expect(r.json).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });
        const retry = Number(r.headers.get("retry-after"));
        expect(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${r.headers.get("retry-after")}`).toBe(true);
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
      // outro IP: livre
      expect((await call(menuPath(X.slug), { ip: newIp() })).status).toBe(200);
      // mesmo IP, outro slug: livre (balde por IP+slug)
      expect((await call(menuPath(Y.slug), { ip })).status).toBe(200);
      // 429 para origem cadastrada carrega CORS (o navegador consegue ler o Retry-After)
      const withCors = await call(menuPath(X.slug), { ip, origin: ORIGIN_X });
      expect(withCors.status).toBe(429);
      expect(withCors.headers.get("access-control-allow-origin")).toBe(ORIGIN_X);
      expect(withCors.headers.get("access-control-expose-headers") ?? "").toMatch(/retry-after/i);
      // origem hostil continua recebendo 403 (CORS é avaliado antes do aviso de limite)
      expect((await call(menuPath(X.slug), { ip, origin: "https://zz-evil.example.com" })).status).toBe(403);
    });

    it("SDK: o 429 vira StorefrontApiError{code:'rate_limited', status:429, retryAfterSeconds>0}", async () => {
      const ip = newIp();
      await burst(121, () => call(menuPath(Y.slug), { ip }));
      const client = createStorefrontClient({
        baseUrl: BASE,
        slug: Y.slug,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Forwarded-For": ip ?? newIp() } }),
      });
      const err = await client.getMenu().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(StorefrontApiError);
      expect(err).toMatchObject({ code: "rate_limited", status: 429 });
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("quote: 60 requisições por minuto por IP+slug (conta mesmo as inválidas); a 61ª => 429", async () => {
      const ip = newIp();
      // Content-Type errado: 400 barato (não vai ao banco), mas conta no balde
      const results = await burst(66, () => call(quotePath(Y.slug), { method: "POST", ip, headers: { "Content-Type": "text/plain" }, body: "{}" }));
      expect(results.filter((r) => r.status === 400).length).toBe(60);
      const limited = results.filter((r) => r.status === 429);
      expect(limited.length).toBe(6);
      expect(limited.every((r) => Number(r.headers.get("retry-after")) >= 1)).toBe(true);
      // o menu do mesmo slug tem balde próprio
      expect((await call(menuPath(Y.slug), { ip })).status).toBe(200);
    });

    // [F-24 documentado] O IP vem do 1º valor de X-Forwarded-For. Atrás da Vercel/CDN o cabeçalho é sobrescrito pela plataforma,
    // mas num servidor exposto direto (ou proxy que repassa o valor do cliente) qualquer um zera o limite girando o cabeçalho.
    it("[F-24 documentado] girar X-Forwarded-For contorna o limite: sem proxy confiável o rate limit é só 'freio casual'", async () => {
      const ip = newIp();
      await burst(125, () => call(menuPath(X.slug), { ip }));
      expect((await call(menuPath(X.slug), { ip })).status).toBe(429);
      expect((await call(menuPath(X.slug), { ip: newIp() })).status).toBe(200); // IP forjado => cota nova
    });
  });
});
