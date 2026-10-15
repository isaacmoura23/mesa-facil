import { describe, expect, it, vi } from "vitest";
import {
  canonicalOrigin,
  createOriginsCache,
  decideCors,
  isDevOrigin,
  normalizeAllowedOrigin,
  preflightHeaders,
  PREFLIGHT_MAX_AGE_SECONDS,
} from "../../src/modules/public-api/cors";

const ALLOWED = ["https://la-pastelaria.vercel.app", "https://www.lapastelaria.com.br"];

describe("canonicalOrigin / normalizeAllowedOrigin", () => {
  it("aceita só origens canônicas (sem barra, caminho, query, credenciais)", () => {
    expect(canonicalOrigin("https://a.com")).toBe("https://a.com");
    expect(canonicalOrigin("https://a.com:8443")).toBe("https://a.com:8443");
    expect(canonicalOrigin("https://a.com/")).toBeNull();
    expect(canonicalOrigin("https://a.com/x")).toBeNull();
    expect(canonicalOrigin("https://a.com?x=1")).toBeNull();
    expect(canonicalOrigin("https://u:p@a.com")).toBeNull();
    expect(canonicalOrigin(" https://a.com")).toBeNull();
    expect(canonicalOrigin("https://*.a.com")).toBeNull();
    expect(canonicalOrigin("null")).toBeNull();
    expect(canonicalOrigin("")).toBeNull();
    expect(canonicalOrigin("ftp://a.com")).toBeNull();
    expect(canonicalOrigin("https://a.com, https://b.com")).toBeNull();
  });

  it("lista permitida exige https e hostname válido", () => {
    expect(normalizeAllowedOrigin("https://la-pastelaria.vercel.app")).toBe(
      "https://la-pastelaria.vercel.app",
    );
    expect(normalizeAllowedOrigin("http://exemplo.com")).toBeNull();
    expect(normalizeAllowedOrigin("https://*.vercel.app")).toBeNull();
    expect(normalizeAllowedOrigin("https://[::1]")).toBeNull();
    expect(normalizeAllowedOrigin("https://exemplo.com/")).toBeNull();
    expect(normalizeAllowedOrigin(42)).toBeNull();
  });

  it("isDevOrigin: só localhost e 127.0.0.1, com qualquer porta", () => {
    expect(isDevOrigin("http://localhost:3000")).toBe(true);
    expect(isDevOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isDevOrigin("https://localhost")).toBe(true);
    expect(isDevOrigin("http://localhost.evil.com")).toBe(false);
    expect(isDevOrigin("http://0.0.0.0:3000")).toBe(false);
    expect(isDevOrigin("http://192.168.0.2:3000")).toBe(false);
  });
});

describe("decideCors", () => {
  it("sem Origin: passa sem cabeçalhos CORS", () => {
    expect(decideCors(null, ALLOWED, { dev: false })).toEqual({ type: "none" });
  });

  it("origem exata permitida", () => {
    expect(decideCors("https://la-pastelaria.vercel.app", ALLOWED, { dev: false })).toEqual({
      type: "allowed",
      origin: "https://la-pastelaria.vercel.app",
    });
  });

  it("nega origem fora da lista, subdomínio, porta diferente, http e variações", () => {
    const denied = [
      "https://evil.example",
      "https://x.la-pastelaria.vercel.app",
      "https://la-pastelaria.vercel.app:8443",
      "http://la-pastelaria.vercel.app",
      "https://la-pastelaria.vercel.app/",
      "https://la-pastelaria.vercel.app.evil.com",
      "null",
      "",
    ];
    for (const origin of denied) {
      expect(decideCors(origin, ALLOWED, { dev: false }), origin).toEqual({ type: "denied" });
    }
  });

  it("lista vazia nega tudo em produção", () => {
    expect(decideCors("https://a.com", [], { dev: false })).toEqual({ type: "denied" });
  });

  it("ignora entradas inválidas/curinga na lista", () => {
    expect(decideCors("https://a.vercel.app", ["https://*.vercel.app"], { dev: false })).toEqual({
      type: "denied",
    });
    expect(decideCors("http://a.com", ["http://a.com"], { dev: false })).toEqual({ type: "denied" });
  });

  it("localhost/127.0.0.1 só em desenvolvimento", () => {
    expect(decideCors("http://localhost:3000", [], { dev: true })).toEqual({
      type: "allowed",
      origin: "http://localhost:3000",
    });
    expect(decideCors("http://127.0.0.1:5173", [], { dev: true }).type).toBe("allowed");
    expect(decideCors("http://localhost:3000", [], { dev: false })).toEqual({ type: "denied" });
    expect(decideCors("http://localhost.evil.com", [], { dev: true })).toEqual({ type: "denied" });
  });
});

describe("preflightHeaders", () => {
  it("devolve Allow-Origin exata, métodos, cabeçalhos e Max-Age, sem credentials", () => {
    const h = preflightHeaders("https://a.com", ["POST", "OPTIONS"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://a.com");
    expect(h["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
    expect(h["Access-Control-Allow-Headers"]).toContain("Content-Type");
    expect(h["Access-Control-Max-Age"]).toBe(String(PREFLIGHT_MAX_AGE_SECONDS));
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(Object.keys(h)).not.toContain("Access-Control-Allow-Credentials");
  });
});

describe("createOriginsCache", () => {
  it("cacheia por slug durante o TTL e busca de novo depois", async () => {
    let now = 1_000;
    const fetchOrigins = vi.fn(async () => ["https://a.com"]);
    const cache = createOriginsCache({ fetchOrigins, ttlMs: 60_000, now: () => now });

    await cache.get("demo-a");
    await cache.get("demo-a");
    expect(fetchOrigins).toHaveBeenCalledTimes(1);

    await cache.get("demo-b");
    expect(fetchOrigins).toHaveBeenCalledTimes(2);

    now += 59_999;
    await cache.get("demo-a");
    expect(fetchOrigins).toHaveBeenCalledTimes(2);

    now += 2;
    await cache.get("demo-a");
    expect(fetchOrigins).toHaveBeenCalledTimes(3);
  });

  it("junta buscas simultâneas e descarta origens inválidas", async () => {
    const fetchOrigins = vi.fn(async () => ["https://ok.com", "http://ruim.com", "https://*.x.com"]);
    const cache = createOriginsCache({ fetchOrigins });
    const [a, b] = await Promise.all([cache.get("s"), cache.get("s")]);
    expect(fetchOrigins).toHaveBeenCalledTimes(1);
    expect(a).toEqual(["https://ok.com"]);
    expect(b).toEqual(["https://ok.com"]);
  });

  it("falha sem valor antigo repassa o erro (não libera origem) e não cacheia a falha", async () => {
    const fetchOrigins = vi
      .fn<(slug: string) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("db fora"))
      .mockResolvedValueOnce(["https://a.com"]);
    const cache = createOriginsCache({ fetchOrigins });
    await expect(cache.get("s")).rejects.toThrow("db fora");
    await expect(cache.get("s")).resolves.toEqual(["https://a.com"]);
  });

  it("falha com valor antigo serve o antigo (fail-stale)", async () => {
    let now = 0;
    const fetchOrigins = vi
      .fn<(slug: string) => Promise<string[]>>()
      .mockResolvedValueOnce(["https://a.com"])
      .mockRejectedValueOnce(new Error("db fora"));
    const cache = createOriginsCache({ fetchOrigins, ttlMs: 10, now: () => now });
    await cache.get("s");
    now = 100;
    await expect(cache.get("s")).resolves.toEqual(["https://a.com"]);
  });

  it("limita o número de entradas", async () => {
    const cache = createOriginsCache({ fetchOrigins: async () => [], maxEntries: 3 });
    for (const slug of ["a", "b", "c", "d", "e"]) await cache.get(slug);
    expect(cache.size()).toBe(3);
  });
});
