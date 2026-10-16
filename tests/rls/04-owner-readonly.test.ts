/**
 * O dono é MONITOR: lê pedidos/comandas/mesas/pagamentos, mas não opera. Nenhuma ação operacional
 * (aceitar, recusar, mudar status, cancelar, abrir/fechar comanda, pagamento, estado de mesa,
 * impressão, cadastro de cliente/pedido) passa — e o dado real fica inalterado.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makeTab, makeTable, orderRow, tabRow, tableRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

describe("dono lê (modo monitoramento)", () => {
  it("pedidos, itens, histórico, comandas, mesas, clientes, pagamentos, impressões e auditoria do próprio restaurante", async () => {
    const o = as("ownerA");
    const orders = await o.from("orders").select("id,status,restaurant_id,order_number");
    expectOk(orders);
    expect(rows(orders).map((r) => r.id).sort()).toEqual(expect.arrayContaining([...A().orderIds].sort()));
    expect(rows(orders).every((r) => r.restaurant_id === A().id)).toBe(true);

    for (const [table, min] of [
      ["order_items", 1],
      ["order_item_modifiers", 1],
      ["order_status_history", 1],
      ["tabs", 1],
      ["tab_status_history", 1],
      ["restaurant_tables", 6],
      ["customers", 1],
      ["customer_addresses", 1],
      ["payments", 1],
      ["audit_logs", 0],
    ] as const) {
      const res = await o.from(table).select("*");
      expectOk(res);
      expect(rows(res).length, table).toBeGreaterThanOrEqual(min);
    }
    const tab = await o.from("tabs").select("id,status").eq("id", A().tabId).single();
    expect(tab.data?.status).toBe("OPEN");
  });
});

describe("dono NÃO opera pedidos", () => {
  const attempts: Array<{ name: string; from: string; patch: Record<string, unknown> }> = [
    { name: "aceitar (RECEIVED -> CONFIRMED)", from: "RECEIVED", patch: { status: "CONFIRMED" } },
    { name: "recusar com motivo (RECEIVED -> REJECTED)", from: "RECEIVED", patch: { status: "REJECTED", status_reason: "sem estoque" } },
    { name: "iniciar preparo (CONFIRMED -> PREPARING)", from: "CONFIRMED", patch: { status: "PREPARING" } },
    { name: "marcar pronto (PREPARING -> READY)", from: "PREPARING", patch: { status: "READY" } },
    { name: "concluir (READY -> COMPLETED)", from: "READY", patch: { status: "COMPLETED" } },
    { name: "cancelar com motivo (CONFIRMED -> CANCELLED)", from: "CONFIRMED", patch: { status: "CANCELLED", status_reason: "dono cancelou" } },
    { name: "alterar previsão (estimated_ready_at)", from: "RECEIVED", patch: { estimated_ready_at: new Date(Date.now() + 600_000).toISOString() } },
  ];

  for (const a of attempts) {
    it(`${a.name}: 0 linhas afetadas e pedido inalterado`, async () => {
      const order = await makeOrder(cleanup, A().id, { status: a.from });
      const before = await orderRow(order.id);
      const res = await as("ownerA").from("orders").update(a.patch).eq("id", order.id).select("id");
      expectNotApplied(res);
      expect(await orderRow(order.id)).toEqual(before);
    });
  }

  it("atualização em massa de todos os pedidos de A também não afeta nada", async () => {
    const before = await admin().from("orders").select("id,status,status_reason").eq("restaurant_id", A().id).order("id");
    const res = await as("ownerA").from("orders").update({ status: "CANCELLED", status_reason: "mass" }).eq("restaurant_id", A().id).select("id");
    expectNotApplied(res);
    expect((await admin().from("orders").select("id,status,status_reason").eq("restaurant_id", A().id).order("id")).data).toEqual(before.data);
  });

  it("não cria pedidos, itens, histórico nem registra pagamento (sem policy/GRANT)", async () => {
    const o = as("ownerA");
    expectDenied(await o.from("orders").insert({ restaurant_id: A().id, fulfillment_type: "PICKUP", subtotal_cents: 100, total_cents: 100, idempotency_key: `zz-${uniq()}` }).select("id"));
    expectDenied(await o.from("order_items").insert({ restaurant_id: A().id, order_id: A().orderIds[0], product_name: "x", unit_price_cents: 1, quantity: 1, line_total_cents: 1 }).select("id"));
    expectDenied(
      await o
        .from("payments")
        .insert({ restaurant_id: A().id, order_id: A().orderIds[0], method: "CASH", amount_cents: 100, status: "PAID", paid_at: new Date().toISOString(), idempotency_key: `zz-${uniq()}` })
        .select("id"),
    );
    expectDenied(await o.from("payments").update({ status: "REFUNDED" }).eq("id", A().paymentId).select("id"));
    expectDenied(await o.from("payments").delete().eq("id", A().paymentId).select("id"));
    expect(rows(await admin().from("payments").select("id").eq("restaurant_id", A().id).like("idempotency_key", "zz-%"))).toHaveLength(0);
    expect((await admin().from("payments").select("status").eq("id", A().paymentId).single()).data?.status).toBe("PAID");
  });

  it("não cadastra cliente nem pede impressão (orders.create / print.request são operacionais)", async () => {
    expectDenied(await as("ownerA").from("customers").insert({ restaurant_id: A().id, name: `zz-${uniq()}` }).select("id"));
    expectNotApplied(await as("ownerA").from("customers").update({ name: "HACKED" }).eq("id", A().customerId).select("id"));
    expectDenied(
      await as("ownerA")
        .from("print_jobs")
        .insert({ restaurant_id: A().id, document_type: "KITCHEN_TICKET", order_id: A().orderIds[0], requested_by: world().users.ownerA.id, printer_target: "zz-x" })
        .select("id"),
    );
    expect((await admin().from("customers").select("name").eq("id", A().customerId).single()).data?.name).toMatch(/^DEMO/);
  });
});

describe("dono NÃO opera comandas", () => {
  it("não abre comanda (insert), nem fecha, cancela ou renomeia comanda existente", async () => {
    const table = await makeTable(cleanup, A().id);
    const tab = await makeTab(cleanup, A().id, { tableId: table.id, openedBy: world().users.cashierA.id });
    const before = await tabRow(tab.id);

    const free = await makeTable(cleanup, A().id);
    expectDenied(
      await as("ownerA")
        .from("tabs")
        .insert({ restaurant_id: A().id, table_id: free.id, status: "OPEN", total_cents: 0, opened_by: world().users.ownerA.id, label: `zz-${uniq()}` })
        .select("id"),
    );
    expect(rows(await admin().from("tabs").select("id").eq("table_id", free.id))).toHaveLength(0);

    for (const patch of [{ status: "CLOSED" }, { status: "CANCELLED", status_reason: "dono" }, { label: "zz-renomeada" }, { guests: 9 }]) {
      expectNotApplied(await as("ownerA").from("tabs").update(patch).eq("id", tab.id).select("id"));
    }
    expect(await tabRow(tab.id)).toEqual(before);
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");
  });
});

describe("dono NÃO muda o estado operacional das mesas", () => {
  // Fase 4 (mig. 0121/0120): o status da mesa só muda por set_table_status (e pelos triggers da comanda).
  // OCCUPIED/CLEANING nem são destinos aceitos (vêm só de open_tab/close_tab); CLEANING/OCCUPIED -> AVAILABLE exige tables.operate.
  const transitions: Array<[string, string, RegExp]> = [
    ["AVAILABLE", "OCCUPIED", /INVALID_TABLE_STATUS/],
    ["OCCUPIED", "CLEANING", /INVALID_TABLE_STATUS/],
    ["OCCUPIED", "AVAILABLE", /FORBIDDEN/],
    ["CLEANING", "AVAILABLE", /FORBIDDEN/],
    ["CLEANING", "OCCUPIED", /INVALID_TABLE_STATUS/],
  ];
  for (const [from, to, rule] of transitions) {
    it(`${from} -> ${to}: set_table_status recusa (${rule.source}) e a mesa fica inalterada; UPDATE direto também é negado`, async () => {
      const table = await makeTable(cleanup, A().id, { status: from });
      expectRule(await as("ownerA").rpc("set_table_status", { p_table: table.id, p_to: to }), rule);
      expectDenied(await as("ownerA").from("restaurant_tables").update({ status: to }).eq("id", table.id).select("id"), /42501|permission denied/i);
      expect((await tableRow(table.id)).status).toBe(from);
    });
  }

  it("cadastro (tables.manage) é do dono: cria e renomeia mesas; não apaga mesa ativa", async () => {
    const created = await as("ownerA").from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-dono-${uniq()}` }).select("id,name").single();
    expectOk(created);
    cleanup.add(async () => void (await admin().from("restaurant_tables").delete().eq("id", created.data!.id)));
    expectOk(await as("ownerA").from("restaurant_tables").update({ name: `zz-dono2-${uniq()}`, capacity: 8 }).eq("id", created.data!.id));
    expect(rows(await as("ownerA").from("restaurant_tables").delete().eq("id", created.data!.id).select("id"))).toHaveLength(0); // só INACTIVE pode ser apagada
    expect(rows(await admin().from("restaurant_tables").select("id").eq("id", created.data!.id))).toHaveLength(1);
  });

  it("[comportamento documentado, F-12] ativar/desativar (INACTIVE) é cadastro e fica com tables.manage, que o dono tem (via set_table_status)", async () => {
    const table = await makeTable(cleanup, A().id, { status: "AVAILABLE" });
    const off = await as("ownerA").rpc("set_table_status", { p_table: table.id, p_to: "INACTIVE" });
    expectOk(off);
    expect(off.data).toMatchObject({ ok: true, unchanged: false, table: { status: "INACTIVE" } });
    expect((await tableRow(table.id)).status).toBe("INACTIVE");
    const on = await as("ownerA").rpc("set_table_status", { p_table: table.id, p_to: "AVAILABLE" });
    expectOk(on);
    expect((await tableRow(table.id)).status).toBe("AVAILABLE");
    // o caminho direto (UPDATE de status) deixou de existir para todos os clientes
    expectDenied(await as("ownerA").from("restaurant_tables").update({ status: "INACTIVE" }).eq("id", table.id).select("id"), /42501|permission denied/i);
    expect((await tableRow(table.id)).status).toBe("AVAILABLE");
  });
});
