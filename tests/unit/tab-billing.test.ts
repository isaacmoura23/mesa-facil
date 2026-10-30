/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 4, painel de cobrança: src/modules/tab-billing/{money,errors,types}. Módulos puros (zod); sem rede nem React.
 * Bugs confirmados usam `it.fails` com o código F-xx (F-37/F-38 corrigidos na Fase 8: viraram `it`).
 */
import { describe, expect, it } from "vitest";
import { BillingActionError, parseBillingError } from "../../src/modules/tab-billing/errors";
import { centsToInput, parseMoneyToCents } from "../../src/modules/tab-billing/money";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  TERMINAL_ORDER_STATUSES,
  UNPAID_REASON_MAX,
  UNPAID_REASON_MIN,
  VOID_ORDER_STATUSES,
  cancelTabResultSchema,
  closeTabResultSchema,
  paymentMethodLabel,
  recordPaymentResultSchema,
  tabBalanceSchema,
} from "../../src/modules/tab-billing/types";

describe("tab-billing/money: parseMoneyToCents", () => {
  const valid: Array<[string, number]> = [
    ["12", 1200],
    ["0", 0],
    ["0,5", 50],
    ["0,05", 5],
    ["12,5", 1250],
    ["12,50", 1250],
    ["12.5", 1250],
    ["12.50", 1250],
    ["1.234,50", 123450],
    ["1.234.567,89", 123456789],
    ["R$ 5", 500],
    ["r$5,99", 599],
    ["  7,00  ", 700],
    ["999999999,99", 99999999999],
  ];
  for (const [input, cents] of valid) {
    it(`"${input}" => ${cents}`, () => expect(parseMoneyToCents(input)).toBe(cents));
  }

  const invalid = ["", "   ", "abc", "-5", "+5", "1e5", "12,345", "0,001", "1.234", ",50", "12,", "12.", "1,234.50", "1 000,50", "R$", "1000000000", "NaN", "Infinity", "12,5,0", "0x10", "٣"];
  for (const input of invalid) {
    it(`"${input}" => null`, () => expect(parseMoneyToCents(input)).toBeNull());
  }

  it("nunca devolve valor fracionário, negativo ou NaN para qualquer entrada válida", () => {
    for (const [input] of valid) {
      const v = parseMoneyToCents(input)!;
      expect(Number.isInteger(v) && v >= 0).toBe(true);
    }
  });

  it("não usa ponto flutuante (0,07 e 1,15 não viram 6 / 114 centavos)", () => {
    expect(parseMoneyToCents("0,07")).toBe(7);
    expect(parseMoneyToCents("1,15")).toBe(115);
    expect(parseMoneyToCents("19,99")).toBe(1999);
  });

  // F-37: com vírgula, TODOS os pontos são descartados sem validar o agrupamento de milhar.
  it("[F-37] agrupamento de milhar inválido com vírgula deve ser rejeitado ('1.2,50' vira R$ 12,50; '12.50,3' vira R$ 1.250,30)", () => {
    expect(parseMoneyToCents("1.2,50")).toBeNull();
    expect(parseMoneyToCents("12.50,3")).toBeNull();
    expect(parseMoneyToCents("1.23,45")).toBeNull();
  });
});

describe("tab-billing/money: centsToInput", () => {
  it("formata centavos como texto editável com vírgula", () => {
    expect(centsToInput(0)).toBe("0,00");
    expect(centsToInput(5)).toBe("0,05");
    expect(centsToInput(1250)).toBe("12,50");
    expect(centsToInput(123456)).toBe("1234,56");
  });
  it("valores negativos viram 0 e fracionários são truncados", () => {
    expect(centsToInput(-100)).toBe("0,00");
    expect(centsToInput(99.9)).toBe("0,99");
  });
  it("é inverso de parseMoneyToCents para qualquer inteiro não negativo", () => {
    for (const c of [0, 1, 9, 10, 99, 100, 101, 1999, 100000, 99999999]) expect(parseMoneyToCents(centsToInput(c))).toBe(c);
  });
});

describe("tab-billing/errors: parseBillingError", () => {
  // Códigos que as RPCs de comanda/pagamento realmente levantam (migs. 0119/0120) e que a UI de cobrança precisa explicar.
  const CONTRACT_CODES = [
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "TAB_NOT_FOUND",
    "TAB_NOT_OPEN",
    "TAB_HAS_OPEN_ORDERS",
    "TAB_UNPAID",
    "INVALID_UNPAID_REASON",
    "REASON_REQUIRED",
    "TAB_HAS_ORDERS",
    "TAB_HAS_PAYMENTS",
    "INVALID_TARGET",
    "INVALID_METHOD",
    "INVALID_AMOUNT",
    "INVALID_TENDERED",
    "INVALID_REFERENCE",
    "ORDER_NOT_PAYABLE",
    "OVERPAYMENT",
    "IDEMPOTENCY_CONFLICT",
  ];
  for (const code of CONTRACT_CODES) {
    it(`${code}: mensagem em PT-BR, sem vazar o texto do banco`, () => {
      const r = parseBillingError({ message: `${code}: texto interno do banco com detalhes sensíveis` });
      expect(r.code).toBe(code);
      expect(r.message).not.toMatch(/banco|sensíveis|[A-Z_]{6,}:/);
      expect(r.message.length).toBeGreaterThan(10);
    });
  }

  it("flag stale: só quando o estado mudou por outro caminho (saldo, comanda, pedido)", () => {
    for (const c of ["TAB_NOT_OPEN", "OVERPAYMENT", "TAB_HAS_OPEN_ORDERS", "TAB_UNPAID", "TAB_HAS_ORDERS", "TAB_HAS_PAYMENTS", "IDEMPOTENCY_CONFLICT", "ORDER_NOT_PAYABLE", "TAB_NOT_FOUND"]) {
      expect(parseBillingError({ message: `${c}: x` }).stale, c).toBe(true);
    }
    for (const c of ["FORBIDDEN", "UNAUTHENTICATED", "INVALID_AMOUNT", "INVALID_TENDERED", "INVALID_METHOD", "REASON_REQUIRED", "INVALID_UNPAID_REASON"]) {
      expect(parseBillingError({ message: `${c}: x` }).stale, c).toBe(false);
    }
  });

  it("42501 sem prefixo vira FORBIDDEN; mensagem sem código, vazia, nula ou código desconhecido viram UNKNOWN genérico (nunca o texto cru)", () => {
    expect(parseBillingError({ code: "42501", message: "permission denied for table payments" }).code).toBe("FORBIDDEN");
    for (const e of [null, undefined, {}, { message: "" }, { message: "falha de rede" }, { message: "fetch failed" }, { message: "XYZ_NAO_EXISTE: x" }, { message: "tab_not_found: minúsculo" }, { message: " TAB_NOT_OPEN: espaço antes" }]) {
      const r = parseBillingError(e as any);
      expect(r.code === "UNKNOWN" || r.code === "XYZ_NAO_EXISTE", JSON.stringify(e)).toBe(true);
      expect(r.stale).toBe(false);
      expect(r.message).toMatch(/conexão|tente novamente/i);
    }
  });

  it("BillingActionError carrega código, mensagem e stale", () => {
    const e = new BillingActionError(parseBillingError({ message: "OVERPAYMENT: x" }));
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BillingActionError");
    expect(e.code).toBe("OVERPAYMENT");
    expect(e.stale).toBe(true);
    expect(e.message).toMatch(/saldo restante/i);
  });

  // F-38: o banco levanta estes códigos mas a UI de cobrança só mostra o texto genérico "verifique a conexão".
  it("[F-38] ORDER_NOT_FOUND e RESTAURANT_UNAVAILABLE (levantados por record_payment/close_tab) têm mensagem própria", () => {
    for (const c of ["ORDER_NOT_FOUND", "RESTAURANT_UNAVAILABLE"]) expect(parseBillingError({ message: `${c}: x` }).code, c).toBe(c);
    expect(parseBillingError({ message: "ORDER_NOT_FOUND: x" }).message).not.toMatch(/conexão/i);
  });
});

describe("tab-billing/types", () => {
  it("formas de pagamento = enum do banco (CASH|PIX|CREDIT|DEBIT|VOUCHER|OTHER), todas com rótulo", () => {
    expect([...PAYMENT_METHODS]).toEqual(["CASH", "PIX", "CREDIT", "DEBIT", "VOUCHER", "OTHER"]);
    for (const m of PAYMENT_METHODS) expect(PAYMENT_METHOD_LABELS[m]).toBeTruthy();
    expect(paymentMethodLabel("PIX")).toBe("Pix");
    expect(paymentMethodLabel("CARD")).toBe("Cartão");
    expect(paymentMethodLabel("QUALQUER")).toBe("QUALQUER");
  });

  it("estados terminais/anulados batem com a regra do banco (close_tab/tab_totals)", () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(["CANCELLED", "COMPLETED", "REJECTED"]);
    expect([...VOID_ORDER_STATUSES].sort()).toEqual(["CANCELLED", "REJECTED"]);
    expect(UNPAID_REASON_MIN).toBe(10);
    expect(UNPAID_REASON_MAX).toBe(500);
  });

  const balance = {
    tab: { id: "t1", status: "OPEN", label: null, table_name: "Mesa 1", table_id: "x", guests: 2, unpaid_cents: 0, unpaid_reason: null, extra: "tolerado" },
    orders: [{ id: "o1", order_number: 7, status: "COMPLETED", total_cents: 2500, payment_status: "UNPAID", counts_toward_total: true }],
    consumed_cents: 2500,
    paid_cents: 1000,
    remaining_cents: 1500,
    overpaid_cents: 0,
    open_orders_count: 0,
    payments: [{ id: "p1", method: "PIX", amount_cents: 1000, tendered_cents: null, change_cents: null, status: "PAID", paid_at: "2026-01-01T10:00:00Z", tab_id: "t1", order_id: null, reference: "r1" }],
  };

  it("tabBalanceSchema aceita o formato de get_tab_balance (campos extras tolerados) e preserva os valores", () => {
    const parsed = tabBalanceSchema.safeParse(balance);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ consumed_cents: 2500, paid_cents: 1000, remaining_cents: 1500 });
    expect(parsed.data!.payments[0].reference).toBe("r1");
    expect((parsed.data!.tab as any).extra).toBe("tolerado");
  });

  it("tabBalanceSchema usa [] quando orders/payments faltam e rejeita valores não inteiros, ausentes ou do tipo errado", () => {
    const { orders: _o, payments: _p, ...bare } = balance;
    const ok = tabBalanceSchema.safeParse(bare);
    expect(ok.success).toBe(true);
    expect(ok.data!.orders).toEqual([]);
    expect(ok.data!.payments).toEqual([]);
    expect(tabBalanceSchema.safeParse({ ...balance, consumed_cents: 10.5 }).success).toBe(false);
    expect(tabBalanceSchema.safeParse({ ...balance, paid_cents: "100" }).success).toBe(false);
    expect(tabBalanceSchema.safeParse({ ...balance, remaining_cents: undefined }).success).toBe(false);
    expect(tabBalanceSchema.safeParse({ ...balance, tab: undefined }).success).toBe(false);
    expect(tabBalanceSchema.safeParse({ ...balance, payments: [{ id: "p", method: "PIX" }] }).success).toBe(false); // sem amount_cents
    expect(tabBalanceSchema.safeParse(null).success).toBe(false);
    expect(tabBalanceSchema.safeParse("ok").success).toBe(false);
  });

  it("resultados de record_payment/close_tab/cancel_tab: objetos tolerantes; null/array/string são rejeitados", () => {
    for (const s of [recordPaymentResultSchema, closeTabResultSchema, cancelTabResultSchema]) {
      expect(s.safeParse({ ok: true, qualquer: 1 }).success).toBe(true);
      expect(s.safeParse(null).success).toBe(false);
      expect(s.safeParse("ok").success).toBe(false);
    }
    expect(recordPaymentResultSchema.safeParse({ change_cents: 3.5 }).success).toBe(false);
    expect(recordPaymentResultSchema.safeParse({ change_cents: 300, remaining_cents: 0 }).success).toBe(true);
  });
});
