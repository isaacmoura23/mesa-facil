/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Comandas, mesas, pagamentos (leitura) e fila de impressão — regras por papel e integridade.
 * (A concorrência — uma comanda aberta por mesa, order_number, pagamentos duplicados — está em
 * 07-concurrency.test.ts.)
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makePayment, makeTable, tabRow, tableRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();
afterAll(async () => {
  await admin().from("print_jobs").delete().eq("restaurant_id", A().id).like("printer_target", "zz-%");
  await cleanup.run();
});

const openTab = (who: AccountKey, tableId: string | null, extra: Record<string, unknown> = {}) =>
  as(who)
    .from("tabs")
    .insert({ restaurant_id: A().id, table_id: tableId, status: "OPEN", total_cents: 0, opened_by: world().users[who].id, label: `zz-${uniq()}`, ...extra })
    .select("*")
    .single();

async function openedTab(who: AccountKey, tableId: string | null, extra: Record<string, unknown> = {}) {
  const res = await openTab(who, tableId, extra);
  expectOk(res);
  const id = res.data!.id as string;
  cleanup.add(async () => {
    await admin().from("payments").delete().eq("tab_id", id);
    await admin().from("tabs").delete().eq("id", id);
  });
  return res.data!;
}

describe("abertura de comanda", () => {
  for (const who of ["cashierA", "waiterA", "managerA"] as const) {
    it(`${who} (tabs.manage) abre comanda; a mesa passa a OCCUPIED; autoria = o próprio usuário`, async () => {
      const table = await makeTable(cleanup, A().id);
      const tab = await openedTab(who, table.id);
      expect(tab.status).toBe("OPEN");
      expect(tab.opened_by).toBe(world().users[who].id);
      expect(tab.single_per_table).toBe(true);
      expect((await tableRow(table.id)).status).toBe("OCCUPIED");
      const hist = await admin().from("tab_status_history").select("from_status,to_status,changed_by").eq("tab_id", tab.id);
      expect(hist.data).toEqual([{ from_status: null, to_status: "OPEN", changed_by: world().users[who].id }]);
    });
  }

  it("cozinha (sem tabs.manage) e dono não abrem comanda; usuário sem vínculo também não", async () => {
    const table = await makeTable(cleanup, A().id);
    for (const who of ["kitchenA", "ownerA", "plain", "superadmin"] as const) {
      expectDenied(await openTab(who, table.id));
    }
    expect(rows(await admin().from("tabs").select("id").eq("table_id", table.id))).toHaveLength(0);
    expect((await tableRow(table.id)).status).toBe("AVAILABLE");
  });

  it("não é possível forjar autoria, estado, total ou desligar 'uma comanda por mesa'", async () => {
    const table = await makeTable(cleanup, A().id);
    expectDenied(await openTab("cashierA", table.id, { total_cents: 5000 }));
    expectDenied(await openTab("cashierA", table.id, { status: "CLOSED", closed_at: new Date().toISOString() }));
    expectDenied(await openTab("cashierA", table.id, { closed_at: new Date().toISOString() }));
    expect(rows(await admin().from("tabs").select("id").eq("table_id", table.id))).toHaveLength(0);

    // opened_by forjado é sobrescrito pelo trigger com o auth.uid() (autoria é do servidor)
    const other = await makeTable(cleanup, A().id);
    const impersonated = await openedTab("cashierA", other.id, { opened_by: world().users.managerA.id });
    expect(impersonated.opened_by).toBe(world().users.cashierA.id);

    // single_per_table:false é ignorado (o trigger copia da configuração do restaurante)
    const first = await openedTab("cashierA", table.id, { single_per_table: false });
    expect(first.single_per_table).toBe(true);
    const second = await openTab("waiterA", table.id, { single_per_table: false });
    expect(second.error?.code).toBe("23505");
  });

  // CORRIGIDO (mig. 111, F-01): antes, o INSERT em tabs concedia todas as colunas ao cliente e o
  // trigger só sobrescrevia opened_by/single_per_table. Agora opened_at/created_at/closed_by/status_reason também.
  it("[F-01] opened_at/created_at/closed_by/status_reason forjados no INSERT são sobrescritos ou rejeitados", async () => {
    const table = await makeTable(cleanup, A().id);
    const forged = "2001-01-01T00:00:00Z";
    const res = await openTab("cashierA", table.id, { opened_at: forged, created_at: forged, closed_by: world().users.ownerA.id, status_reason: "forjado" });
    if (res.error) {
      expectDenied(res);
      return;
    }
    cleanup.add(async () => void (await admin().from("tabs").delete().eq("id", res.data!.id)));
    const row = await tabRow(res.data!.id);
    expect(new Date(row.opened_at).getFullYear(), "opened_at forjado pelo cliente").toBeGreaterThan(2020);
    expect(new Date(row.created_at).getFullYear(), "created_at forjado pelo cliente").toBeGreaterThan(2020);
    expect(row.closed_by, "closed_by forjado pelo cliente").toBeNull();
    expect(row.status_reason, "status_reason forjado pelo cliente").toBeNull();
  });

  it("mesa inativa não aceita comanda; mesa de outro restaurante não pode ser usada (FK composta)", async () => {
    const inactive = await makeTable(cleanup, A().id, { status: "INACTIVE" });
    expectRule(await openTab("cashierA", inactive.id), /TABLE_INACTIVE/);
    const res = await openTab("cashierA", B().tableIds[3]);
    expect(res.error?.code).toBe("23503");
  });

  it("comanda avulsa (sem mesa) pode ter várias abertas", async () => {
    const t1 = await openedTab("cashierA", null);
    const t2 = await openedTab("cashierA", null);
    expect(t1.id).not.toBe(t2.id);
  });
});

describe("fechamento e cancelamento de comanda", () => {
  it("fechar calcula o total no servidor (ignora pedidos cancelados/recusados), marca autor e libera a mesa para limpeza", async () => {
    const table = await makeTable(cleanup, A().id);
    const tab = await openedTab("waiterA", table.id);
    await makeOrder(cleanup, A().id, { tabId: tab.id, tableId: table.id, fulfillment: "DINE_IN", totalCents: 3000 });
    await makeOrder(cleanup, A().id, { tabId: tab.id, tableId: table.id, fulfillment: "DINE_IN", totalCents: 2000 });
    await makeOrder(cleanup, A().id, { tabId: tab.id, tableId: table.id, fulfillment: "DINE_IN", totalCents: 9999, status: "CANCELLED" });

    // total vindo do cliente é barrado por GRANT (coluna não atualizável)
    expectDenied(await as("cashierA").from("tabs").update({ status: "CLOSED", total_cents: 1 }).eq("id", tab.id).select("id"), /42501|permission denied/);
    expect((await tabRow(tab.id)).status).toBe("OPEN");

    expectOk(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"));
    const closed = await tabRow(tab.id);
    expect(closed).toMatchObject({ status: "CLOSED", total_cents: 5000, closed_by: world().users.cashierA.id });
    expect(closed.closed_at).not.toBeNull();
    expect((await tableRow(table.id)).status).toBe("CLEANING");
  });

  it("comanda encerrada é imutável (não reabre, não troca status, não edita rótulo)", async () => {
    const tab = await openedTab("cashierA", null);
    expectOk(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"));
    const frozen = await tabRow(tab.id);
    for (const patch of [{ status: "OPEN" }, { status: "CANCELLED", status_reason: "x" }, { label: "zz-novo" }, { guests: 3 }]) {
      expectRule(await as("managerA").from("tabs").update(patch).eq("id", tab.id).select("id"), /TAB_INVALID_TRANSITION/);
    }
    expect(await tabRow(tab.id)).toEqual(frozen);
  });

  it("cancelar exige motivo; com motivo funciona e libera a mesa", async () => {
    const table = await makeTable(cleanup, A().id);
    const tab = await openedTab("cashierA", table.id);
    for (const patch of [{ status: "CANCELLED" }, { status: "CANCELLED", status_reason: "  " }]) {
      expectRule(await as("cashierA").from("tabs").update(patch).eq("id", tab.id).select("id"), /REASON_REQUIRED|tabs_cancel_reason_required|violates check/);
    }
    expect((await tabRow(tab.id)).status).toBe("OPEN");
    expectOk(await as("cashierA").from("tabs").update({ status: "CANCELLED", status_reason: "cliente saiu" }).eq("id", tab.id).select("id"));
    expect(await tabRow(tab.id)).toMatchObject({ status: "CANCELLED", status_reason: "cliente saiu" });
    expect((await tableRow(table.id)).status).toBe("CLEANING");
  });

  it("colunas calculadas pelo servidor não são editáveis (mesa, total, marcos, autoria)", async () => {
    const table = await makeTable(cleanup, A().id);
    const other = await makeTable(cleanup, A().id);
    const tab = await openedTab("cashierA", table.id);
    const before = await tabRow(tab.id);
    for (const patch of [
      { table_id: other.id },
      { total_cents: 100 },
      { closed_at: new Date().toISOString() },
      { opened_by: world().users.ownerA.id },
      { closed_by: world().users.ownerA.id },
      { single_per_table: false },
      { restaurant_id: B().id },
    ]) {
      expectDenied(await as("cashierA").from("tabs").update(patch).eq("id", tab.id).select("id"), /42501|permission denied/);
    }
    expect(await tabRow(tab.id)).toEqual(before);
    // colunas livres: rótulo e nº de pessoas
    expectOk(await as("waiterA").from("tabs").update({ label: "zz-editada", guests: 4 }).eq("id", tab.id).select("id"));
    expect(await tabRow(tab.id)).toMatchObject({ label: "zz-editada", guests: 4 });
  });

  it("pedido não pode ser lançado em comanda encerrada (TAB_NOT_OPEN) e comanda não é apagável", async () => {
    const tab = await openedTab("cashierA", null);
    expectOk(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"));
    await expect(makeOrder(cleanup, A().id, { tabId: tab.id, fulfillment: "DINE_IN" })).rejects.toThrow(/TAB_NOT_OPEN/);
    expectDenied(await as("managerA").from("tabs").delete().eq("id", tab.id).select("id"));
    expect(rows(await admin().from("tabs").select("id").eq("id", tab.id))).toHaveLength(1);
  });

  it("visibilidade: cozinha não vê comandas; garçom/caixa/gerente/dono veem as do próprio restaurante", async () => {
    expectNoRows(await as("kitchenA").from("tabs").select("id"));
    expectNoRows(await as("kitchenA").from("tab_status_history").select("id"));
    for (const who of ["waiterA", "cashierA", "managerA", "ownerA"] as const) {
      const r = await as(who).from("tabs").select("id,restaurant_id").eq("id", A().tabId);
      expectOk(r);
      expect(rows(r)).toHaveLength(1);
    }
  });
});

describe("mesas: cadastro (tables.manage) x operação (tables.operate)", () => {
  it("garçom e caixa operam o estado (AVAILABLE -> OCCUPIED -> CLEANING -> AVAILABLE) mas não renomeiam nem desativam", async () => {
    for (const who of ["waiterA", "cashierA"] as const) {
      const t = await makeTable(cleanup, A().id);
      expectOk(await as(who).from("restaurant_tables").update({ status: "OCCUPIED" }).eq("id", t.id).select("id"));
      expectOk(await as(who).from("restaurant_tables").update({ status: "CLEANING" }).eq("id", t.id).select("id"));
      expectOk(await as(who).from("restaurant_tables").update({ status: "AVAILABLE" }).eq("id", t.id).select("id"));

      expectRule(await as(who).from("restaurant_tables").update({ name: "zz-renomeada" }).eq("id", t.id).select("id"), /FORBIDDEN/);
      expectRule(await as(who).from("restaurant_tables").update({ capacity: 99 }).eq("id", t.id).select("id"), /FORBIDDEN/);
      expectRule(await as(who).from("restaurant_tables").update({ status: "INACTIVE" }).eq("id", t.id).select("id"), /FORBIDDEN/);
      expectDenied(await as(who).from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-${uniq()}` }).select("id"));
      expectNotApplied(await as(who).from("restaurant_tables").delete().eq("id", t.id).select("id"));
      expect(await tableRow(t.id)).toMatchObject({ status: "AVAILABLE", name: t.name, capacity: 2 });
    }
  });

  it("cozinha não vê nem altera mesas (sem tables.view / tables.operate)", async () => {
    const t = await makeTable(cleanup, A().id);
    expectNoRows(await as("kitchenA").from("restaurant_tables").select("id").eq("id", t.id));
    expectNotApplied(await as("kitchenA").from("restaurant_tables").update({ status: "OCCUPIED" }).eq("id", t.id).select("id"));
    expect((await tableRow(t.id)).status).toBe("AVAILABLE");
  });

  it("transições inválidas são rejeitadas para qualquer papel", async () => {
    const cases: Array<[string, string]> = [
      ["AVAILABLE", "CLEANING"],
      ["INACTIVE", "OCCUPIED"],
      ["INACTIVE", "CLEANING"],
      ["OCCUPIED", "INACTIVE"],
    ];
    for (const [from, to] of cases) {
      const t = await makeTable(cleanup, A().id, { status: from });
      expectRule(await as("managerA").from("restaurant_tables").update({ status: to }).eq("id", t.id).select("id"), /TABLE_INVALID_TRANSITION/);
      expect((await tableRow(t.id)).status).toBe(from);
    }
  });

  it("não libera mesa com comanda aberta; depois de fechar, vira CLEANING e então AVAILABLE", async () => {
    const t = await makeTable(cleanup, A().id);
    const tab = await openedTab("waiterA", t.id);
    expectRule(await as("waiterA").from("restaurant_tables").update({ status: "AVAILABLE" }).eq("id", t.id).select("id"), /TABLE_HAS_OPEN_TAB/);
    expectRule(await as("waiterA").from("restaurant_tables").update({ status: "CLEANING" }).eq("id", t.id).select("id"), /TABLE_HAS_OPEN_TAB/);
    expect((await tableRow(t.id)).status).toBe("OCCUPIED");
    expectOk(await as("waiterA").from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"));
    expect((await tableRow(t.id)).status).toBe("CLEANING");
    expectOk(await as("waiterA").from("restaurant_tables").update({ status: "AVAILABLE" }).eq("id", t.id).select("id"));
  });

  it("gerente desativa e só então apaga a mesa; mesa ativa não é apagável", async () => {
    const t = await makeTable(cleanup, A().id);
    expect(rows(await as("managerA").from("restaurant_tables").delete().eq("id", t.id).select("id"))).toHaveLength(0);
    expectOk(await as("managerA").from("restaurant_tables").update({ status: "INACTIVE" }).eq("id", t.id).select("id"));
    const del = await as("managerA").from("restaurant_tables").delete().eq("id", t.id).select("id");
    expectOk(del);
    expect(rows(del)).toHaveLength(1);
  });
});

describe("pagamentos: quem vê e quem escreve", () => {
  it("caixa, gerente e dono leem pagamentos; cozinha e garçom não; B é invisível", async () => {
    for (const who of ["cashierA", "managerA", "ownerA"] as const) {
      const r = await as(who).from("payments").select("id,restaurant_id");
      expectOk(r);
      expect(rows(r).length).toBeGreaterThan(0);
      expect(rows(r).every((p) => p.restaurant_id === A().id)).toBe(true);
    }
    for (const who of ["kitchenA", "waiterA", "plain"] as const) expectNoRows(await as(who).from("payments").select("id"));
    expectNoRows(await as("cashierA").from("payments").select("id").eq("restaurant_id", B().id));
  });

  it("nenhum papel insere/atualiza/apaga pagamento direto (só RPC/webhook com service role)", async () => {
    const order = await makeOrder(cleanup, A().id, { totalCents: 4000 });
    for (const who of ["cashierA", "managerA", "waiterA", "ownerA"] as const) {
      expectDenied(
        await as(who)
          .from("payments")
          .insert({ restaurant_id: A().id, order_id: order.id, method: "CASH", amount_cents: 4000, status: "PAID", paid_at: new Date().toISOString(), idempotency_key: `zz-${uniq()}` })
          .select("id"),
      );
    }
    expectDenied(await as("cashierA").from("payments").update({ amount_cents: 1 }).eq("id", A().paymentId).select("id"));
    expectDenied(await as("cashierA").from("payments").delete().eq("id", A().paymentId).select("id"));
    expect((await admin().from("orders").select("payment_status").eq("id", order.id).single()).data?.payment_status).toBe("UNPAID");
    expect(rows(await admin().from("payments").select("id").eq("order_id", order.id))).toHaveLength(0);
  });

  it("constraints do banco: valor > 0, não UNPAID, PAID exige paid_at, referência exige provider, precisa de alvo, FK composta por tenant", async () => {
    const order = await makeOrder(cleanup, A().id);
    const base = { restaurant_id: A().id, order_id: order.id, method: "CASH", amount_cents: 100, status: "PAID", paid_at: new Date().toISOString() };
    const attempt = async (patch: Record<string, unknown>) => {
      const r = await admin().from("payments").insert({ ...base, idempotency_key: `zz-${uniq()}`, ...patch }).select("id");
      if (r.data?.length) cleanup.add(async () => void (await admin().from("payments").delete().eq("id", r.data![0].id)));
      return r;
    };
    expect((await attempt({ amount_cents: 0 })).error?.code).toBe("23514");
    expect((await attempt({ amount_cents: -5 })).error?.code).toBe("23514");
    expect((await attempt({ status: "UNPAID" })).error?.code).toBe("23514");
    expect((await attempt({ paid_at: null })).error?.code).toBe("23514");
    expect((await attempt({ provider: null, provider_reference: "ref-sem-provider" })).error?.code).toBe("23514");
    expect((await attempt({ order_id: null, tab_id: null })).error?.code).toBe("23514");
    expect((await attempt({ order_id: B().orderIds[0] })).error?.code).toBe("23503"); // pedido de B sob restaurante A
    expect(rows(await admin().from("payments").select("id").eq("order_id", order.id))).toHaveLength(0);
  });
});

describe("fila de impressão (print_jobs): só via RPC request_print (F-08 corrigido, mig. 0116)", () => {
  const request = (who: AccountKey, orderId: string, type = "KITCHEN_TICKET") => as(who).rpc("request_print", { p_order: orderId, p_document_type: type });
  const directBody = (who: AccountKey, orderId: string, extra: Record<string, unknown> = {}) => ({
    restaurant_id: A().id,
    document_type: "KITCHEN_TICKET",
    order_id: orderId,
    requested_by: world().users[who].id,
    printer_target: `zz-${uniq()}`,
    payload: { forjado: true },
    ...extra,
  });

  it("cozinha, caixa, garçom e gerente pedem impressão via request_print: nasce REQUESTED, nunca PRINTED", async () => {
    const order = await makeOrder(cleanup, A().id);
    for (const who of ["kitchenA", "cashierA", "waiterA", "managerA"] as const) {
      const res = await request(who, order.id);
      expectOk(res);
      expect(res.data).toMatchObject({ ok: true, status: "REQUESTED" });
      const job = await admin().from("print_jobs").select("status,printed_at,requested_by,restaurant_id,order_id").eq("id", (res.data as any).job_id).single();
      expect(job.data).toMatchObject({ status: "REQUESTED", printed_at: null, requested_by: world().users[who].id, restaurant_id: A().id, order_id: order.id });
    }
  });

  it("INSERT direto em print_jobs é negado a qualquer papel autenticado (F-08): nada é gravado", async () => {
    const order = await makeOrder(cleanup, A().id);
    for (const who of ["kitchenA", "cashierA", "waiterA", "managerA", "ownerA"] as const) {
      expectDenied(await as(who).from("print_jobs").insert(directBody(who, order.id)).select("id"));
    }
    // nem com status/timestamps/erro/solicitante forjados
    for (const extra of [
      { status: "PRINTED", printed_at: new Date().toISOString() },
      { status: "DISPATCHED", dispatched_at: new Date().toISOString() },
      { status: "FAILED", error_message: "x" },
      { requested_by: world().users.managerA.id },
    ]) {
      expectDenied(await as("cashierA").from("print_jobs").insert(directBody("cashierA", order.id, extra)).select("id"));
    }
    expect(rows(await admin().from("print_jobs").select("id").eq("order_id", order.id))).toHaveLength(0);
  });

  it("dono não pede impressão; ninguém atualiza ou apaga jobs diretamente (status só pelas RPCs)", async () => {
    const order = await makeOrder(cleanup, A().id);
    expectDenied(await request("ownerA", order.id), /FORBIDDEN|42501/);
    const job = await request("cashierA", order.id);
    expectOk(job);
    const id = (job.data as any).job_id as string;
    expectDenied(await as("cashierA").from("print_jobs").update({ status: "PRINTED", printed_at: new Date().toISOString() }).eq("id", id).select("id"));
    expectDenied(await as("cashierA").from("print_jobs").update({ payload: { forjado: true } }).eq("id", id).select("id"));
    expectDenied(await as("managerA").from("print_jobs").delete().eq("id", id).select("id"));
    expect((await admin().from("print_jobs").select("status").eq("id", id).single()).data?.status).toBe("REQUESTED");
  });

  it("[F-08 corrigido] o payload é montado no servidor: o cliente não o define nem o altera", async () => {
    const order = await makeOrder(cleanup, A().id);
    const res = await request("cashierA", order.id, "ORDER_RECEIPT");
    expectOk(res);
    const stored = (await admin().from("print_jobs").select("payload").eq("id", (res.data as any).job_id).single()).data!.payload as any;
    expect(stored).toMatchObject({ document_type: "ORDER_RECEIPT", order_number: order.order_number, total_cents: 3000 });
    expect(stored.forjado).toBeUndefined();
    // a RPC ignora qualquer tentativa de injetar conteúdo: só aceita (pedido, tipo)
    const extra = await as("cashierA").rpc("request_print", { p_order: order.id, p_document_type: "KITCHEN_TICKET", p_payload: { forjado: true } } as never);
    expect(extra.error, "RPC não deve aceitar p_payload").not.toBeNull();
  });

  it("o próprio banco recusa PRINTED sem printed_at (nunca automático), mesmo para service role", async () => {
    const order = await makeOrder(cleanup, A().id);
    const r = await admin().from("print_jobs").insert({ restaurant_id: A().id, document_type: "KITCHEN_TICKET", order_id: order.id, status: "PRINTED", printer_target: "zz-x" }).select("id");
    expect(r.error?.code).toBe("23514");
  });
});

describe("pedido DINE_IN ligado a comanda/mesa de outro restaurante é impossível (FKs compostas)", () => {
  it("order com tab_id de B sob restaurant_id A falha", async () => {
    await expect(makeOrder(cleanup, A().id, { tabId: B().tabId, fulfillment: "DINE_IN" })).rejects.toThrow(/TAB_NOT_OPEN|foreign key|23503|violates/);
    await expect(makeOrder(cleanup, A().id, { tableId: B().tableIds[0], fulfillment: "DINE_IN" })).rejects.toThrow(/foreign key|23503|violates/);
  });
  it("pagamento sob A para comanda de B falha", async () => {
    const r = await makePayment(cleanup, A().id, { tabId: B().tabId });
    expect(r.error?.code).toBe("23503");
  });
});
