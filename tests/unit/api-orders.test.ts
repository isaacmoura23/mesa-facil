/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 3, API pública: rotas de pedido em src/modules/public-api/handlers.ts (sem Next nem banco) e `refund` do rate limiter.
 * `deps.orders` é simulado: o foco é a ORQUESTRAÇÃO (Idempotency-Key, status HTTP, devolução de cota, CORS, vazamentos).
 */
import { describe, expect, it, vi } from "vitest";
import { createPublicApi, type OrdersDeps, type PublicApiDeps } from "../../src/modules/public-api/handlers";
import { createRateLimiter } from "../../src/modules/public-api/rate-limit";
import type { SubmitOrderResult } from "../../src/modules/orders-server/schemas";
import type { TrackResult } from "../../src/modules/orders-server/tracking";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BASE = "http://api.test/api/public/v1/restaurants";
const ORIGIN = "https://la-pastelaria.vercel.app";
const KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const KEY2 = "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e";

const created = (over: Record<string, unknown> = {}): SubmitOrderResult => ({
  status: "created",
  order: { publicCode: "ABCDEFGH23456789", orderNumber: 12, status: "RECEIVED", totalCents: 2500, subtotalCents: 2000, deliveryFeeCents: 500, estimatedReadyAt: "2026-10-15T13:00:00+00:00", idempotentReplay: false, ...over },
});
const tracked = (): TrackResult => ({
  status: "ok",
  order: {
    restaurantName: "Demo",
    timezone: "America/Sao_Paulo",
    orderNumber: 12,
    fulfillmentType: "PICKUP",
    status: "RECEIVED",
    paymentStatus: "UNPAID",
    paymentMethod: "PIX",
    items: [],
    subtotalCents: 2000,
    deliveryFeeCents: 0,
    discountCents: 0,
    totalCents: 2000,
    statusHistory: [],
    neighborhood: null,
    createdAt: null,
    estimatedReadyAt: null,
    statusReason: null,
  },
});

function setup(opts: { submit?: OrdersDeps["submit"]; track?: OrdersDeps["track"]; allowed?: boolean; noOrders?: boolean } = {}) {
  const finish = vi.fn();
  const submit = vi.fn(opts.submit ?? (async () => created()));
  const track = vi.fn(opts.track ?? (async () => tracked()));
  const beginAttempt = vi.fn((_ip: string, _slug: string) => (opts.allowed === false ? ({ allowed: false as const, retryAfterSeconds: 42 }) : ({ allowed: true as const, finish })));
  const trackLimiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
  const logError = vi.fn();
  const deps: PublicApiDeps = {
    loadMenu: vi.fn(async () => null),
    loadQuote: vi.fn(async () => null),
    loadOrigins: vi.fn(async () => [ORIGIN]),
    limiters: {
      menu: createRateLimiter({ limit: 100, windowMs: 60_000 }),
      quote: createRateLimiter({ limit: 100, windowMs: 60_000 }),
      global: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    },
    ...(opts.noOrders ? {} : { orders: { submit, track, beginAttempt, trackLimiter } }),
    isDev: () => false,
    imageUrl: () => null,
    logError,
  };
  return { api: createPublicApi(deps), submit, track, beginAttempt, finish, trackLimiter, logError, deps };
}

const body = (over: Record<string, unknown> = {}) => ({
  fulfillmentType: "PICKUP",
  items: [{ productId: U(1), quantity: 1 }],
  customer: { name: "Maria Souza", phone: "(11) 91234-5678" },
  payment: { method: "PIX" },
  ...over,
});
const req = (json: unknown, headers: Record<string, string> = {}, slug = "demo-a") =>
  new Request(`${BASE}/${slug}/orders`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof json === "string" ? json : JSON.stringify(json) });
const getReq = (code: string, headers: Record<string, string> = {}, slug = "demo-a") => new Request(`${BASE}/${slug}/orders/${code}`, { headers });

describe("POST orders: Idempotency-Key", () => {
  it("campo no corpo: serviço recebe a chave; 201 com os campos públicos e SEM ids internos", async () => {
    const { api, submit, finish } = setup();
    const res = await api.createOrder(req(body({ idempotencyKey: KEY })), "demo-a");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({
      data: { publicCode: "ABCDEFGH23456789", orderNumber: 12, status: "RECEIVED", subtotalCents: 2000, deliveryFeeCents: 500, totalCents: 2500, estimatedReadyAt: "2026-10-15T13:00:00+00:00", idempotentReplay: false },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe("demo-a");
    expect((submit.mock.calls[0][1] as any).idempotencyKey).toBe(KEY);
    expect(finish).toHaveBeenCalledWith(true);
  });

  it("header Idempotency-Key sem o campo: vale; header + campo iguais: vale; diferentes: 400 sem chamar o serviço", async () => {
    const { api, submit } = setup();
    const viaHeader = await api.createOrder(req(body(), { "Idempotency-Key": KEY }), "demo-a");
    expect(viaHeader.status).toBe(201);
    expect((submit.mock.calls[0][1] as any).idempotencyKey).toBe(KEY);
    const same = await api.createOrder(req(body({ idempotencyKey: KEY }), { "idempotency-key": ` ${KEY} ` }), "demo-a");
    expect(same.status).toBe(201);
    const clash = await api.createOrder(req(body({ idempotencyKey: KEY2 }), { "Idempotency-Key": KEY }), "demo-a");
    expect(clash.status).toBe(400);
    expect((await clash.json()).error.code).toBe("invalid_request");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("sem chave ou com chave inválida (campo ou header) => 400 com details[idempotencyKey]; o limite estrito não é consumido", async () => {
    const { api, submit, beginAttempt } = setup();
    const missing = await api.createOrder(req(body()), "demo-a");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.details).toEqual([{ path: "idempotencyKey", message: "Obrigatória." }]);
    for (const bad of ["curta", "x".repeat(101), "com espaço no meio 12345", "chavé-ção-1234567890"]) {
      expect((await api.createOrder(req(body({ idempotencyKey: bad })), "demo-a")).status, bad).toBe(400);
    }
    for (const bad of ["curta", "x".repeat(101), "com espaço no meio 12345"]) {
      const r = await api.createOrder(req(body(), { "Idempotency-Key": bad }), "demo-a");
      expect(r.status, `header ${bad}`).toBe(400);
      expect((await r.json()).error.details[0].path).toBe("idempotencyKey");
    }
    expect(submit).not.toHaveBeenCalled();
    expect(beginAttempt).not.toHaveBeenCalled();
  });

  it("replay: 200 com idempotentReplay:true; a cota de pedidos CRIADOS é devolvida (finish(false))", async () => {
    const { api, finish } = setup({ submit: async () => created({ idempotentReplay: true }) });
    const res = await api.createOrder(req(body({ idempotencyKey: KEY })), "demo-a");
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotentReplay).toBe(true);
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("POST orders: mapeamento de resultados e devolução de cota", () => {
  const run = async (result: SubmitOrderResult | Error) => {
    const s = setup({ submit: async () => { if (result instanceof Error) throw result; return result; } });
    const res = await s.api.createOrder(req(body({ idempotencyKey: KEY })), "demo-a");
    return { res, json: await res.json(), ...s };
  };

  it("rejected => 422 order_rejected com errors[] (code/field/itemIndex/message); cota devolvida", async () => {
    const errors = [{ code: "RESTAURANT_CLOSED", field: null, itemIndex: null, message: "Fechado." }, { code: "PRODUCT_UNAVAILABLE", field: null, itemIndex: 2, message: "Indisponível." }];
    const { res, json, finish } = await run({ status: "rejected", errors });
    expect(res.status).toBe(422);
    expect(json.error).toEqual({ code: "order_rejected", message: expect.any(String), errors });
    expect(finish).toHaveBeenCalledWith(false);
  });
  it("conflict => 409 idempotency_conflict; invalid => 400 com details; not_found => 404; error => 500 genérico (sem texto interno)", async () => {
    const c = await run({ status: "conflict" });
    expect([c.res.status, c.json.error.code]).toEqual([409, "idempotency_conflict"]);
    const i = await run({ status: "invalid", issues: [{ path: "customer.phone", message: "Informe um telefone válido." }] });
    expect([i.res.status, i.json.error.code, i.json.error.details]).toEqual([400, "invalid_request", [{ path: "customer.phone", message: "Informe um telefone válido." }]]);
    const n = await run({ status: "not_found" });
    expect([n.res.status, n.json.error.code]).toEqual([404, "restaurant_not_found"]);
    const e = await run({ status: "error" });
    expect([e.res.status, e.json.error.code]).toEqual([500, "internal_error"]);
    for (const r of [c, i, n, e]) expect(r.finish).toHaveBeenCalledWith(false);
  });
  it("serviço que LANÇA => 500 internal_error, erro só no log (nunca na resposta) e cota devolvida", async () => {
    const { res, json, logError, finish } = await run(new Error('relation "orders" does not exist at /home/app/src/modules/x.ts:10:3'));
    expect(res.status).toBe(500);
    expect(json.error.code).toBe("internal_error");
    expect(JSON.stringify(json)).not.toMatch(/relation|orders|home\/app|src\/modules/);
    expect(logError).toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(false);
  });
  it("limite estrito atingido => 429 rate_limited com Retry-After do limitador; o serviço NÃO é chamado", async () => {
    const { api, submit } = setup({ allowed: false });
    const res = await api.createOrder(req(body({ idempotencyKey: KEY })), "demo-a");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(submit).not.toHaveBeenCalled();
  });
  it("o IP e o slug normalizado vão para beginAttempt (X-Forwarded-For: primeiro valor)", async () => {
    const { api, beginAttempt } = setup();
    await api.createOrder(req(body({ idempotencyKey: KEY }), { "x-forwarded-for": "198.18.1.2, 10.0.0.1" }, "DEMO-A"), "DEMO-A");
    expect(beginAttempt).toHaveBeenCalledWith("198.18.1.2", "demo-a");
  });
  it("sem deps.orders configuradas => 500 internal_error (nunca crash); o log explica", async () => {
    const { api, logError } = setup({ noOrders: true });
    const res = await api.createOrder(req(body({ idempotencyKey: KEY })), "demo-a");
    expect(res.status).toBe(500);
    expect(logError).toHaveBeenCalled();
    expect((await api.trackOrder(getReq("ABCDEFGH23456789"), "demo-a", "ABCDEFGH23456789")).status).toBe(500);
  });
});

describe("POST orders: entrada inválida (antes do serviço e do limite estrito)", () => {
  it("Content-Type errado, JSON quebrado, corpo grande, não-objeto e zod => 400/413 sem tocar no serviço", async () => {
    const { api, submit, beginAttempt } = setup();
    const ct = await api.createOrder(new Request(`${BASE}/demo-a/orders`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body({ idempotencyKey: KEY })) }), "demo-a");
    expect(ct.status).toBe(400);
    expect((await api.createOrder(req("{ quebrado"), "demo-a")).status).toBe(400);
    for (const j of [null, [], "x", 1]) expect((await api.createOrder(req(j), "demo-a")).status, JSON.stringify(j)).toBe(400);
    const big = await api.createOrder(req(JSON.stringify({ ...body({ idempotencyKey: KEY }), pad: "x".repeat(70 * 1024) })), "demo-a");
    expect(big.status).toBe(413);
    const zod = await api.createOrder(req(body({ idempotencyKey: KEY, customer: { name: "A", phone: "1" } })), "demo-a");
    expect(zod.status).toBe(400);
    const j = await zod.json();
    expect(j.error.code).toBe("invalid_request");
    expect(j.error.details.length).toBeGreaterThan(0);
    expect(j.error.details.length).toBeLessThanOrEqual(10);
    for (const d of j.error.details) expect(Object.keys(d).sort()).toEqual(["message", "path"]);
    expect(submit).not.toHaveBeenCalled();
    expect(beginAttempt).not.toHaveBeenCalled();
  });
  it("slug inválido => 404 antes de qualquer processamento", async () => {
    const { api, submit } = setup();
    for (const slug of ["a_b", "-x", "a".repeat(64), ""]) expect((await api.createOrder(req(body({ idempotencyKey: KEY }), {}, slug), slug)).status, slug).toBe(404);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("CORS dos pedidos", () => {
  it("origem não cadastrada => 403 e o serviço nunca roda (nenhum pedido criado por origem hostil)", async () => {
    const { api, submit, beginAttempt } = setup();
    for (const origin of ["https://evil.example.com", "null", `${ORIGIN}/`, "http://la-pastelaria.vercel.app"]) {
      const res = await api.createOrder(req(body({ idempotencyKey: KEY }), { origin }), "demo-a");
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect((await api.trackOrder(getReq("ABCDEFGH23456789", { origin }), "demo-a", "ABCDEFGH23456789")).status).toBe(403);
    }
    expect(submit).not.toHaveBeenCalled();
    expect(beginAttempt).not.toHaveBeenCalled();
  });
  it("origem cadastrada: ACAO nas respostas 201/422/400/429 e no acompanhamento; sem Allow-Credentials", async () => {
    const mk = (o: Parameters<typeof setup>[0]) => setup(o);
    const ok = mk({});
    const r201 = await ok.api.createOrder(req(body({ idempotencyKey: KEY }), { origin: ORIGIN }), "demo-a");
    const r400 = await ok.api.createOrder(req(body(), { origin: ORIGIN }), "demo-a");
    const r422 = await mk({ submit: async () => ({ status: "rejected", errors: [{ code: "EMPTY_CART", field: null, itemIndex: null, message: "Vazio." }] }) }).api.createOrder(req(body({ idempotencyKey: KEY }), { origin: ORIGIN }), "demo-a");
    const r429 = await mk({ allowed: false }).api.createOrder(req(body({ idempotencyKey: KEY }), { origin: ORIGIN }), "demo-a");
    const rTrack = await ok.api.trackOrder(getReq("ABCDEFGH23456789", { origin: ORIGIN }), "demo-a", "ABCDEFGH23456789");
    expect([r201.status, r400.status, r422.status, r429.status, rTrack.status]).toEqual([201, 400, 422, 429, 200]);
    for (const r of [r201, r400, r422, r429, rTrack]) {
      expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(r.headers.get("vary")).toMatch(/Origin/);
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
    expect(r429.headers.get("access-control-expose-headers") ?? "").toMatch(/Retry-After/i);
  });
  it("preflight: orders => POST,OPTIONS com Idempotency-Key liberado; orders/{code} => GET,OPTIONS; origem hostil => 403", async () => {
    const { api } = setup();
    const pre = (url: string, origin: string, method: string) => new Request(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": method } });
    const post = await api.ordersPreflight(pre(`${BASE}/demo-a/orders`, ORIGIN, "POST"), "demo-a");
    expect(post.status).toBe(204);
    expect(post.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(post.headers.get("access-control-allow-headers")).toMatch(/Idempotency-Key/i);
    expect(post.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const get = await api.trackPreflight(pre(`${BASE}/demo-a/orders/X`, ORIGIN, "GET"), "demo-a");
    expect(get.status).toBe(204);
    expect(get.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    for (const f of [api.ordersPreflight, api.trackPreflight]) {
      const bad = await f(pre(`${BASE}/demo-a/orders`, "https://evil.example.com", "POST"), "demo-a");
      expect(bad.status).toBe(403);
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await api.ordersPreflight(pre(`${BASE}/a_b/orders`, ORIGIN, "POST"), "a_b")).status).toBe(404);
  });
});

describe("GET orders/{publicCode}", () => {
  it("200 {data} do modelo sem PII, no-store, noindex; o serviço recebe slug e código já aparados", async () => {
    const { api, track } = setup();
    const res = await api.trackOrder(getReq("ABCDEFGH23456789"), "demo-a", " ABCDEFGH23456789 ");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    const json = await res.json();
    expect(Object.keys(json)).toEqual(["data"]);
    expect(json.data).toMatchObject({ orderNumber: 12, status: "RECEIVED", paymentStatus: "UNPAID" });
    expect(track).toHaveBeenCalledWith("demo-a", "ABCDEFGH23456789");
  });
  it("código malformado/codificado de forma inválida => 404 order_not_found SEM consultar o banco", async () => {
    const { api, track } = setup();
    let n = 0;
    for (const code of ["ab", "x".repeat(41), "a b", "a%2Fb", "..", "%00", "%E0%A4%A", "a_b_c_d", "' or 1=1 --", "😀😀😀"]) {
      const res = await api.trackOrder(getReq("X", { "x-forwarded-for": `198.18.9.${++n}` }), "demo-a", code);
      expect(res.status, code).toBe(404);
      expect((await res.json()).error.code).toBe("order_not_found");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(track).not.toHaveBeenCalled();
  });
  it("not_found => 404 order_not_found; error => 500; serviço que lança => 500 sem texto interno", async () => {
    const nf = setup({ track: async () => ({ status: "not_found" }) });
    const r404 = await nf.api.trackOrder(getReq("ABCDEFGH23456789"), "demo-a", "ABCDEFGH23456789");
    expect([r404.status, (await r404.json()).error.code]).toEqual([404, "order_not_found"]);
    const er = setup({ track: async () => ({ status: "error" }) });
    expect((await er.api.trackOrder(getReq("ABCDEFGH23456789"), "demo-a", "ABCDEFGH23456789")).status).toBe(500);
    const boom = setup({ track: async () => { throw new Error("connection refused 127.0.0.1:54321"); } });
    const rb = await boom.api.trackOrder(getReq("ABCDEFGH23456789"), "demo-a", "ABCDEFGH23456789");
    expect(rb.status).toBe(500);
    expect(await rb.text()).not.toMatch(/127\.0\.0\.1|connection refused/);
    expect(boom.logError).toHaveBeenCalled();
  });
  it("limite de consultas por IP+slug (60/min em produção; aqui 3): o 4º => 429 com Retry-After, inclusive para 404", async () => {
    const { api, track } = setup();
    const call = (code: string) => api.trackOrder(getReq(code, { "x-forwarded-for": "198.18.5.5" }), "demo-a", code);
    expect([(await call("ABCDEFGH23456789")).status, (await call("ABCDEFGH23456788")).status, (await call("zz")).status]).toEqual([200, 200, 404]);
    const limited = await call("ABCDEFGH23456789");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(track).toHaveBeenCalledTimes(2);
    // outro IP continua livre
    expect((await api.trackOrder(getReq("ABCDEFGH23456789", { "x-forwarded-for": "198.18.5.6" }), "demo-a", "ABCDEFGH23456789")).status).toBe(200);
  });
});

describe("createRateLimiter.refund", () => {
  it("devolve a última tentativa: libera uma vaga sem mexer nas demais", () => {
    let now = 0;
    const l = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    now = 1000;
    l.check("k");
    now = 2000;
    l.check("k");
    expect(l.check("k").allowed).toBe(false);
    l.refund("k");
    now = 3000;
    expect(l.check("k")).toMatchObject({ allowed: true, remaining: 0 });
    expect(l.check("k").allowed).toBe(false);
  });
  it("remove o ÚLTIMO registro (a janela continua contando a primeira tentativa para o Retry-After)", () => {
    let now = 0;
    const l = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    now = 1000;
    l.check("k");
    now = 40_000;
    l.check("k");
    l.refund("k"); // sobra só o hit de t=1000
    now = 41_000;
    l.check("k");
    const denied = l.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(20); // o hit de t=1000 sai em t=61000
  });
  it("chave desconhecida ou já vazia: não lança e não cria chave; ao zerar a chave ela é removida (size)", () => {
    const l = createRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(() => l.refund("nunca-vista")).not.toThrow();
    expect(l.size()).toBe(0);
    l.check("a");
    expect(l.size()).toBe(1);
    l.refund("a");
    expect(l.size()).toBe(0);
    l.refund("a");
    expect(l.size()).toBe(0);
  });
  it("devolver mais do que foi consumido nunca dá crédito extra (nunca passa do limite)", () => {
    const l = createRateLimiter({ limit: 2, windowMs: 60_000 });
    l.check("k");
    for (let i = 0; i < 5; i++) l.refund("k");
    expect([l.check("k").allowed, l.check("k").allowed, l.check("k").allowed]).toEqual([true, true, false]);
  });
  it("chaves independentes: devolver uma não afeta a outra", () => {
    const l = createRateLimiter({ limit: 1, windowMs: 60_000 });
    l.check("a");
    l.check("b");
    l.refund("a");
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("b").allowed).toBe(false);
  });
});
