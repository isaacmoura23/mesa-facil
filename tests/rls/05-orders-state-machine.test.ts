/**
 * Máquina de estados de pedidos + congelamento de colunas para clientes diretos:
 *  - caixa aceita/recusa (com motivo); cozinha só PREPARING/READY; gerente cancela (com motivo);
 *  - garçom/dono não operam; transição inválida e cancelamento/recusa sem motivo são rejeitados;
 *  - totais, payment_status, cliente, endereço, marcos de tempo e identidade não são editáveis.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makePayment, orderRow } from "../helpers/factory";

const A = () => world().restaurants.a;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

const update = (who: Parameters<typeof as>[0], id: string, patch: Record<string, unknown>) =>
  as(who).from("orders").update(patch).eq("id", id).select("id,status,status_reason");

describe("caixa (orders.accept / orders.reject / orders.update_status)", () => {
  it("aceita RECEIVED -> CONFIRMED: marco confirmed_at do servidor + histórico com o autor", async () => {
    const o = await makeOrder(cleanup, A().id);
    const res = await update("cashierA", o.id, { status: "CONFIRMED" });
    expectOk(res);
    expect(rows(res)).toHaveLength(1);
    const row = await orderRow(o.id);
    expect(row.status).toBe("CONFIRMED");
    expect(row.confirmed_at).not.toBeNull();
    const hist = await admin().from("order_status_history").select("from_status,to_status,changed_by").eq("order_id", o.id).order("id");
    expect(hist.data).toEqual([
      { from_status: null, to_status: "RECEIVED", changed_by: null },
      { from_status: "RECEIVED", to_status: "CONFIRMED", changed_by: world().users.cashierA.id },
    ]);
  });

  it("recusa com motivo: persiste motivo e rejected_at", async () => {
    const o = await makeOrder(cleanup, A().id);
    expectOk(await update("cashierA", o.id, { status: "REJECTED", status_reason: "Sem estoque de carne" }));
    const row = await orderRow(o.id);
    expect(row).toMatchObject({ status: "REJECTED", status_reason: "Sem estoque de carne" });
    expect(row.rejected_at).not.toBeNull();
  });

  it("recusa sem motivo (ausente, vazio ou só espaços) é rejeitada e o pedido continua RECEIVED", async () => {
    const o = await makeOrder(cleanup, A().id);
    for (const patch of [{ status: "REJECTED" }, { status: "REJECTED", status_reason: "" }, { status: "REJECTED", status_reason: "   " }]) {
      expectRule(await update("cashierA", o.id, patch), /REASON_REQUIRED/);
    }
    expect((await orderRow(o.id)).status).toBe("RECEIVED");
  });

  it("caixa não cancela (orders.cancel é do gerente), mesmo com motivo", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "CONFIRMED" });
    expectRule(await update("cashierA", o.id, { status: "CANCELLED", status_reason: "cliente desistiu" }), /FORBIDDEN/);
    expect((await orderRow(o.id)).status).toBe("CONFIRMED");
  });

  it("caixa conduz CONFIRMED -> PREPARING -> READY -> COMPLETED (retirada)", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "CONFIRMED", fulfillment: "PICKUP" });
    for (const next of ["PREPARING", "READY", "COMPLETED"]) expectOk(await update("cashierA", o.id, { status: next }));
    const row = await orderRow(o.id);
    expect(row.status).toBe("COMPLETED");
    expect(row.completed_at).not.toBeNull();
  });
});

describe("cozinha (orders.update_status apenas): PREPARING / READY, nada além", () => {
  it("CONFIRMED -> PREPARING -> READY é permitido", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "CONFIRMED" });
    expectOk(await update("kitchenA", o.id, { status: "PREPARING" }));
    expectOk(await update("kitchenA", o.id, { status: "READY" }));
    expect((await orderRow(o.id)).status).toBe("READY");
  });

  it("não aceita, não recusa, não cancela e não pula etapas", async () => {
    const received = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectRule(await update("kitchenA", received.id, { status: "CONFIRMED" }), /FORBIDDEN/);
    expectRule(await update("kitchenA", received.id, { status: "REJECTED", status_reason: "cozinha recusou" }), /FORBIDDEN/);
    expectRule(await update("kitchenA", received.id, { status: "CANCELLED", status_reason: "cozinha cancelou" }), /FORBIDDEN/);
    expectRule(await update("kitchenA", received.id, { status: "PREPARING" }), /ORDER_INVALID_TRANSITION/);
    expect((await orderRow(received.id)).status).toBe("RECEIVED");

    const preparing = await makeOrder(cleanup, A().id, { status: "PREPARING" });
    expectRule(await update("kitchenA", preparing.id, { status: "CANCELLED", status_reason: "x" }), /FORBIDDEN/);
    expect((await orderRow(preparing.id)).status).toBe("PREPARING");
  });
});

describe("gerente cancela; garçom não opera", () => {
  it("gerente cancela com motivo (cancelled_at do servidor) e é obrigado a informar o motivo", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "PREPARING" });
    for (const patch of [{ status: "CANCELLED" }, { status: "CANCELLED", status_reason: " " }]) {
      expectRule(await update("managerA", o.id, patch), /REASON_REQUIRED/);
    }
    expect((await orderRow(o.id)).status).toBe("PREPARING");
    expectOk(await update("managerA", o.id, { status: "CANCELLED", status_reason: "Cliente desistiu" }));
    const row = await orderRow(o.id);
    expect(row).toMatchObject({ status: "CANCELLED", status_reason: "Cliente desistiu" });
    expect(row.cancelled_at).not.toBeNull();
  });

  it("garçom (só orders.view/create) não altera status: 0 linhas e dado inalterado", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    for (const patch of [{ status: "CONFIRMED" }, { status: "REJECTED", status_reason: "x" }, { status: "CANCELLED", status_reason: "x" }]) {
      expectNotApplied(await update("waiterA", o.id, patch));
    }
    expect((await orderRow(o.id)).status).toBe("RECEIVED");
  });
});

describe("transições inválidas são rejeitadas (inclusive para quem tem todas as permissões)", () => {
  const invalid: Array<[string, string, string]> = [
    ["PICKUP", "RECEIVED", "READY"],
    ["PICKUP", "RECEIVED", "PREPARING"],
    ["PICKUP", "RECEIVED", "COMPLETED"],
    ["PICKUP", "CONFIRMED", "READY"],
    ["PICKUP", "CONFIRMED", "COMPLETED"],
    ["PICKUP", "PREPARING", "COMPLETED"],
    ["PICKUP", "PREPARING", "CONFIRMED"],
    ["PICKUP", "READY", "PREPARING"],
    ["PICKUP", "READY", "OUT_FOR_DELIVERY"],
    ["DELIVERY", "READY", "COMPLETED"],
    ["DELIVERY", "OUT_FOR_DELIVERY", "READY"],
    ["DINE_IN", "READY", "OUT_FOR_DELIVERY"],
    ["PICKUP", "COMPLETED", "PREPARING"],
    ["PICKUP", "COMPLETED", "CANCELLED"],
    ["PICKUP", "CANCELLED", "RECEIVED"],
    ["PICKUP", "CANCELLED", "CONFIRMED"],
    ["PICKUP", "REJECTED", "CONFIRMED"],
    ["PICKUP", "REJECTED", "CANCELLED"],
  ];
  for (const [type, from, to] of invalid) {
    it(`${type}: ${from} -> ${to} é ORDER_INVALID_TRANSITION`, async () => {
      const o = await makeOrder(cleanup, A().id, { status: from, fulfillment: type as "PICKUP" });
      const needsReason = to === "CANCELLED" || to === "REJECTED";
      const patch = needsReason ? { status: to, status_reason: "motivo válido" } : { status: to };
      const res = await update("managerA", o.id, patch);
      expectRule(res, /ORDER_INVALID_TRANSITION/);
      // se o INSERT direto do estado terminal exigia motivo, o seed não o criou: confirma o estado real
      expect((await orderRow(o.id)).status).toBe(from);
    });
  }

  it("fluxo de entrega completo: READY -> OUT_FOR_DELIVERY -> COMPLETED, com histórico ordenado", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED", fulfillment: "DELIVERY" });
    expectOk(await update("cashierA", o.id, { status: "CONFIRMED" }));
    expectOk(await update("kitchenA", o.id, { status: "PREPARING" }));
    expectOk(await update("kitchenA", o.id, { status: "READY" }));
    expectOk(await update("cashierA", o.id, { status: "OUT_FOR_DELIVERY" }));
    expectOk(await update("cashierA", o.id, { status: "COMPLETED" }));
    const hist = await admin().from("order_status_history").select("to_status").eq("order_id", o.id).order("id");
    expect(rows(hist).map((h) => h.to_status)).toEqual(["RECEIVED", "CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"]);
  });

  it("mesmo o service role não pula estados nem altera a identidade do pedido", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectRule(await admin().from("orders").update({ status: "COMPLETED" }).eq("id", o.id), /ORDER_INVALID_TRANSITION/);
    expectRule(await admin().from("orders").update({ order_number: 999999 }).eq("id", o.id), /IMMUTABLE_FIELD/);
    expectRule(await admin().from("orders").update({ fulfillment_type: "DELIVERY" }).eq("id", o.id), /IMMUTABLE_FIELD/);
    expectRule(await admin().from("orders").update({ public_code: "FORJADO" }).eq("id", o.id), /IMMUTABLE_FIELD/);
    expect((await orderRow(o.id)).status).toBe("RECEIVED");
  });

  it("decisões concorrentes (caixa aceita x gerente recusa): exatamente uma vence e o estado final é coerente", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    const [accept, reject] = await Promise.all([
      update("cashierA", o.id, { status: "CONFIRMED" }),
      update("managerA", o.id, { status: "REJECTED", status_reason: "corrida" }),
    ]);
    const outcomes = [accept.error ? "err" : "ok", reject.error ? "err" : "ok"].sort();
    expect(outcomes).toEqual(["err", "ok"]);
    const row = await orderRow(o.id);
    expect(row.status).toBe(accept.error ? "REJECTED" : "CONFIRMED");
    const losing = accept.error ?? reject.error;
    expect(losing!.message).toMatch(/ORDER_INVALID_TRANSITION/);
  });
});

describe("colunas congeladas para clientes diretos (totais, pagamento, cliente, identidade, marcos)", () => {
  // Qualquer coluna fora do GRANT (status, status_reason, estimated_ready_at) falha com 42501.
  const frozen: Array<[string, unknown]> = [
    ["total_cents", 1],
    ["subtotal_cents", 1],
    ["discount_cents", 2999],
    ["delivery_fee_cents", 0],
    ["payment_status", "PAID"],
    ["customer_name", "FORJADO"],
    ["customer_phone", "11000000000"],
    ["customer_email", "forjado@example.test"],
    ["delivery_address", { street: "forjada" }],
    ["notes", "forjado"],
    ["table_id", null],
    ["tab_id", null],
    ["table_label", "FORJADA"],
    ["customer_id", null],
    ["restaurant_id", "00000000-0000-4000-8000-0000000000b1"],
    ["order_number", 1],
    ["public_code", "FORJADO000000000"],
    ["idempotency_key", "zz-forjada-12345"],
    ["fulfillment_type", "DELIVERY"],
    ["source", "PUBLIC_WEB"],
    ["created_by", "00000000-0000-4000-8000-00000000dead"],
    ["created_at", "2020-01-01T00:00:00Z"],
    ["updated_at", "2020-01-01T00:00:00Z"],
    ["confirmed_at", "2020-01-01T00:00:00Z"],
    ["completed_at", "2020-01-01T00:00:00Z"],
    ["cancelled_at", "2020-01-01T00:00:00Z"],
    ["rejected_at", "2020-01-01T00:00:00Z"],
    ["id", "00000000-0000-4000-8000-00000000dead"],
  ];

  for (const [col, val] of frozen) {
    it(`caixa não altera orders.${col}`, async () => {
      const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
      const before = await orderRow(o.id);
      const res = await update("cashierA", o.id, { [col]: val });
      expectDenied(res, /42501|permission denied/);
      expect(await orderRow(o.id)).toEqual(before);
    });
  }

  it("misturar coluna livre (status) com coluna congelada (total) derruba a operação inteira", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    const before = await orderRow(o.id);
    expectDenied(await update("cashierA", o.id, { status: "CONFIRMED", total_cents: 1, subtotal_cents: 1 }), /42501|permission denied/);
    expectDenied(await update("managerA", o.id, { status: "CONFIRMED", payment_status: "PAID" }), /42501|permission denied/);
    expect(await orderRow(o.id)).toEqual(before);
  });

  it("status_reason só muda junto com o status (sem status => FORBIDDEN_FIELD); previsão (estimated_ready_at) é livre", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectRule(await update("cashierA", o.id, { status_reason: "texto solto" }), /FORBIDDEN_FIELD/);
    expect((await orderRow(o.id)).status_reason).toBeNull();

    const eta = new Date(Date.now() + 20 * 60_000).toISOString();
    expectOk(await update("cashierA", o.id, { estimated_ready_at: eta }));
    expect(new Date((await orderRow(o.id)).estimated_ready_at).getTime()).toBe(new Date(eta).getTime());
  });

  it("payment_status é derivado dos pagamentos (service role/webhook), nunca de cliente", async () => {
    const o = await makeOrder(cleanup, A().id, { status: "CONFIRMED", totalCents: 5000 });
    expect((await orderRow(o.id)).payment_status).toBe("UNPAID");
    const p1 = await makePayment(cleanup, A().id, { orderId: o.id }, { amount: 2000, status: "PAID" });
    expectOk(p1);
    expect((await orderRow(o.id)).payment_status).toBe("PENDING"); // parcial
    const p2 = await makePayment(cleanup, A().id, { orderId: o.id }, { amount: 3000, status: "PAID" });
    expectOk(p2);
    expect((await orderRow(o.id)).payment_status).toBe("PAID");
    // cliente tentando desfazer
    expectDenied(await update("managerA", o.id, { payment_status: "UNPAID" }), /42501|permission denied/);
    expect((await orderRow(o.id)).payment_status).toBe("PAID");
  });

  it("ninguém (nem gerente) apaga pedido, item ou histórico; histórico e contador não são graváveis", async () => {
    const o = await makeOrder(cleanup, A().id);
    expectDenied(await as("managerA").from("orders").delete().eq("id", o.id).select("id"));
    expectDenied(await as("managerA").from("order_items").delete().eq("order_id", o.id).select("id"));
    expectDenied(await as("managerA").from("order_status_history").delete().eq("order_id", o.id).select("id"));
    expectDenied(await as("managerA").from("order_status_history").update({ to_status: "COMPLETED" }).eq("order_id", o.id).select("id"));
    expectDenied(await as("managerA").from("order_counters").select("*"));
    expectDenied(await as("managerA").from("order_counters").update({ last_number: 0 }).eq("restaurant_id", A().id).select("*"));
    expect(rows(await admin().from("orders").select("id").eq("id", o.id))).toHaveLength(1);
  });
});
