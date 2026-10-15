/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Concorrência real (Promise.all contra o banco): invariantes que dependem de índice único /
 * serialização, não de checagem em aplicação.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, as, world } from "../helpers/clients";
import { expectOk, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makePayment, makeTab, makeTable, tableRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

describe("uma comanda aberta por mesa", () => {
  const open = (who: "cashierA" | "waiterA" | "managerA", tableId: string) =>
    as(who)
      .from("tabs")
      .insert({ restaurant_id: A().id, table_id: tableId, status: "OPEN", total_cents: 0, opened_by: world().users[who].id, label: `zz-${uniq()}` })
      .select("id");

  it("duas aberturas simultâneas na mesma mesa: apenas uma sucede", async () => {
    const table = await makeTable(cleanup, A().id);
    const [r1, r2] = await Promise.all([open("cashierA", table.id), open("waiterA", table.id)]);
    const ok = [r1, r2].filter((r) => !r.error);
    const failed = [r1, r2].filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error!.code).toBe("23505");
    const tabs = await admin().from("tabs").select("id,status").eq("table_id", table.id);
    expect(rows(tabs)).toHaveLength(1);
    expect(rows(tabs)[0].status).toBe("OPEN");
    cleanup.add(async () => void (await admin().from("tabs").delete().eq("table_id", table.id)));
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");
  });

  it("rajada de 8 aberturas (3 usuários) na mesma mesa: exatamente 1 sucesso e 1 comanda OPEN", async () => {
    const table = await makeTable(cleanup, A().id);
    const who = ["cashierA", "waiterA", "managerA", "cashierA", "waiterA", "managerA", "cashierA", "waiterA"] as const;
    const results = await Promise.all(who.map((w) => open(w, table.id)));
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error!.code).toBe("23505");
    const tabs = await admin().from("tabs").select("id").eq("table_id", table.id).eq("status", "OPEN");
    expect(rows(tabs)).toHaveLength(1);
    cleanup.add(async () => void (await admin().from("tabs").delete().eq("table_id", table.id)));
  });

  it("mesas diferentes não se bloqueiam; após fechar a comanda, a mesma mesa aceita nova abertura", async () => {
    const [t1, t2] = [await makeTable(cleanup, A().id), await makeTable(cleanup, A().id)];
    const [r1, r2] = await Promise.all([open("cashierA", t1.id), open("waiterA", t2.id)]);
    expectOk(r1 as any);
    expectOk(r2 as any);
    const first = (r1.data as any)[0].id as string;
    cleanup.add(async () => void (await admin().from("tabs").delete().in("table_id", [t1.id, t2.id])));
    expectOk(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", first).select("id") as any);
    const reopen = await open("waiterA", t1.id);
    expectOk(reopen as any);
  });

  it("restaurantes diferentes: a unicidade é por restaurante+mesa (B não é afetado por A)", async () => {
    const tb = await makeTable(cleanup, B().id);
    const ta = await makeTable(cleanup, A().id);
    const [ra, rb] = await Promise.all([
      open("cashierA", ta.id),
      as("cashierB").from("tabs").insert({ restaurant_id: B().id, table_id: tb.id, status: "OPEN", total_cents: 0, opened_by: world().users.cashierB.id, label: `zz-${uniq()}` }).select("id"),
    ]);
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
    cleanup.add(async () => void (await admin().from("tabs").delete().in("table_id", [ta.id, tb.id])));
  });
});

describe("order_number: sequencial por restaurante, sem duplicar sob concorrência (service role)", () => {
  it("20 pedidos paralelos no mesmo restaurante recebem números distintos e consecutivos", async () => {
    const made = await Promise.all(Array.from({ length: 20 }, () => makeOrder(cleanup, A().id)));
    const numbers = made.map((o) => o.order_number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(20);
    expect(numbers[numbers.length - 1] - numbers[0]).toBe(19); // sem lacunas na rajada
  });

  it("pedidos intercalados de A e B: contadores independentes, cada um sem duplicatas", async () => {
    const jobs = Array.from({ length: 16 }, (_, i) => makeOrder(cleanup, i % 2 === 0 ? A().id : B().id));
    const made = await Promise.all(jobs);
    for (const rid of [A().id, B().id]) {
      const nums = made.filter((o) => o.restaurant_id === rid).map((o) => o.order_number);
      expect(new Set(nums).size).toBe(nums.length);
      expect(nums).toHaveLength(8);
    }
    // unicidade no banco (restaurant_id, order_number)
    const dup = await admin().from("orders").select("order_number").eq("restaurant_id", A().id);
    const all = rows(dup).map((r) => r.order_number);
    expect(new Set(all).size).toBe(all.length);
  });

  it("número informado em duplicidade é rejeitado pela unique (restaurant_id, order_number)", async () => {
    const o = await makeOrder(cleanup, A().id);
    const r = await admin()
      .from("orders")
      .insert({ restaurant_id: A().id, order_number: o.order_number, fulfillment_type: "PICKUP", subtotal_cents: 1, total_cents: 1, idempotency_key: `zz-${uniq()}` });
    expect(r.error?.code).toBe("23505");
  });

  it("clientes não conseguem ler nem mexer no contador (order_counters)", async () => {
    const r = await as("managerA").from("order_counters").select("*");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/permission denied|42501/i);
  });
});

describe("idempotência do checkout e de pagamentos", () => {
  it("5 inserções paralelas com a mesma idempotency_key => 1 pedido", async () => {
    const key = `zz-idem-${uniq()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin()
          .from("orders")
          .insert({ restaurant_id: A().id, fulfillment_type: "PICKUP", subtotal_cents: 100, total_cents: 100, idempotency_key: key, source: "STAFF" })
          .select("id"),
      ),
    );
    const ok = results.filter((r) => !r.error);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error!.code).toBe("23505");
    const id = (ok[0].data as any)[0].id;
    cleanup.add(async () => void (await admin().from("orders").delete().eq("id", id)));
    expect(rows(await admin().from("orders").select("id").eq("restaurant_id", A().id).eq("idempotency_key", key))).toHaveLength(1);
  });

  it("a mesma idempotency_key em restaurantes diferentes é permitida (escopo por tenant)", async () => {
    const key = `zz-idem-${uniq()}`;
    const mk = (rid: string) => admin().from("orders").insert({ restaurant_id: rid, fulfillment_type: "PICKUP", subtotal_cents: 1, total_cents: 1, idempotency_key: key, source: "STAFF" }).select("id");
    const [a, b] = await Promise.all([mk(A().id), mk(B().id)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    cleanup.add(async () => void (await admin().from("orders").delete().in("id", [(a.data as any)[0].id, (b.data as any)[0].id])));
  });

  it("pagamento duplicado com o mesmo provider_reference é rejeitado (mesmo restaurante e entre restaurantes)", async () => {
    const o1 = await makeOrder(cleanup, A().id, { totalCents: 1000 });
    const o2 = await makeOrder(cleanup, A().id, { totalCents: 1000 });
    const ob = await makeOrder(cleanup, B().id, { totalCents: 1000 });
    const ref = `zz-ref-${uniq()}`;
    expectOk((await makePayment(cleanup, A().id, { orderId: o1.id }, { provider: "zz-gateway", reference: ref })) as any);
    const dupSame = await makePayment(cleanup, A().id, { orderId: o2.id }, { provider: "zz-gateway", reference: ref });
    expect(dupSame.error?.code).toBe("23505");
    // a referência do gateway é global por provider: B também não pode reutilizá-la
    const dupOther = await makePayment(cleanup, B().id, { orderId: ob.id }, { provider: "zz-gateway", reference: ref });
    expect(dupOther.error?.code).toBe("23505");
    // outro provider com a mesma referência é um pagamento distinto
    const otherProvider = await makePayment(cleanup, A().id, { orderId: o2.id }, { provider: "zz-outro", reference: ref });
    expect(otherProvider.error).toBeNull();
    expect((await admin().from("orders").select("payment_status").eq("id", o2.id).single()).data?.payment_status).toBe("PAID");
  });

  it("rajada de 6 webhooks com o mesmo provider_reference => 1 pagamento e o pedido fica PAID uma única vez", async () => {
    const order = await makeOrder(cleanup, A().id, { totalCents: 2500 });
    const ref = `zz-wh-${uniq()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => makePayment(cleanup, A().id, { orderId: order.id }, { amount: 2500, provider: "zz-gateway", reference: ref })));
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error!.code).toBe("23505");
    const pays = await admin().from("payments").select("id,amount_cents").eq("order_id", order.id);
    expect(rows(pays)).toHaveLength(1);
    expect((await admin().from("orders").select("payment_status").eq("id", order.id).single()).data?.payment_status).toBe("PAID");
  });

  it("mesma idempotency_key de pagamento no mesmo restaurante é rejeitada; em outro restaurante é aceita", async () => {
    const order = await makeOrder(cleanup, A().id, { totalCents: 1000 });
    const orderB = await makeOrder(cleanup, B().id, { totalCents: 1000 });
    const idem = `zz-pay-${uniq()}`;
    expect((await makePayment(cleanup, A().id, { orderId: order.id }, { amount: 100, idem })).error).toBeNull();
    expect((await makePayment(cleanup, A().id, { orderId: order.id }, { amount: 100, idem })).error?.code).toBe("23505");
    expect((await makePayment(cleanup, B().id, { orderId: orderB.id }, { amount: 100, idem })).error).toBeNull();
  });
});

/**
 * Corridas (race conditions) encontradas no banco e CORRIGIDAS na mig. 111 — ver tests/FINDINGS.md. Antes eram it.fails; agora
 * são regressões normais (it).
 */
describe("corridas confirmadas (achados)", () => {
  // F-05: payments_sync_order soma os pagamentos visíveis no snapshot da própria transação; dois pagamentos
  // concorrentes (2000 + 3000 = total 5000) deixam o pedido em PENDING (o último a commitar sobrescreve).
  it("[F-05] pagamentos concorrentes que somam o total deixam orders.payment_status = PAID", async () => {
    const wrong: number[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await makeOrder(cleanup, A().id, { totalCents: 5000 });
      await Promise.all([
        makePayment(cleanup, A().id, { orderId: o.id }, { amount: 2000, status: "PAID" }),
        makePayment(cleanup, A().id, { orderId: o.id }, { amount: 3000, status: "PAID" }),
      ]);
      const paid = rows(await admin().from("payments").select("amount_cents").eq("order_id", o.id)).reduce((s, p) => s + p.amount_cents, 0);
      const st = (await admin().from("orders").select("payment_status").eq("id", o.id).single()).data!.payment_status;
      expect(paid).toBe(5000);
      if (st !== "PAID") wrong.push(i);
    }
    expect(wrong, `pedidos totalmente pagos que ficaram sem PAID (iterações): ${wrong}`).toEqual([]);
  });

  // F-06: orders_before_insert lê o status da comanda sem travar a linha; fechar a comanda ao mesmo tempo em que
  // um pedido é lançado deixa o pedido numa comanda CLOSED fora de tabs.total_cents.
  it("[F-06] pedido lançado em paralelo ao fechamento da comanda entra no total ou é recusado", async () => {
    const anomalies: number[] = [];
    for (let i = 0; i < 6; i++) {
      const tab = await makeTab(cleanup, A().id, { openedBy: world().users.cashierA.id });
      await makeOrder(cleanup, A().id, { tabId: tab.id, fulfillment: "DINE_IN", totalCents: 1000 });
      const [close, ins] = await Promise.all([
        admin().from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"),
        admin()
          .from("orders")
          .insert({ restaurant_id: A().id, fulfillment_type: "DINE_IN", subtotal_cents: 500, total_cents: 500, tab_id: tab.id, idempotency_key: `zz-race-${uniq()}`, source: "STAFF" })
          .select("id"),
      ]);
      expect(close.error).toBeNull();
      if (ins.data?.length) cleanup.add(async () => void (await admin().from("orders").delete().eq("id", ins.data![0].id)));
      const t = (await admin().from("tabs").select("status,total_cents").eq("id", tab.id).single()).data!;
      const sum = rows(await admin().from("orders").select("total_cents,status").eq("tab_id", tab.id))
        .filter((o) => !["CANCELLED", "REJECTED"].includes(o.status))
        .reduce((s, o) => s + o.total_cents, 0);
      if (t.status === "CLOSED" && t.total_cents !== sum) anomalies.push(i);
    }
    expect(anomalies, `comandas fechadas com total diferente da soma dos pedidos (iterações): ${anomalies}`).toEqual([]);
  });

  // F-07: register_restaurant conta os vínculos de owner e depois insere, sem trava: chamadas concorrentes
  // furam o limite de 5 restaurantes por usuário.
  it("[F-07] register_restaurant respeita o limite de 5 mesmo com chamadas simultâneas", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => as("plain").rpc("register_restaurant", { p_name: `zz DEMO limite ${i}`, p_slug: `zz-race-${uniq()}-${i}`.slice(0, 40) })),
    );
    for (const r of results) if (r.data) cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", r.data as string)));
    const created = results.filter((r) => !r.error).length;
    expect(created, `restaurantes criados por um único usuário: ${created}`).toBeLessThanOrEqual(5);
  });
});
