import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_BUCKET, publicImageUrl } from "../../src/lib/storage";

const BASE = "http://127.0.0.1:54321";
const RID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-de-teste");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("publicImageUrl", () => {
  it("monta a URL pública do bucket restaurant-public", () => {
    expect(PUBLIC_BUCKET).toBe("restaurant-public");
    expect(publicImageUrl(`restaurants/${RID}/products/abc.png`)).toBe(`${BASE}/storage/v1/object/public/restaurant-public/restaurants/${RID}/products/abc.png`);
    expect(publicImageUrl(`restaurants/${RID}/logo/l.webp`)).toBe(`${BASE}/storage/v1/object/public/restaurant-public/restaurants/${RID}/logo/l.webp`);
  });

  it("barra final da URL base é removida (sem '//')", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `${BASE}/`);
    expect(publicImageUrl("restaurants/x/products/a.png")).toBe(`${BASE}/storage/v1/object/public/restaurant-public/restaurants/x/products/a.png`);
  });

  it("vazio, nulo ou indefinido => null", () => {
    for (const v of [null, undefined, ""]) expect(publicImageUrl(v)).toBeNull();
  });

  it("path traversal ('..' em qualquer posição) => null", () => {
    for (const p of ["..", "../x.png", "restaurants/../x.png", `restaurants/${RID}/products/../../other/x.png`, "a/b/..", "a..b", "...", "restaurants/x/products/a..png"]) {
      expect(publicImageUrl(p), p).toBeNull();
    }
  });

  it("barra inicial (caminho absoluto) => null", () => {
    expect(publicImageUrl("/restaurants/x/products/a.png")).toBeNull();
    expect(publicImageUrl("//evil.example/a.png")).toBeNull();
  });

  it("codifica cada segmento (espaço, #, ?, %, unicode) sem alterar as barras — nada escapa do bucket", () => {
    const url = publicImageUrl("restaurants/x/products/a b#c?d%e é.png")!;
    expect(url).toBe(`${BASE}/storage/v1/object/public/restaurant-public/restaurants/x/products/a%20b%23c%3Fd%25e%20%C3%A9.png`);
    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.host).toBe("127.0.0.1:54321");
  });

  it("sequências já codificadas são codificadas de novo (%2e%2e não vira '..')", () => {
    const url = publicImageUrl("restaurants/%2e%2e/%2E%2E/x.png")!;
    expect(new URL(url).pathname).toBe("/storage/v1/object/public/restaurant-public/restaurants/%252e%252e/%252E%252E/x.png");
  });

  it("contrabarra, quebra de linha e NUL são codificados", () => {
    const url = publicImageUrl("restaurants/x/a\\b\nc\u0000d.png")!;
    expect(url).toContain("a%5Cb%0Ac%00d.png");
  });

  it("URL de esquema estranho no 'path' não troca o host", () => {
    const url = publicImageUrl("http://evil.example/x.png")!;
    expect(new URL(url).host).toBe("127.0.0.1:54321");
    expect(url).toContain("http%3A");
  });

  it("sem Supabase configurado (env ausente/inválido) => null, sem lançar", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(publicImageUrl("restaurants/x/products/a.png")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "isto-nao-e-url");
    expect(publicImageUrl("restaurants/x/products/a.png")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(publicImageUrl("restaurants/x/products/a.png")).toBeNull();
  });
});
