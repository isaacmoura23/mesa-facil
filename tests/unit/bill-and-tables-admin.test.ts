/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 4: src/modules/printing/bill (schema do payload da conta) e src/modules/tables-admin/{schemas,cursor,format}
 * (painel do dono: cadastro de mesas, filtros, cursor opaco da paginação e formatação). Módulos puros.
 */
import { describe, expect, it } from "vitest";
import {
  BILL_DOCUMENT_LABELS,
  BILL_DOCUMENT_TYPES,
  BILL_NOT_FISCAL_NOTICE,
  billPayloadSchema,
  billPlace,
  billTotals,
  requestTabPrintResultSchema,
} from "../../src/modules/printing/bill";
import { decodeCursor, encodeCursor } from "../../src/modules/tables-admin/cursor";
import {
  capacityLabel,
  formatDuration,
  formatMoney,
  orderStatusLabel,
  paymentMethodLabel,
  tabShortCode,
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
  TAB_STATUS_LABELS,
  TAB_STATUS_TONES,
  ORDER_STATUS_LABELS,
} from "../../src/modules/tables-admin/format";
import {
  EMPTY_FILTERS,
  TABLE_CAPACITY_MAX,
  TABLE_NAME_MAX,
  entityIdSchema,
  fieldErrorsOf,
  filtersToQuery,
  parseTabFilters,
  slugSchema,
  tableFormSchema,
} from "../../src/modules/tables-admin/schemas";

const nb = (s: string) => s.replace(/\s/g, " ");
const UUID = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
describe("printing/bill: schema do payload (request_tab_print)", () => {
  const item = (name: string, quantity: number, line: number | null, extra: Record<string, unknown> = {}) => ({ name, quantity, line_total_cents: line, ...extra });
  const base = {
    document_type: "PARTIAL_BILL",
    restaurant_name: "DEMO Restaurante A",
    timezone: "America/Sao_Paulo",
    printed_at_local: "16/10/2026 10:30",
    tab: { status: "OPEN", label: null, table_name: "Mesa 4", guests: 3, opened_at_local: "16/10/2026 09:00", closed_at_local: null },
    orders: [{ order_number: 12, status: "COMPLETED", total_cents: 3000, created_at_local: "16/10/2026 09:10", items: [item("X-Burger", 2, 5000)] }],
    items: [item("X-Burger", 2, 5000, { variant_name: "G", unit_price_cents: 2500, modifiers: [{ name: "Bacon", price_delta_cents: 500 }] })],
    subtotal_cents: 5000,
    payments: [{ method: "CASH", amount_cents: 2000, tendered_cents: 3000, change_cents: 1000, paid_at_local: "16/10/2026 10:00" }],
    paid_cents: 2000,
    remaining_cents: 3000,
  };

  it("aceita o payload do servidor (PARTIAL e FINAL) e preserva os valores", () => {
    const p = billPayloadSchema.parse(base);
    expect(p.document_type).toBe("PARTIAL_BILL");
    expect(p.items[0]).toMatchObject({ name: "X-Burger", quantity: 2, variant_name: "G" });
    expect(billPayloadSchema.safeParse({ ...base, document_type: "FINAL_BILL", total_cents: 5000, unpaid_cents: 3000 }).success).toBe(true);
  });

  it("rejeita tipo de documento fora de PARTIAL_BILL/FINAL_BILL (inclusive os de pedido) e restaurant_name ausente", () => {
    for (const t of ["KITCHEN_TICKET", "ORDER_RECEIPT", "partial_bill", "", null]) expect(billPayloadSchema.safeParse({ ...base, document_type: t }).success, String(t)).toBe(false);
    const { restaurant_name: _r, ...noName } = base;
    expect(billPayloadSchema.safeParse(noName).success).toBe(false);
  });

  it("aplica defaults ([]) a items/orders/payments e tolera tab nulo e totais ausentes", () => {
    const p = billPayloadSchema.parse({ document_type: "FINAL_BILL", restaurant_name: "X" });
    expect(p.items).toEqual([]);
    expect(p.orders).toEqual([]);
    expect(p.payments).toEqual([]);
    expect(p.tab ?? null).toBeNull();
  });

  it("rejeita item/pagamento malformado (quantidade ou valor não inteiro) e NÃO expõe campos de cliente", () => {
    expect(billPayloadSchema.safeParse({ ...base, items: [item("A", 1.5, 100)] }).success).toBe(false);
    expect(billPayloadSchema.safeParse({ ...base, payments: [{ method: "PIX", amount_cents: "10" }] }).success).toBe(false);
    expect(billPayloadSchema.safeParse({ ...base, subtotal_cents: 10.5 }).success).toBe(false);
    // chaves de cliente que o servidor nunca manda são descartadas pelo parse (objeto estrito do zod remove desconhecidas)
    const parsed = billPayloadSchema.parse({ ...base, customer_name: "Maria", customer_phone: "11999990000" });
    expect(JSON.stringify(parsed)).not.toMatch(/Maria|11999990000|customer/);
  });

  it("requestTabPrintResultSchema exige ok:true, job_id, status e payload válido", () => {
    const ok = { ok: true, job_id: UUID, status: "REQUESTED", payload: base };
    expect(requestTabPrintResultSchema.safeParse(ok).success).toBe(true);
    expect(requestTabPrintResultSchema.safeParse({ ...ok, ok: false }).success).toBe(false);
    expect(requestTabPrintResultSchema.safeParse({ ...ok, job_id: undefined }).success).toBe(false);
    expect(requestTabPrintResultSchema.safeParse({ ...ok, payload: { ...base, document_type: "X" } }).success).toBe(false);
  });

  it("rótulos e aviso 'não é documento fiscal' existem para os dois tipos", () => {
    for (const t of BILL_DOCUMENT_TYPES) {
      expect(BILL_DOCUMENT_LABELS[t]).toBeTruthy();
      expect(BILL_NOT_FISCAL_NOTICE[t]).toMatch(/NÃO É DOCUMENTO FISCAL/);
    }
  });

  it("billPlace: 'Mesa X / Comanda Y' sem separador sobrando", () => {
    const p = (tab: any) => billPayloadSchema.parse({ ...base, tab });
    expect(billPlace(p({ table_name: "4", label: "João" }))).toBe("Mesa 4 / Comanda João");
    expect(billPlace(p({ table_name: "4", label: null }))).toBe("Mesa 4");
    expect(billPlace(p({ table_name: null, label: "João" }))).toBe("Comanda João");
    expect(billPlace(p({}))).toBe("");
    expect(billPlace(billPayloadSchema.parse({ document_type: "FINAL_BILL", restaurant_name: "X" }))).toBe("");
  });

  it("billTotals: usa os totais do servidor; sem eles deduz de itens/pagamentos; saldo nunca negativo; cai nos itens dos pedidos", () => {
    expect(billTotals(billPayloadSchema.parse(base))).toMatchObject({ subtotalCents: 5000, paidCents: 2000, remainingCents: 3000 });
    const bare = billPayloadSchema.parse({ document_type: "PARTIAL_BILL", restaurant_name: "X", items: [item("A", 1, 700), item("B", 2, 300)], payments: [{ method: "PIX", amount_cents: 400 }] });
    expect(billTotals(bare)).toMatchObject({ subtotalCents: 1000, paidCents: 400, remainingCents: 600 });
    const over = billPayloadSchema.parse({ document_type: "FINAL_BILL", restaurant_name: "X", items: [item("A", 1, 500)], payments: [{ method: "PIX", amount_cents: 900 }] });
    expect(billTotals(over).remainingCents).toBe(0);
    const viaOrders = billPayloadSchema.parse({ document_type: "PARTIAL_BILL", restaurant_name: "X", orders: [{ order_number: 1, items: [item("A", 1, 250)] }, { order_number: 2, items: [item("B", 1, 350)] }] });
    expect(billTotals(viaOrders)).toMatchObject({ subtotalCents: 600, remainingCents: 600 });
    expect(billTotals(viaOrders).items).toHaveLength(2);
    expect(billTotals(billPayloadSchema.parse({ document_type: "PARTIAL_BILL", restaurant_name: "X", consumed_cents: 900 })).subtotalCents).toBe(900);
    const nullLine = billPayloadSchema.parse({ document_type: "PARTIAL_BILL", restaurant_name: "X", items: [item("A", 1, null)] });
    expect(billTotals(nullLine).subtotalCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("tables-admin/cursor: cursor opaco da paginação (opened_at desc, id desc)", () => {
  const cursor = { t: "2026-10-16T12:05:12.179613+00:00", id: UUID };

  it("ida e volta preservam o cursor; o texto é base64url opaco (sem JSON legível)", () => {
    const enc = encodeCursor(cursor);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain(UUID);
    expect(decodeCursor(enc)).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ t: "2026-01-01 00:00:00Z", id: UUID }))).toEqual({ t: "2026-01-01 00:00:00Z", id: UUID });
    expect(decodeCursor(encodeCursor({ t: "2026-01-01T00:00:00-03:00", id: UUID }))?.t).toBe("2026-01-01T00:00:00-03:00");
  });

  it("vazio/indefinido => null (primeira página)", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("valores inválidos, adulterados ou hostis => null (nunca lança nem chega ao banco)", () => {
    const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");
    const hostile: Array<[string, string]> = [
      ["lixo", "%%%"],
      ["não-base64", "não é base64!"],
      ["base64 de texto", b64("só texto")],
      ["JSON truncado", b64('{"t":"2026-01-01T00:00:00Z","id":')],
      ["array", b64([cursor])],
      ["null", b64("null")],
      ["número", b64("42")],
      ["sem id", b64({ t: cursor.t })],
      ["sem t", b64({ id: UUID })],
      ["id não-uuid", b64({ t: cursor.t, id: "1 or 1=1" })],
      ["id SQLi", b64({ t: cursor.t, id: `${UUID}'; drop table tabs;--` })],
      ["t SQLi", b64({ t: "2026-01-01T00:00:00Z'); drop table tabs;--", id: UUID })],
      ["t sem fuso", b64({ t: "2026-01-01T00:00:00", id: UUID })],
      ["t só data", b64({ t: "2026-01-01", id: UUID })],
      ["t filtro PostgREST", b64({ t: "2026-01-01T00:00:00Z),id.eq.x", id: UUID })],
      ["t objeto", b64({ t: { $gt: "" }, id: UUID })],
      ["id objeto", b64({ t: cursor.t, id: { $ne: null } })],
      ["t com vírgula/ponto-e-vírgula", b64({ t: "2026-01-01T00:00:00,Z", id: UUID })],
    ];
    for (const [what, raw] of hostile) expect(decodeCursor(raw), what).toBeNull();
  });

  it("campos extras são descartados (não passam adiante)", () => {
    const parsed = decodeCursor(Buffer.from(JSON.stringify({ ...cursor, restaurant_id: "outro", admin: true }), "utf8").toString("base64url"));
    expect(parsed).toEqual(cursor);
    expect(parsed).not.toHaveProperty("restaurant_id");
  });

  it("alterar um caractere do cursor invalida ou muda o valor, mas nunca produz um cursor com forma inválida aceita", () => {
    const enc = encodeCursor(cursor);
    for (let i = 0; i < enc.length; i += 7) {
      const tampered = enc.slice(0, i) + (enc[i] === "A" ? "B" : "A") + enc.slice(i + 1);
      const d = decodeCursor(tampered);
      if (d) {
        expect(d.id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(d.t).toMatch(/^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("tables-admin/schemas", () => {
  it("tableFormSchema: nome colapsa espaços e é aparado; capacidade vira número", () => {
    const r = tableFormSchema.safeParse({ name: "  Mesa   da   Janela  ", capacity: " 6 " });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ name: "Mesa da Janela", capacity: 6 });
  });

  it("tableFormSchema: limites do nome (1..40) e da capacidade (1..50, inteiro, só dígitos)", () => {
    const err = (v: any) => {
      const r = tableFormSchema.safeParse(v);
      return r.success ? null : fieldErrorsOf(r.error);
    };
    expect(err({ name: "", capacity: "4" })).toMatchObject({ name: expect.stringMatching(/nome/i) });
    expect(err({ name: "   ", capacity: "4" })?.name).toBeTruthy();
    expect(err({ name: "x".repeat(TABLE_NAME_MAX), capacity: "4" })).toBeNull();
    expect(err({ name: "x".repeat(TABLE_NAME_MAX + 1), capacity: "4" })?.name).toMatch(/40/);
    expect(err({ name: "Mesa", capacity: "" })?.capacity).toBeTruthy();
    expect(err({ name: "Mesa", capacity: "0" })?.capacity).toMatch(/mínima/i);
    expect(err({ name: "Mesa", capacity: String(TABLE_CAPACITY_MAX) })).toBeNull();
    expect(err({ name: "Mesa", capacity: String(TABLE_CAPACITY_MAX + 1) })?.capacity).toMatch(/máxima/i);
    for (const bad of ["-1", "1.5", "1,5", "abc", "1e2", "+3", "0x10", "٣"]) expect(err({ name: "Mesa", capacity: bad })?.capacity, bad).toBeTruthy();
  });

  it("tableFormSchema nunca aceita nem repassa campos que o cliente não pode definir (restaurant_id, qr_token, status)", () => {
    const r = tableFormSchema.parse({ name: "Mesa", capacity: "4", restaurant_id: UUID, qr_token: "FORJADO", status: "OCCUPIED" } as any);
    expect(Object.keys(r).sort()).toEqual(["capacity", "name"]);
  });

  it("fieldErrorsOf: só a primeira mensagem por campo", () => {
    const r = tableFormSchema.safeParse({ name: "", capacity: "abc" });
    expect(r.success).toBe(false);
    const errs = fieldErrorsOf((r as any).error);
    expect(Object.keys(errs).sort()).toEqual(["capacity", "name"]);
  });

  it("entityIdSchema/slugSchema", () => {
    expect(entityIdSchema.safeParse(UUID).success).toBe(true);
    for (const bad of ["", "abc", "1 or 1=1", `${UUID}x`, "00000000-0000-0000-0000-00000000000g"]) expect(entityIdSchema.safeParse(bad).success, bad).toBe(false);
    expect(slugSchema.safeParse("demo-a").success).toBe(true);
    expect(slugSchema.safeParse("   ").success).toBe(false);
    expect(slugSchema.safeParse("x".repeat(64)).success).toBe(false);
  });

  it("parseTabFilters: valores inválidos são ignorados (nunca lançam); arrays pegam o primeiro; datas impossíveis caem", () => {
    expect(parseTabFilters({})).toEqual(EMPTY_FILTERS);
    expect(parseTabFilters({ status: "OPEN", from: "2026-01-01", to: "2026-01-31", table: UUID })).toEqual({ status: "OPEN", from: "2026-01-01", to: "2026-01-31", table: UUID });
    expect(parseTabFilters({ status: ["CLOSED", "OPEN"], table: "none" })).toMatchObject({ status: "CLOSED", table: "none" });
    expect(parseTabFilters({ status: "DROP", from: "ontem", to: "2026-13-45", table: "1 or 1=1" })).toEqual(EMPTY_FILTERS);
    expect(parseTabFilters({ status: "open" }).status).toBe("ALL"); // diferencia maiúsculas
    expect(parseTabFilters({ from: "2026-01-01T00:00:00Z" }).from).toBeNull();
  });

  // F-40: Date aceita 30/02 (vira 02/03), então o filtro passa e o Postgres recusa "2026-02-30T00:00:00-03:00" (22008): a lista
  // mostra a mensagem de erro de carregamento em vez de ignorar o parâmetro inválido.
  it.fails("[F-40] datas impossíveis do calendário (30/02, 31/04) são ignoradas como as demais entradas inválidas", () => {
    for (const d of ["2026-02-30", "2026-02-31", "2026-04-31", "2026-06-31"]) {
      expect(parseTabFilters({ from: d }).from, d).toBeNull();
      expect(parseTabFilters({ to: d }).to, d).toBeNull();
    }
  });

  it("filtersToQuery: omite padrões, inclui extras não vazios e faz ida e volta com parseTabFilters", () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe("");
    const f = { status: "CLOSED" as const, from: "2026-01-01", to: "2026-01-31", table: UUID };
    const q = filtersToQuery(f, { cursor: "abc", vazio: null });
    expect(q).toContain("status=CLOSED");
    expect(q).toContain("cursor=abc");
    expect(q).not.toContain("vazio");
    const back = parseTabFilters(Object.fromEntries(new URLSearchParams(filtersToQuery(f))));
    expect(back).toEqual(f);
    // valores hostis são codificados
    expect(filtersToQuery({ ...EMPTY_FILTERS, table: "none" }, { cursor: "a&b=c" })).toBe("table=none&cursor=a%26b%3Dc");
  });
});

// ---------------------------------------------------------------------------
describe("tables-admin/format", () => {
  it("formatMoney (pt-BR, BRL)", () => {
    expect(nb(formatMoney(0))).toBe("R$ 0,00");
    expect(nb(formatMoney(123456))).toBe("R$ 1.234,56");
    expect(nb(formatMoney(5))).toBe("R$ 0,05");
  });

  it("formatDuration: agora / min / h / d; data inválida => vazio", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(formatDuration(ago(0), now)).toBe("agora");
    expect(formatDuration(ago(5), now)).toBe("5 min");
    expect(formatDuration(ago(120), now)).toBe("2 h");
    expect(formatDuration(ago(130), now)).toBe("2 h 10 min");
    expect(formatDuration(ago(60 * 24 * 3 + 5), now)).toBe("3 d");
    expect(formatDuration("lixo", now)).toBe("");
    expect(formatDuration(new Date(now + 3_600_000).toISOString(), now)).toBe("agora");
  });

  it("tabShortCode: 6 caracteres hex maiúsculos do id", () => {
    expect(tabShortCode("a1b2c3d4-0000-4000-8000-000000000000")).toBe("A1B2C3");
    expect(tabShortCode(UUID)).toBe("111111");
  });

  it("rótulos e tons cobrem todos os estados (mesa, comanda, pedido)", () => {
    for (const s of ["AVAILABLE", "OCCUPIED", "CLEANING", "INACTIVE"] as const) {
      expect(TABLE_STATUS_LABELS[s]).toBeTruthy();
      expect(TABLE_STATUS_TONES[s]).toBeTruthy();
    }
    for (const s of ["OPEN", "CLOSED", "CANCELLED"] as const) {
      expect(TAB_STATUS_LABELS[s]).toBeTruthy();
      expect(TAB_STATUS_TONES[s]).toBeTruthy();
    }
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual(["CANCELLED", "COMPLETED", "CONFIRMED", "OUT_FOR_DELIVERY", "PREPARING", "READY", "RECEIVED", "REJECTED"]);
  });

  it("orderStatusLabel não confunde chaves herdadas de Object.prototype com estados (lição do F-19)", () => {
    expect(orderStatusLabel("READY")).toBe("Pronto");
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(orderStatusLabel(k), k).toBe(k);
    expect(orderStatusLabel("")).toBe("");
  });

  it("paymentMethodLabel: formas conhecidas; desconhecida vira 'Outro'; chaves herdadas também", () => {
    expect(paymentMethodLabel("PIX")).toBe("Pix");
    expect(paymentMethodLabel("CASH")).toBe("Dinheiro");
    expect(paymentMethodLabel("BITCOIN")).toBe("Outro");
  });

  // F-19 (mesma classe): PAYMENT_METHOD_LABELS[method] ?? "Outro" devolve uma FUNÇÃO para "constructor"/"toString".
  it.fails("[F-39] paymentMethodLabel('constructor'/'toString'/'__proto__') devolve texto, não função herdada de Object.prototype", () => {
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(typeof paymentMethodLabel(k), k).toBe("string");
  });

  it("capacityLabel", () => {
    expect(capacityLabel(null)).toMatch(/não informada/i);
    expect(capacityLabel(1)).toBe("1 lugar");
    expect(capacityLabel(4)).toBe("4 lugares");
  });
});
