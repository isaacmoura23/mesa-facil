import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintDocument } from "../../src/components/printing/print-document";
import { printPayloadSchema, type PrintPayload } from "../../src/modules/printing/types";

const base = {
  restaurant_name: "Qi Buxo",
  order_number: 7,
  fulfillment_type: "PICKUP",
  created_at_local: "01/11/2026 16:38",
  table_label: "Balcão",
  items: [{ name: "Bolo Trufado", variant_name: "8 fatias", quantity: 1, line_total_cents: 3500, modifiers: [] }],
  customer_name: "Maria da Silva",
  customer_phone: "85994084103",
  public_code: "ABC123XYZ",
  estimated_ready_at_local: "01/11/2026 17:08",
  confirmed_at_local: "01/11/2026 16:38",
  subtotal_cents: 3500,
  delivery_fee_cents: 0,
  discount_cents: 0,
  total_cents: 3500,
  payment_status: "PAID",
  payments: [{ method: "CASH", amount_cents: 3500, tendered_cents: 5000, change_cents: 1500, paid_at_local: "01/11/2026 16:38" }],
};
const render = (type: PrintPayload["document_type"], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PrintDocument, { payload: printPayloadSchema.parse({ ...base, document_type: type, ...extra }), width: "80" }));

describe("comanda completa (impressão)", () => {
  it("mostra cliente, telefone, código, prazo, itens, total, pagamento recebido, troco e hora do aceite", () => {
    const out = render("ORDER_FULL");
    for (const text of [
      "Comanda completa", "PEDIDO #7", "Maria da Silva", "(85) 99408-4103", "ABC123XYZ", "Prazo esperado", "01/11/2026 17:08",
      "Bolo Trufado", "8 fatias", "R$", "TOTAL", "Pagamento recebido", "Dinheiro", "Valor recebido", "Troco", "Pedido aceito em 01/11/2026 16:38",
    ]) {
      expect(out, text).toContain(text);
    }
    expect(out).toMatch(/50,00/);
    expect(out).toMatch(/15,00/);
    expect(out).not.toContain("Comanda de preparo, sem preços");
    expect(out).not.toContain("Pagamento declarado");
  });

  it("sem pagamento registrado, mostra o declarado e a situação, sem inventar troco", () => {
    const out = render("ORDER_FULL", { payments: [], payment_status: "UNPAID", payment_method: "PIX" });
    expect(out).toContain("Pagamento declarado");
    expect(out).not.toContain("Pagamento recebido");
    expect(out).not.toContain("Valor recebido");
  });

  it("a comanda de preparo continua sem preço, telefone, código e pagamento", () => {
    const out = render("KITCHEN_TICKET", { customer_first_name: "Maria" });
    expect(out).toContain("Comanda de preparo, sem preços");
    for (const text of ["(85) 99408-4103", "ABC123XYZ", "Prazo esperado", "Pagamento recebido", "TOTAL", "Maria da Silva"]) {
      expect(out, text).not.toContain(text);
    }
  });

  it("payloads antigos (sem os campos novos) continuam válidos", () => {
    const old = printPayloadSchema.parse({ document_type: "ORDER_RECEIPT", restaurant_name: "X", order_number: 1, fulfillment_type: "PICKUP", items: [] });
    expect(old.payments).toEqual([]);
  });
});
