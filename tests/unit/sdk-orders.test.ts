/* eslint-disable @typescript-eslint/no-explicit-any */
/** SDK (Fase 3): createOrder / trackOrder / newIdempotencyKey com `fetch` simulado. */
import { describe, expect, it, vi } from "vitest";
import { createStorefrontClient, newIdempotencyKey, StorefrontApiError } from "../../sdk/src/index";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const input = { fulfillmentType: "PICKUP" as const, items: [{ productId: "p1", quantity: 1 }], customer: { name: "Maria", phone: "11912345678" }, payment: { method: "PIX" as const } };
const created = { publicCode: "ABCDEFGH23456789", orderNumber: 1, status: "RECEIVED", subtotalCents: 1000, deliveryFeeCents: 0, totalCents: 1000, estimatedReadyAt: null, idempotentReplay: false };
const client = (fetchMock: any) => createStorefrontClient({ baseUrl: "http://api.test/", slug: "demo-a", fetch: fetchMock });

describe("newIdempotencyKey", () => {
  it("gera chaves únicas no formato aceito pelo servidor (16-100 [A-Za-z0-9_-])", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
  });
  it("sem crypto.randomUUID usa getRandomValues e, por último, Math.random (ainda válido)", () => {
    const real = globalThis.crypto;
    try {
      vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(171) });
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
      vi.stubGlobal("crypto", undefined);
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      vi.stubGlobal("crypto", real);
    }
  });
});

describe("createOrder", () => {
  it("POST /orders: chave gerada vai no HEADER (não no corpo), corpo JSON camelCase sem idempotencyKey; devolve data", async () => {
    const f = vi.fn(async () => json(201, { data: created }));
    const order = await client(f).createOrder(input);
    expect(order).toEqual(created);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/public/v1/restaurants/demo-a/orders");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
    expect(h["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(init.body as string).not.toContain("idempotencyKey");
  });
  it("a chave do chamador é usada tal e qual (retry seguro: mesma chave nas duas tentativas)", async () => {
    const f = vi.fn(async () => json(200, { data: { ...created, idempotentReplay: true } }));
    const c = client(f);
    const key = newIdempotencyKey();
    await c.createOrder({ ...input, idempotencyKey: key });
    await c.createOrder({ ...input, idempotencyKey: key });
    const keys = f.mock.calls.map((call: any) => call[1].headers["Idempotency-Key"]);
    expect(keys).toEqual([key, key]);
  });
  it("sem chave informada, cada chamada gera uma chave diferente", async () => {
    const f = vi.fn(async () => json(201, { data: created }));
    const c = client(f);
    await c.createOrder(input);
    await c.createOrder(input);
    const [a, b] = f.mock.calls.map((call: any) => call[1].headers["Idempotency-Key"]);
    expect(a).not.toBe(b);
  });
  it("422 order_rejected => StorefrontApiError com rejections[] normalizadas; entradas malformadas são descartadas", async () => {
    const f = vi.fn(async () =>
      json(422, { error: { code: "order_rejected", message: "O pedido não pôde ser aceito.", errors: [{ code: "RESTAURANT_CLOSED", field: null, itemIndex: null, message: "Fechado." }, { code: "PRODUCT_UNAVAILABLE", field: "items", itemIndex: 3, message: "Indisponível." }, { code: 5 }, null, "x", { code: "X" }] } }),
    );
    const err = await client(f).createOrder(input).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(StorefrontApiError);
    expect(err).toMatchObject({ code: "order_rejected", status: 422 });
    expect(err.rejections).toEqual([
      { code: "RESTAURANT_CLOSED", field: null, itemIndex: null, message: "Fechado." },
      { code: "PRODUCT_UNAVAILABLE", field: "items", itemIndex: 3, message: "Indisponível." },
    ]);
  });
  it("400 traz details; 409 idempotency_conflict; 429 traz retryAfterSeconds; rejections fica null fora do 422", async () => {
    const bad = await client(async () => json(400, { error: { code: "invalid_request", message: "x", details: [{ path: "customer.phone", message: "Telefone inválido." }] } })).createOrder(input).then(() => null, (e) => e);
    expect(bad).toMatchObject({ code: "invalid_request", status: 400, details: [{ path: "customer.phone", message: "Telefone inválido." }], rejections: null });
    const conflict = await client(async () => json(409, { error: { code: "idempotency_conflict", message: "x" } })).createOrder(input).then(() => null, (e) => e);
    expect(conflict).toMatchObject({ code: "idempotency_conflict", status: 409 });
    const limited = await client(async () => json(429, { error: { code: "rate_limited", message: "x" } }, { "Retry-After": "120" })).createOrder(input).then(() => null, (e) => e);
    expect(limited).toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 120 });
  });
  it("rede caída => network_error (status 0); resposta sem JSON => erro tipado, sem lançar erro genérico", async () => {
    const down = await client(async () => { throw new TypeError("fetch failed"); }).createOrder(input).then(() => null, (e) => e);
    expect(down).toBeInstanceOf(StorefrontApiError);
    expect(down.status).toBe(0);
    const html = await client(async () => new Response("<html>502</html>", { status: 502 })).createOrder(input).then(() => null, (e) => e);
    expect(html).toBeInstanceOf(StorefrontApiError);
    expect(html.status).toBe(502);
  });
});

describe("trackOrder", () => {
  it("GET /orders/{code} com o código codificado na URL e sem corpo/Content-Type", async () => {
    const f = vi.fn(async () => json(200, { data: { orderNumber: 1, status: "RECEIVED" } }));
    const t = await client(f).trackOrder("ABCDEFGH23456789");
    expect(t).toMatchObject({ orderNumber: 1, status: "RECEIVED" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/public/v1/restaurants/demo-a/orders/ABCDEFGH23456789");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
  it("códigos com caracteres especiais não escapam do caminho (encodeURIComponent)", async () => {
    const f = vi.fn(async () => json(404, { error: { code: "order_not_found", message: "x" } }));
    for (const code of ["../menu", "a/b", "a?b=1", "a#b", "a b", "%2e%2e"]) {
      await client(f).trackOrder(code).then(() => null, () => null);
    }
    const urls = f.mock.calls.map((c: any) => c[0] as string);
    expect(urls[0]).toBe("http://api.test/api/public/v1/restaurants/demo-a/orders/..%2Fmenu");
    for (const u of urls) {
      expect(u.startsWith("http://api.test/api/public/v1/restaurants/demo-a/orders/")).toBe(true);
      expect(u.slice("http://api.test/api/public/v1/restaurants/demo-a/orders/".length)).not.toMatch(/[/?# ]/);
    }
  });
  it("404 => StorefrontApiError order_not_found", async () => {
    const err = await client(async () => json(404, { error: { code: "order_not_found", message: "Pedido não encontrado." } })).trackOrder("AAAAAAAAAAAAAAAA").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(StorefrontApiError);
    expect(err).toMatchObject({ code: "order_not_found", status: 404 });
  });
});
