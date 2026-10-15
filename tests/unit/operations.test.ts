/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 3, painel operacional: src/modules/operations/{errors,format,alert-prefs,types}. Módulos puros (zod/Intl);
 * localStorage/window são simulados. Não cobre os hooks (React) nem o sound-engine (Web Audio).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseActionError } from "../../src/modules/operations/errors";
import { dayBoundIso, elapsedMinutes, formatAddress, formatDateTime, formatElapsed, formatMoney, formatPhone, formatTime, itemsCount, startOfTodayIso, summarizeItems } from "../../src/modules/operations/format";
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  DEFAULT_FILTERS,
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  historyRowSchema,
  isActiveStatus,
  ORDER_STATUSES,
  orderRowSchema,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  STATUS_LABELS,
  TAB_LABELS,
  transitionRowSchema,
  type OperationsOrder,
} from "../../src/modules/operations/types";

const nb = (s: string) => s.replace(/\s/g, " ");

describe("operations/errors: parseActionError", () => {
  it("mapeia os códigos estáveis das RPCs (prefixo da mensagem) para PT-BR; só ORDER_* relevantes pedem recarga", () => {
    const cases: Array<[string, RegExp, boolean]> = [
      ["ORDER_INVALID_TRANSITION: RECEIVED -> READY não é permitido para PICKUP", /já mudou de estado/, true],
      ["REASON_REQUIRED: informe o motivo", /Informe o motivo/, false],
      ["FORBIDDEN: requer permissão orders.accept", /não tem permissão/, false],
      ["FORBIDDEN_FIELD: x", /não tem permissão/, false],
      ["ORDER_NOT_FOUND: pedido não encontrado", /não encontrado/, true],
      ["INVALID_STATUS: status desconhecido", /Estado inválido/, false],
      ["UNAUTHENTICATED: faça login para continuar", /sessão expirou/, false],
      ["REASON_TOO_LONG: o motivo deve ter no máximo 500 caracteres", /máximo de 500/, false],
    ];
    for (const [message, re, stale] of cases) {
      const e = parseActionError({ message });
      expect(e.message, message).toMatch(re);
      expect(e.stale, message).toBe(stale);
      expect(e.code).toBe(/^([A-Z][A-Z_]+)/.exec(message)![1]);
    }
  });
  it("PGRST/42501 sem prefixo vira FORBIDDEN; qualquer outra coisa vira UNKNOWN com mensagem genérica (nunca o texto cru do banco)", () => {
    expect(parseActionError({ message: "permission denied for function transition_order_status", code: "42501" })).toMatchObject({ code: "FORBIDDEN", stale: false });
    for (const err of [null, undefined, {}, { message: "" }, { message: "duplicate key value violates unique constraint \"orders_pkey\"" }, { message: "TypeError: failed to fetch" }, { message: "ORDER_" }, { message: "tabela orders" }]) {
      const e = parseActionError(err as any);
      expect(e.code === "UNKNOWN" || /^[A-Z_]+$/.test(e.code)).toBe(true);
      expect(e.message).not.toMatch(/duplicate key|orders_pkey|TypeError/);
      expect(e.stale).toBe(false);
    }
    expect(parseActionError({ message: "ALGO_NOVO: x" })).toMatchObject({ code: "ALGO_NOVO", message: expect.stringMatching(/Não foi possível concluir/) });
    expect(parseActionError(null)).toMatchObject({ code: "UNKNOWN" });
  });
  it("códigos herdados de Object.prototype não viram função/mensagem inválida", () => {
    for (const message of ["constructor: x", "TOSTRING: x", "HASOWNPROPERTY: x"]) {
      const e = parseActionError({ message });
      expect(typeof e.message).toBe("string");
      expect(typeof e.stale).toBe("boolean");
    }
  });
});

describe("operations/format", () => {
  it("formatMoney (BRL em centavos)", () => {
    expect(nb(formatMoney(0))).toBe("R$ 0,00");
    expect(nb(formatMoney(1050))).toBe("R$ 10,50");
    expect(nb(formatMoney(123456))).toBe("R$ 1.234,56");
    expect(nb(formatMoney(5))).toBe("R$ 0,05");
  });
  it("formatTime/formatDateTime no fuso de São Paulo; ISO inválido => placeholder", () => {
    expect(formatTime("2026-10-15T15:30:00Z")).toBe("12:30");
    expect(formatTime("2026-10-15T02:05:00Z")).toBe("23:05"); // 14/10 em SP
    expect(formatDateTime("2026-10-15T15:30:00Z")).toMatch(/^15\/10,? 12:30$/);
    expect(formatTime("x")).toBe("--:--");
    expect(formatDateTime("x")).toBe("--");
    expect(formatTime("")).toBe("--:--");
  });
  it("formatElapsed / elapsedMinutes", () => {
    const t0 = Date.parse("2026-10-15T12:00:00Z");
    const at = (min: number) => new Date(t0 - min * 60_000).toISOString();
    expect(formatElapsed(at(0), t0)).toBe("agora");
    expect(formatElapsed(new Date(t0 - 30_000).toISOString(), t0)).toBe("agora");
    expect(formatElapsed(at(1), t0)).toBe("há 1 min");
    expect(formatElapsed(at(59), t0)).toBe("há 59 min");
    expect(formatElapsed(at(60), t0)).toBe("há 1 h");
    expect(formatElapsed(at(130), t0)).toBe("há 2 h 10 min");
    expect(formatElapsed(at(24 * 60), t0)).toBe("há 1 d");
    expect(formatElapsed(at(3 * 24 * 60 + 5), t0)).toBe("há 3 d");
    expect(formatElapsed(at(-10), t0)).toBe("agora"); // relógio adiantado: nunca negativo
    expect(formatElapsed("lixo", t0)).toBe("");
    expect(elapsedMinutes(at(45), t0)).toBe(45);
    expect(elapsedMinutes(at(-45), t0)).toBe(0);
    expect(elapsedMinutes("lixo", t0)).toBe(0);
  });
  it("formatPhone: celular, fixo, prefixo 55, e devolve o original quando não reconhece", () => {
    expect(formatPhone("11912345678")).toBe("(11) 91234-5678");
    expect(formatPhone("1132124567")).toBe("(11) 3212-4567");
    expect(formatPhone("5511912345678")).toBe("(11) 91234-5678");
    expect(formatPhone("+55 (11) 91234-5678")).toBe("(11) 91234-5678");
    expect(formatPhone("12345")).toBe("12345");
    expect(formatPhone("")).toBe("");
    expect(formatPhone(null)).toBe("");
    expect(formatPhone(undefined)).toBe("");
    // 10 dígitos que começam com 55 (DDD 55) NÃO perdem o prefixo
    expect(formatPhone("5532124567")).toBe("(55) 3212-4567");
  });
  it("formatAddress: linhas sem partes vazias, CEP só quando existe", () => {
    expect(formatAddress(null)).toEqual([]);
    expect(formatAddress(undefined)).toEqual([]);
    expect(formatAddress({})).toEqual([]);
    expect(formatAddress({ street: "Rua A", number: "10", neighborhood: "Centro", city: "SP", postal_code: "01310100" })).toEqual(["Rua A, 10", "Centro - SP", "CEP 01310100"]);
    expect(formatAddress({ street: "Rua A", city: "SP" })).toEqual(["Rua A", "SP"]);
    expect(formatAddress({ number: "10" })).toEqual(["10"]);
  });
  const order = (items: Array<{ product_name: string; quantity: number }>) => ({ order_items: items }) as unknown as OperationsOrder;
  it("summarizeItems / itemsCount", () => {
    expect(summarizeItems(order([]))).toBe("Sem itens carregados");
    expect(summarizeItems(order([{ product_name: "Pizza", quantity: 2 }]))).toBe("2x Pizza");
    const four = order([1, 2, 3, 4].map((n) => ({ product_name: `P${n}`, quantity: n })));
    expect(summarizeItems(four)).toBe("1x P1, 2x P2, 3x P3 +1");
    expect(summarizeItems(four, 4)).toBe("1x P1, 2x P2, 3x P3, 4x P4");
    expect(summarizeItems(four, 1)).toBe("1x P1 +3");
    expect(itemsCount(four)).toBe(10);
    expect(itemsCount(order([]))).toBe(0);
  });
  it("startOfTodayIso: início do dia em SP (UTC-3), inclusive logo após a meia-noite UTC", () => {
    expect(startOfTodayIso(new Date("2026-10-15T15:00:00Z"))).toBe("2026-10-15T03:00:00.000Z");
    expect(startOfTodayIso(new Date("2026-10-15T02:00:00Z"))).toBe("2026-10-14T03:00:00.000Z"); // ainda é dia 14 em SP
    expect(startOfTodayIso(new Date("2026-10-15T03:00:00Z"))).toBe("2026-10-15T03:00:00.000Z");
    expect(startOfTodayIso(new Date("2026-10-15T02:59:59Z"))).toBe("2026-10-14T03:00:00.000Z");
    expect(startOfTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}T03:00:00\.000Z$/);
  });
  it("dayBoundIso: início/fim do dia de SP em UTC; formato inválido => null", () => {
    expect(dayBoundIso("2026-10-15", false)).toBe("2026-10-15T03:00:00.000Z");
    expect(dayBoundIso("2026-10-15", true)).toBe("2026-10-16T02:59:59.999Z");
    for (const bad of ["", "15/10/2026", "2026-10-1", "2026-13-45", "2026-10-15T00:00", "x", "2026-10-15 "]) expect(dayBoundIso(bad, false), bad).toBeNull();
  });
});

describe("operations/types", () => {
  it("ACTIVE + CLOSED particionam ORDER_STATUSES; isActiveStatus coerente", () => {
    expect([...ACTIVE_STATUSES, ...CLOSED_STATUSES].sort()).toEqual([...ORDER_STATUSES].sort());
    for (const s of ACTIVE_STATUSES) expect(isActiveStatus(s)).toBe(true);
    for (const s of CLOSED_STATUSES) expect(isActiveStatus(s)).toBe(false);
    expect([...CLOSED_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "REJECTED"]);
  });
  it("rótulos cobrem todos os status/modalidades/formas de pagamento; UNPAID existe", () => {
    for (const s of ORDER_STATUSES) {
      expect(STATUS_LABELS[s], s).toBeTruthy();
      expect(TAB_LABELS[s], s).toBeTruthy();
    }
    for (const f of FULFILLMENT_TYPES) expect(FULFILLMENT_LABELS[f], f).toBeTruthy();
    expect(Object.keys(PAYMENT_METHOD_LABELS).sort()).toEqual(["CARD", "CASH", "PIX"]);
    expect(PAYMENT_STATUS_LABELS.UNPAID).toBeTruthy();
    expect(DEFAULT_FILTERS).toEqual({ period: "today", from: "", to: "", fulfillment: "ALL", search: "" });
  });
  it("os 8 status do app = enum order_status do banco (sem divergência)", () => {
    expect([...ORDER_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "CONFIRMED", "OUT_FOR_DELIVERY", "PREPARING", "READY", "RECEIVED", "REJECTED"]);
    expect([...FULFILLMENT_TYPES].sort()).toEqual(["DELIVERY", "DINE_IN", "PICKUP"]);
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: "o1",
    restaurant_id: "r1",
    order_number: 7,
    public_code: "ABCDEFGH23456789",
    source: "PUBLIC_WEB",
    fulfillment_type: "DELIVERY",
    status: "RECEIVED",
    payment_status: "UNPAID",
    subtotal_cents: 1000,
    delivery_fee_cents: 500,
    discount_cents: 0,
    total_cents: 1500,
    created_at: "2026-10-15T12:00:00Z",
    updated_at: "2026-10-15T12:00:00Z",
    ...over,
  });
  it("orderRowSchema: linha mínima do banco, defaults (order_items=[]), colunas da 0114 opcionais", () => {
    const r = orderRowSchema.safeParse(row());
    expect(r.success, r.error?.message).toBe(true);
    expect(r.data!.order_items).toEqual([]);
    const full = orderRowSchema.safeParse(
      row({
        customer_name: "Maria",
        customer_phone: "11912345678",
        delivery_address: { street: "Rua A", number: "1", extra: "passthrough" },
        payment_method_intent: "CASH",
        change_for_cents: 5000,
        estimated_ready_at: null,
        notes: null,
        order_items: [{ id: "i1", product_name: "Pizza", variant_name_snapshot: "G", quantity: 2, unit_price_cents: 2000, modifiers_cents: 100, line_total_cents: 4200, order_item_modifiers: [{ modifier_name: "Borda", group_name: null, quantity: 1, price_delta_cents: 100 }] }],
      }),
    );
    expect(full.success, full.error?.message).toBe(true);
    expect((full.data!.delivery_address as any).extra).toBe("passthrough");
    expect(full.data!.order_items[0].order_item_modifiers).toHaveLength(1);
  });
  it("orderRowSchema recusa status/modalidade desconhecidos e tipos errados (nada inválido chega à UI)", () => {
    for (const bad of [row({ status: "BANANA" }), row({ fulfillment_type: "VOO" }), row({ total_cents: "15" }), row({ total_cents: 1.5 }), row({ order_number: "7" }), row({ id: 1 }), row({ order_items: "x" }), row({ created_at: undefined })]) {
      expect(orderRowSchema.safeParse(bad).success).toBe(false);
    }
    expect(orderRowSchema.safeParse(null).success).toBe(false);
  });
  it("transitionRowSchema / historyRowSchema", () => {
    expect(transitionRowSchema.safeParse({ fulfillment_type: "PICKUP", from_status: "RECEIVED", to_status: "CONFIRMED", required_permission: "orders.accept" }).success).toBe(true);
    expect(transitionRowSchema.safeParse({ fulfillment_type: "PICKUP", from_status: "X", to_status: "CONFIRMED", required_permission: "orders.accept" }).success).toBe(false);
    expect(historyRowSchema.safeParse({ id: 1, from_status: null, to_status: "RECEIVED", changed_by: null, reason: null, created_at: "t" }).success).toBe(true);
    expect(historyRowSchema.safeParse({ id: "uuid", from_status: "RECEIVED", to_status: "REJECTED", changed_by: "u1", reason: "sem estoque", created_at: "t" }).success).toBe(true);
    expect(historyRowSchema.safeParse({ id: 1, from_status: "RECEIVED", to_status: "NOPE", changed_by: null, reason: null, created_at: "t" }).success).toBe(false);
  });
});

describe("operations/alert-prefs (localStorage simulado)", () => {
  const KEY = "mesa-facil.ops.alert.v1";
  class Store {
    data = new Map<string, string>();
    failWrite = false;
    getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      if (this.failWrite) throw new Error("QuotaExceededError");
      this.data.set(k, v);
    }
  }
  let store: Store;
  let listeners: Array<(e: any) => void>;
  async function load() {
    vi.resetModules();
    return import("../../src/modules/operations/alert-prefs");
  }
  beforeEach(() => {
    store = new Store();
    listeners = [];
    vi.stubGlobal("window", {
      localStorage: store,
      addEventListener: (_: string, fn: (e: any) => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: (e: any) => void) => void (listeners = listeners.filter((l) => l !== fn)),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("padrão: ligado, volume 0,7, sino, repete a cada 20 s; servidor sempre devolve o padrão", async () => {
    const m = await load();
    expect(m.getAlertPrefsSnapshot()).toEqual({ enabled: true, volume: 0.7, sound: "sino", repeatSeconds: 20 });
    expect(m.getAlertPrefsServerSnapshot()).toBe(m.DEFAULT_ALERT_PREFS);
    expect(m.getAlertPrefsSnapshot()).toBe(m.getAlertPrefsSnapshot()); // estável (useSyncExternalStore)
    expect(m.ALERT_SOUNDS).toEqual(["sino", "campainha", "bipe"]);
    expect([...m.REPEAT_OPTIONS]).toEqual([0, 10, 20, 30, 60]);
  });
  it("updateAlertPrefs valida, persiste e notifica; valores inválidos são ignorados por inteiro", async () => {
    const m = await load();
    const seen = vi.fn();
    const off = m.subscribeAlertPrefs(seen);
    m.updateAlertPrefs({ volume: 0.3, sound: "bipe", repeatSeconds: 0 });
    expect(m.getAlertPrefsSnapshot()).toEqual({ enabled: true, volume: 0.3, sound: "bipe", repeatSeconds: 0 });
    expect(JSON.parse(store.data.get(KEY)!)).toEqual({ enabled: true, volume: 0.3, sound: "bipe", repeatSeconds: 0 });
    expect(seen).toHaveBeenCalledTimes(1);
    for (const bad of [{ volume: 1.5 }, { volume: -0.1 }, { sound: "buzina" as any }, { repeatSeconds: 15 }, { enabled: "sim" as any }]) {
      m.updateAlertPrefs(bad as any);
      expect(m.getAlertPrefsSnapshot()).toEqual({ enabled: true, volume: 0.3, sound: "bipe", repeatSeconds: 0 });
    }
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    m.updateAlertPrefs({ enabled: false });
    expect(seen).toHaveBeenCalledTimes(1); // desinscrito
    expect(listeners).toHaveLength(0);
  });
  it("lê as preferências salvas; JSON quebrado ou inválido cai no padrão sem lançar", async () => {
    store.data.set(KEY, JSON.stringify({ enabled: false, volume: 0.2, sound: "campainha", repeatSeconds: 60 }));
    expect((await load()).getAlertPrefsSnapshot()).toEqual({ enabled: false, volume: 0.2, sound: "campainha", repeatSeconds: 60 });
    for (const raw of ["{", "null", JSON.stringify({ volume: 9 }), JSON.stringify({ sound: "x" }), JSON.stringify({ repeatSeconds: 7 }), '"texto"']) {
      store.data.set(KEY, raw);
      expect((await load()).getAlertPrefsSnapshot(), raw).toEqual({ enabled: true, volume: 0.7, sound: "sino", repeatSeconds: 20 });
    }
    // campos ausentes recebem o default individualmente
    store.data.set(KEY, JSON.stringify({ volume: 0.5 }));
    expect((await load()).getAlertPrefsSnapshot()).toEqual({ enabled: true, volume: 0.5, sound: "sino", repeatSeconds: 20 });
  });
  it("storage bloqueado: a leitura usa o padrão e a escrita falha em silêncio, mas a preferência vale na sessão", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("SecurityError");
        },
        setItem() {
          throw new Error("SecurityError");
        },
      },
      addEventListener() {},
      removeEventListener() {},
    });
    const m = await load();
    expect(m.getAlertPrefsSnapshot().enabled).toBe(true);
    expect(() => m.updateAlertPrefs({ enabled: false })).not.toThrow();
    expect(m.getAlertPrefsSnapshot().enabled).toBe(false);
  });
  it("evento 'storage' da mesma chave recarrega e notifica (outra aba); outras chaves são ignoradas", async () => {
    const m = await load();
    const seen = vi.fn();
    m.subscribeAlertPrefs(seen);
    expect(m.getAlertPrefsSnapshot().volume).toBe(0.7);
    store.data.set(KEY, JSON.stringify({ volume: 0.1 }));
    listeners[0]({ key: "outra-chave" });
    expect(seen).not.toHaveBeenCalled();
    listeners[0]({ key: KEY });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(m.getAlertPrefsSnapshot().volume).toBe(0.1);
  });
});
