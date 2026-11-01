import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OperationsOrder } from "../../src/modules/operations/types";
import type { OrderAction } from "../../src/modules/operations/use-order-actions";

// O botão de impressão usa o cliente do Supabase; aqui só interessa o cartão.
vi.mock("../../src/components/operations/print-button", () => ({ PrintButton: () => null }));

const { KitchenCard } = await import("../../src/components/kitchen/kitchen-card");

const order = {
  id: "o1", order_number: 6, status: "CONFIRMED", fulfillment_type: "PICKUP", table_label: "Balcão",
  created_at: "2026-10-31T20:23:00.000Z", customer_name: null, notes: null, order_items: [], payment_status: "PAID",
} as unknown as OperationsOrder;
const advance = { kind: "advance", to: "PREPARING", label: "Iniciar preparo", needsReason: false } as unknown as OrderAction;
const cancel = { kind: "cancel", to: "CANCELLED", label: "Cancelar pedido", needsReason: true } as unknown as OrderAction;

const html = (cancelAction: OrderAction | null) =>
  renderToStaticMarkup(
    createElement(KitchenCard, { order, now: Date.now(), action: advance, cancelAction, busy: false, canPrint: true, idleHint: null, unseen: false, onAction: () => undefined }),
  );

describe("cartão da cozinha: Cancelar preparo", () => {
  it("mostra 'Iniciar preparo' e 'Cancelar preparo' quando a pessoa pode cancelar", () => {
    const out = html(cancel);
    expect(out).toContain("Iniciar preparo");
    expect(out).toContain("Cancelar preparo");
  });

  it("sem permissão de cancelar, o botão não existe", () => {
    const out = html(null);
    expect(out).toContain("Iniciar preparo");
    expect(out).not.toContain("Cancelar preparo");
  });
});
