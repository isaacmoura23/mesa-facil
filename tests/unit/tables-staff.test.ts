/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 4, operação de mesas/comandas: src/modules/tables/{format,errors,staff-cart,types}. Módulos puros (zod/Intl/Web Crypto).
 * Os hooks (React) e as consultas ao Supabase não são cobertos aqui (ver tests/rls/22).
 */
import { describe, expect, it } from "vitest";
import { parseTabsError } from "../../src/modules/tables/errors";
import { formatOpenFor, normalizeText, tabSubtitle, tabTitle } from "../../src/modules/tables/format";
import {
  EMPTY_STAFF_CART,
  MAX_LINES,
  addToStaffCart,
  newAttemptKey,
  removeLine,
  setLineQuantity,
  staffCartCount,
  staffCartEstimate,
  toStaffPayload,
} from "../../src/modules/tables/staff-cart";
import {
  TAB_STATUSES,
  TAB_STATUS_LABELS,
  TABLE_STATUSES,
  TABLE_STATUS_LABELS,
  countsTowardTab,
  orderBriefSchema,
  tabBalanceSchema,
  tabRowSchema,
  tableRowSchema,
} from "../../src/modules/tables/types";
import { MAX_QUANTITY, type CartLineInput } from "../../src/modules/storefront/cart";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const input = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  productId: P1,
  variantId: null,
  quantity: 1,
  modifierIds: [],
  notes: "",
  snapshot: { name: "X-Burger", variantName: null, unitPriceCents: 2500, imagePath: null, modifiers: [] },
  ...over,
});

describe("tables/format", () => {
  it("tabTitle: nome da mesa, 'Mesa removida', balcão com rótulo, balcão sem rótulo", () => {
    expect(tabTitle({ table_id: "t", label: null }, "5")).toBe("Mesa 5");
    expect(tabTitle({ table_id: "t", label: null }, "Mesa 5")).toBe("Mesa 5");
    expect(tabTitle({ table_id: "t", label: null }, "mesa varanda")).toBe("mesa varanda");
    expect(tabTitle({ table_id: "t", label: "João" }, null)).toBe("Mesa removida");
    expect(tabTitle({ table_id: null, label: "  João  " }, null)).toBe("Balcão: João");
    expect(tabTitle({ table_id: null, label: "   " }, null)).toBe("Balcão");
    expect(tabTitle({ table_id: null, label: null }, null)).toBe("Balcão");
  });

  it("tabSubtitle: rótulo só em comanda de mesa; concordância de 'pessoa(s)'", () => {
    expect(tabSubtitle({ table_id: "t", label: "Aniversário", guests: 4 })).toBe("Aniversário, 4 pessoas");
    expect(tabSubtitle({ table_id: "t", label: null, guests: 1 })).toBe("1 pessoa");
    expect(tabSubtitle({ table_id: null, label: "João", guests: null })).toBe("");
    expect(tabSubtitle({ table_id: "t", label: "  ", guests: 0 })).toBe("");
  });

  it("formatOpenFor: agora / minutos / horas com minutos zerados; data inválida => vazio; relógio adiantado não fica negativo", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(formatOpenFor(ago(0), now)).toBe("agora");
    expect(formatOpenFor(ago(0.5), now)).toBe("agora");
    expect(formatOpenFor(ago(1), now)).toBe("1 min");
    expect(formatOpenFor(ago(59), now)).toBe("59 min");
    expect(formatOpenFor(ago(60), now)).toBe("1 h 00 min");
    expect(formatOpenFor(ago(65), now)).toBe("1 h 05 min");
    expect(formatOpenFor(ago(60 * 26 + 7), now)).toBe("26 h 07 min");
    expect(formatOpenFor("lixo", now)).toBe("");
    expect(formatOpenFor(new Date(now + 5 * 60_000).toISOString(), now)).toBe("agora");
  });

  it("normalizeText: sem acento, minúsculo, aparado (busca de mesas)", () => {
    expect(normalizeText("  MESA Çará  ")).toBe("mesa cara");
    expect(normalizeText("Pão de Açúcar")).toBe("pao de acucar");
    expect(normalizeText("")).toBe("");
  });
});

describe("tables/errors: parseTabsError", () => {
  it("códigos de mesa/comanda do contrato têm mensagem própria e pedem recarga quando o estado mudou", () => {
    for (const c of ["TABLE_HAS_OPEN_TAB", "TABLE_INACTIVE", "TABLE_NOT_AVAILABLE", "TABLE_NOT_FOUND", "TABLE_INVALID_TRANSITION", "TAB_NOT_FOUND", "TAB_NOT_OPEN"]) {
      const r = parseTabsError({ message: `${c}: detalhe interno` });
      expect(r.code, c).toBe(c);
      expect(r.stale, c).toBe(true);
      expect(r.message).not.toMatch(/interno|[A-Z_]{6,}/);
    }
    for (const c of ["FORBIDDEN", "UNAUTHENTICATED"]) expect(parseTabsError({ message: `${c}: x` })).toMatchObject({ code: c, stale: false });
  });

  it("42501 sem prefixo => FORBIDDEN; texto desconhecido/vazio/nulo => genérico, sem vazar o texto cru", () => {
    expect(parseTabsError({ code: "42501", message: "permission denied for table tabs" }).code).toBe("FORBIDDEN");
    for (const e of [null, undefined, {}, { message: "" }, { message: "fetch failed" }, { message: "ALGO_NOVO: x" }, { message: "table_has_open_tab: x" }]) {
      const r = parseTabsError(e as any);
      expect(r.message).toMatch(/conexão|permissão|sessão|tente/i);
      expect(r.stale).toBe(false);
      expect(r.message).not.toMatch(/ALGO_NOVO|fetch/);
    }
  });

  // F-38 (UI): o banco levanta estes códigos ao abrir comanda/lançar pedido mas a tela só mostra "verifique a conexão".
  it.fails("[F-38] RESTAURANT_UNAVAILABLE, LABEL_REQUIRED, INVALID_LABEL, INVALID_GUESTS, INVALID_NOTES e INVALID_IDEMPOTENCY_KEY têm mensagem própria", () => {
    for (const c of ["RESTAURANT_UNAVAILABLE", "LABEL_REQUIRED", "INVALID_LABEL", "INVALID_GUESTS", "INVALID_NOTES", "INVALID_IDEMPOTENCY_KEY"]) {
      expect(parseTabsError({ message: `${c}: x` }).message, c).not.toMatch(/conexão/i);
    }
  });
});

describe("tables/staff-cart (carrinho local do lançamento da equipe)", () => {
  it("adiciona, agrupa linhas iguais (mesma variante/adicionais/observação) e separa as diferentes", () => {
    let s = addToStaffCart(EMPTY_STAFF_CART, input());
    s = addToStaffCart(s, input({ quantity: 2 }));
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].quantity).toBe(3);
    s = addToStaffCart(s, input({ notes: "sem cebola" }));
    s = addToStaffCart(s, input({ modifierIds: [M1] }));
    s = addToStaffCart(s, input({ productId: P2 }));
    expect(s.lines).toHaveLength(4);
    // escolher o tamanho de um produto que já estava no carrinho SEM tamanho absorve a linha antiga (migração da v1)
    s = addToStaffCart(s, input({ variantId: V1 }));
    expect(s.lines).toHaveLength(4);
    expect(s.lines.find((l) => l.variantId === V1)?.quantity).toBe(4); // 1 nova + 3 absorvidas
    expect(s.lines.some((l) => l.productId === P1 && l.variantId === null && l.notes === "" && l.modifierIds.length === 0)).toBe(false);
    expect(EMPTY_STAFF_CART.lines).toHaveLength(0); // imutável
  });

  it("quantidade: limitada a 1..99; setLineQuantity < 1 remove; NaN vira 1; adicionar acima do teto satura em 99", () => {
    let s = addToStaffCart(EMPTY_STAFF_CART, input({ quantity: 500 }));
    expect(s.lines[0].quantity).toBe(MAX_QUANTITY);
    const id = s.lines[0].id;
    expect(setLineQuantity(s, id, 5).lines[0].quantity).toBe(5);
    expect(setLineQuantity(s, id, 7.9).lines[0].quantity).toBe(7);
    expect(setLineQuantity(s, id, 1000).lines[0].quantity).toBe(MAX_QUANTITY);
    expect(setLineQuantity(s, id, Number.NaN).lines[0].quantity).toBe(1);
    expect(setLineQuantity(s, id, 0).lines).toHaveLength(0);
    expect(setLineQuantity(s, id, -3).lines).toHaveLength(0);
    expect(setLineQuantity(s, "nao-existe", 2)).toEqual(s);
    s = addToStaffCart(s, input({ quantity: 99 }));
    expect(s.lines[0].quantity).toBe(MAX_QUANTITY);
  });

  it(`limite de ${MAX_LINES} linhas distintas; observação aparada e truncada em 300`, () => {
    let s = EMPTY_STAFF_CART;
    for (let i = 0; i < MAX_LINES + 5; i++) s = addToStaffCart(s, input({ notes: `obs ${i}` }));
    expect(s.lines).toHaveLength(MAX_LINES);
    const long = addToStaffCart(EMPTY_STAFF_CART, input({ notes: `  ${"x".repeat(400)}  ` }));
    expect(long.lines[0].notes).toHaveLength(300);
  });

  it("removeLine e contadores/estimativa (adicionais somam; nunca negativo)", () => {
    let s = addToStaffCart(EMPTY_STAFF_CART, input({ quantity: 2, snapshot: { name: "X", variantName: null, unitPriceCents: 2500, imagePath: null, modifiers: [{ id: M1, name: "Bacon", priceDeltaCents: 500 }] }, modifierIds: [M1] }));
    s = addToStaffCart(s, input({ productId: P2, quantity: 3, snapshot: { name: "Refri", variantName: null, unitPriceCents: 600, imagePath: null, modifiers: [] } }));
    expect(staffCartCount(s.lines)).toBe(5);
    expect(staffCartEstimate(s.lines)).toBe(2 * 3000 + 3 * 600);
    const neg = addToStaffCart(EMPTY_STAFF_CART, input({ snapshot: { name: "Promo", variantName: null, unitPriceCents: 100, imagePath: null, modifiers: [{ id: M1, name: "Desc", priceDeltaCents: -500 }] } }));
    expect(staffCartEstimate(neg.lines)).toBe(0);
    expect(removeLine(s, s.lines[0].id).lines).toHaveLength(1);
    expect(removeLine(s, "x")).toEqual(s);
  });

  it("toStaffPayload: formato de create_staff_order (snake_case, sem preço, observação aparada e omitida se vazia)", () => {
    let s = addToStaffCart(EMPTY_STAFF_CART, input({ quantity: 2, variantId: V1, modifierIds: [M1], notes: "  sem gelo  " }));
    s = addToStaffCart(s, input({ productId: P2 }));
    const payload = toStaffPayload(s.lines);
    expect(payload).toEqual([
      { product_id: P1, variant_id: V1, quantity: 2, modifier_ids: [M1], notes: "sem gelo" },
      { product_id: P2, variant_id: null, quantity: 1, modifier_ids: [] },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/price|cents|snapshot|imagePath/i);
    expect(payload[1]).not.toHaveProperty("notes");
  });

  it("newAttemptKey: UUID v4 único a cada tentativa e dentro do limite de 8..80 caracteres da chave de idempotência", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newAttemptKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(k.length).toBeGreaterThanOrEqual(8);
      expect(k.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("tables/types", () => {
  it("estados batem com os enums do banco, com rótulo para todos", () => {
    expect([...TABLE_STATUSES]).toEqual(["AVAILABLE", "OCCUPIED", "CLEANING", "INACTIVE"]);
    expect([...TAB_STATUSES]).toEqual(["OPEN", "CLOSED", "CANCELLED"]);
    for (const s of TABLE_STATUSES) expect(TABLE_STATUS_LABELS[s]).toBeTruthy();
    for (const s of TAB_STATUSES) expect(TAB_STATUS_LABELS[s]).toBeTruthy();
  });

  it("countsTowardTab: cancelados/recusados não contam no consumo", () => {
    for (const s of ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"]) expect(countsTowardTab(s), s).toBe(true);
    for (const s of ["CANCELLED", "REJECTED"]) expect(countsTowardTab(s), s).toBe(false);
  });

  const table = { id: "t1", restaurant_id: "r1", name: "Mesa 1", area: null, capacity: 4, status: "AVAILABLE", sort_order: 1, updated_at: "2026-01-01T00:00:00Z" };
  const tab = { id: "b1", restaurant_id: "r1", table_id: null, label: "João", guests: null, status: "OPEN", status_reason: null, opened_at: "2026-01-01T00:00:00Z", closed_at: null, total_cents: 0, updated_at: "2026-01-01T00:00:00Z" };

  it("tableRowSchema/tabRowSchema: aceitam as linhas do banco, rejeitam estado desconhecido e corrigem números ruins (catch)", () => {
    expect(tableRowSchema.safeParse(table).success).toBe(true);
    expect(tableRowSchema.safeParse({ ...table, status: "BROKEN" }).success).toBe(false);
    expect(tableRowSchema.safeParse({ ...table, sort_order: "x" }).data?.sort_order).toBe(0);
    expect(tabRowSchema.safeParse(tab).success).toBe(true);
    expect(tabRowSchema.safeParse({ ...tab, status: "REOPENED" }).success).toBe(false);
    expect(tabRowSchema.safeParse({ ...tab, total_cents: null }).data?.total_cents).toBe(0);
    expect(tabRowSchema.safeParse({ ...tab, opened_at: undefined }).success).toBe(false);
  });

  it("tabBalanceSchema (resumo) é tolerante: campos ausentes/ruins viram 0; extras são ignorados", () => {
    expect(tabBalanceSchema.parse({ consumed_cents: 100, paid_cents: 40, remaining_cents: 60, payments: [], x: 1 })).toEqual({ consumed_cents: 100, paid_cents: 40, remaining_cents: 60 });
    expect(tabBalanceSchema.parse({})).toEqual({ consumed_cents: 0, paid_cents: 0, remaining_cents: 0 });
    expect(tabBalanceSchema.parse({ consumed_cents: "100", paid_cents: 1.5 })).toEqual({ consumed_cents: 0, paid_cents: 0, remaining_cents: 0 });
  });

  it("orderBriefSchema exige tab_id (pode ser nulo) e total inteiro", () => {
    expect(orderBriefSchema.safeParse({ id: "o", tab_id: null, status: "READY", total_cents: 100 }).success).toBe(true);
    expect(orderBriefSchema.safeParse({ id: "o", status: "READY", total_cents: 100 }).success).toBe(false);
    expect(orderBriefSchema.safeParse({ id: "o", tab_id: "t", status: "READY", total_cents: 1.5 }).success).toBe(false);
  });
});
