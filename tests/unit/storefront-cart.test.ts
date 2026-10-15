import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CART_SCHEMA_VERSION,
  EMPTY_CART,
  LEGACY_CART_SCHEMA_VERSION,
  MAX_LINES,
  MAX_NOTES,
  MAX_QUANTITY,
  cartCount,
  cartStorageKey,
  clampQuantity,
  estimatedLineCents,
  estimatedSubtotalCents,
  estimatedUnitCents,
  legacyCartStorageKey,
  lineKey,
  newLineId,
  sanitizeCart,
  toCheckoutItems,
  withAddedLine,
  type CartLine,
  type CartLineInput,
} from "../../src/modules/storefront/cart";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const V1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const V2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const rawLine = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  productId: P1,
  variantId: null,
  quantity: 2,
  modifierIds: [M1],
  notes: "sem cebola",
  snapshot: { name: "X-Burger", variantName: null, unitPriceCents: 2500, imagePath: null, modifiers: [{ id: M1, name: "Bacon", priceDeltaCents: 500 }] },
  ...over,
});
const cartOf = (lines: unknown[], version: unknown = CART_SCHEMA_VERSION) => ({ version, lines });
const input = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  productId: P1,
  variantId: null,
  quantity: 1,
  modifierIds: [],
  notes: "",
  snapshot: { name: "X", variantName: null, unitPriceCents: 1000, imagePath: null, modifiers: [] },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("constantes alinhadas com o servidor (validate_cart)", () => {
  it("MAX_LINES=50 e MAX_QUANTITY=99 são exatamente os limites do banco; MAX_NOTES do cliente não excede os 500 do servidor", () => {
    expect(MAX_LINES).toBe(50);
    expect(MAX_QUANTITY).toBe(99);
    expect(MAX_NOTES).toBeLessThanOrEqual(500);
    expect(CART_SCHEMA_VERSION).toBe(2);
    expect(LEGACY_CART_SCHEMA_VERSION).toBe(1);
  });
});

describe("sanitizeCart — entrada inválida => carrinho vazio, sem lançar", () => {
  it("não-objetos", () => {
    for (const v of [null, undefined, "", "texto", 0, 1, NaN, true, false, [], [rawLine()], () => 1, Symbol.for("x")]) {
      expect(sanitizeCart(v)).toBe(EMPTY_CART);
    }
  });

  it("versão antiga, futura, ausente ou de outro tipo", () => {
    // v1 (migrada) e v2 (atual) são válidas; qualquer outra coisa é descartada.
    for (const v of [undefined, 0, 3, 99, -1, "1", "2", 1.5, null, [1], {}]) {
      expect(sanitizeCart({ version: v, lines: [rawLine()] }), `version=${JSON.stringify(v)}`).toBe(EMPTY_CART);
    }
    expect(sanitizeCart({ lines: [rawLine()] })).toBe(EMPTY_CART);
  });

  it("lines ausente ou que não é array", () => {
    for (const lines of [undefined, null, "x", 1, {}, { 0: rawLine() }]) expect(sanitizeCart({ version: 2, lines })).toBe(EMPTY_CART);
  });

  it("todas as linhas inválidas => vazio (mesma referência congelada)", () => {
    expect(sanitizeCart(cartOf([null, 1, "x", [], {}, rawLine({ productId: "nao-uuid" })]))).toBe(EMPTY_CART);
    expect(Object.isFrozen(EMPTY_CART)).toBe(true);
  });
});

describe("sanitizeCart — linhas", () => {
  it("linha válida passa intacta", () => {
    const out = sanitizeCart(cartOf([rawLine()]));
    expect(out.version).toBe(2);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toEqual(rawLine());
  });

  it("v1 é MIGRADA (não descartada): variantId/variantName ficam null, mesmo se a linha v1 trouxer lixo nesses campos", () => {
    const legacy = { version: 1, lines: [{ ...rawLine(), variantId: undefined, snapshot: { ...rawLine().snapshot, variantName: undefined } }, rawLine({ id: "l2", variantId: V1, snapshot: { ...rawLine().snapshot, variantName: "G" } })] };
    const out = sanitizeCart(legacy);
    expect(out.version).toBe(2);
    expect(out.lines).toHaveLength(2);
    for (const l of out.lines) {
      expect(l.variantId).toBeNull();
      expect(l.snapshot.variantName).toBeNull();
    }
  });

  it("v2 com variante: variantId normalizado em minúsculas e variantName aparado; variantId inválido vira null (nunca derruba a linha)", () => {
    const ok = sanitizeCart(cartOf([rawLine({ variantId: V1.toUpperCase(), snapshot: { ...rawLine().snapshot, variantName: "  Grande " } })]));
    expect(ok.lines[0].variantId).toBe(V1);
    expect(ok.lines[0].snapshot.variantName).toBe("Grande");
    for (const bad of ["lixo", 7, {}, "", `${V1}x`]) {
      const out = sanitizeCart(cartOf([rawLine({ variantId: bad, snapshot: { ...rawLine().snapshot, variantName: "G" } })]));
      expect(out.lines[0].variantId, JSON.stringify(bad)).toBeNull();
      expect(out.lines[0].snapshot.variantName).toBeNull();
    }
    // sem variantId => nome da variante é descartado
    expect(sanitizeCart(cartOf([rawLine({ variantId: null, snapshot: { ...rawLine().snapshot, variantName: "G" } })])).lines[0].snapshot.variantName).toBeNull();
  });

  it("uuid inválido de produto ou de adicional descarta a linha; maiúsculas são normalizadas para minúsculas", () => {
    for (const productId of ["", "123", "11111111-1111-4111-8111-11111111111", `${P1}x`, `x${P1}`, `${P1}\n`, "gggggggg-1111-4111-8111-111111111111", 7, null]) {
      expect(sanitizeCart(cartOf([rawLine({ productId })])), JSON.stringify(productId)).toBe(EMPTY_CART);
    }
    expect(sanitizeCart(cartOf([rawLine({ modifierIds: ["lixo"] })]))).toBe(EMPTY_CART);
    const up = sanitizeCart(cartOf([rawLine({ productId: P1.toUpperCase(), modifierIds: [M1.toUpperCase()] })]));
    expect(up.lines[0].productId).toBe(P1);
    expect(up.lines[0].modifierIds).toEqual([M1]);
  });

  it("quantidade: inteiros fora da faixa são limitados a 1..99; não-inteiros e não-números descartam a linha", () => {
    const q = (v: unknown) => sanitizeCart(cartOf([rawLine({ quantity: v })])).lines[0]?.quantity;
    expect(q(0)).toBe(1);
    expect(q(-5)).toBe(1);
    expect(q(1)).toBe(1);
    expect(q(99)).toBe(99);
    expect(q(100)).toBe(99);
    expect(q(1_000_000)).toBe(99);
    for (const bad of [1.5, "2", null, undefined, NaN, Infinity, {}, [], true]) expect(q(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("mais de 50 linhas: só as 50 primeiras são consideradas", () => {
    const many = Array.from({ length: 80 }, (_, i) => rawLine({ id: `l${i}` }));
    const out = sanitizeCart(cartOf(many));
    expect(out.lines).toHaveLength(MAX_LINES);
    expect(out.lines.at(-1)!.id).toBe("l49");
    // linhas inválidas dentro das 50 primeiras não "abrem espaço" para as seguintes
    const mixed = [...Array.from({ length: 50 }, () => null), rawLine({ id: "tarde" })];
    expect(sanitizeCart(cartOf(mixed))).toBe(EMPTY_CART);
  });

  it("ids de linha repetidos: só a primeira vale; id vazio ou > 64 descarta", () => {
    const out = sanitizeCart(cartOf([rawLine({ id: "dup", quantity: 1 }), rawLine({ id: "dup", quantity: 9 })]));
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].quantity).toBe(1);
    expect(sanitizeCart(cartOf([rawLine({ id: "" })]))).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([rawLine({ id: "x".repeat(65) })]))).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([rawLine({ id: "x".repeat(64) })])).lines).toHaveLength(1);
  });

  it("observações longas são truncadas em MAX_NOTES (a linha é mantida)", () => {
    const out = sanitizeCart(cartOf([rawLine({ notes: "n".repeat(5000) })]));
    expect(out.lines[0].notes).toHaveLength(MAX_NOTES);
    expect(sanitizeCart(cartOf([rawLine({ notes: 123 })]))).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([rawLine({ notes: null })]))).toBe(EMPTY_CART);
  });

  it("adicionais repetidos são deduplicados; mais de 60 descarta a linha", () => {
    expect(sanitizeCart(cartOf([rawLine({ modifierIds: [M1, M1, M2, M1.toUpperCase()] })])).lines[0].modifierIds).toEqual([M1, M2]);
    const sixtyOne = Array.from({ length: 61 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(sanitizeCart(cartOf([rawLine({ modifierIds: sixtyOne })]))).toBe(EMPTY_CART);
  });

  it("snapshot: preço negativo/absurdo/fracionado descarta a linha; imagePath inválido vira null", () => {
    const withSnap = (over: Record<string, unknown>) => rawLine({ snapshot: { ...rawLine().snapshot, ...over } });
    for (const unitPriceCents of [-1, 100_000_001, 1.5, "10", null, NaN]) expect(sanitizeCart(cartOf([withSnap({ unitPriceCents })])), JSON.stringify(unitPriceCents)).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([withSnap({ name: "n".repeat(301) })]))).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([withSnap({ imagePath: 42 })])).lines[0].snapshot.imagePath).toBeNull();
    expect(sanitizeCart(cartOf([withSnap({ imagePath: "p".repeat(501) })])).lines[0].snapshot.imagePath).toBeNull();
    expect(sanitizeCart(cartOf([withSnap({ imagePath: "restaurants/x/products/a.png" })])).lines[0].snapshot.imagePath).toBe("restaurants/x/products/a.png");
    expect(sanitizeCart(cartOf([withSnap({ modifiers: [{ id: "lixo", name: "x", priceDeltaCents: 1 }] })]))).toBe(EMPTY_CART);
    expect(sanitizeCart(cartOf([withSnap({ modifiers: "x" })]))).toBe(EMPTY_CART);
  });

  it("campos extras (inclusive __proto__ / price_cents) são descartados e não poluem o protótipo", () => {
    const hostile = JSON.parse(
      `{"version":2,"__proto__":{"polluted":true},"lines":[{"id":"l1","productId":"${P1}","quantity":1,"modifierIds":[],"notes":"","price_cents":1,"__proto__":{"polluted":true},"snapshot":{"name":"X","unitPriceCents":1000,"imagePath":null,"modifiers":[],"constructor":{"prototype":{"polluted":true}}}}]}`,
    );
    const out = sanitizeCart(hostile);
    expect(out.lines).toHaveLength(1);
    expect(Object.keys(out.lines[0]).sort()).toEqual(["id", "modifierIds", "notes", "productId", "quantity", "snapshot", "variantId"]);
    expect(Object.keys(out.lines[0].snapshot).sort()).toEqual(["imagePath", "modifiers", "name", "unitPriceCents", "variantName"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fuzz determinístico: nunca lança, sempre devolve versão 2 com ≤ 50 linhas válidas", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const junk = (): unknown =>
      pick<() => unknown>([
        () => null,
        () => undefined,
        () => rnd() * 1e12,
        () => -rnd() * 10,
        () => "x".repeat(Math.floor(rnd() * 400)),
        () => P1,
        () => [junk(), junk()],
        () => ({ a: junk(), id: "i" + Math.floor(rnd() * 5) }),
        () => rawLine({ id: "i" + Math.floor(rnd() * 90), quantity: Math.floor(rnd() * 300) - 100 }),
        () => rawLine({ id: "j" + Math.floor(rnd() * 90) }),
      ])();
    for (let i = 0; i < 400; i++) {
      const raw = { version: rnd() < 0.9 ? 2 : 3, lines: Array.from({ length: Math.floor(rnd() * 70) }, junk) };
      const out = sanitizeCart(raw);
      expect(out.version).toBe(2);
      expect(out.lines.length).toBeLessThanOrEqual(MAX_LINES);
      for (const l of out.lines) {
        expect(l.quantity).toBeGreaterThanOrEqual(1);
        expect(l.quantity).toBeLessThanOrEqual(MAX_QUANTITY);
        expect(l.notes.length).toBeLessThanOrEqual(MAX_NOTES);
      }
    }
  });

  it("idempotente: sanitizar duas vezes dá o mesmo resultado", () => {
    const once = sanitizeCart(cartOf([rawLine({ quantity: 500, notes: "n".repeat(900) }), rawLine({ id: "l2", productId: P2 })]));
    expect(sanitizeCart(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("clampQuantity / lineKey / newLineId", () => {
  it("clampQuantity", () => {
    expect(clampQuantity(NaN)).toBe(1);
    expect(clampQuantity(Infinity)).toBe(1);
    expect(clampQuantity(-Infinity)).toBe(1);
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(0.9)).toBe(1);
    expect(clampQuantity(1.9)).toBe(1);
    expect(clampQuantity(98.9)).toBe(98);
    expect(clampQuantity(99.9)).toBe(99);
    expect(clampQuantity(100)).toBe(99);
    expect(clampQuantity(1e9)).toBe(99);
    expect(clampQuantity(-3)).toBe(1);
  });

  it("lineKey ignora a ordem dos adicionais e espaços nas pontas da observação; não muta a entrada", () => {
    const mods = [M2, M1];
    const k = (productId: string, modifierIds: string[], notes: string, variantId: string | null = null) => lineKey({ productId, variantId, modifierIds, notes });
    expect(k(P1, mods, " oi ")).toBe(k(P1, [M1, M2], "oi"));
    expect(mods).toEqual([M2, M1]);
    expect(k(P1, [], "a")).not.toBe(k(P2, [], "a"));
    expect(k(P1, [M1], "")).not.toBe(k(P1, [], ""));
    // a variante faz parte da chave: P e G do mesmo produto são linhas diferentes; sem variante != com variante
    expect(k(P1, [], "", V1)).not.toBe(k(P1, [], "", V2));
    expect(k(P1, [], "", V1)).not.toBe(k(P1, [], "", null));
    expect(k(P1, [], "", V1)).toBe(k(P1, [], "", V1));
  });

  it("newLineId gera ids distintos e cai num fallback quando crypto.randomUUID não existe/lança", () => {
    const a = newLineId();
    expect(a).not.toBe(newLineId());
    vi.stubGlobal("crypto", {
      randomUUID() {
        throw new Error("indisponível");
      },
    });
    const b = newLineId();
    expect(typeof b).toBe("string");
    expect(b.length).toBeGreaterThan(5);
    expect(b).not.toBe(newLineId());
  });
});

describe("withAddedLine (puro)", () => {
  it("adiciona linha nova e não muta o estado anterior", () => {
    const state = { version: 2 as const, lines: [] as CartLine[] };
    const next = withAddedLine(state, input());
    expect(state.lines).toHaveLength(0);
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].id).toBeTruthy();
  });

  it("agrupa linhas iguais somando a quantidade (limitada a 99) e atualiza o snapshot", () => {
    let s = withAddedLine(EMPTY_CART, input({ quantity: 60 }));
    s = withAddedLine(s, input({ quantity: 60, snapshot: { name: "X novo", variantName: null, unitPriceCents: 1200, imagePath: null, modifiers: [] } }));
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].quantity).toBe(99);
    expect(s.lines[0].snapshot.unitPriceCents).toBe(1200);
  });

  it("observação/adicionais diferentes => linhas diferentes; ordem dos adicionais não importa", () => {
    let s = withAddedLine(EMPTY_CART, input({ modifierIds: [M1, M2] }));
    s = withAddedLine(s, input({ modifierIds: [M2, M1] }));
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].quantity).toBe(2);
    s = withAddedLine(s, input({ modifierIds: [M1, M2], notes: "capricha" }));
    s = withAddedLine(s, input({ productId: P2 }));
    expect(s.lines).toHaveLength(3);
  });

  it("variantes diferentes do mesmo produto => linhas diferentes; a mesma variante agrupa", () => {
    const snap = (variantName: string) => ({ name: "Pizza", variantName, unitPriceCents: 1000, imagePath: null, modifiers: [] });
    let s = withAddedLine(EMPTY_CART, input({ variantId: V1, snapshot: snap("P") }));
    s = withAddedLine(s, input({ variantId: V2, snapshot: snap("G") }));
    s = withAddedLine(s, input({ variantId: V1, snapshot: snap("P") }));
    expect(s.lines).toHaveLength(2);
    expect(s.lines.find((l) => l.variantId === V1)!.quantity).toBe(2);
  });

  it("linha migrada da v1 (sem variante) é absorvida ao escolher o tamanho do mesmo produto (mesmos adicionais/observação)", () => {
    const orphan = sanitizeCart({ version: 1, lines: [rawLine({ id: "velha", quantity: 2 })] });
    const next = withAddedLine(orphan, input({ variantId: V1, modifierIds: [M1], notes: "sem cebola", quantity: 1, snapshot: { name: "X-Burger", variantName: "G", unitPriceCents: 2000, imagePath: null, modifiers: [] } }));
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0]).toMatchObject({ variantId: V1, quantity: 3 });
    // outro produto/observação não é absorvido
    const keep = withAddedLine(orphan, input({ variantId: V1, notes: "diferente" }));
    expect(keep.lines).toHaveLength(2);
  });

  it("limita quantidade (1..99) e observação (trim + MAX_NOTES) na entrada", () => {
    const s = withAddedLine(EMPTY_CART, input({ quantity: 5000, notes: `   ${"n".repeat(1000)}   ` }));
    expect(s.lines[0].quantity).toBe(99);
    expect(s.lines[0].notes).toHaveLength(MAX_NOTES);
    expect(withAddedLine(EMPTY_CART, input({ quantity: -2 })).lines[0].quantity).toBe(1);
    expect(withAddedLine(EMPTY_CART, input({ quantity: NaN })).lines[0].quantity).toBe(1);
  });

  it("com 50 linhas distintas, uma 51ª é ignorada (mesma referência); mas agrupar numa existente ainda funciona", () => {
    let s = EMPTY_CART;
    for (let i = 0; i < MAX_LINES; i++) s = withAddedLine(s, input({ notes: `obs ${i}` }));
    expect(s.lines).toHaveLength(MAX_LINES);
    expect(withAddedLine(s, input({ notes: "nova" }))).toBe(s);
    const grouped = withAddedLine(s, input({ notes: "obs 3", quantity: 2 }));
    expect(grouped.lines).toHaveLength(MAX_LINES);
    expect(grouped.lines[3].quantity).toBe(3);
  });
});

describe("estimativas, contagem, chave e itens do checkout", () => {
  const line = (over: Partial<CartLine> = {}): CartLine => ({ id: "a", productId: P1, variantId: null, quantity: 2, modifierIds: [M1], notes: " obs ", snapshot: { name: "X", variantName: null, unitPriceCents: 1000, imagePath: null, modifiers: [{ id: M1, name: "B", priceDeltaCents: 250 }] }, ...over });

  it("preço estimado = (unitário + adicionais) × quantidade; nunca negativo", () => {
    expect(estimatedUnitCents(line())).toBe(1250);
    expect(estimatedLineCents(line())).toBe(2500);
    expect(estimatedSubtotalCents([line(), line({ quantity: 1 })])).toBe(2500 + 1250);
    expect(estimatedSubtotalCents([])).toBe(0);
    const neg = line({ snapshot: { name: "X", variantName: null, unitPriceCents: 100, imagePath: null, modifiers: [{ id: M1, name: "desc", priceDeltaCents: -500 }] } });
    expect(estimatedUnitCents(neg)).toBe(0);
  });

  it("cartCount soma quantidades", () => {
    expect(cartCount([line({ quantity: 3 }), line({ quantity: 4 })])).toBe(7);
    expect(cartCount([])).toBe(0);
  });

  it("cartStorageKey é por restaurante e versionada (v2); a chave legada v1 continua disponível para migração", () => {
    expect(cartStorageKey("demo-a")).toBe("mesafacil:cart:v2:demo-a");
    expect(legacyCartStorageKey("demo-a")).toBe("mesafacil:cart:v1:demo-a");
    expect(cartStorageKey("demo-a")).not.toBe(cartStorageKey("demo-b"));
  });

  it("toCheckoutItems envia só o que o servidor aceita (sem snapshot/preço), com observação aparada", () => {
    const items = toCheckoutItems([line()]);
    expect(items).toEqual([{ productId: P1, variantId: null, quantity: 2, modifierIds: [M1], notes: "obs" }]);
    expect(JSON.stringify(items)).not.toMatch(/price|snapshot|unit/i);
    expect(toCheckoutItems([line({ variantId: V1 })])[0].variantId).toBe(V1);
  });
});
