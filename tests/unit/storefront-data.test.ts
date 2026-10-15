/**
 * src/modules/storefront/data.ts é `server-only` e usa `next/cache` ("use cache"). Para testar a lógica pura
 * (normalizeSlug, menuCacheTag, getPublicMenu) sem Next, mockamos o mínimo: server-only, next/cache e o cliente Supabase.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createPublicClient: () => ({ rpc }) }));

const { menuCacheTag, normalizeSlug, getPublicMenu } = await import("../../src/modules/storefront/data");
const { storefrontMenuTag } = await import("../../src/modules/menu/tags");

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const validMenu = {
  restaurant: { id: U(1), name: "DEMO", slug: "demo-a", logo_path: null, timezone: "America/Sao_Paulo" },
  settings: { accepts_orders: true, enabled_fulfillment_types: ["PICKUP"], delivery_zones: [] },
  is_open_now: true,
  categories: [],
};

beforeEach(() => {
  rpc.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-de-teste");
});

describe("normalizeSlug", () => {
  it("normaliza caixa, espaços e escapes de URL válidos", () => {
    expect(normalizeSlug("demo-a")).toBe("demo-a");
    expect(normalizeSlug("DEMO-A")).toBe("demo-a");
    expect(normalizeSlug("  demo-a  ")).toBe("demo-a");
    expect(normalizeSlug("%20demo-a%20")).toBe("demo-a");
    expect(normalizeSlug("demo%2Da")).toBe("demo-a");
    expect(normalizeSlug("a".repeat(63))).toBe("a".repeat(63));
    expect(normalizeSlug("loja-1")).toBe("loja-1");
  });

  it("recusa tudo que não pode ser um slug: vazio, 64+, separadores, hífens soltos, traversal, unicode, NUL, escape quebrado", () => {
    const bad = [
      "",
      "   ",
      "a".repeat(64),
      "demo_a",
      "demo a",
      "demo--a",
      "-demo",
      "demo-",
      "demo/a",
      "demo-a/",
      "../etc/passwd",
      "..%2F..%2Fetc",
      "demo%2Fa",
      "demo-a%00",
      "dëmo",
      "ｄｅｍｏ",
      "İstanbul",
      "%E0%A4%A", // escape malformado: decodeURIComponent lança
      "%",
      "demo.a",
      "demo-a?x=1",
      "demo-a#x",
      "'; drop table restaurants;--",
      "<script>",
    ];
    for (const s of bad) expect(normalizeSlug(s), JSON.stringify(s)).toBeNull();
  });
});

describe("menuCacheTag", () => {
  it("formato estável e idêntico ao usado pelo painel ao invalidar (menu/tags.ts duplica a string de propósito)", () => {
    expect(menuCacheTag("demo-a")).toBe("storefront:menu:demo-a");
    for (const slug of ["demo-a", "loja-1", "x"]) expect(storefrontMenuTag(slug)).toBe(menuCacheTag(slug));
  });

  it("a origem não mudou de formato (guarda contra a duplicação ficar defasada)", () => {
    const src = readFileSync(path.join(process.cwd(), "src", "modules", "storefront", "data.ts"), "utf8");
    expect(src).toMatch(/return `storefront:menu:\$\{slug\}`;/);
    const tags = readFileSync(path.join(process.cwd(), "src", "modules", "menu", "tags.ts"), "utf8");
    expect(tags).toMatch(/return `storefront:menu:\$\{slug\}`;/);
  });
});

describe("getPublicMenu", () => {
  it("slug inválido => null sem chamar o banco", async () => {
    expect(await getPublicMenu("../x")).toBeNull();
    expect(await getPublicMenu("")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("chama public_menu com o slug normalizado e converte o resultado", async () => {
    rpc.mockResolvedValue({ data: validMenu, error: null });
    const m = await getPublicMenu(" DEMO-A ");
    expect(rpc).toHaveBeenCalledWith("public_menu", { p_slug: "demo-a" });
    expect(m?.restaurant.slug).toBe("demo-a");
  });

  it("restaurante inexistente/suspenso (RPC devolve null, [], {} ou [null]) => null", async () => {
    for (const data of [null, undefined, [], {}, [null], [{}]]) {
      rpc.mockResolvedValue({ data, error: null });
      expect(await getPublicMenu("demo-a"), JSON.stringify(data)).toBeNull();
    }
  });

  it("aceita o jsonb embrulhado em lista", async () => {
    rpc.mockResolvedValue({ data: [validMenu], error: null });
    expect((await getPublicMenu("demo-a"))?.restaurant.name).toBe("DEMO");
  });

  it("erro de RPC sobe como exceção (não vira 'restaurante não encontrado'), exceto not_found", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    await expect(getPublicMenu("demo-a")).rejects.toThrow(/public_menu falhou/);
    rpc.mockResolvedValue({ data: null, error: { message: "restaurant_not_found" } });
    expect(await getPublicMenu("demo-a")).toBeNull();
  });

  it("formato inesperado do banco => exceção (a página mostra erro, não dados quebrados)", async () => {
    rpc.mockResolvedValue({ data: { restaurant: 1 }, error: null });
    await expect(getPublicMenu("demo-a")).rejects.toThrow(/formato inesperado/);
  });

  it("Supabase não configurado => exceção explícita", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    await expect(getPublicMenu("demo-a")).rejects.toThrow(/não configurado/);
  });
});
