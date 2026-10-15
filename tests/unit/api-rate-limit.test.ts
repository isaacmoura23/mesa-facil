import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "../../src/modules/public-api/rate-limit";

describe("createRateLimiter (janela deslizante)", () => {
  it("permite até o limite e nega o excedente com Retry-After", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.check("k")).toMatchObject({ allowed: true, remaining: 2 });
    now = 10_000;
    expect(limiter.check("k")).toMatchObject({ allowed: true, remaining: 1 });
    now = 20_000;
    expect(limiter.check("k")).toMatchObject({ allowed: true, remaining: 0 });
    now = 30_000;
    const denied = limiter.check("k");
    expect(denied.allowed).toBe(false);
    // O mais antigo (t=0) sai da janela em t=60000: faltam 30 s.
    expect(denied.retryAfterSeconds).toBe(30);
  });

  it("a janela desliza: libera quando o registro mais antigo expira", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    limiter.check("k");
    now = 500;
    limiter.check("k");
    now = 700;
    expect(limiter.check("k").allowed).toBe(false);
    now = 1_001; // t=0 saiu da janela, t=500 ainda não
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
  });

  it("tentativas negadas não prolongam o bloqueio", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    limiter.check("k");
    for (now = 100; now < 900; now += 100) expect(limiter.check("k").allowed).toBe(false);
    now = 1_001;
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("isola chaves (IP+slug) entre si", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("1.1.1.1|demo-a").allowed).toBe(true);
    expect(limiter.check("1.1.1.1|demo-a").allowed).toBe(false);
    expect(limiter.check("1.1.1.1|demo-b").allowed).toBe(true);
    expect(limiter.check("2.2.2.2|demo-a").allowed).toBe(true);
  });

  it("retryAfterSeconds é sempre >= 1", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    limiter.check("k");
    now = 999;
    expect(limiter.check("k").retryAfterSeconds).toBe(1);
  });

  it("limita a memória (maxKeys)", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 100; i += 1) limiter.check(`ip-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });
});

describe("clientIp", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("usa o PRIMEIRO valor de x-forwarded-for", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.5");
  });

  it("ignora valores que não são IP e cai para x-real-ip", () => {
    expect(clientIp(h({ "x-forwarded-for": "lixo", "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientIp(h({}))).toBe("unknown");
  });

  it("agrupa IPv6 pelo prefixo /64 e converte IPv4 mapeado", () => {
    const a = clientIp(h({ "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    const b = clientIp(h({ "x-forwarded-for": "2001:db8:1:2::1" }));
    const c = clientIp(h({ "x-forwarded-for": "2001:db8:1:3::1" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(clientIp(h({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
  });
});
