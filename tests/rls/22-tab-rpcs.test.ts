/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 4 (migs. 0117-0123): comandas, pedidos de salão, pagamento manual, mesas e conta impressa — SÓ pelas RPCs
 * open_tab / create_staff_order / get_tab_balance / record_payment / close_tab / cancel_tab / set_table_status /
 * request_tab_print / rotate_table_qr, chamadas por clientes AUTENTICADOS reais (JWT de signInWithPassword).
 * O service role só monta fixtures (mesas, cardápio, pedidos de entrega/retirada) e confere o estado real do banco.
 *
 * Dados efêmeros: mesas `zz-mesa-*`, produtos `zz-*` (makeMenuFixture), referências de pagamento `zz-t22-*`,
 * chaves de idempotência `zz-t22-*`. Tudo é apagado no afterAll (comandas, pagamentos, impressões, pedidos). Os ajustes
 * em DEMO A (aberto/fechado, accepts_orders, mínimo, modalidades) são restaurados em `finally` e no afterAll.
 */
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, anon, as, realtimeAs, world } from "../helpers/clients";
import { expectDenied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makeTable, tabRow, tableRow, uniq, waitFor } from "../helpers/factory";
import { billTotals, requestTabPrintResultSchema } from "../../src/modules/printing/bill";
import { closeTabResultSchema, recordPaymentResultSchema, tabBalanceSchema } from "../../src/modules/tab-billing/types";
import { BASE_FULFILLMENT, clearTodayException, insertRow, makeMenuFixture, setOpenToday, setSettings, type MenuFixture } from "../helpers/menu";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const U = (k: AccountKey) => world().users[k].id;
const cleanup = new Cleanup();

let fxA: MenuFixture;
let fxB: MenuFixture;
let pVar: any; // produto com variantes P (R$ 10,00, padrão) e G (R$ 20,00)
let vP: any, vG: any;
let pOther: any; // produto de A com variante própria (para VARIANT_NOT_ALLOWED)
let vOther: any;

const ref = () => `zz-t22-${uniq()}`;
const ikey = () => `zz-t22-key-${uniq()}`;
const line = (p: any, quantity = 1, extra: Record<string, unknown> = {}) => ({ product_id: p.id, quantity, modifier_ids: [], ...extra });

const rpc = (who: AccountKey, fn: string, args: Record<string, unknown>) => as(who).rpc(fn, args);
const open = (who: AccountKey, tableId: string | null, label: string | null = null, guests: number | null = null, rid = A().id) =>
  rpc(who, "open_tab", { p_restaurant: rid, p_table_id: tableId, p_label: label, p_guests: guests });
const staffOrder = (who: AccountKey, tab: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  rpc(who, "create_staff_order", { p_tab: tab, p_items: items, ...extra });
const pay = (who: AccountKey, tab: string, cents: number, extra: Record<string, unknown> = {}) =>
  rpc(who, "record_payment", { p_tab: tab, p_method: "PIX", p_amount_cents: cents, ...extra });
const balance = (who: AccountKey, tab: string) => rpc(who, "get_tab_balance", { p_tab: tab });
const closeTab = (who: AccountKey, tab: string, reason: string | null = null) => rpc(who, "close_tab", { p_tab: tab, p_unpaid_reason: reason });
const cancelTab = (who: AccountKey, tab: string, reason: string | null = "teste automatizado") => rpc(who, "cancel_tab", { p_tab: tab, p_reason: reason });
const setTable = (who: AccountKey, table: string, to: string) => rpc(who, "set_table_status", { p_table: table, p_to: to });
const printTab = (who: AccountKey, tab: string, type: string) => rpc(who, "request_tab_print", { p_tab: tab, p_document_type: type });

/** Remove tudo que uma comanda de teste deixou (a ordem respeita as FKs). */
function track(tabId: string) {
  cleanup.add(async () => {
    const a = admin();
    const ids = rows(await a.from("orders").select("id").eq("tab_id", tabId)).map((o) => o.id as string);
    await a.from("payments").delete().eq("tab_id", tabId);
    if (ids.length) {
      await a.from("payments").delete().in("order_id", ids);
      await a.from("print_jobs").delete().in("order_id", ids);
    }
    await a.from("print_jobs").delete().eq("tab_id", tabId);
    if (ids.length) await a.from("orders").delete().in("id", ids);
    await a.from("tabs").delete().eq("id", tabId);
  });
}

/** Mesa efêmera + comanda aberta (garçom por padrão). */
async function openTable(who: AccountKey = "waiterA", guests: number | null = null) {
  const table = await makeTable(cleanup, A().id, { name: `zz-mesa-${uniq()}` });
  const r = await open(who, table.id, null, guests);
  expectOk(r);
  const tab = (r.data as any).tab as { id: string; table_name: string };
  track(tab.id);
  return { table, tab };
}
async function openCounter(label = `zz-balcao-${uniq()}`, who: AccountKey = "waiterA") {
  const r = await open(who, null, label);
  expectOk(r);
  const tab = (r.data as any).tab as { id: string };
  track(tab.id);
  return tab;
}
/** Lança um pedido de salão e confere o sucesso. */
async function order(tab: string, items: unknown[], who: AccountKey = "waiterA", extra: Record<string, unknown> = {}) {
  const r = await staffOrder(who, tab, items, extra);
  expectOk(r);
  expect((r.data as any).ok, JSON.stringify(r.data)).toBe(true);
  return (r.data as any).order as { id: string; order_number: number; total_cents: number; status: string };
}
/** CONFIRMED -> PREPARING -> READY -> COMPLETED pela RPC oficial (gerente). */
async function complete(orderId: string) {
  for (const to of ["PREPARING", "READY", "COMPLETED"]) expectOk(await rpc("managerA", "transition_order_status", { p_order: orderId, p_to: to, p_reason: null }));
}
const cancelOrder = async (orderId: string) => expectOk(await rpc("managerA", "transition_order_status", { p_order: orderId, p_to: "CANCELLED", p_reason: "teste automatizado" }));
/** Comanda com consumo concluído de `cents` (um item de R$ 10,00 x cents/1000). */
async function tabWithConsumption(units: number, who: AccountKey = "waiterA") {
  const t = await openTable(who);
  const o = await order(t.tab.id, [line(fxA.pPlain, units)]);
  await complete(o.id);
  return { ...t, o };
}
const auditFor = async (resourceId: string, action?: string) => {
  let q = admin().from("audit_logs").select("action,metadata,actor_id,restaurant_id").eq("resource_id", resourceId);
  if (action) q = q.eq("action", action);
  return rows(await q);
};

beforeAll(async () => {
  await setOpenToday(A().id, true);
  cleanup.add(async () => {
    await clearTodayException(A().id);
    await setSettings(A().id, { accepts_orders: true, min_order_cents: 0, enabled_fulfillment_types: BASE_FULFILLMENT });
  });
  fxA = await makeMenuFixture(cleanup, A().id);
  fxB = await makeMenuFixture(cleanup, B().id);
  pVar = await insertRow("products", { restaurant_id: A().id, category_id: fxA.category.id, name: `zz-pizza-${uniq()}`, price_cents: 900, sort_order: 20 });
  vP = await insertRow("product_variants", { restaurant_id: A().id, product_id: pVar.id, name: "P", price_cents: 1000, is_default: true, sort_order: 1 });
  vG = await insertRow("product_variants", { restaurant_id: A().id, product_id: pVar.id, name: "G", price_cents: 2000, sort_order: 2 });
  pOther = await insertRow("products", { restaurant_id: A().id, category_id: fxA.category.id, name: `zz-outro-${uniq()}`, price_cents: 800, sort_order: 21 });
  vOther = await insertRow("product_variants", { restaurant_id: A().id, product_id: pOther.id, name: "Unico", price_cents: 800, is_default: true, sort_order: 1 });
  cleanup.add(async () => void (await admin().from("product_variants").delete().eq("restaurant_id", A().id).in("product_id", [pVar.id, pOther.id])));
}, 120_000);

afterAll(async () => {
  await cleanup.run();
});

// =====================================================================================================================
describe("fluxo completo do salão", () => {
  it("mesa -> open_tab -> 2 pedidos (CONFIRMED/STAFF) -> pagamentos parciais -> close_tab -> CLEANING -> set_table_status AVAILABLE", async () => {
    const table = await makeTable(cleanup, A().id, { name: `zz-mesa-fluxo-${uniq()}` });
    const opened = await open("waiterA", table.id, null, 3);
    expectOk(opened);
    const tab = (opened.data as any).tab;
    track(tab.id);
    expect(opened.data).toMatchObject({ ok: true, tab: { status: "OPEN", table_id: table.id, table_name: table.name, guests: 3, opened_by: U("waiterA"), restaurant_id: A().id } });
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");

    // pedido 1: 2 x R$ 10,00
    const r1 = await staffOrder("waiterA", tab.id, [line(fxA.pPlain, 2, { notes: "sem gelo" })]);
    expectOk(r1);
    expect(r1.data).toMatchObject({
      ok: true,
      idempotent_replay: false,
      order: { status: "CONFIRMED", source: "STAFF", fulfillment_type: "DINE_IN", tab_id: tab.id, table_id: table.id, table_label: table.name, total_cents: 2000, subtotal_cents: 2000 },
      balance: { consumed_cents: 2000, paid_cents: 0, remaining_cents: 2000 },
    });
    const o1 = (r1.data as any).order;
    // pedido 2: produto com grupo (min 1): R$ 10,00 + m1 (1,00) + m2 (2,00) = R$ 13,00
    const o2 = await order(tab.id, [line(fxA.pGrp, 1, { modifier_ids: [fxA.m1.id, fxA.m2.id] })], "waiterA", { p_notes: "mesa da janela" });
    expect(o2.total_cents).toBe(1300);

    // linha do banco: autoria, snapshots e histórico
    const row = (await admin().from("orders").select("*").eq("id", o1.id).single()).data as any;
    expect(row).toMatchObject({ source: "STAFF", status: "CONFIRMED", payment_status: "UNPAID", created_by: U("waiterA"), customer_id: null, tab_id: tab.id, delivery_fee_cents: 0, discount_cents: 0 });
    expect(row.confirmed_at).not.toBeNull();
    const items = rows(await admin().from("order_items").select("product_name,unit_price_cents,quantity,line_total_cents,notes").eq("order_id", o1.id));
    expect(items).toEqual([{ product_name: fxA.pPlain.name, unit_price_cents: 1000, quantity: 2, line_total_cents: 2000, notes: "sem gelo" }]);
    const hist = rows(await admin().from("order_status_history").select("from_status,to_status,changed_by").eq("order_id", o1.id));
    expect(hist).toEqual([{ from_status: null, to_status: "CONFIRMED", changed_by: U("waiterA") }]);
    const mods = rows(await admin().from("order_item_modifiers").select("modifier_name,price_delta_cents").eq("restaurant_id", A().id).in("modifier_id", [fxA.m1.id, fxA.m2.id]));
    expect(mods.map((m) => m.price_delta_cents).sort()).toEqual([100, 200]);

    // fechar com pedidos em andamento é recusado
    expectRule(await closeTab("cashierA", tab.id), /TAB_HAS_OPEN_ORDERS/);
    await complete(o1.id);
    await complete(o2.id);

    // pagamentos parciais pelo caixa
    const p1 = await pay("cashierA", tab.id, 1000);
    expectOk(p1);
    expect(p1.data).toMatchObject({ ok: true, idempotent_replay: false, payment: { method: "PIX", amount_cents: 1000, status: "PAID", tab_id: tab.id, order_id: null }, balance: { consumed_cents: 3300, paid_cents: 1000, remaining_cents: 2300 } });
    const p2 = await pay("cashierA", tab.id, 1500, { p_method: "CASH", p_tendered_cents: 2000 });
    expectOk(p2);
    expect((p2.data as any).payment).toMatchObject({ method: "CASH", amount_cents: 1500, tendered_cents: 2000, change_cents: 500 });
    expect((p2.data as any).balance.remaining_cents).toBe(800);
    // contrato x app: o schema do painel aceita a resposta real. [F-41, documentado] ele lê change_cents/remaining_cents NO TOPO,
    // mas o banco os devolve em payment.change_cents / balance.remaining_cents; a UI cai no cálculo local do troco.
    const parsedPay = recordPaymentResultSchema.safeParse(p2.data);
    expect(parsedPay.success).toBe(true);
    expect(parsedPay.data!.change_cents ?? null).toBeNull();
    expect((p2.data as any).payment.change_cents).toBe(500);

    const unpaid = await closeTab("cashierA", tab.id);
    expectRule(unpaid, /TAB_UNPAID/);
    expect(unpaid.error!.details).toMatch(/remaining_cents=800/);
    expect((await tabRow(tab.id)).status).toBe("OPEN");

    expectOk(await pay("cashierA", tab.id, 800));
    const bal = await balance("waiterA", tab.id);
    expect(tabBalanceSchema.safeParse(bal.data).success, "o schema do painel recusou get_tab_balance").toBe(true);
    expect((bal.data as any)).toMatchObject({ consumed_cents: 3300, paid_cents: 3300, remaining_cents: 0, overpaid_cents: 0, open_orders_count: 0 });

    const closed = await closeTab("cashierA", tab.id);
    expectOk(closed);
    expect(closed.data).toMatchObject({ ok: true, unchanged: false, unpaid_cents: 0, table_status: "CLEANING" });
    expect(closeTabResultSchema.safeParse(closed.data).success).toBe(true);
    expect(await tabRow(tab.id)).toMatchObject({ status: "CLOSED", total_cents: 3300, unpaid_cents: 0, unpaid_reason: null, closed_by: U("cashierA") });
    expect((await tableRow(table.id)).status).toBe("CLEANING");

    // a mesa em limpeza não abre comanda; o garçom libera
    expectRule(await open("waiterA", table.id), /TABLE_NOT_AVAILABLE/);
    const freed = await setTable("waiterA", table.id, "AVAILABLE");
    expect(freed.data).toMatchObject({ ok: true, unchanged: false, table: { status: "AVAILABLE" } });
    expect((await tableRow(table.id)).status).toBe("AVAILABLE");
    const again = await open("cashierA", table.id);
    expectOk(again);
    track((again.data as any).tab.id);
  });

  it("comanda de balcão: exige identificação (LABEL_REQUIRED); pedidos levam o rótulo como table_label; fechar não mexe em nenhuma mesa", async () => {
    expectRule(await open("waiterA", null), /LABEL_REQUIRED/);
    expectRule(await open("waiterA", null, "   "), /LABEL_REQUIRED/);
    const label = `zz-balcao-${uniq()}`;
    const tab = await openCounter(label);
    expect(await tabRow(tab.id)).toMatchObject({ table_id: null, label, status: "OPEN" });
    const o = await order(tab.id, [line(fxA.pPlain)]);
    const row = (await admin().from("orders").select("table_id,table_label,tab_id,fulfillment_type").eq("id", o.id).single()).data;
    expect(row).toEqual({ table_id: null, table_label: label, tab_id: tab.id, fulfillment_type: "DINE_IN" });
    await complete(o.id);
    expectOk(await pay("cashierA", tab.id, 1000, { p_method: "DEBIT" }));
    const closed = await closeTab("waiterA", tab.id);
    expect(closed.data).toMatchObject({ ok: true, unchanged: false, table_status: null });
  });

  it("open_tab valida entrada: rótulo > 80 caracteres/controle (INVALID_LABEL), pessoas fora de 1..999 (INVALID_GUESTS)", async () => {
    const t = await makeTable(cleanup, A().id);
    expectRule(await open("waiterA", t.id, "x".repeat(81)), /INVALID_LABEL/);
    expectRule(await open("waiterA", t.id, "zz\u0007bel"), /INVALID_LABEL/);
    expectRule(await open("waiterA", t.id, "zz-ok", 0), /INVALID_GUESTS/);
    expectRule(await open("waiterA", t.id, "zz-ok", 1000), /INVALID_GUESTS/);
    expect(rows(await admin().from("tabs").select("id").eq("table_id", t.id))).toHaveLength(0);
    expect((await tableRow(t.id)).status).toBe("AVAILABLE");
  });
});


// =====================================================================================================================
describe("papéis: quem opera e quem apenas lê", () => {
  it("o dono LÊ comandas, mesas, pedidos e saldo, mas é negado em TODAS as RPCs operacionais (nada muda no banco)", async () => {
    const { table, tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain)]);
    await complete(o.id);
    expectOk(await pay("cashierA", tab.id, 400));

    // leitura
    const owner = as("ownerA");
    expect(rows(await owner.from("tabs").select("id,status").eq("id", tab.id))).toHaveLength(1);
    expect(rows(await owner.from("restaurant_tables").select("id,status").eq("id", table.id))).toHaveLength(1);
    expect(rows(await owner.from("orders").select("id,status,source").eq("id", o.id))).toEqual([{ id: o.id, status: "COMPLETED", source: "STAFF" }]);
    expect(rows(await owner.from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    const bal = await balance("ownerA", tab.id);
    expectOk(bal);
    expect(bal.data).toMatchObject({ consumed_cents: 1000, paid_cents: 400, remaining_cents: 600 });

    // escrita: tudo FORBIDDEN (o dono é monitor)
    const t2 = await makeTable(cleanup, A().id);
    expectRule(await open("ownerA", t2.id), /FORBIDDEN/);
    expectRule(await staffOrder("ownerA", tab.id, [line(fxA.pPlain)]), /FORBIDDEN/);
    expectRule(await pay("ownerA", tab.id, 100), /FORBIDDEN/);
    expectRule(await closeTab("ownerA", tab.id, "justificativa de teste do dono"), /FORBIDDEN/);
    expectRule(await cancelTab("ownerA", tab.id), /FORBIDDEN/);
    expectRule(await setTable("ownerA", table.id, "AVAILABLE"), /FORBIDDEN/); // OCCUPIED -> AVAILABLE exige tables.operate
    expectRule(await printTab("ownerA", tab.id, "PARTIAL_BILL"), /FORBIDDEN|TAB_NOT_FOUND/);

    // nada mudou
    expect(await tabRow(tab.id)).toMatchObject({ status: "OPEN", total_cents: 0 });
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    expect(rows(await admin().from("tabs").select("id").eq("table_id", t2.id))).toHaveLength(0);
    expect(rows(await admin().from("print_jobs").select("id").eq("tab_id", tab.id))).toHaveLength(0);
  });

  it("cozinha: negada em tudo (sem tabs.manage/tabs.view/payments.record/orders.create/tables.operate); nada é gravado", async () => {
    const { table, tab } = await openTable();
    const t2 = await makeTable(cleanup, A().id);
    expectRule(await open("kitchenA", t2.id), /FORBIDDEN/);
    expectRule(await staffOrder("kitchenA", tab.id, [line(fxA.pPlain)]), /FORBIDDEN/);
    expectRule(await balance("kitchenA", tab.id), /FORBIDDEN/);
    expectRule(await pay("kitchenA", tab.id, 100), /FORBIDDEN/);
    expectRule(await closeTab("kitchenA", tab.id), /FORBIDDEN/);
    expectRule(await cancelTab("kitchenA", tab.id), /FORBIDDEN/);
    expectRule(await setTable("kitchenA", t2.id, "INACTIVE"), /FORBIDDEN/);
    expectRule(await printTab("kitchenA", tab.id, "PARTIAL_BILL"), /FORBIDDEN|TAB_NOT_FOUND/);
    expectRule(await rpc("kitchenA", "rotate_table_qr", { p_table: table.id }), /FORBIDDEN/);
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(0);
    expect(rows(await admin().from("tabs").select("id").eq("table_id", t2.id))).toHaveLength(0);
    expect(rows(await admin().from("print_jobs").select("id").eq("tab_id", tab.id))).toHaveLength(0);
  });

  it("garçom abre, lança pedidos e pede a conta, mas NÃO registra pagamento nem fecha comanda com saldo (nem com justificativa)", async () => {
    const { tab } = await openTable("waiterA");
    const o = await order(tab.id, [line(fxA.pPlain, 3)], "waiterA");
    await complete(o.id);
    expectRule(await pay("waiterA", tab.id, 1000), /FORBIDDEN/);
    expectRule(await closeTab("waiterA", tab.id), /TAB_UNPAID/);
    expectRule(await closeTab("waiterA", tab.id, "cliente foi embora sem pagar (teste)"), /FORBIDDEN/);
    expect(await tabRow(tab.id)).toMatchObject({ status: "OPEN", unpaid_cents: 0, unpaid_reason: null });
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(0);
    const bill = await printTab("waiterA", tab.id, "PARTIAL_BILL");
    expectOk(bill);
    expect(bill.data).toMatchObject({ ok: true, status: "REQUESTED" });
    expectOk(await balance("waiterA", tab.id));
    // com o saldo quitado pelo caixa, o garçom fecha
    expectOk(await pay("cashierA", tab.id, 3000, { p_method: "VOUCHER" }));
    expectOk(await closeTab("waiterA", tab.id));
  });

  it("caixa registra pagamento e fecha; gerente cancela comanda vazia; ambos abrem e lançam pedidos", async () => {
    for (const who of ["cashierA", "managerA"] as const) {
      const { tab } = await openTable(who);
      const o = await order(tab.id, [line(fxA.pPlain)], who);
      await complete(o.id);
      expectOk(await pay(who, tab.id, 1000, { p_method: "CREDIT" }));
      expectOk(await closeTab(who, tab.id));
    }
    const empty = await openCounter();
    const c = await cancelTab("managerA", empty.id, "cliente desistiu");
    expect(c.data).toMatchObject({ ok: true, unchanged: false, status: "CANCELLED" });
    expect(await tabRow(empty.id)).toMatchObject({ status: "CANCELLED", status_reason: "cliente desistiu" });
    expect((await auditFor(empty.id, "tab.cancelled"))[0]).toMatchObject({ actor_id: U("managerA"), metadata: { reason: "cliente desistiu" } });
    // repetir é idempotente
    expect((await cancelTab("managerA", empty.id, "cliente desistiu")).data).toMatchObject({ ok: true, unchanged: true, status: "CANCELLED" });
  });

  it("outro restaurante / sem vínculo / anônimo: *_NOT_FOUND indistinguível de inexistente; anon sem EXECUTE", async () => {
    const { table, tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain)]);
    const ghost = "00000000-0000-4000-8000-00000000dead";
    // equipe de B tentando agir em A
    for (const who of ["managerB", "cashierB", "ownerB"] as const) {
      expectRule(await open(who, table.id), /RESTAURANT_NOT_FOUND/);
      expectRule(await staffOrder(who, tab.id, [line(fxA.pPlain)]), /TAB_NOT_FOUND/);
      expectRule(await balance(who, tab.id), /TAB_NOT_FOUND/);
      expectRule(await pay(who, tab.id, 100), /TAB_NOT_FOUND/);
      expectRule(await rpc(who, "record_payment", { p_order: o.id, p_method: "PIX", p_amount_cents: 100 }), /ORDER_NOT_FOUND/);
      expectRule(await closeTab(who, tab.id), /TAB_NOT_FOUND/);
      expectRule(await cancelTab(who, tab.id), /TAB_NOT_FOUND/);
      expectRule(await setTable(who, table.id, "INACTIVE"), /TABLE_NOT_FOUND/);
      expectRule(await printTab(who, tab.id, "FINAL_BILL"), /TAB_NOT_FOUND/);
      expectRule(await rpc(who, "rotate_table_qr", { p_table: table.id }), /TABLE_NOT_FOUND/);
    }
    // sem vínculo e inexistente dão exatamente a mesma resposta
    for (const who of ["plain", "superadmin"] as const) {
      expectRule(await balance(who, tab.id), /TAB_NOT_FOUND/);
      expect((await balance(who, tab.id)).error!.message).toBe((await balance(who, ghost)).error!.message);
      expect((await pay(who, tab.id, 100)).error!.message).toBe((await pay(who, ghost, 100)).error!.message);
      expect((await closeTab(who, tab.id)).error!.message).toBe((await closeTab(who, ghost)).error!.message);
    }
    expect((await balance("cashierA", ghost)).error!.message).toMatch(/TAB_NOT_FOUND/);
    // anon: sem EXECUTE
    const a = anon();
    for (const [fn, args] of [
      ["open_tab", { p_restaurant: A().id, p_table_id: table.id, p_label: "zz-anon" }],
      ["create_staff_order", { p_tab: tab.id, p_items: [line(fxA.pPlain)] }],
      ["get_tab_balance", { p_tab: tab.id }],
      ["record_payment", { p_tab: tab.id, p_method: "PIX", p_amount_cents: 100 }],
      ["close_tab", { p_tab: tab.id }],
      ["cancel_tab", { p_tab: tab.id, p_reason: "anon" }],
      ["set_table_status", { p_table: table.id, p_to: "INACTIVE" }],
      ["request_tab_print", { p_tab: tab.id, p_document_type: "PARTIAL_BILL" }],
      ["rotate_table_qr", { p_table: table.id }],
    ] as const) {
      expectDenied(await a.rpc(fn, args as any), /42501|permission denied/i);
    }
    expect(await tabRow(tab.id)).toMatchObject({ status: "OPEN" });
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(0);
  });

  it("[F-35] set_table_status não vaza o estado da mesa para quem não tem permissão (cozinha, mesa já no estado pedido)", async () => {
    // F-35 (corrigido na mig. 0133): a permissão é checada ANTES do ramo 'unchanged'
    const t = await makeTable(cleanup, A().id, { status: "AVAILABLE" });
    const r = await setTable("kitchenA", t.id, "AVAILABLE");
    expect(r.error, `a cozinha (sem tables.view) leu a mesa: ${JSON.stringify(r.data)}`).not.toBeNull();
    expectRule(r, /FORBIDDEN/);
  });
});

// =====================================================================================================================
describe("erros do contrato (códigos estáveis)", () => {
  it("open_tab: TABLE_HAS_OPEN_TAB, TABLE_INACTIVE, TABLE_NOT_AVAILABLE, TABLE_NOT_FOUND", async () => {
    const { table } = await openTable();
    expectRule(await open("cashierA", table.id), /TABLE_HAS_OPEN_TAB/);
    const inactive = await makeTable(cleanup, A().id, { status: "INACTIVE" });
    expectRule(await open("cashierA", inactive.id), /TABLE_INACTIVE/);
    const cleaning = await makeTable(cleanup, A().id, { status: "CLEANING" });
    expectRule(await open("cashierA", cleaning.id), /TABLE_NOT_AVAILABLE/);
    expectRule(await open("cashierA", "00000000-0000-4000-8000-00000000dead"), /TABLE_NOT_FOUND/);
    expect((await tableRow(inactive.id)).status).toBe("INACTIVE");
    expect((await tableRow(cleaning.id)).status).toBe("CLEANING");
  });

  it("TAB_NOT_OPEN: pedido, pagamento e cancelamento em comanda encerrada/cancelada; close_tab em cancelada", async () => {
    const closed = await openCounter();
    expectOk(await closeTab("cashierA", closed.id));
    const cancelled = await openCounter();
    expectOk(await cancelTab("managerA", cancelled.id));
    for (const tab of [closed.id, cancelled.id]) {
      expectRule(await staffOrder("waiterA", tab, [line(fxA.pPlain)]), /TAB_NOT_OPEN/);
      expectRule(await pay("cashierA", tab, 100), /TAB_NOT_OPEN/);
    }
    expectRule(await cancelTab("managerA", closed.id), /TAB_NOT_OPEN/);
    expectRule(await closeTab("cashierA", cancelled.id), /TAB_NOT_OPEN/);
    expect(rows(await admin().from("orders").select("id").in("tab_id", [closed.id, cancelled.id]))).toHaveLength(0);
    expect(rows(await admin().from("payments").select("id").in("tab_id", [closed.id, cancelled.id]))).toHaveLength(0);
  });

  it("close_tab: TAB_HAS_OPEN_ORDERS, TAB_UNPAID (com detalhe do saldo), INVALID_UNPAID_REASON (< 10 e > 500 caracteres)", async () => {
    const { tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain)]);
    expectRule(await closeTab("cashierA", tab.id), /TAB_HAS_OPEN_ORDERS/);
    expectRule(await closeTab("cashierA", tab.id, "curto"), /INVALID_UNPAID_REASON/);
    expectRule(await closeTab("cashierA", tab.id, "x".repeat(501)), /INVALID_UNPAID_REASON/);
    await complete(o.id);
    const unpaid = await closeTab("cashierA", tab.id);
    expectRule(unpaid, /TAB_UNPAID/);
    expect(unpaid.error!.details).toContain("remaining_cents=1000");
    expectRule(await closeTab("cashierA", tab.id, "123456789"), /INVALID_UNPAID_REASON/); // 9 caracteres
    expect(await tabRow(tab.id)).toMatchObject({ status: "OPEN" });
  });

  it("record_payment: INVALID_TARGET, INVALID_METHOD, INVALID_AMOUNT, INVALID_TENDERED, INVALID_REFERENCE, OVERPAYMENT (com saldo), ORDER_NOT_PAYABLE", async () => {
    const { tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain, 2)]); // R$ 20,00
    const base = { p_tab: tab.id, p_method: "PIX", p_amount_cents: 500 };
    const call = (over: Record<string, unknown>) => rpc("cashierA", "record_payment", { ...base, ...over });
    expectRule(await call({ p_tab: null }), /INVALID_TARGET/); // nenhum alvo
    expectRule(await call({ p_order: o.id }), /INVALID_TARGET/); // dois alvos
    for (const m of ["BITCOIN", "", null, "cash money"]) expectRule(await call({ p_method: m }), /INVALID_METHOD/);
    for (const v of [0, -100, null]) expectRule(await call({ p_amount_cents: v }), /INVALID_AMOUNT/);
    expectRule(await call({ p_tendered_cents: 600 }), /INVALID_TENDERED/); // PIX não tem troco
    expectRule(await call({ p_method: "CASH", p_tendered_cents: 400 }), /INVALID_TENDERED/); // entregou menos do que pagou
    expectRule(await call({ p_reference: "x".repeat(151) }), /INVALID_REFERENCE/);
    expectRule(await call({ p_reference: "ctrl\u0001char" }), /INVALID_REFERENCE/);
    const over = await call({ p_amount_cents: 2001 });
    expectRule(over, /OVERPAYMENT/);
    expect(over.error!.details).toContain("remaining_cents=2000");
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(0);

    // pedido cancelado não é pagável
    const o2 = await order(tab.id, [line(fxA.pPlain)]);
    await cancelOrder(o2.id);
    expectRule(await rpc("cashierA", "record_payment", { p_order: o2.id, p_method: "PIX", p_amount_cents: 100 }), /ORDER_NOT_PAYABLE/);
  });

  it("cancel_tab: REASON_REQUIRED, TAB_HAS_ORDERS (pedido ativo) e TAB_HAS_PAYMENTS (pagamento sobrevive ao pedido cancelado)", async () => {
    const { table, tab } = await openTable();
    expectRule(await cancelTab("managerA", tab.id, ""), /REASON_REQUIRED/);
    expectRule(await cancelTab("managerA", tab.id, "x".repeat(501)), /REASON_REQUIRED/);
    const o = await order(tab.id, [line(fxA.pPlain)]);
    expectRule(await cancelTab("managerA", tab.id), /TAB_HAS_ORDERS/);
    expectOk(await pay("cashierA", tab.id, 1000));
    await cancelOrder(o.id); // o consumo some, o pagamento fica (overpaid)
    expectRule(await cancelTab("managerA", tab.id), /TAB_HAS_PAYMENTS/);
    const bal = await balance("cashierA", tab.id);
    expect(bal.data).toMatchObject({ consumed_cents: 0, paid_cents: 1000, remaining_cents: 0, overpaid_cents: 1000 });
    expect(await tabRow(tab.id)).toMatchObject({ status: "OPEN" });
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");
    // só pode ser fechada (o dinheiro recebido fica registrado)
    expectOk(await closeTab("cashierA", tab.id));
  });

  it("create_staff_order: INVALID_NOTES e INVALID_IDEMPOTENCY_KEY; carrinho vazio/inválido devolve ok:false sem gravar", async () => {
    const { tab } = await openTable();
    expectRule(await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_notes: "x".repeat(1001) }), /INVALID_NOTES/);
    expectRule(await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_notes: "controle\u0001" }), /INVALID_NOTES/);
    for (const k of ["curta", "x".repeat(81), "chave\u0001com-controle"]) expectRule(await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k }), /INVALID_IDEMPOTENCY_KEY/);
    const empty = await staffOrder("waiterA", tab.id, []);
    expect(empty.error).toBeNull();
    expect(empty.data).toMatchObject({ ok: false });
    expect(((empty.data as any).errors as any[]).map((e) => e.code)).toContain("EMPTY_CART");
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(0);
  });
});


// =====================================================================================================================
describe("get_tab_balance e record_payment", () => {
  it("saldo: consumido exclui cancelados; remaining/overpaid coerentes; lista pedidos e pagamentos", async () => {
    const { tab } = await openTable();
    const oa = await order(tab.id, [line(fxA.pPlain, 2)]); // 2000
    const ob = await order(tab.id, [line(fxA.pPlain, 5)]); // 5000 (será cancelado)
    const oc = await order(tab.id, [line(fxA.pPlain, 1)]); // 1000 (segue em andamento)
    await cancelOrder(ob.id);
    await complete(oa.id);
    expectOk(await pay("cashierA", tab.id, 1500));

    const r = await balance("managerA", tab.id);
    expectOk(r);
    const d = r.data as any;
    expect(d).toMatchObject({ consumed_cents: 3000, paid_cents: 1500, remaining_cents: 1500, overpaid_cents: 0, open_orders_count: 1 });
    expect(d.tab).toMatchObject({ id: tab.id, status: "OPEN", total_cents: 0, unpaid_cents: 0 });
    const byId = new Map<string, any>((d.orders as any[]).map((o) => [o.id, o]));
    expect(byId.size).toBe(3);
    expect(byId.get(oa.id)).toMatchObject({ status: "COMPLETED", total_cents: 2000, counts_toward_total: true });
    expect(byId.get(ob.id)).toMatchObject({ status: "CANCELLED", total_cents: 5000, counts_toward_total: false });
    expect(byId.get(oc.id)).toMatchObject({ status: "CONFIRMED", counts_toward_total: true });
    expect((d.orders as any[]).map((o) => o.order_number)).toEqual([oa.order_number, ob.order_number, oc.order_number].sort((x, y) => x - y));
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ method: "PIX", amount_cents: 1500, status: "PAID", tab_id: tab.id, change_cents: null });
    // consumo = soma dos pedidos que contam; saldo = consumo - pago
    expect(d.consumed_cents).toBe((d.orders as any[]).filter((o) => o.counts_toward_total).reduce((s, o) => s + o.total_cents, 0));
    expect(d.remaining_cents).toBe(d.consumed_cents - d.paid_cents);
  });

  it("pagamento por pedido da comanda também conta no saldo da comanda; o payment_status só muda no pedido pago por p_order", async () => {
    const { tab } = await openTable();
    const o1 = await order(tab.id, [line(fxA.pPlain)]);
    const o2 = await order(tab.id, [line(fxA.pPlain)]);
    const byOrder = await rpc("cashierA", "record_payment", { p_order: o1.id, p_method: "CASH", p_amount_cents: 1000 });
    expectOk(byOrder);
    expect(byOrder.data).toMatchObject({ ok: true, payment: { order_id: o1.id, tab_id: tab.id }, order: { paid_cents: 1000, remaining_cents: 0, payment_status: "PAID" }, balance: { consumed_cents: 2000, paid_cents: 1000, remaining_cents: 1000 } });
    expectRule(await rpc("cashierA", "record_payment", { p_order: o1.id, p_method: "CASH", p_amount_cents: 1 }), /OVERPAYMENT/); // o pedido já está quitado
    expectOk(await pay("cashierA", tab.id, 1000));
    const rows2 = rows(await admin().from("orders").select("id,payment_status").in("id", [o1.id, o2.id]));
    expect(rows2.find((r) => r.id === o1.id)?.payment_status).toBe("PAID");
    expect(rows2.find((r) => r.id === o2.id)?.payment_status).toBe("UNPAID"); // pagamento por comanda não rateia entre pedidos
    expect(((await balance("cashierA", tab.id)).data as any)).toMatchObject({ paid_cents: 2000, remaining_cents: 0 });
  });

  it("pagamento de pedido de entrega/retirada (p_order): parcial -> PENDING, total -> PAID, excesso => OVERPAYMENT, troco calculado", async () => {
    const delivery = await makeOrder(cleanup, A().id, { status: "CONFIRMED", fulfillment: "DELIVERY", totalCents: 3000 });
    const p1 = await rpc("cashierA", "record_payment", { p_order: delivery.id, p_method: "PIX", p_amount_cents: 1000 });
    expectOk(p1);
    expect(p1.data).toMatchObject({ ok: true, payment: { order_id: delivery.id, tab_id: null, amount_cents: 1000 }, order: { total_cents: 3000, paid_cents: 1000, remaining_cents: 2000, payment_status: "PENDING" } });
    expect((p1.data as any).balance).toBeUndefined(); // sem comanda
    expect((await admin().from("orders").select("payment_status").eq("id", delivery.id).single()).data?.payment_status).toBe("PENDING");
    expectRule(await rpc("cashierA", "record_payment", { p_order: delivery.id, p_method: "PIX", p_amount_cents: 2001 }), /OVERPAYMENT/);
    expectRule(await rpc("waiterA", "record_payment", { p_order: delivery.id, p_method: "PIX", p_amount_cents: 100 }), /FORBIDDEN/);
    const p2 = await rpc("managerA", "record_payment", { p_order: delivery.id, p_method: "CASH", p_amount_cents: 2000, p_tendered_cents: 5000 });
    expectOk(p2);
    expect((p2.data as any).payment).toMatchObject({ change_cents: 3000, tendered_cents: 5000 });
    expect((p2.data as any).order).toMatchObject({ paid_cents: 3000, remaining_cents: 0, payment_status: "PAID" });
    expect((await admin().from("orders").select("payment_status").eq("id", delivery.id).single()).data?.payment_status).toBe("PAID");

    const pickup = await makeOrder(cleanup, A().id, { status: "READY", fulfillment: "PICKUP", totalCents: 1800 });
    const p3 = await rpc("cashierA", "record_payment", { p_order: pickup.id, p_method: "DEBIT", p_amount_cents: 1800 });
    expect(p3.data).toMatchObject({ order: { payment_status: "PAID", remaining_cents: 0 } });
  });

  it("idempotente por p_reference: repetição devolve o MESMO pagamento (idempotent_replay), mesmo com a comanda já fechada; divergência => IDEMPOTENCY_CONFLICT", async () => {
    const { tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain, 2)]);
    await complete(o.id);
    const r = ref();
    const first = await pay("cashierA", tab.id, 1200, { p_reference: r });
    expectOk(first);
    expect(first.data).toMatchObject({ ok: true, idempotent_replay: false, payment: { reference: r } });
    const again = await pay("cashierA", tab.id, 1200, { p_reference: r });
    expectOk(again);
    expect(again.data).toMatchObject({ ok: true, idempotent_replay: true });
    expect((again.data as any).payment.id).toBe((first.data as any).payment.id);
    expect((again.data as any).balance).toMatchObject({ paid_cents: 1200, remaining_cents: 800 });
    // outro usuário da equipe com a mesma referência também recebe o mesmo pagamento
    expect(((await pay("managerA", tab.id, 1200, { p_reference: r })).data as any).payment.id).toBe((first.data as any).payment.id);
    expect(rows(await admin().from("payments").select("id,idempotency_key,provider,recorded_by").eq("tab_id", tab.id))).toEqual([
      { id: (first.data as any).payment.id, idempotency_key: `MANUAL:${r}`, provider: "MANUAL", recorded_by: U("cashierA") },
    ]);
    expect(await auditFor((first.data as any).payment.id, "payment.recorded")).toHaveLength(1); // a repetição não duplica auditoria

    // divergências com a mesma referência
    expectRule(await pay("cashierA", tab.id, 1000, { p_reference: r }), /IDEMPOTENCY_CONFLICT/); // valor
    expectRule(await pay("cashierA", tab.id, 1200, { p_reference: r, p_method: "CASH" }), /IDEMPOTENCY_CONFLICT/); // forma
    const other = await openCounter();
    expectRule(await pay("cashierA", other.id, 1200, { p_reference: r }), /IDEMPOTENCY_CONFLICT/); // outra comanda
    expectRule(await rpc("cashierA", "record_payment", { p_order: o.id, p_method: "PIX", p_amount_cents: 1200, p_reference: r }), /IDEMPOTENCY_CONFLICT/); // outro alvo

    // fecha com justificativa; a repetição continua devolvendo o pagamento original
    expectOk(await closeTab("cashierA", tab.id, "restante perdoado pelo gerente (teste)"));
    const late = await pay("cashierA", tab.id, 1200, { p_reference: r });
    expectOk(late);
    expect(late.data).toMatchObject({ ok: true, idempotent_replay: true });
    // mas um pagamento NOVO na comanda fechada é recusado
    expectRule(await pay("cashierA", tab.id, 100, { p_reference: ref() }), /TAB_NOT_OPEN/);
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(1);
  });

  it("a referência é por restaurante: a mesma string no restaurante B é outro pagamento", async () => {
    const r = ref();
    const { tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain)]);
    await complete(o.id);
    expectOk(await pay("cashierA", tab.id, 1000, { p_reference: r }));
    const tableB = await makeTable(cleanup, B().id, { name: `zz-mesa-${uniq()}` });
    const ob = await open("cashierB", tableB.id, null, null, B().id);
    expectOk(ob);
    const tabB = (ob.data as any).tab.id as string;
    cleanup.add(async () => {
      await admin().from("payments").delete().eq("tab_id", tabB);
      await admin().from("orders").delete().eq("tab_id", tabB);
      await admin().from("tabs").delete().eq("id", tabB);
    });
    const oB = await staffOrder("waiterB", tabB, [line(fxB.pPlain)]);
    expectOk(oB);
    expect((oB.data as any).ok).toBe(true);
    const pB = await pay("cashierB", tabB, 1000, { p_reference: r });
    expectOk(pB);
    expect((pB.data as any).idempotent_replay).toBe(false);
  });

  it("tab_id/order_id/valores do cliente não escapam do servidor: o pagamento sempre nasce PAID, MANUAL, com recorded_by = chamador", async () => {
    const { tab } = await openTable();
    const o = await order(tab.id, [line(fxA.pPlain)]);
    const r = await rpc("cashierA", "record_payment", { p_tab: tab.id, p_method: "pix", p_amount_cents: 1000, p_reference: ref(), p_status: "PENDING", p_recorded_by: U("managerA") });
    expect(r.error?.code, "a RPC aceitou parâmetros que não existem na assinatura").toBe("PGRST202");
    const ok = await pay("cashierA", tab.id, 1000, { p_method: " pix " }); // forma é normalizada
    expectOk(ok);
    const p = (await admin().from("payments").select("status,provider,recorded_by,method,paid_at,order_id").eq("id", (ok.data as any).payment.id).single()).data;
    expect(p).toMatchObject({ status: "PAID", provider: "MANUAL", recorded_by: U("cashierA"), method: "PIX", order_id: null });
    expect(p!.paid_at).not.toBeNull();
    expect(o.total_cents).toBe(1000);
  });
});

// =====================================================================================================================
describe("close_tab: idempotência e fechamento com justificativa auditada", () => {
  it("repetir close_tab devolve unchanged:true sem novo efeito (nem auditoria nem mudança de mesa)", async () => {
    const { table, tab, o } = await tabWithConsumption(1);
    expectOk(await pay("cashierA", tab.id, 1000));
    const c1 = await closeTab("cashierA", tab.id);
    expect(c1.data).toMatchObject({ ok: true, unchanged: false, table_status: "CLEANING" });
    const closedRow = await tabRow(tab.id);
    expectOk(await setTable("cashierA", table.id, "AVAILABLE"));
    const c2 = await closeTab("managerA", tab.id);
    expectOk(c2);
    expect(c2.data).toMatchObject({ ok: true, unchanged: true, unpaid_cents: 0 });
    expect(await tabRow(tab.id)).toEqual(closedRow); // closed_by/closed_at não mudam
    expect((await tableRow(table.id)).status).toBe("AVAILABLE"); // a repetição não re-suja a mesa
    expect(await auditFor(tab.id, "tab.closed")).toHaveLength(1);
    expect(o.id).toBeTruthy();
  });

  it("fechar com saldo exige justificativa (10..500) e payments.record+tabs.manage; grava unpaid_cents/unpaid_reason e auditoria tab.closed_unpaid", async () => {
    const { table, tab } = await tabWithConsumption(3);
    expectOk(await pay("cashierA", tab.id, 1000));
    const reason = "cliente saiu sem pagar o restante (teste)";
    const c = await closeTab("cashierA", tab.id, `  ${reason}  `);
    expectOk(c);
    expect(c.data).toMatchObject({ ok: true, unchanged: false, unpaid_cents: 2000, table_status: "CLEANING", balance: { remaining_cents: 2000, tab: { status: "CLOSED", unpaid_cents: 2000, unpaid_reason: reason } } });
    expect(await tabRow(tab.id)).toMatchObject({ status: "CLOSED", total_cents: 3000, unpaid_cents: 2000, unpaid_reason: reason, closed_by: U("cashierA") });
    expect((await tableRow(table.id)).status).toBe("CLEANING");
    const logs = await auditFor(tab.id, "tab.closed_unpaid");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_id: U("cashierA"), restaurant_id: A().id, metadata: { consumed_cents: 3000, paid_cents: 1000, unpaid_cents: 2000, unpaid_reason: reason, table_id: table.id } });
    // a repetição é no-op e mantém a justificativa original
    expect((await closeTab("cashierA", tab.id, "outra justificativa qualquer")).data).toMatchObject({ unchanged: true, unpaid_cents: 2000 });
    expect((await tabRow(tab.id)).unpaid_reason).toBe(reason);
    expect(await auditFor(tab.id)).toEqual(expect.not.arrayContaining([expect.objectContaining({ action: "tab.closed" })]));
  });

  it("sem saldo a justificativa é descartada (unpaid_reason fica nulo) e a ação auditada é tab.closed", async () => {
    const { tab } = await tabWithConsumption(1);
    expectOk(await pay("cashierA", tab.id, 1000));
    expectOk(await closeTab("managerA", tab.id, "justificativa desnecessária (teste)"));
    expect(await tabRow(tab.id)).toMatchObject({ status: "CLOSED", unpaid_cents: 0, unpaid_reason: null });
    expect(await auditFor(tab.id, "tab.closed")).toHaveLength(1);
    expect(await auditFor(tab.id, "tab.closed_unpaid")).toHaveLength(0);
  });

  it("comanda vazia (sem consumo) fecha sem pagamento; pedidos cancelados/recusados não contam", async () => {
    const empty = await openCounter();
    expect((await closeTab("waiterA", empty.id)).data).toMatchObject({ ok: true, unchanged: false, unpaid_cents: 0 });
    const t = await openCounter();
    const o = await order(t.id, [line(fxA.pPlain, 4)]);
    await cancelOrder(o.id);
    expectOk(await closeTab("waiterA", t.id));
    expect(await tabRow(t.id)).toMatchObject({ status: "CLOSED", total_cents: 0, unpaid_cents: 0 });
  });
});

// =====================================================================================================================
describe("price_cart em modo equipe (create_staff_order) x modo público (validate_cart / create_public_order)", () => {
  const codesOf = (r: { data: any }) => ((r.data?.errors ?? []) as any[]).map((e) => e.code);
  const publicQuote = (items: unknown[], fulfillment = "PICKUP") => anon().rpc("validate_cart", { p_slug: A().slug, p_fulfillment: fulfillment, p_items: items, p_delivery_zone_id: null });
  const publicOrder = (items: unknown[]) =>
    admin().rpc("create_public_order", {
      p_slug: A().slug,
      p_fulfillment: "PICKUP",
      p_items: items,
      p_customer: { name: "zz-Maria Souza", phone: "11988887777", email: null },
      p_address: null,
      p_delivery_zone_id: null,
      p_notes: null,
      p_idempotency_key: `zz-t22-pub-${uniq()}`,
      p_payment: { method: "PIX" },
    });

  it("equipe ignora horário, accepts_orders e pedido mínimo; o cardápio público continua recusando (regressão de validate_cart/create_public_order)", async () => {
    const { tab } = await openTable();
    try {
      await setOpenToday(A().id, false);
      await setSettings(A().id, { accepts_orders: false, min_order_cents: 100_000 });

      // público: recusado
      const q = await publicQuote([line(fxA.pPlain)]);
      expect(q.error).toBeNull();
      expect(q.data).toMatchObject({ ok: false });
      expect(codesOf(q)).toContain("RESTAURANT_CLOSED");
      const before = rows(await admin().from("orders").select("id").eq("restaurant_id", A().id).like("idempotency_key", "zz-t22-pub-%")).length;
      const pub = await publicOrder([line(fxA.pPlain)]);
      expect(pub.error).toBeNull();
      expect(pub.data).toMatchObject({ ok: false });
      expect(codesOf(pub)).toContain("RESTAURANT_CLOSED");
      expect(rows(await admin().from("orders").select("id").eq("restaurant_id", A().id).like("idempotency_key", "zz-t22-pub-%")).length).toBe(before);

      // equipe: aceita (R$ 10,00 < mínimo de R$ 1.000,00, restaurante fechado e pausado)
      const o = await order(tab.id, [line(fxA.pPlain)]);
      expect(o.total_cents).toBe(1000);
    } finally {
      await setOpenToday(A().id, true);
      await setSettings(A().id, { accepts_orders: true, min_order_cents: 0 });
    }
    // controle: reaberto, o público volta a aceitar
    expect((await publicQuote([line(fxA.pPlain)])).data).toMatchObject({ ok: true });
  });

  it("equipe mantém as regras de produto/variante/adicional: nada é gravado e os códigos são os do cardápio", async () => {
    const { tab } = await openTable();
    const cases: Array<[string, unknown[], string | RegExp]> = [
      ["produto de B", [line(fxB.pPlain)], /./],
      ["variante exigida e ausente", [line(pVar)], "VARIANT_REQUIRED"],
      ["variante de outro produto", [line(pVar, 1, { variant_id: vOther.id })], /VARIANT_/],
      ["grupo min 1 sem adicional", [line(fxA.pGrp)], "MODIFIER_GROUP_MIN"],
      ["grupo max 2 com 3 adicionais", [line(fxA.pGrp, 1, { modifier_ids: [fxA.m1.id, fxA.m2.id, fxA.m6.id] })], "MODIFIER_GROUP_MAX"],
      ["adicional indisponível", [line(fxA.pGrp, 1, { modifier_ids: [fxA.m3.id] })], /MODIFIER_UNAVAILABLE|MODIFIER_NOT_ALLOWED/],
      ["adicional de grupo não vinculado ao produto", [line(fxA.pGrp, 1, { modifier_ids: [fxA.m7.id] })], "MODIFIER_NOT_ALLOWED"],
      ["produto indisponível", [line(fxA.pUnavail)], "PRODUCT_UNAVAILABLE"],
      ["produto inativo", [line(fxA.pInactive)], /PRODUCT_/],
      ["quantidade 0", [line(fxA.pPlain, 0)], "INVALID_QUANTITY"],
      ["quantidade 100", [line(fxA.pPlain, 100)], "INVALID_QUANTITY"],
      ["carrinho vazio", [], "EMPTY_CART"],
    ];
    for (const [what, items, code] of cases) {
      const r = await staffOrder("waiterA", tab.id, items);
      expect(r.error, `${what}: ${JSON.stringify(r.error)}`).toBeNull();
      expect(r.data, what).toMatchObject({ ok: false });
      const got = codesOf(r);
      expect(got.length, what).toBeGreaterThan(0);
      if (typeof code === "string") expect(got, what).toContain(code);
      else expect(got.join(","), what).toMatch(code);
    }
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(0);
    // produto de B é indistinguível de inexistente
    const ghost = await staffOrder("waiterA", tab.id, [line({ id: "00000000-0000-4000-8000-00000000dead" })]);
    const foreign = await staffOrder("waiterA", tab.id, [line(fxB.pPlain)]);
    expect(codesOf(foreign)).toEqual(codesOf(ghost));
    expect((foreign.data as any).errors[0].message).toBe((ghost.data as any).errors[0].message);
  });

  it("variantes e adicionais válidos entram no total; preços do cliente são ignorados", async () => {
    const { tab } = await openTable();
    const forged = { unit_price_cents: 1, price_cents: 1, total_cents: 1, line_total_cents: 1, price_delta_cents: -500 };
    const a = await order(tab.id, [line(pVar, 1, { variant_id: vG.id, ...forged })]);
    expect(a.total_cents).toBe(2000);
    const b = await order(tab.id, [line(pVar, 2, { variant_id: vP.id }), line(fxA.pGrp, 1, { modifier_ids: [fxA.m6.id], ...forged })]);
    expect(b.total_cents).toBe(2 * 1000 + 1000 + 50);
    const items = rows(await admin().from("order_items").select("product_name,variant_name_snapshot,unit_price_cents,quantity,line_total_cents").eq("order_id", a.id));
    expect(items).toEqual([{ product_name: pVar.name, variant_name_snapshot: "G", unit_price_cents: 2000, quantity: 1, line_total_cents: 2000 }]);
  });

  it("modalidade DINE_IN desabilitada no restaurante continua recusando (FULFILLMENT_DISABLED)", async () => {
    const { tab } = await openTable();
    try {
      await setSettings(A().id, { enabled_fulfillment_types: ["PICKUP", "DELIVERY"] });
      const r = await staffOrder("waiterA", tab.id, [line(fxA.pPlain)]);
      expect(r.data).toMatchObject({ ok: false });
      expect(codesOf(r)).toContain("FULFILLMENT_DISABLED");
    } finally {
      await setSettings(A().id, { enabled_fulfillment_types: BASE_FULFILLMENT });
    }
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(0);
  });
});

// =====================================================================================================================
describe("create_staff_order idempotente (p_idempotency_key, mig. 0123)", () => {
  it("repetição sequencial devolve o pedido original com idempotent_replay:true e não duplica o consumo", async () => {
    const { tab } = await openTable();
    const k = ikey();
    const first = await staffOrder("waiterA", tab.id, [line(fxA.pPlain, 2)], { p_idempotency_key: k });
    expectOk(first);
    expect(first.data).toMatchObject({ ok: true, idempotent_replay: false, order: { total_cents: 2000 } });
    const second = await staffOrder("waiterA", tab.id, [line(fxA.pPlain, 2)], { p_idempotency_key: k });
    expectOk(second);
    expect(second.data).toMatchObject({ ok: true, idempotent_replay: true, order: { id: (first.data as any).order.id, total_cents: 2000, status: "CONFIRMED" }, balance: { consumed_cents: 2000 } });
    // outro membro com a mesma chave recebe o mesmo pedido
    expect(((await staffOrder("cashierA", tab.id, [line(fxA.pPlain, 2)], { p_idempotency_key: k })).data as any).order.id).toBe((first.data as any).order.id);
    expect(rows(await admin().from("orders").select("id,idempotency_key").eq("tab_id", tab.id))).toEqual([{ id: (first.data as any).order.id, idempotency_key: `STAFF:${tab.id}:${k}` }]);
    expect(await auditFor((first.data as any).order.id, "order.staff_created")).toHaveLength(1);
    // [documentado, igual ao F-36/F-31] a mesma chave com ITENS diferentes devolve o original sem avisar
    const diff = await staffOrder("waiterA", tab.id, [line(fxA.pPlain, 9)], { p_idempotency_key: k });
    expect(diff.data).toMatchObject({ ok: true, idempotent_replay: true, order: { id: (first.data as any).order.id, total_cents: 2000 } });
  });

  it("8 chamadas simultâneas com a mesma chave => 1 pedido (7 replays); a chave é por comanda", async () => {
    const { tab } = await openTable();
    const other = await openCounter();
    const k = ikey();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => staffOrder((["waiterA", "cashierA", "managerA"] as const)[i % 3], tab.id, [line(fxA.pPlain)], { p_idempotency_key: k })));
    for (const r of results) {
      expectOk(r);
      expect((r.data as any).ok).toBe(true);
    }
    const ids = new Set(results.map((r) => (r.data as any).order.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => (r.data as any).idempotent_replay === false)).toHaveLength(1);
    expect(results.filter((r) => (r.data as any).idempotent_replay === true)).toHaveLength(7);
    expect(rows(await admin().from("orders").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    expect((await balance("cashierA", tab.id)).data).toMatchObject({ consumed_cents: 1000 });
    // a mesma chave em OUTRA comanda é outro pedido
    const o2 = await staffOrder("waiterA", other.id, [line(fxA.pPlain)], { p_idempotency_key: k });
    expect((o2.data as any).idempotent_replay).toBe(false);
    expect((o2.data as any).order.id).not.toBe([...ids][0]);
  });

  it("a chamada antiga de 3 argumentos (sem chave) continua válida e nunca é replay; chave só vale para quem tem permissão", async () => {
    const { tab } = await openTable();
    const a = await rpc("waiterA", "create_staff_order", { p_tab: tab.id, p_items: [line(fxA.pPlain)], p_notes: "mesa 3" });
    const b = await rpc("waiterA", "create_staff_order", { p_tab: tab.id, p_items: [line(fxA.pPlain)], p_notes: null });
    expectOk(a);
    expectOk(b);
    expect((a.data as any).idempotent_replay).toBe(false);
    expect((b.data as any).idempotent_replay).toBe(false);
    expect((a.data as any).order.id).not.toBe((b.data as any).order.id);
    expect(rows(await admin().from("orders").select("id,idempotency_key,notes").eq("tab_id", tab.id)).map((o) => o.idempotency_key)).toEqual([null, null]);
    // sem permissão a chave não revela nada
    const k = ikey();
    expectOk(await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k }));
    expectRule(await staffOrder("kitchenA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k }), /FORBIDDEN/);
    expectRule(await staffOrder("managerB", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k }), /TAB_NOT_FOUND/);
  });

  it("o replay sobrevive ao fechamento da comanda (retry após perder a resposta não vira TAB_NOT_OPEN)", async () => {
    const { tab } = await openTable();
    const k = ikey();
    const first = await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k });
    const id = (first.data as any).order.id as string;
    await complete(id);
    expectOk(await pay("cashierA", tab.id, 1000));
    expectOk(await closeTab("cashierA", tab.id));
    const late = await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: k });
    expectOk(late);
    expect(late.data).toMatchObject({ ok: true, idempotent_replay: true, order: { id, status: "COMPLETED" }, balance: { tab: { status: "CLOSED" } } });
    // chave nova em comanda fechada continua recusada
    expectRule(await staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: ikey() }), /TAB_NOT_OPEN/);
  });
});

// =====================================================================================================================
describe("request_tab_print (PARTIAL_BILL / FINAL_BILL) e mark_print_job", () => {
  const PII = /customer|phone|e-?mail|@|cliente|teste automatizado|\b\d{10,13}\b/i;

  it("PARTIAL_BILL: payload montado no servidor, itens consolidados, pagamentos e saldo; sem telefone/e-mail/nome de cliente", async () => {
    const { table, tab } = await openTable("waiterA", 4);
    const o1 = await order(tab.id, [line(fxA.pPlain, 1)]);
    const o2 = await order(tab.id, [line(fxA.pPlain, 2)]);
    const o3 = await order(tab.id, [line(fxA.pGrp, 1, { modifier_ids: [fxA.m1.id] })]); // 1100
    // pedido com dados de cliente (criado via service role) vinculado à comanda: nada disso pode aparecer na conta
    const withCustomer = await makeOrder(cleanup, A().id, { tabId: tab.id, tableId: table.id, fulfillment: "DINE_IN", totalCents: 3000 });
    await admin().from("orders").update({ customer_phone: "11977776666", customer_email: "zz.cliente@example.test" }).eq("id", withCustomer.id);
    expect(o1.id && o2.id && o3.id).toBeTruthy();
    expectOk(await pay("cashierA", tab.id, 1000));
    expectOk(await pay("cashierA", tab.id, 500, { p_method: "CASH", p_tendered_cents: 1000 }));

    const r = await printTab("waiterA", tab.id, "PARTIAL_BILL");
    expectOk(r);
    const d = r.data as any;
    expect(d).toMatchObject({ ok: true, status: "REQUESTED" });
    const p = d.payload;
    // contrato x app: o schema do documento aceita a resposta real e os totais calculados batem com os do servidor
    const parsedBill = requestTabPrintResultSchema.safeParse(d);
    expect(parsedBill.success, JSON.stringify(parsedBill.error?.issues)).toBe(true);
    expect(billTotals(parsedBill.data!.payload)).toMatchObject({ subtotalCents: 7100, paidCents: 1500, remainingCents: 5600 });
    expect(p).toMatchObject({ document_type: "PARTIAL_BILL", restaurant_name: A().name, subtotal_cents: 7100, paid_cents: 1500, remaining_cents: 5600 });
    expect(p.tab).toMatchObject({ status: "OPEN", table_name: table.name, guests: 4, closed_at_local: null });
    expect(p.printed_at_local).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(p).not.toHaveProperty("total_cents"); // total/unpaid só em comanda CLOSED
    // itens consolidados: pPlain (1 + 2) vira uma linha
    const plain = (p.items as any[]).filter((i) => i.name === fxA.pPlain.name);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ quantity: 3, line_total_cents: 3000 });
    expect((p.items as any[]).find((i) => i.name === fxA.pGrp.name)).toMatchObject({ quantity: 1, line_total_cents: 1100 });
    expect(p.orders).toHaveLength(4);
    expect(p.payments).toHaveLength(2);
    expect(p.payments[0]).toMatchObject({ method: "PIX", amount_cents: 1000, change_cents: null });
    expect(p.payments[1]).toMatchObject({ method: "CASH", amount_cents: 500, tendered_cents: 1000, change_cents: 500 });
    // PII: nada de cliente na conta
    expect(JSON.stringify(p)).not.toMatch(PII);
    const keys = new Set<string>();
    JSON.stringify(p, (k, v) => (keys.add(k), v));
    for (const forbidden of ["customer_name", "customer_phone", "customer_email", "phone", "email", "address", "delivery_address", "idempotency_key", "created_by", "opened_by", "recorded_by"]) expect(keys.has(forbidden), forbidden).toBe(false);

    // persistência
    const job = (await admin().from("print_jobs").select("*").eq("id", d.job_id).single()).data as any;
    expect(job).toMatchObject({ restaurant_id: A().id, tab_id: tab.id, order_id: null, document_type: "PARTIAL_BILL", status: "REQUESTED", requested_by: U("waiterA"), printed_at: null });
    expect(job.payload).toEqual(p);
    expect(await auditFor(d.job_id, "print.requested")).toHaveLength(1);
  });

  it("FINAL_BILL vale em comanda OPEN e CLOSED (CLOSED traz total/saldo em aberto); PARTIAL_BILL só em OPEN; CANCELLED => TAB_NOT_BILLABLE", async () => {
    const { tab } = await tabWithConsumption(2);
    expectOk(await pay("cashierA", tab.id, 500));
    const openFinal = await printTab("cashierA", tab.id, "final_bill");
    expectOk(openFinal);
    expect((openFinal.data as any).payload).toMatchObject({ document_type: "FINAL_BILL", subtotal_cents: 2000, paid_cents: 500, remaining_cents: 1500 });
    expect((openFinal.data as any).payload).not.toHaveProperty("total_cents");
    expectOk(await closeTab("cashierA", tab.id, "cliente pagará depois, autorizado (teste)"));
    const closedFinal = await printTab("cashierA", tab.id, "FINAL_BILL");
    expectOk(closedFinal);
    const p = (closedFinal.data as any).payload;
    expect(p).toMatchObject({ document_type: "FINAL_BILL", total_cents: 2000, unpaid_cents: 1500, remaining_cents: 1500 });
    expect(p.tab.status).toBe("CLOSED");
    expect(p.tab.closed_at_local).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(JSON.stringify(p)).not.toMatch(/justificativa|autorizado|unpaid_reason/i); // a justificativa interna não vai para o papel do cliente
    expectRule(await printTab("cashierA", tab.id, "PARTIAL_BILL"), /TAB_NOT_OPEN/);

    const cancelled = await openCounter();
    expectOk(await cancelTab("managerA", cancelled.id));
    for (const t of ["PARTIAL_BILL", "FINAL_BILL"]) expectRule(await printTab("cashierA", cancelled.id, t), /TAB_NOT_BILLABLE/);
    for (const t of ["KITCHEN_TICKET", "RECEIPT", "x", ""]) expectRule(await printTab("cashierA", tab.id, t), /INVALID_DOCUMENT_TYPE/);
    expect(rows(await admin().from("print_jobs").select("id").eq("tab_id", cancelled.id))).toHaveLength(0);
  });

  it("permissões: print.request (garçom/caixa/gerente) pede; cozinha e dono não; sem print.request via override => FORBIDDEN", async () => {
    const { tab } = await openTable();
    for (const who of ["waiterA", "cashierA", "managerA"] as const) expectOk(await printTab(who, tab.id, "PARTIAL_BILL"));
    for (const who of ["kitchenA", "ownerA"] as const) expectRule(await printTab(who, tab.id, "PARTIAL_BILL"), /FORBIDDEN|TAB_NOT_FOUND/);
    const jobs = rows(await admin().from("print_jobs").select("requested_by").eq("tab_id", tab.id));
    expect(jobs.map((j) => j.requested_by).sort()).toEqual([U("waiterA"), U("cashierA"), U("managerA")].sort());
  });

  it("mark_print_job: só o solicitante marca (DISPATCHED/FAILED); PRINTED nunca vem do cliente", async () => {
    const { tab } = await openTable();
    const job = ((await printTab("waiterA", tab.id, "PARTIAL_BILL")).data as any).job_id as string;
    const mark = (who: AccountKey, status: string) => rpc(who, "mark_print_job", { p_job: job, p_status: status });
    const stranger = await mark("cashierA", "DISPATCHED");
    expect(stranger.error, "outro usuário marcou o job do garçom").not.toBeNull();
    expect((await admin().from("print_jobs").select("status").eq("id", job).single()).data?.status).toBe("REQUESTED");
    expectRule(await mark("waiterA", "PRINTED"), /INVALID_PRINT_STATUS/);
    expect((await mark("waiterA", "DISPATCHED")).data).toMatchObject({ ok: true, status: "DISPATCHED" });
    expect((await admin().from("print_jobs").select("status,dispatched_at,printed_at").eq("id", job).single()).data).toMatchObject({ status: "DISPATCHED", printed_at: null });
  });
});

// =====================================================================================================================
describe("rotate_table_qr e grants de coluna (F-03)", () => {
  it("rotate_table_qr: tables.manage (dono/gerente) troca o token no servidor; garçom/caixa/cozinha negados; o token nunca vai para audit_logs", async () => {
    const t = await makeTable(cleanup, A().id, { name: `zz-mesa-qr-${uniq()}` });
    const readToken = async () => (await admin().from("restaurant_tables").select("qr_token").eq("id", t.id).single()).data!.qr_token as string;
    const original = await readToken();
    for (const who of ["waiterA", "cashierA", "kitchenA"] as const) expectRule(await rpc(who, "rotate_table_qr", { p_table: t.id }), /FORBIDDEN/);
    expect(await readToken()).toBe(original);

    const seen = new Set<string>([original]);
    for (const who of ["managerA", "ownerA", "managerA"] as const) {
      const r = await rpc(who, "rotate_table_qr", { p_table: t.id });
      expectOk(r);
      const tok = (r.data as any).qr_token as string;
      expect(tok).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(seen.has(tok), "token repetido").toBe(false);
      seen.add(tok);
      expect(await readToken()).toBe(tok);
    }
    // auditoria registra QUE houve rotação, nunca o token
    const logs = await auditFor(t.id, "table.qr_rotated");
    expect(logs).toHaveLength(3);
    for (const l of logs) for (const tok of seen) expect(JSON.stringify(l)).not.toContain(tok);
    const all = rows(await admin().from("audit_logs").select("metadata").eq("restaurant_id", A().id).order("created_at", { ascending: false }).limit(200));
    for (const l of all) for (const tok of seen) expect(JSON.stringify(l.metadata ?? {})).not.toContain(tok);
    // mesa de outro restaurante
    expectRule(await rpc("managerB", "rotate_table_qr", { p_table: t.id }), /TABLE_NOT_FOUND/);
  });

  it("clientes não gravam qr_token nem status de mesa/comanda; tabs não aceita INSERT; só label/guests são editáveis", async () => {
    const { table, tab } = await openTable();
    const tok = (await admin().from("restaurant_tables").select("qr_token").eq("id", table.id).single()).data!.qr_token;
    for (const who of ["ownerA", "managerA"] as const) {
      expectDenied(await as(who).from("restaurant_tables").update({ qr_token: "ZZFORJADO12345678" }).eq("id", table.id).select("id"), /42501|permission denied/i);
      expectDenied(await as(who).from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-${uniq()}`, qr_token: "ZZFORJADO12345678" }).select("id"), /42501|permission denied/i);
      expectDenied(await as(who).from("restaurant_tables").update({ status: "AVAILABLE" }).eq("id", table.id).select("id"), /42501|permission denied/i);
    }
    expectDenied(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", tab.id).select("id"), /42501|permission denied/i);
    expectDenied(await as("cashierA").from("tabs").insert({ restaurant_id: A().id, label: "zz-direto" }).select("id"), /42501|permission denied|row-level security/i);
    expect((await admin().from("restaurant_tables").select("qr_token,status").eq("id", table.id).single()).data).toEqual({ qr_token: tok, status: "OCCUPIED" });
    expect((await tabRow(tab.id)).status).toBe("OPEN");
    expect(rows(await admin().from("tabs").select("id").eq("label", "zz-direto"))).toHaveLength(0);
  });
});


// =====================================================================================================================
describe("concorrência real (Promise.all contra o banco, clientes autenticados)", () => {
  const noDeadlock = (results: Array<{ error: { code?: string; message: string } | null }>) => {
    for (const r of results) {
      if (r.error) {
        expect(r.error.code, r.error.message).not.toBe("40P01");
        expect(r.error.message).not.toMatch(/deadlock|could not serialize|serialization/i);
      }
    }
  };
  const sumPaid = async (tab: string) => rows(await admin().from("payments").select("amount_cents,status").eq("tab_id", tab)).filter((p) => p.status === "PAID").reduce((s, p) => s + p.amount_cents, 0);

  it("abertura simultânea na mesma mesa (6 chamadas, 3 papéis) => 1 comanda; as demais TABLE_HAS_OPEN_TAB", async () => {
    const table = await makeTable(cleanup, A().id, { name: `zz-mesa-${uniq()}` });
    const who = ["waiterA", "cashierA", "managerA", "waiterA", "cashierA", "managerA"] as const;
    const results = await Promise.all(who.map((w) => open(w, table.id, `zz-conc-${uniq()}`)));
    noDeadlock(results as any);
    const ok = results.filter((r) => !r.error);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expectRule(r, /TABLE_HAS_OPEN_TAB/);
    const tabId = (ok[0].data as any).tab.id as string;
    track(tabId);
    const tabs = rows(await admin().from("tabs").select("id,status").eq("table_id", table.id));
    expect(tabs).toEqual([{ id: tabId, status: "OPEN" }]);
    expect((await tableRow(table.id)).status).toBe("OCCUPIED");
  });

  it("pagamento x fechamento (com justificativa) nos dois sentidos: sem deadlock e saldo/inadimplência sempre consistentes", async () => {
    for (const order of ["pay-first", "close-first", "pay-first", "close-first", "pay-first", "close-first"] as const) {
      const { tab } = await tabWithConsumption(5);
      const doPay = () => pay("cashierA", tab.id, 5000, { p_reference: ref() });
      const doClose = () => closeTab("managerA", tab.id, "fechamento concorrente com saldo (teste)");
      const [a, b] = order === "pay-first" ? await Promise.all([doPay(), doClose()]) : await Promise.all([doClose(), doPay()]);
      const payRes = order === "pay-first" ? a : b;
      const closeRes = order === "pay-first" ? b : a;
      noDeadlock([a, b] as any);
      expect(closeRes.error, JSON.stringify(closeRes.error)).toBeNull(); // com justificativa o fechamento sempre acontece
      const row = await tabRow(tab.id);
      const paid = await sumPaid(tab.id);
      expect(row.status).toBe("CLOSED");
      if (payRes.error) {
        expectRule(payRes, /TAB_NOT_OPEN/); // o pagamento chegou depois do fechamento
        expect(paid).toBe(0);
        expect(row).toMatchObject({ unpaid_cents: 5000, total_cents: 5000 });
        expect(row.unpaid_reason).toBeTruthy();
      } else {
        expect(paid).toBe(5000); // o pagamento entrou antes: nada ficou em aberto
        expect(row).toMatchObject({ unpaid_cents: 0, unpaid_reason: null, total_cents: 5000 });
      }
      expect(row.unpaid_cents).toBe(5000 - paid); // invariante: inadimplência = consumo - pago, nunca divergente
    }
  });

  it("pagamento x fechamento SEM justificativa: ou fecha quitado, ou recusa TAB_UNPAID e o pagamento entra; nunca fecha com saldo escondido", async () => {
    for (const order of ["pay-first", "close-first", "pay-first", "close-first"] as const) {
      const { tab } = await tabWithConsumption(3);
      const doPay = () => pay("cashierA", tab.id, 3000, { p_reference: ref() });
      const doClose = () => closeTab("cashierA", tab.id);
      const [a, b] = order === "pay-first" ? await Promise.all([doPay(), doClose()]) : await Promise.all([doClose(), doPay()]);
      const payRes = order === "pay-first" ? a : b;
      const closeRes = order === "pay-first" ? b : a;
      noDeadlock([a, b] as any);
      expectOk(payRes); // o pagamento nunca falha: ou entra antes do fechamento, ou o fechamento recusou
      const row = await tabRow(tab.id);
      if (closeRes.error) {
        expectRule(closeRes, /TAB_UNPAID/);
        expect(row.status).toBe("OPEN");
        expectOk(await closeTab("cashierA", tab.id)); // agora quitado
      } else {
        expect((closeRes.data as any).unpaid_cents).toBe(0);
      }
      const final = await tabRow(tab.id);
      expect(final).toMatchObject({ status: "CLOSED", unpaid_cents: 0, total_cents: 3000 });
      expect(await sumPaid(tab.id)).toBe(3000);
    }
  });

  it("pagamento por pedido (p_order) x fechamento: mesma ordem de locks (comanda -> pedido), sem deadlock", async () => {
    for (const first of ["pay", "close", "pay", "close"] as const) {
      const { tab, o } = await tabWithConsumption(2);
      const doPay = () => rpc("cashierA", "record_payment", { p_order: o.id, p_method: "PIX", p_amount_cents: 2000, p_reference: ref() });
      const doClose = () => closeTab("managerA", tab.id, "fechamento concorrente por pedido (teste)");
      const [a, b] = first === "pay" ? await Promise.all([doPay(), doClose()]) : await Promise.all([doClose(), doPay()]);
      const payRes = first === "pay" ? a : b;
      const closeRes = first === "pay" ? b : a;
      noDeadlock([a, b] as any);
      expectOk(closeRes);
      const row = await tabRow(tab.id);
      const paid = rows(await admin().from("payments").select("amount_cents").eq("order_id", o.id)).reduce((s, p) => s + p.amount_cents, 0);
      if (payRes.error) {
        expectRule(payRes, /TAB_NOT_OPEN/);
        expect(paid).toBe(0);
      } else {
        expect(paid).toBe(2000);
        expect((await admin().from("orders").select("payment_status").eq("id", o.id).single()).data?.payment_status).toBe("PAID");
      }
      expect(row.unpaid_cents).toBe(2000 - paid);
    }
  });

  it("6 pagamentos simultâneos com a MESMA referência => 1 pagamento (1 criado + 5 replays)", async () => {
    const { tab } = await tabWithConsumption(4);
    const r = ref();
    const who = ["cashierA", "managerA", "cashierA", "managerA", "cashierA", "managerA"] as const;
    const results = await Promise.all(who.map((w) => pay(w, tab.id, 1500, { p_reference: r })));
    noDeadlock(results as any);
    for (const x of results) expectOk(x);
    expect(results.filter((x) => (x.data as any).idempotent_replay === false)).toHaveLength(1);
    expect(results.filter((x) => (x.data as any).idempotent_replay === true)).toHaveLength(5);
    expect(new Set(results.map((x) => (x.data as any).payment.id)).size).toBe(1);
    expect(rows(await admin().from("payments").select("id").eq("tab_id", tab.id))).toHaveLength(1);
    expect(await sumPaid(tab.id)).toBe(1500);
    expect(await auditFor((results[0].data as any).payment.id, "payment.recorded")).toHaveLength(1);
  });

  it("6 pagamentos distintos de R$ 10,00 numa conta de R$ 30,00 => exatamente 3 entram; 3 recebem OVERPAYMENT; saldo nunca negativo", async () => {
    const { tab } = await tabWithConsumption(3);
    const results = await Promise.all(Array.from({ length: 6 }, () => pay("cashierA", tab.id, 1000, { p_reference: ref() })));
    noDeadlock(results as any);
    expect(results.filter((r) => !r.error)).toHaveLength(3);
    for (const r of results.filter((x) => x.error)) expectRule(r, /OVERPAYMENT/);
    expect(await sumPaid(tab.id)).toBe(3000);
    expect((await balance("cashierA", tab.id)).data).toMatchObject({ consumed_cents: 3000, paid_cents: 3000, remaining_cents: 0, overpaid_cents: 0 });
  });

  it("dois close_tab simultâneos => um fecha (unchanged:false) e o outro devolve unchanged:true; uma única auditoria", async () => {
    const { tab } = await tabWithConsumption(1);
    expectOk(await pay("cashierA", tab.id, 1000));
    const results = await Promise.all([closeTab("cashierA", tab.id), closeTab("managerA", tab.id), closeTab("waiterA", tab.id), closeTab("cashierA", tab.id)]);
    noDeadlock(results as any);
    for (const r of results) expectOk(r);
    expect(results.filter((r) => (r.data as any).unchanged === false)).toHaveLength(1);
    expect(results.filter((r) => (r.data as any).unchanged === true)).toHaveLength(3);
    expect(await auditFor(tab.id, "tab.closed")).toHaveLength(1);
    const winner = (await tabRow(tab.id)).closed_by;
    expect([U("cashierA"), U("managerA"), U("waiterA")]).toContain(winner);
  });

  it("novo pedido x fechamento: nunca sobra comanda CLOSED com pedido em andamento (nem pedido fora do total)", async () => {
    for (const first of ["order", "close", "order", "close", "order", "close"] as const) {
      const { tab } = await tabWithConsumption(1);
      expectOk(await pay("cashierA", tab.id, 1000));
      const doOrder = () => staffOrder("waiterA", tab.id, [line(fxA.pPlain)], { p_idempotency_key: ikey() });
      const doClose = () => closeTab("cashierA", tab.id);
      const [a, b] = first === "order" ? await Promise.all([doOrder(), doClose()]) : await Promise.all([doClose(), doOrder()]);
      const orderRes = first === "order" ? a : b;
      const closeRes = first === "order" ? b : a;
      noDeadlock([a, b] as any);
      const row = await tabRow(tab.id);
      const all = rows(await admin().from("orders").select("status,total_cents").eq("tab_id", tab.id));
      if (closeRes.error) {
        // o pedido entrou primeiro (CONFIRMED) e o fechamento recusou
        expectRule(closeRes, /TAB_HAS_OPEN_ORDERS|TAB_UNPAID/);
        expectOk(orderRes);
        expect(row.status).toBe("OPEN");
        expect(all).toHaveLength(2);
      } else {
        // o fechamento ganhou: o pedido tardio foi recusado
        expectRule(orderRes, /TAB_NOT_OPEN/);
        expect(row.status).toBe("CLOSED");
        expect(all).toHaveLength(1);
        expect(row.total_cents).toBe(1000);
      }
      if (row.status === "CLOSED") expect(all.every((o) => ["COMPLETED", "CANCELLED", "REJECTED"].includes(o.status))).toBe(true);
    }
  });

  it("novo pedido x cancel_tab: comanda CANCELLED nunca tem pedido ativo", async () => {
    for (const first of ["order", "cancel", "order", "cancel"] as const) {
      const tab = await openCounter();
      const doOrder = () => staffOrder("waiterA", tab.id, [line(fxA.pPlain)]);
      const doCancel = () => cancelTab("managerA", tab.id, "cancelamento concorrente (teste)");
      const [a, b] = first === "order" ? await Promise.all([doOrder(), doCancel()]) : await Promise.all([doCancel(), doOrder()]);
      noDeadlock([a, b] as any);
      const orderRes = first === "order" ? a : b;
      const cancelRes = first === "order" ? b : a;
      const row = await tabRow(tab.id);
      const active = rows(await admin().from("orders").select("status").eq("tab_id", tab.id)).filter((o) => !["CANCELLED", "REJECTED"].includes(o.status));
      if (row.status === "CANCELLED") {
        expectOk(cancelRes);
        expect(orderRes.error, JSON.stringify(orderRes.data)).not.toBeNull();
        expect(active).toHaveLength(0);
      } else {
        expect(row.status).toBe("OPEN");
        expectRule(cancelRes, /TAB_HAS_ORDERS/);
        expect(active).toHaveLength(1);
      }
    }
  });

  it("10 pedidos simultâneos na mesma comanda: order_number único e consumo exato", async () => {
    const { tab } = await openTable();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => staffOrder((["waiterA", "cashierA"] as const)[i % 2], tab.id, [line(fxA.pPlain)], { p_idempotency_key: ikey() })));
    noDeadlock(results as any);
    for (const r of results) expectOk(r);
    const numbers = results.map((r) => (r.data as any).order.order_number as number);
    expect(new Set(numbers).size).toBe(10);
    expect((await balance("cashierA", tab.id)).data).toMatchObject({ consumed_cents: 10_000 });
  });
});

// =====================================================================================================================
// Realtime: tabs, restaurant_tables e payments de A chegam à equipe de A e NUNCA à de B (e vice-versa).
// =====================================================================================================================
vi.setConfig({ testTimeout: 150_000 });

interface Ev {
  table: string;
  eventType: string;
  id?: string;
  restaurant_id?: string;
  status?: string;
}
interface Listener {
  events: Ev[];
  channel: RealtimeChannel;
  down: boolean;
}
const rtChannels: Array<{ client: SupabaseClient; channel: RealtimeChannel }> = [];
let activeListeners: Listener[] = [];
beforeEach(() => {
  activeListeners = [];
});

async function listen(client: SupabaseClient, tables: string[]): Promise<Listener> {
  const events: Ev[] = [];
  const channel = client.channel(`rt22-${Math.random().toString(36).slice(2)}`);
  for (const table of tables) {
    channel.on("postgres_changes" as never, { event: "*", schema: "public", table } as never, (payload: any) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old && Object.keys(payload.old).length ? payload.old : {};
      events.push({ table, eventType: payload.eventType, id: row.id, restaurant_id: row.restaurant_id, status: row.status });
    });
  }
  const listener: Listener = { events, channel, down: false };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Realtime não assinou ${tables.join(",")} em 20s`)), 20_000);
    channel.subscribe((status: string, err?: Error) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        listener.down = true; // o Realtime local reinicia o tenant a cada ~5 min; o teste é repetido (retry)
        clearTimeout(timer);
        reject(new Error(`Realtime ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  rtChannels.push({ client, channel });
  activeListeners.push(listener);
  return listener;
}
async function until(cond: () => boolean, what: string, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      if (activeListeners.some((l) => l.down)) throw new Error(`Realtime reiniciou durante o teste (${what}); será repetido`);
      return cond();
    },
    { timeoutMs, what },
  );
}
const count = (l: Listener, table: string) => l.events.filter((e) => e.table === table).length;
const saw = (l: Listener, id: string, table?: string, type?: string) => l.events.some((e) => e.id === id && (!table || e.table === table) && (!type || e.eventType === type));

/** Toca as sondas até todo assinante "vivo" receber algo novo na tabela indicada. */
async function warmUp(alive: Array<{ l: Listener; table: string }>, touch: (round: number) => Promise<unknown>, timeoutMs = 60_000) {
  const baseline = alive.map(({ l, table }) => count(l, table));
  const deadline = Date.now() + timeoutMs;
  for (let round = 1; ; round++) {
    await touch(round);
    const settled = await until(() => alive.every(({ l, table }, i) => count(l, table) > baseline[i]), "aquecimento", 2_500).then(
      () => true,
      (e: Error) => {
        if (/reiniciou/.test(e.message)) throw e;
        return false;
      },
    );
    if (settled) return;
    if (Date.now() > deadline) throw new Error("Realtime não ficou ativo a tempo (aquecimento)");
  }
}

describe("Realtime: tabs, restaurant_tables e payments respeitam o tenant e o RLS de cada assinante", { retry: 3 }, () => {
  afterAll(async () => {
    for (const { client, channel } of rtChannels) await client.removeChannel(channel).catch(() => undefined);
  });

  it("a equipe de A recebe os eventos de comanda, mesa e pagamento de A e NUNCA os de B (e B não recebe os de A); garçom não recebe payments", async () => {
    // sondas para o aquecimento (uma comanda por tenant, via service role)
    const tA = await makeTable(cleanup, A().id, { name: `zz-mesa-rt-${uniq()}` });
    const tB = await makeTable(cleanup, B().id, { name: `zz-mesa-rt-${uniq()}` });
    const probeTabA = await admin().from("tabs").insert({ restaurant_id: A().id, table_id: null, label: `zz-probe-${uniq()}`, opened_by: U("cashierA") }).select("id").single();
    const probeTabB = await admin().from("tabs").insert({ restaurant_id: B().id, table_id: null, label: `zz-probe-${uniq()}`, opened_by: U("cashierB") }).select("id").single();
    expectOk(probeTabA);
    expectOk(probeTabB);
    for (const [rid, id] of [[A().id, probeTabA.data!.id], [B().id, probeTabB.data!.id]] as const) {
      cleanup.add(async () => {
        await admin().from("payments").delete().eq("tab_id", id);
        await admin().from("tabs").delete().eq("id", id);
      });
      expect(rid).toBeTruthy();
    }
    const tables = ["tabs", "restaurant_tables", "payments"];
    const lca = await listen(realtimeAs("cashierA"), tables);
    const lcb = await listen(realtimeAs("cashierB"), tables);
    const lw = await listen(realtimeAs("waiterA"), tables);
    await warmUp(
      [
        { l: lca, table: "tabs" },
        { l: lca, table: "restaurant_tables" },
        { l: lca, table: "payments" },
        { l: lcb, table: "tabs" },
        { l: lcb, table: "restaurant_tables" },
        { l: lcb, table: "payments" },
        { l: lw, table: "tabs" },
        { l: lw, table: "restaurant_tables" },
      ],
      async (n) => {
        for (const [probeTab, table] of [[probeTabA.data!.id, tA], [probeTabB.data!.id, tB]] as const) {
          await admin().from("tabs").update({ guests: (n % 90) + 1 }).eq("id", probeTab);
          await admin().from("restaurant_tables").update({ capacity: (n % 20) + 2 }).eq("id", table.id);
        }
        await admin().from("payments").insert({ restaurant_id: A().id, tab_id: probeTabA.data!.id, method: "CASH", amount_cents: 100, status: "PAID", provider: "MANUAL", idempotency_key: `zz-t22-probe-${uniq()}`, paid_at: new Date().toISOString() });
        await admin().from("payments").insert({ restaurant_id: B().id, tab_id: probeTabB.data!.id, method: "CASH", amount_cents: 100, status: "PAID", provider: "MANUAL", idempotency_key: `zz-t22-probe-${uniq()}`, paid_at: new Date().toISOString() });
      },
    );

    // ---- B primeiro (commits anteriores), A depois: os eventos de A fecham a janela de observação ----
    const mesaB = await makeTable(cleanup, B().id, { name: `zz-mesa-b-${uniq()}` });
    const openB = await open("cashierB", mesaB.id, null, null, B().id);
    expectOk(openB);
    const tabB = (openB.data as any).tab.id as string;
    cleanup.add(async () => {
      await admin().from("payments").delete().eq("tab_id", tabB);
      await admin().from("orders").delete().eq("tab_id", tabB);
      await admin().from("tabs").delete().eq("id", tabB);
    });
    const oB = await staffOrder("waiterB", tabB, [line(fxB.pPlain)]);
    expectOk(oB);
    const payB = await pay("cashierB", tabB, 1000, { p_reference: ref() });
    expectOk(payB);
    const payBId = (payB.data as any).payment.id as string;

    const mesaA = await makeTable(cleanup, A().id, { name: `zz-mesa-a-${uniq()}` });
    const openA = await open("waiterA", mesaA.id);
    expectOk(openA);
    const tabA = (openA.data as any).tab.id as string;
    track(tabA);
    const oA = await order(tabA, [line(fxA.pPlain)]);
    await complete(oA.id);
    const payA = await pay("cashierA", tabA, 1000, { p_reference: ref() });
    expectOk(payA);
    const payAId = (payA.data as any).payment.id as string;
    expectOk(await closeTab("cashierA", tabA)); // tabs UPDATE + restaurant_tables UPDATE (OCCUPIED -> CLEANING)

    await until(
      () =>
        saw(lca, tabA, "tabs", "INSERT") &&
        lca.events.some((e) => e.id === tabA && e.table === "tabs" && e.eventType === "UPDATE" && e.status === "CLOSED") &&
        lca.events.some((e) => e.id === mesaA.id && e.table === "restaurant_tables" && e.status === "CLEANING") &&
        saw(lca, payAId, "payments", "INSERT") &&
        saw(lw, tabA, "tabs") &&
        lw.events.some((e) => e.id === mesaA.id && e.table === "restaurant_tables" && e.status === "OCCUPIED") &&
        saw(lcb, tabB, "tabs", "INSERT") &&
        saw(lcb, payBId, "payments", "INSERT") &&
        lcb.events.some((e) => e.id === mesaB.id && e.table === "restaurant_tables" && e.status === "OCCUPIED"),
      "eventos de comanda/mesa/pagamento chegarem",
    );

    // isolamento
    for (const e of lca.events) expect(e.restaurant_id, `A recebeu evento de outro tenant em ${e.table}`).toBe(A().id);
    for (const e of lw.events) expect(e.restaurant_id).toBe(A().id);
    for (const e of lcb.events) expect(e.restaurant_id, `B recebeu evento de outro tenant em ${e.table}`).toBe(B().id);
    expect(lca.events.some((e) => e.id === tabB || e.id === mesaB.id || e.id === payBId), "A viu comanda/mesa/pagamento de B").toBe(false);
    expect(lcb.events.some((e) => e.id === tabA || e.id === mesaA.id || e.id === payAId), "B viu comanda/mesa/pagamento de A").toBe(false);
    // RLS por papel: o garçom lê tabs/mesas, mas não payments (sem reports.view / payments.record)
    expect(count(lw, "payments")).toBe(0);
    expect(lw.events.some((e) => e.id === payAId)).toBe(false);
  });
});
