import { describe, expect, it } from "vitest";
import { buildCsv, fetchHistoryPage, paymentSummary, DEFAULT_HISTORY_FILTERS, type HistoryRow } from "../../src/components/history/history-model";

const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  id: "o1", order_number: 7, fulfillment_type: "PICKUP", status: "COMPLETED", payment_status: "PAID",
  payment_method_intent: "PIX", table_label: null, total_cents: 3500, created_at: "2026-11-01T20:00:00.000Z", ...over,
});

describe("histórico: forma declarada x recebida", () => {
  it("sem pagamento recebido, mostra só o que o cliente declarou", () => {
    expect(paymentSummary(row())).toEqual({ declared: "Pix", received: null, differs: false });
  });
  it("recebido igual ao declarado não é divergência", () => {
    expect(paymentSummary(row({ paid_methods: ["PIX"] }))).toEqual({ declared: "Pix", received: "Pix", differs: false });
  });
  it("declarou Pix e pagou em dinheiro: aponta a divergência", () => {
    expect(paymentSummary(row({ paid_methods: ["CASH"] }))).toEqual({ declared: "Pix", received: "Dinheiro", differs: true });
  });
  it("'Cartão' declarado cobre crédito e débito", () => {
    expect(paymentSummary(row({ payment_method_intent: "CARD", paid_methods: ["DEBIT"] })).differs).toBe(false);
    expect(paymentSummary(row({ payment_method_intent: "CARD", paid_methods: ["CASH"] })).differs).toBe(true);
  });
  it("pagamento dividido junta as formas", () => {
    expect(paymentSummary(row({ paid_methods: ["CASH", "PIX"] })).received).toBe("Dinheiro + Pix");
  });
  it("o CSV ganha a coluna 'recebida'", () => {
    const csv = buildCsv([row({ paid_methods: ["CASH"] })]);
    expect(csv).toContain("Forma de pagamento recebida");
    expect(csv).toContain(";Pix;Dinheiro");
  });

  it("busca a página e junta os pagamentos PAID; sem acesso (erro), segue só com o declarado", async () => {
    const orders = [{ id: "o1", order_number: 7, fulfillment_type: "PICKUP", status: "COMPLETED", payment_status: "PAID", payment_method_intent: "PIX", table_label: null, total_cents: 3500, created_at: "2026-11-01T20:00:00.000Z" }];
    const make = (payErr: boolean) => ({
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        for (const n of ["select", "eq", "gte", "lte", "order", "limit", "or", "in"]) q[n] = () => q;
        const result = table === "orders"
          ? { data: orders, error: null }
          : payErr ? { data: null, error: { message: "negado" } } : { data: [{ order_id: "o1", method: "CASH" }, { order_id: "o1", method: "CASH" }], error: null };
        q.then = (resolve: (v: unknown) => void) => resolve(result);
        return q;
      },
    }) as unknown as Parameters<typeof fetchHistoryPage>[0];
    const [ok] = await fetchHistoryPage(make(false), "r", DEFAULT_HISTORY_FILTERS, null);
    expect(ok.paid_methods).toEqual(["CASH"]);
    const [semAcesso] = await fetchHistoryPage(make(true), "r", DEFAULT_HISTORY_FILTERS, null);
    expect(semAcesso.paid_methods).toBeUndefined();
  });
});
