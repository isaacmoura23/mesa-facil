/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 8 (unitários): adaptador Upstash, rate limit assíncrono, IP do cliente e Turnstile.
 * `fetch` é simulado; nada toca rede nem banco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const UP = { url: "https://up.example.test/", token: "tok-secret" };
const stubUp = () => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", UP.url);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", UP.token);
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const jsonRes = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
const timeoutErr = () => new DOMException("The operation timed out", "TimeoutError");

describe("upstash.ts", () => {
  it("upstashConfig: exige URL https (ou localhost) E token; remove barra final; sem chaves = null", async () => {
    const { upstashConfig } = await import("../../src/modules/public-api/upstash");
    expect(upstashConfig({})).toBeNull();
    expect(upstashConfig({ UPSTASH_REDIS_REST_URL: "https://x.test" })).toBeNull();
    expect(upstashConfig({ UPSTASH_REDIS_REST_TOKEN: "t" })).toBeNull();
    expect(upstashConfig({ UPSTASH_REDIS_REST_URL: "  ", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeNull();
    expect(upstashConfig({ UPSTASH_REDIS_REST_URL: "http://evil.example.test", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeNull();
    expect(upstashConfig({ UPSTASH_REDIS_REST_URL: "http://localhost:8079", UPSTASH_REDIS_REST_TOKEN: "t" })).toEqual({ url: "http://localhost:8079", token: "t" });
    expect(upstashConfig({ UPSTASH_REDIS_REST_URL: "https://x.test///", UPSTASH_REDIS_REST_TOKEN: " t " })).toEqual({ url: "https://x.test", token: "t" });
  });

  it("sem configuração: upstashIncr devolve null e NÃO chama a rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { upstashIncr, upstashDecr } = await import("../../src/modules/public-api/upstash");
    expect(await upstashIncr("k", 1000)).toBeNull();
    await upstashDecr("k");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upstashIncr: MULTI/EXEC com INCR + PEXPIRE NX + PTTL, Authorization Bearer e timeout (signal); devolve count e ttl", async () => {
    stubUp();
    const fetchMock = vi.fn(async () => jsonRes([{ result: 3 }, { result: 0 }, { result: 45_000 }]));
    vi.stubGlobal("fetch", fetchMock);
    const { upstashIncr } = await import("../../src/modules/public-api/upstash");
    expect(await upstashIncr("rl:x:1.2.3.4", 60_000)).toEqual({ count: 3, ttlMs: 45_000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://up.example.test/multi-exec");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    expect(JSON.parse(init.body as string)).toEqual([["INCR", "rl:x:1.2.3.4"], ["PEXPIRE", "rl:x:1.2.3.4", 60_000, "NX"], ["PTTL", "rl:x:1.2.3.4"]]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("PTTL negativo (chave sem expiração): reaplica PEXPIRE por pipeline e assume a janela inteira", async () => {
    stubUp();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith("/multi-exec") ? jsonRes([{ result: 1 }, { result: 0 }, { result: -1 }]) : jsonRes([{ result: 1 }])));
    vi.stubGlobal("fetch", fetchMock);
    const { upstashIncr } = await import("../../src/modules/public-api/upstash");
    expect(await upstashIncr("k", 5000)).toEqual({ count: 1, ttlMs: 5000 });
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/pipeline") && JSON.parse((i as RequestInit).body as string)[0][0] === "PEXPIRE")).toBe(true);
  });

  it("upstashDecr usa o pipeline com DECR", async () => {
    stubUp();
    const fetchMock = vi.fn(async () => jsonRes([{ result: 0 }]));
    vi.stubGlobal("fetch", fetchMock);
    const { upstashDecr } = await import("../../src/modules/public-api/upstash");
    await upstashDecr("k1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://up.example.test/pipeline");
    expect(JSON.parse(init.body as string)).toEqual([["DECR", "k1"]]);
  });

  it("falhas viram null (nunca lançam): timeout, rede, HTTP 500, corpo que não é array, resultado não numérico, HTML", async () => {
    stubUp();
    const scenarios: Array<() => Promise<Response>> = [
      async () => {
        throw timeoutErr();
      },
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => jsonRes({ error: "boom" }, { status: 500 }),
      async () => jsonRes({ result: 1 }),
      async () => jsonRes([{ result: "abc" }, { result: 0 }, { result: 10 }]),
      async () => new Response("<html>", { status: 200 }),
    ];
    for (const s of scenarios) {
      vi.resetModules();
      vi.stubGlobal("fetch", vi.fn(s));
      const { upstashIncr } = await import("../../src/modules/public-api/upstash");
      await expect(upstashIncr("k", 1000)).resolves.toBeNull();
    }
  });

  it("o aviso de indisponibilidade é limitado (1 por minuto) e não vaza o token", async () => {
    stubUp();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({}, { status: 503 })));
    const { upstashIncr } = await import("../../src/modules/public-api/upstash");
    for (let i = 0; i < 5; i++) await upstashIncr("k", 1000);
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("tok-secret");
  });

  it("warnIfMemoryOnly: avisa UMA vez só em produção sem Upstash", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { warnIfMemoryOnly } = await import("../../src/modules/public-api/upstash");
    warnIfMemoryOnly();
    warnIfMemoryOnly();
    expect(console.warn).toHaveBeenCalledTimes(1);
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    (console.warn as any).mockClear();
    (await import("../../src/modules/public-api/upstash")).warnIfMemoryOnly();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("rate-limit.ts: checkAsync/refundAsync", () => {
  it("sem Upstash: checkAsync = check em memória; sem `name` nunca usa o Redis mesmo configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createRateLimiter, checkLimit } = await import("../../src/modules/public-api/rate-limit");
    const l = createRateLimiter({ limit: 2, windowMs: 1000, name: "t" });
    expect((await l.checkAsync!("k")).allowed).toBe(true);
    expect((await l.checkAsync!("k")).allowed).toBe(true);
    expect((await l.checkAsync!("k")).allowed).toBe(false);
    stubUp();
    const anonymous = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect((await checkLimit(anonymous, "k")).allowed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("com Upstash: dentro do limite permite (remaining), acima nega com Retry-After do PTTL e devolve a tentativa negada (DECR)", async () => {
    stubUp();
    let count = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith("/multi-exec") ? jsonRes([{ result: ++count }, { result: 0 }, { result: 12_300 }]) : jsonRes([{ result: 0 }])));
    vi.stubGlobal("fetch", fetchMock);
    const { createRateLimiter } = await import("../../src/modules/public-api/rate-limit");
    const l = createRateLimiter({ limit: 2, windowMs: 60_000, name: "api-menu" });
    expect(await l.checkAsync!("ip")).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
    expect(await l.checkAsync!("ip")).toMatchObject({ allowed: true, remaining: 0 });
    expect(await l.checkAsync!("ip")).toEqual({ allowed: false, limit: 2, remaining: 0, retryAfterSeconds: 13 });
    await new Promise((r) => setTimeout(r, 5));
    const decrs = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/pipeline"));
    expect(decrs).toHaveLength(1);
    expect(JSON.parse((decrs[0][1] as RequestInit).body as string)).toEqual([["DECR", "rl:api-menu:ip"]]);
  });

  it("Redis fora do ar (timeout) degrada para a memória sem derrubar a requisição", async () => {
    stubUp();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw timeoutErr();
    }));
    const { createRateLimiter } = await import("../../src/modules/public-api/rate-limit");
    const l = createRateLimiter({ limit: 1, windowMs: 60_000, name: "x" });
    expect((await l.checkAsync!("k")).allowed).toBe(true);
    expect((await l.checkAsync!("k")).allowed).toBe(false); // a memória assumiu e continua limitando
  });

  it("refundAsync: DECR no Redis (com name) e devolve a última tentativa em memória; checkLimit/refundLimit usam a versão assíncrona se existir", async () => {
    stubUp();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes([{ result: 0 }]));
    vi.stubGlobal("fetch", fetchMock);
    const { createRateLimiter, refundLimit, checkLimit } = await import("../../src/modules/public-api/rate-limit");
    const l = createRateLimiter({ limit: 1, windowMs: 60_000, name: "orders" });
    l.check("k");
    expect(l.check("k").allowed).toBe(false);
    await refundLimit(l, "k");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual([["DECR", "rl:orders:k"]]);
    expect(l.check("k").allowed).toBe(true); // o estorno liberou a vaga em memória
    const calls: string[] = [];
    const dummy = { check: () => (calls.push("check"), { allowed: true, limit: 1, remaining: 0, retryAfterSeconds: 0 }), refund: () => void calls.push("refund"), size: () => 0 };
    await checkLimit(dummy, "k");
    await refundLimit(dummy, "k");
    expect(calls).toEqual(["check", "refund"]);
  });
});

describe("rate-limit.ts: clientIp", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("Vercel: usa x-real-ip, depois x-vercel-forwarded-for; ignora o x-forwarded-for livre", async () => {
    const { clientIp } = await import("../../src/modules/public-api/rate-limit");
    const env = { VERCEL: "1", NODE_ENV: "production" };
    expect(clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), env)).toBe("203.0.113.9");
    expect(clientIp(h({ "x-vercel-forwarded-for": "198.51.100.7, 10.0.0.1", "x-forwarded-for": "6.6.6.6" }), env)).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6" }), env)).toBe("unknown");
    expect(clientIp(h({ "x-real-ip": "lixo" }), { VERCEL: "true" })).toBe("unknown");
  });

  it("TRUSTED_PROXY_HOPS conta pela DIREITA: hops=1 => último valor; hops=2 => penúltimo; spoof à esquerda não muda o resultado", async () => {
    const { clientIp } = await import("../../src/modules/public-api/rate-limit");
    const xff = h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(clientIp(xff, { TRUSTED_PROXY_HOPS: "1", NODE_ENV: "production" })).toBe("3.3.3.3");
    expect(clientIp(xff, { TRUSTED_PROXY_HOPS: "2", NODE_ENV: "production" })).toBe("2.2.2.2");
    const spoofed = h({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(clientIp(spoofed, { TRUSTED_PROXY_HOPS: "1", NODE_ENV: "production" })).toBe("3.3.3.3");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1" }), { TRUSTED_PROXY_HOPS: "3" })).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, lixo" }), { TRUSTED_PROXY_HOPS: "1" })).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1" }), { TRUSTED_PROXY_HOPS: "0", NODE_ENV: "production" })).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1" }), { TRUSTED_PROXY_HOPS: "99", NODE_ENV: "production" })).toBe("unknown");
  });

  it("produção sem proxy declarado: cabeçalhos ignorados ('unknown'); o 1º x-forwarded-for forjado não vira identidade", async () => {
    const { clientIp } = await import("../../src/modules/public-api/rate-limit");
    expect(clientIp(h({ "x-forwarded-for": "198.18.0.1", "x-real-ip": "198.18.0.2" }), { NODE_ENV: "production" })).toBe("unknown");
    expect(clientIp(h({}), { NODE_ENV: "production" })).toBe("unknown");
  });

  it("desenvolvimento/teste: 1º x-forwarded-for, depois x-real-ip; IPv4 mapeado vira IPv4; IPv6 agrupa em /64; inválido => unknown", async () => {
    const { clientIp } = await import("../../src/modules/public-api/rate-limit");
    expect(clientIp(h({ "x-forwarded-for": "198.18.1.1, 5.5.5.5" }), {})).toBe("198.18.1.1");
    expect(clientIp(h({ "x-real-ip": "198.18.1.2" }), { NODE_ENV: "test" })).toBe("198.18.1.2");
    expect(clientIp(h({ "x-forwarded-for": "::ffff:198.18.1.3" }), {})).toBe("198.18.1.3");
    const a = clientIp(h({ "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }), {});
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8:1:2::1" }), {})).toBe(a);
    expect(clientIp(h({ "x-forwarded-for": "não-é-ip" }), {})).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "x".repeat(100) }), {})).toBe("unknown");
    expect(clientIp(h({}), {})).toBe("unknown");
  });
});

describe("captcha/turnstile.ts", () => {
  const ON = () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-xyz");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-abc");
  };

  it("desligado sem as DUAS chaves: ok sem chamar a rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { isCaptchaEnabled, verifyCaptcha } = await import("../../src/lib/captcha/turnstile");
    expect(isCaptchaEnabled({})).toBe(false);
    expect(isCaptchaEnabled({ TURNSTILE_SECRET_KEY: "s" })).toBe(false);
    expect(isCaptchaEnabled({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" })).toBe(false);
    expect(isCaptchaEnabled({ TURNSTILE_SECRET_KEY: " ", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" })).toBe(false);
    expect(isCaptchaEnabled({ TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" })).toBe(true);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-xyz");
    expect(await verifyCaptcha(undefined)).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ligado: sem token / vazio / não string => missing; token gigante => invalid; sem rede em nenhum", async () => {
    ON();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { verifyCaptcha, MAX_CAPTCHA_TOKEN_LENGTH } = await import("../../src/lib/captcha/turnstile");
    for (const t of [undefined, null, "", "   ", 123, {}]) expect(await verifyCaptcha(t)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyCaptcha("x".repeat(MAX_CAPTCHA_TOKEN_LENGTH + 1))).toEqual({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("siteverify: sucesso => ok (POST form com secret/response/remoteip só para IP exato); success diferente de true => invalid", async () => {
    ON();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { verifyCaptcha } = await import("../../src/lib/captcha/turnstile");
    expect(await verifyCaptcha("tok-1", "203.0.113.5")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect([body.get("secret"), body.get("response"), body.get("remoteip")]).toEqual(["secret-xyz", "tok-1", "203.0.113.5"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await verifyCaptcha("tok-2", "2001:db8:1:2::/64");
    await verifyCaptcha("tok-3", "unknown");
    expect((fetchMock.mock.calls[1][1] as any).body.has("remoteip")).toBe(false);
    expect((fetchMock.mock.calls[2][1] as any).body.has("remoteip")).toBe(false);
    fetchMock.mockImplementation(async () => jsonRes({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(await verifyCaptcha("tok-4")).toEqual({ ok: false, reason: "invalid" });
    for (const weird of [{ success: "true" }, { success: 1 }, [], null, "ok"]) {
      fetchMock.mockImplementation(async () => jsonRes(weird));
      expect(await verifyCaptcha("tok-5")).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("falha FECHADA: timeout, erro de rede, HTTP 5xx e corpo ilegível => unavailable (nunca ok)", async () => {
    ON();
    const { verifyCaptcha } = await import("../../src/lib/captcha/turnstile");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValueOnce(timeoutErr());
    expect(await verifyCaptcha("t")).toEqual({ ok: false, reason: "unavailable" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await verifyCaptcha("t")).toEqual({ ok: false, reason: "unavailable" });
    fetchMock.mockResolvedValueOnce(jsonRes({}, { status: 503 }));
    expect(await verifyCaptcha("t")).toEqual({ ok: false, reason: "unavailable" });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await verifyCaptcha("t")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("mensagens PT-BR existem para cada motivo de falha", async () => {
    const { CAPTCHA_MESSAGES } = await import("../../src/lib/captcha/turnstile");
    expect(Object.keys(CAPTCHA_MESSAGES).sort()).toEqual(["invalid", "missing", "unavailable"]);
    for (const m of Object.values(CAPTCHA_MESSAGES)) expect(m).toMatch(/robô|verificação/i);
  });
});
