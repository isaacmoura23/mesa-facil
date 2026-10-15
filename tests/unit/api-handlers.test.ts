import { describe, expect, it, vi } from "vitest";
import { createPublicApi, type PublicApiDeps } from "../../src/modules/public-api/handlers";
import { createRateLimiter } from "../../src/modules/public-api/rate-limit";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BASE = "http://api.test/api/public/v1/restaurants";
const ORIGIN = "https://la-pastelaria.vercel.app";

const RAW_MENU = {
  restaurant: { name: "Demo", slug: "demo-a", logo_path: null, timezone: "America/Sao_Paulo" },
  settings: { accepts_orders: true, enabled_fulfillment_types: ["PICKUP"] },
  is_open_now: true,
  categories: [],
};
const RAW_QUOTE = {
  ok: true, errors: [], items: [],
  subtotal_cents: 0, delivery_fee_cents: 0, discount_cents: 0, total_cents: 0, minimum_order_cents: 0,
};

function setup(overrides: Partial<PublicApiDeps> = {}, limits = { menu: 120, quote: 60, global: 600 }) {
  const deps = {
    loadMenu: vi.fn(async () => RAW_MENU as unknown),
    loadQuote: vi.fn(async () => RAW_QUOTE as unknown),
    loadOrigins: vi.fn(async () => [ORIGIN]),
    limiters: {
      menu: createRateLimiter({ limit: limits.menu, windowMs: 60_000 }),
      quote: createRateLimiter({ limit: limits.quote, windowMs: 60_000 }),
      global: createRateLimiter({ limit: limits.global, windowMs: 60_000 }),
    },
    isDev: () => false,
    imageUrl: () => null,
    logError: vi.fn(),
    ...overrides,
  } satisfies PublicApiDeps;
  return { deps, api: createPublicApi(deps) };
}

const get = (slug: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/${slug}/menu`, { headers });
const post = (body: unknown, headers: Record<string, string> = {}, raw = false) =>
  new Request(`${BASE}/demo-a/cart/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
const validBody = { fulfillmentType: "PICKUP", items: [{ productId: U(4), quantity: 1 }] };

describe("GET menu", () => {
  it("sem Origin: 200, cache público, nosniff, Vary: Origin e SEM cabeçalhos CORS", async () => {
    const { api } = setup();
    const res = await api.menu(get("demo-a"), "demo-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.json();
    expect(body.data.restaurant.slug).toBe("demo-a");
    expect(body.data.categories).toEqual([]);
  });

  it("origem permitida: ACAO exata, sem credentials", async () => {
    const { api } = setup();
    const res = await api.menu(get("demo-a", { origin: ORIGIN }), "demo-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("origem não permitida: 403 origin_not_allowed, sem dados e sem consultar o cardápio", async () => {
    const { api, deps } = setup();
    const res = await api.menu(get("demo-a", { origin: "https://evil.example" }), "demo-a");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("origin_not_allowed");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(deps.loadMenu).not.toHaveBeenCalled();
  });

  it("localhost só em dev e sem consultar origens", async () => {
    const dev = setup({ isDev: () => true });
    const ok = await dev.api.menu(get("demo-a", { origin: "http://localhost:3000" }), "demo-a");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(dev.deps.loadOrigins).not.toHaveBeenCalled();

    const prod = setup();
    const no = await prod.api.menu(get("demo-a", { origin: "http://localhost:3000" }), "demo-a");
    expect(no.status).toBe(403);
  });

  it("slug inválido: 404 sem tocar no banco", async () => {
    const { api, deps } = setup();
    for (const slug of ["Bad_Slug", "-x", "x-", "a b", "%E0%A4%A", "a".repeat(64), "../etc"]) {
      const res = await api.menu(get("x"), slug);
      expect(res.status, slug).toBe(404);
      expect((await res.json()).error.code).toBe("restaurant_not_found");
    }
    expect(deps.loadMenu).not.toHaveBeenCalled();
    expect(deps.loadOrigins).not.toHaveBeenCalled();
  });

  it("restaurante inexistente (RPC devolve null ou {}): 404", async () => {
    for (const value of [null, {}]) {
      const { api } = setup({ loadMenu: async () => value });
      const res = await api.menu(get("nada"), "nada");
      expect(res.status).toBe(404);
    }
  });

  it("erro do banco vira 500 genérico, sem vazar a mensagem", async () => {
    const { api, deps } = setup({
      loadMenu: async () => {
        throw new Error('permission denied for table secret_table (postgres://user:senha@host)');
      },
    });
    const res = await api.menu(get("demo-a"), "demo-a");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("internal_error");
    expect(text).not.toContain("secret_table");
    expect(text).not.toContain("postgres://");
    expect(deps.logError).toHaveBeenCalled();
  });

  it("formato inesperado da RPC: 500 genérico", async () => {
    const { api } = setup({ loadMenu: async () => ({ foo: "bar" }) });
    expect((await api.menu(get("demo-a"), "demo-a")).status).toBe(500);
  });

  it("falha ao carregar origens: 500 (nunca libera por falha)", async () => {
    const { api, deps } = setup({
      loadOrigins: async () => {
        throw new Error("db fora");
      },
    });
    const res = await api.menu(get("demo-a", { origin: ORIGIN }), "demo-a");
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(deps.loadMenu).not.toHaveBeenCalled();
  });

  it("429 com Retry-After por IP+slug (e CORS para origem permitida); outro IP/slug passa", async () => {
    const { api } = setup({}, { menu: 2, quote: 60, global: 600 });
    const h = { "x-forwarded-for": "203.0.113.5" };
    expect((await api.menu(get("demo-a", h), "demo-a")).status).toBe(200);
    expect((await api.menu(get("demo-a", h), "demo-a")).status).toBe(200);
    const limited = await api.menu(get("demo-a", { ...h, origin: ORIGIN }), "demo-a");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(limited.headers.get("cache-control")).toBe("no-store");

    expect((await api.menu(get("demo-b", h), "demo-b")).status).toBe(200);
    expect((await api.menu(get("demo-a", { "x-forwarded-for": "203.0.113.6" }), "demo-a")).status).toBe(200);
  });

  it("limite global por IP freia varredura de slugs", async () => {
    const { api } = setup({}, { menu: 100, quote: 60, global: 3 });
    const h = { "x-forwarded-for": "203.0.113.9" };
    const codes: number[] = [];
    for (const slug of ["a", "b", "c", "d"]) codes.push((await api.menu(get("x", h), slug)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("POST cart/quote", () => {
  it("200 com envelope {data}, no-store e CORS da origem permitida", async () => {
    const { api, deps } = setup();
    const res = await api.quote(post(validBody, { origin: ORIGIN }), "demo-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await res.json()).data.ok).toBe(true);
    expect(deps.loadQuote).toHaveBeenCalledWith("demo-a", {
      fulfillment: "PICKUP",
      items: [{ product_id: U(4), quantity: 1, modifier_ids: [] }],
      zoneId: null,
    });
  });

  it("zona só é enviada quando DELIVERY", async () => {
    const { api, deps } = setup();
    await api.quote(post({ ...validBody, deliveryZoneId: U(9) }), "demo-a");
    expect(deps.loadQuote).toHaveBeenLastCalledWith("demo-a", expect.objectContaining({ zoneId: null }));
    await api.quote(post({ ...validBody, fulfillmentType: "DELIVERY", deliveryZoneId: U(9) }), "demo-a");
    expect(deps.loadQuote).toHaveBeenLastCalledWith("demo-a", expect.objectContaining({ zoneId: U(9) }));
  });

  it("400 para content-type errado, JSON quebrado e corpo inválido (com details)", async () => {
    const { api, deps } = setup();
    const wrongType = new Request(`${BASE}/demo-a/cart/quote`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(validBody),
    });
    expect((await api.quote(wrongType, "demo-a")).status).toBe(400);
    expect((await api.quote(post("{ruim", {}, true), "demo-a")).status).toBe(400);

    const bad = await api.quote(post({ fulfillmentType: "X", items: [{ productId: "no", quantity: 0 }] }), "demo-a");
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(deps.loadQuote).not.toHaveBeenCalled();
  });

  it("413 acima de 64 KB (Content-Length e corpo sem tamanho declarado)", async () => {
    const { api } = setup();
    const big = JSON.stringify({ ...validBody, pad: "a".repeat(70_000) });
    const declared = await api.quote(post(big, {}, true), "demo-a");
    expect(declared.status).toBe(413);
    expect((await declared.json()).error.code).toBe("payload_too_large");

    // Sem Content-Length (stream): o corte acontece durante a leitura.
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
        controller.close();
      },
    });
    const streamed = new Request(`${BASE}/demo-a/cart/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await api.quote(streamed, "demo-a")).status).toBe(413);
  });

  it("origem não permitida: 403 sem consultar a RPC", async () => {
    const { api, deps } = setup();
    const res = await api.quote(post(validBody, { origin: "https://evil.example" }), "demo-a");
    expect(res.status).toBe(403);
    expect(deps.loadQuote).not.toHaveBeenCalled();
  });

  it("limite do quote (60/min) é separado do menu", async () => {
    const { api } = setup({}, { menu: 120, quote: 1, global: 600 });
    expect((await api.quote(post(validBody), "demo-a")).status).toBe(200);
    expect((await api.quote(post(validBody), "demo-a")).status).toBe(429);
    expect((await api.menu(get("demo-a"), "demo-a")).status).toBe(200);
  });

  it("erro do banco => 500 genérico e formato inesperado => 500", async () => {
    const boom = setup({
      loadQuote: async () => {
        throw new Error("violates foreign key constraint orders_fk");
      },
    });
    const res = await boom.api.quote(post(validBody), "demo-a");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("foreign key");

    const odd = setup({ loadQuote: async () => ({ nada: true }) });
    expect((await odd.api.quote(post(validBody), "demo-a")).status).toBe(500);
  });

  it("carrinho inválido segundo o servidor continua 200 com ok=false e mensagens PT-BR", async () => {
    const { api } = setup({
      loadQuote: async () => ({
        ...RAW_QUOTE,
        ok: false,
        errors: [{ code: "RESTAURANT_CLOSED", message: "texto cru" }],
      }),
    });
    const res = await api.quote(post(validBody), "demo-a");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.ok).toBe(false);
    expect(data.errors[0]).toMatchObject({ code: "RESTAURANT_CLOSED", itemIndex: null });
    expect(data.errors[0].message).not.toContain("texto cru");
  });
});

describe("OPTIONS (preflight)", () => {
  const opts = (origin?: string) =>
    new Request(`${BASE}/demo-a/cart/quote`, {
      method: "OPTIONS",
      headers: {
        ...(origin ? { origin } : {}),
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

  it("origem permitida: 204 com Allow-Origin exata, métodos, cabeçalhos e Max-Age", async () => {
    const { api } = setup();
    const res = await api.quotePreflight(opts(ORIGIN), "demo-a");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
    expect(await res.text()).toBe("");
  });

  it("menu anuncia GET", async () => {
    const { api } = setup();
    const res = await api.menuPreflight(opts(ORIGIN), "demo-a");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("origem não permitida: 403; sem Origin: 204 sem CORS; slug inválido: 404", async () => {
    const { api } = setup();
    const denied = await api.quotePreflight(opts("https://evil.example"), "demo-a");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const none = await api.quotePreflight(opts(), "demo-a");
    expect(none.status).toBe(204);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();

    expect((await api.quotePreflight(opts(ORIGIN), "Slug_Ruim")).status).toBe(404);
  });

  it("dev: libera localhost mesmo sem origens cadastradas", async () => {
    const { api } = setup({ isDev: () => true, loadOrigins: async () => [] });
    const res = await api.quotePreflight(opts("http://localhost:5173"), "demo-a");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
