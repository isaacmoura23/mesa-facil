/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 5 (mig. 0124): dashboard_metrics e restaurant_report (7 relatórios, grupos day/week/month) por clientes AUTENTICADOS
 * reais. O service role só monta as fixtures (restaurante efêmero `zz-t5-*`, pedidos perto da meia-noite do fuso, itens
 * com variantes, descontos/taxas, cancelamentos com PII no motivo, pagamentos PAID/REFUNDED/PENDING) e LÊ as linhas reais
 * para calcular o esperado em JS puro (tests/helpers/phase5.ts) — nunca reaproveita o SQL sob teste.
 * Tudo é apagado no afterAll (o restaurante efêmero leva os pedidos, itens, pagamentos, comandas e mesas em cascata).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectOk, expectRule } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";
import {
  bucketsBetween,
  IN_PROGRESS,
  loadRows,
  makeTenant,
  maskReason,
  modelDashboard,
  modelPeriod,
  ordersIn,
  paymentMethods,
  pick,
  topProducts,
  DEAD,
  type Rows,
  type Tenant,
  type Unit,
} from "../helpers/phase5";

const cleanup = new Cleanup();
const L = (md: string, t: string) => `2026-${md}T${t}-03:00`;
const iso = (d: Date) => d.toISOString();
const NARROW = { from: new Date(L("03-10", "00:00:00")), to: new Date(L("03-13", "00:00:00")) };
const WIDE = { from: new Date(L("02-01", "00:00:00")), to: new Date(L("04-01", "00:00:00")) };
const SP = "America/Sao_Paulo";

type Client = AccountKey | "anon";
const cl = (who: Client) => (who === "anon" ? anon() : as(who));
const dash = (who: Client, rid: string | null, from: string | null, to: string | null) =>
  cl(who).rpc("dashboard_metrics", { p_restaurant: rid, p_from: from, p_to: to });
const rep = (who: Client, rid: string | null, report: string | null, from: string | null, to: string | null, group?: string | null) =>
  cl(who).rpc("restaurant_report", { p_restaurant: rid, p_report: report, p_from: from, p_to: to, ...(group === undefined ? {} : { p_group: group }) });
const ok = async (p: PromiseLike<any>): Promise<any> => {
  const r = await p;
  expectOk(r);
  return r.data;
};

let S: Tenant; // restaurante principal
let rows: Rows;
let productZ: string;

type Item = [name: string, variant: string | null, qty: number, unit: number, mods?: number];
interface Spec {
  key: string;
  at: string;
  ful: "DELIVERY" | "PICKUP" | "DINE_IN";
  status: string;
  items: Item[];
  fee?: number;
  disc?: number;
  reason?: string;
  product?: boolean;
}
const Z = "Falta de insumo " + "z".repeat(100);
const SPECS: Spec[] = [
  { key: "o01", at: L("03-09", "23:59:59"), ful: "DELIVERY", status: "COMPLETED", fee: 500, items: [["Pizza Calabresa", "G", 1, 5000]] },
  { key: "o02", at: L("03-10", "00:00:00"), ful: "PICKUP", status: "COMPLETED", items: [["Pizza Calabresa", "G", 1, 3000]] },
  { key: "o03", at: L("03-10", "12:30:00"), ful: "DELIVERY", status: "COMPLETED", fee: 500, disc: 200, product: true, items: [["Pizza Calabresa", "G", 1, 3000], ["Refrigerante", null, 2, 500]] },
  { key: "o04", at: L("03-10", "20:00:00"), ful: "DINE_IN", status: "COMPLETED", items: [["Sobremesa", null, 1, 1250]] },
  { key: "o05", at: L("03-10", "23:59:59"), ful: "DINE_IN", status: "PREPARING", items: [["Refrigerante", null, 5, 500]] },
  { key: "o06", at: L("03-11", "00:00:01"), ful: "PICKUP", status: "CANCELLED", reason: "Cliente pediu: contato joao@exemplo.com ou 11 98765-4321", items: [["Pizza Calabresa", "G", 1, 1800]] },
  { key: "o07", at: L("03-11", "10:00:00"), ful: "DELIVERY", status: "OUT_FOR_DELIVERY", fee: 700, disc: 1000, items: [["X-Burger", null, 4, 1000, 500]] },
  { key: "o08", at: L("03-11", "18:00:00"), ful: "DELIVERY", status: "REJECTED", fee: 600, reason: "=cmd|' /C calc'!A0", items: [["X-Burger", null, 2, 1100]] },
  { key: "o09", at: L("03-11", "21:00:00"), ful: "PICKUP", status: "READY", items: [["Pizza Calabresa", "P", 1, 2000], ["X-Burger", null, 1, 1000, 500]] },
  { key: "o10", at: L("03-11", "22:10:00"), ful: "PICKUP", status: "CANCELLED", reason: "Cliente desistiu", items: [["Refrigerante", null, 1, 500]] },
  { key: "o11", at: L("03-11", "23:30:00"), ful: "DINE_IN", status: "CANCELLED", reason: "Cliente desistiu", items: [["Sobremesa", null, 1, 1250]] },
  { key: "o12", at: L("03-11", "23:45:00"), ful: "PICKUP", status: "CANCELLED", reason: Z, items: [["Sobremesa", null, 1, 900]] },
  { key: "o13", at: L("03-11", "12:00:00"), ful: "PICKUP", status: "CANCELLED", reason: "Ligou 11999990001 pedindo", items: [["Sobremesa", null, 1, 700]] },
  { key: "o14", at: L("03-11", "13:00:00"), ful: "PICKUP", status: "CANCELLED", reason: "Ligou 21 98888-7777 pedindo", items: [["Sobremesa", null, 1, 800]] },
  { key: "o15", at: L("03-13", "00:00:00"), ful: "PICKUP", status: "COMPLETED", items: [["Pizza Calabresa", "G", 1, 9000]] },
  { key: "o16", at: L("02-01", "12:00:00"), ful: "PICKUP", status: "PREPARING", items: [["Refrigerante", null, 1, 500]] },
  { key: "o17", at: L("02-27", "23:30:00"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 1000]] },
  { key: "o18", at: L("03-02", "00:00:00"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 1111]] },
  { key: "o19", at: L("03-15", "23:59:59"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 2222]] },
  { key: "o20", at: L("03-16", "00:00:00"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 3333]] },
  { key: "o21", at: L("03-31", "23:59:59"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 4444]] },
  { key: "o22", at: L("04-01", "00:00:00"), ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 5555]] },
  // virada do horário de verão de Nova York (08/03/2026 07:00Z): mesmo dia local em NY, dias diferentes em São Paulo
  { key: "o23", at: "2026-03-08T05:30:00Z", ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 700]] },
  { key: "o24", at: "2026-03-09T03:30:00Z", ful: "PICKUP", status: "COMPLETED", items: [["Sobremesa", null, 1, 800]] },
];
const oid: Record<string, string> = {};

async function insertPayment(row: Record<string, unknown>) {
  const r = await admin().from("payments").insert({ restaurant_id: S.id, idempotency_key: `zz-t23-${uniq()}`, ...row });
  if (r.error) throw new Error(`payment: ${r.error.message}`);
}

beforeAll(async () => {
  const a = admin();
  S = await makeTenant(cleanup);
  const prod = await a.from("products").insert({ restaurant_id: S.id, name: `zz-pizza-t23-${uniq()}`, price_cents: 3000 }).select("id").single();
  productZ = prod.data!.id;
  for (const s of SPECS) {
    const sub = s.items.reduce((t, [, , q, u, m]) => t + q * (u + (m ?? 0)), 0);
    const fee = s.fee ?? 0;
    const disc = s.disc ?? 0;
    const o = await a
      .from("orders")
      .insert({
        restaurant_id: S.id,
        fulfillment_type: s.ful,
        status: s.status,
        source: "STAFF",
        created_at: s.at,
        subtotal_cents: sub,
        delivery_fee_cents: fee,
        discount_cents: disc,
        total_cents: sub + fee - disc,
        status_reason: s.reason ?? null,
        customer_name: "zz DEMO cliente",
        idempotency_key: `zz-t23-${s.key}-${uniq()}`,
        delivery_address: s.ful === "DELIVERY" ? { street: "Rua DEMO", number: "1" } : null,
      })
      .select("id")
      .single();
    if (o.error) throw new Error(`order ${s.key}: ${o.error.message}`);
    oid[s.key] = o.data.id;
    const it = await a.from("order_items").insert(
      s.items.map(([name, variant, qty, unit, mods]) => ({
        restaurant_id: S.id,
        order_id: o.data.id,
        product_id: s.product && name === "Pizza Calabresa" ? productZ : null,
        product_name: name,
        variant_name_snapshot: variant,
        unit_price_cents: unit,
        modifiers_cents: mods ?? 0,
        quantity: qty,
        line_total_cents: (unit + (mods ?? 0)) * qty,
      })),
    );
    if (it.error) throw new Error(`items ${s.key}: ${it.error.message}`);
  }

  // Mesas e comandas (estado ATUAL: não depende do período)
  const tbl = async (name: string, status: string) =>
    (await a.from("restaurant_tables").insert({ restaurant_id: S.id, name, status, capacity: 2 }).select("id").single()).data!.id as string;
  await tbl("zz-T1", "AVAILABLE");
  await tbl("zz-T2", "INACTIVE");
  const t3 = await tbl("zz-T3", "AVAILABLE");
  await tbl("zz-T4", "CLEANING");
  const tab = await a.from("tabs").insert({ restaurant_id: S.id, table_id: t3, label: "zz-t5-tab" }).select("id").single();
  if (tab.error) throw new Error(`tab: ${tab.error.message}`);
  const tab2 = await a.from("tabs").insert({ restaurant_id: S.id, table_id: null, label: "zz-t5-tab-fechada" }).select("id").single();
  await a.from("tabs").update({ status: "CLOSED" }).eq("id", tab2.data!.id); // não deve contar em open_tabs

  // Pagamentos (paid_at manda; REFUNDED/PENDING não entram)
  const pay = (k: string, method: string, amount: number, status: string, paid: string | null, extra: Record<string, unknown> = {}) =>
    insertPayment({ order_id: oid[k], method, amount_cents: amount, status, paid_at: paid, ...extra });
  await pay("o02", "CASH", 3000, "PAID", L("03-10", "00:10:00"));
  await pay("o03", "PIX", 4300, "PAID", L("03-10", "12:45:00"));
  await pay("o04", "PIX", 1250, "REFUNDED", L("03-10", "20:10:00"));
  await pay("o05", "PIX", 2500, "PENDING", null);
  await pay("o09", "CREDIT", 3500, "PAID", L("03-11", "21:10:00"));
  await pay("o07", "PIX", 2000, "PAID", L("03-11", "10:30:00"));
  await pay("o01", "CASH", 5000, "PAID", L("03-09", "23:59:59"));
  await pay("o01", "DEBIT", 500, "PAID", L("03-10", "08:00:00")); // pedido de ANTES da janela, pago DENTRO
  await pay("o15", "CASH", 9000, "PAID", L("03-13", "00:00:00")); // paid_at == to (exclusivo)
  await pay("o10", "PIX", 500, "PAID", L("03-11", "22:20:00")); // pedido cancelado, pagamento PAID conta
  await insertPayment({ order_id: null, tab_id: tab.data.id, method: "DEBIT", amount_cents: 700, status: "PAID", paid_at: L("03-12", "12:00:00") });

  rows = await loadRows(S.id);
}, 180_000);

afterAll(async () => {
  await cleanup.run();
});

// =====================================================================================================================
describe("dashboard_metrics: números batem com o cálculo independente", () => {
  it("fixtures: o modelo independente concorda com valores calculados à mão", () => {
    const m = modelDashboard(rows, NARROW.from, NARROW.to, SP);
    expect(pick(m, ["orders_count", "gross_orders_count", "gross_sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count", "rejected_count"])).toEqual({
      orders_count: 13,
      gross_orders_count: 6,
      gross_sales_cents: 20250,
      completed_sales_cents: 8550,
      avg_ticket_cents: 3375,
      cancelled_count: 6,
      rejected_count: 1,
    });
    expect(m.payment_methods).toEqual([
      { method: "PIX", amount_cents: 6800, count: 3 },
      { method: "CREDIT", amount_cents: 3500, count: 1 },
      { method: "CASH", amount_cents: 3000, count: 1 },
      { method: "DEBIT", amount_cents: 1200, count: 2 },
    ]);
  });

  it("janela de 3 dias em São Paulo: totais, modalidades, série diária, top produtos e formas de pagamento", async () => {
    const d = await ok(dash("ownerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    const m = modelDashboard(rows, NARROW.from, NARROW.to, SP);
    expect(pick(d, ["orders_count", "gross_orders_count", "gross_sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count", "rejected_count"])).toEqual(
      pick(m, ["orders_count", "gross_orders_count", "gross_sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count", "rejected_count"]),
    );
    expect(d.by_fulfillment).toEqual(m.by_fulfillment);
    expect(d.by_fulfillment.map((x: any) => x.type)).toEqual(["DELIVERY", "PICKUP", "DINE_IN"]);
    expect(d.sales_series).toEqual(m.sales_series);
    expect(d.sales_series.map((x: any) => x.day)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(d.sales_series[2]).toEqual({ day: "2026-03-12", orders: 0, sales_cents: 0 }); // bucket sem pedido
    expect(d.top_products).toEqual(m.top_products);
    expect(d.top_products[0]).toEqual({ name: "X-Burger", variant: null, quantity: 5, sales_cents: 7500 });
    expect(d.payment_methods).toEqual(m.payment_methods);
    expect(d.period).toMatchObject({ timezone: SP });
    // gross = tudo exceto CANCELLED/REJECTED; ticket médio sobre gross (e não sobre orders_count)
    expect(d.gross_sales_cents).toBe(20250);
    expect(d.avg_ticket_cents).toBe(Math.round(20250 / 6));
    expect(d.avg_ticket_cents).not.toBe(Math.round(20250 / 13));
  });

  it("limites exatos: [from, to) — pedido em from entra, em to não; 23:59:59 do último dia entra", async () => {
    const d = await ok(dash("ownerA", S.id, iso(new Date(L("03-10", "00:00:00"))), iso(new Date(L("03-11", "00:00:00")))));
    // 03-10 inteiro: o02 (00:00:00), o03, o04, o05 (23:59:59); o01 (03-09 23:59:59) e o06 (03-11 00:00:01) ficam de fora
    expect(d.orders_count).toBe(4);
    expect(d.gross_sales_cents).toBe(3000 + 4300 + 1250 + 2500);
    const only = await ok(dash("ownerA", S.id, iso(new Date(L("03-13", "00:00:00"))), iso(new Date(L("03-13", "00:00:01")))));
    expect(only.orders_count).toBe(1); // o15 está exatamente em from
    const before = await ok(dash("ownerA", S.id, iso(new Date(L("03-12", "00:00:00"))), iso(new Date(L("03-13", "00:00:00")))));
    expect(before.orders_count).toBe(0); // o15 está exatamente em to (exclusivo)
  });

  it("top_products usa o snapshot: renomear, repreciar e apagar o produto não muda o resultado", async () => {
    const before = await ok(dash("managerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    const a = admin();
    expectOk(await a.from("products").update({ name: "zz-RENOMEADO", price_cents: 99999 }).eq("id", productZ));
    const renamed = await ok(dash("managerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    expect(renamed.top_products).toEqual(before.top_products);
    expect(JSON.stringify(renamed)).not.toContain("zz-RENOMEADO");
    const rep1 = await ok(rep("managerA", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)));
    expectOk(await a.from("products").delete().eq("id", productZ)); // SET NULL em order_items.product_id
    const gone = await ok(dash("managerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    expect(gone.top_products).toEqual(before.top_products);
    expect(await ok(rep("managerA", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)))).toEqual(rep1);
    expect(before.top_products.some((p: any) => p.name === "Pizza Calabresa" && p.variant === "G" && p.quantity === 2 && p.sales_cents === 6000)).toBe(true);
  });

  it("payment_methods: só PAID, por paid_at (pedido anterior pago dentro entra; paid_at == to não entra; REFUNDED/PENDING não)", async () => {
    const d = await ok(dash("ownerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    expect(d.payment_methods).toEqual(paymentMethods(rows.pays, NARROW.from, NARROW.to));
    const debit = d.payment_methods.find((p: any) => p.method === "DEBIT");
    expect(debit).toEqual({ method: "DEBIT", amount_cents: 1200, count: 2 }); // 500 (pedido o01 de antes da janela) + 700 (comanda, sem pedido)
    expect(d.payment_methods.reduce((t: number, p: any) => t + p.amount_cents, 0)).toBe(14500);
    // o pagamento de R$ 90,00 em 03-13 00:00:00 só aparece quando a janela o inclui
    const w = await ok(dash("ownerA", S.id, iso(NARROW.from), iso(new Date(L("03-13", "00:00:01")))));
    expect(w.payment_methods.find((p: any) => p.method === "CASH").amount_cents).toBe(3000 + 9000);
  });

  it("período vazio: zeros sem divisão por zero, séries com todos os dias e listas vazias", async () => {
    const from = new Date(L("01-05", "00:00:00"));
    const to = new Date(L("01-08", "00:00:00"));
    const d = await ok(dash("ownerA", S.id, iso(from), iso(to)));
    expect(d).toMatchObject({ orders_count: 0, gross_orders_count: 0, gross_sales_cents: 0, completed_sales_cents: 0, avg_ticket_cents: 0, cancelled_count: 0, rejected_count: 0, top_products: [], payment_methods: [] });
    expect(d.by_fulfillment).toEqual([
      { type: "DELIVERY", orders: 0, sales_cents: 0 },
      { type: "PICKUP", orders: 0, sales_cents: 0 },
      { type: "DINE_IN", orders: 0, sales_cents: 0 },
    ]);
    expect(d.sales_series).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"].map((day) => ({ day, orders: 0, sales_cents: 0 })));
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity|null,"gross/);
    // só pedidos cancelados na janela: gross 0, ticket 0, contagem de cancelados > 0
    const c = await ok(dash("ownerA", S.id, iso(new Date(L("03-11", "00:00:00"))), iso(new Date(L("03-11", "00:30:00")))));
    expect(c).toMatchObject({ orders_count: 1, gross_orders_count: 0, gross_sales_cents: 0, avg_ticket_cents: 0, cancelled_count: 1 });
  });

  it("estado atual (in_progress, open_tabs, occupied_tables, tables_total sem INACTIVE) independe do período", async () => {
    const expectedInProgress = rows.orders.filter((o) => IN_PROGRESS.includes(o.status)).length;
    expect(expectedInProgress).toBe(4); // o05, o07, o09, o16 (o16 está fora da janela estreita)
    for (const w of [NARROW, WIDE, { from: new Date(L("01-05", "00:00:00")), to: new Date(L("01-06", "00:00:00")) }]) {
      const d = await ok(dash("ownerA", S.id, iso(w.from), iso(w.to)));
      expect(pick(d, ["in_progress_orders", "open_tabs", "occupied_tables", "tables_total"])).toEqual({ in_progress_orders: 4, open_tabs: 1, occupied_tables: 1, tables_total: 3 });
    }
  });

  it("INVALID_PERIOD: from>=to, nulos e mais de 366 dias; 366 dias exatos passam", async () => {
    const f = "2026-01-01T00:00:00Z";
    for (const [from, to] of [
      [f, f],
      ["2026-01-02T00:00:00Z", f],
      [null, f],
      [f, null],
      [null, null],
      [f, "2027-01-03T00:00:00Z"], // 367 dias
      [f, "2027-01-02T00:00:00.001Z"],
    ] as [string | null, string | null][]) {
      const r = await dash("ownerA", S.id, from, to);
      expectRule(r, /^INVALID_PERIOD/);
      expect(r.error!.code).toBe("22023");
      expectRule(await rep("ownerA", S.id, "sales_by_period", from, to), /^INVALID_PERIOD/);
    }
    const d = await ok(dash("ownerA", S.id, f, "2027-01-02T00:00:00Z")); // 366 dias
    expect(d.sales_series).toHaveLength(bucketsBetween(new Date(f), new Date("2027-01-02T00:00:00Z"), SP, "day").length); // 366 dias de relógio = 367 datas locais em SP (UTC-3)
    const r = await ok(rep("ownerA", S.id, "sales_by_period", f, "2027-01-02T00:00:00Z"));
    expect(r.rows.length).toBe(d.sales_series.length);
    expect(r.truncated).toBe(false);
    // data malformada: erro de parâmetro do PostgREST (4xx), nunca 5xx
    const bad = await dash("ownerA", S.id, "isto-nao-e-data", f);
    expect(bad.error).not.toBeNull();
    expect(bad.status).toBeLessThan(500);
  });

  it("papel: ordem das validações — sem permissão vence parâmetros inválidos (nenhum oráculo)", async () => {
    expectRule(await dash("cashierA", S.id, null, null), /^FORBIDDEN/);
    expectRule(await rep("cashierA", S.id, "invalido", null, null, "year"), /^FORBIDDEN/);
    expectRule(await rep("ownerB", S.id, "invalido", null, null, "year"), /^RESTAURANT_NOT_FOUND/);
  });
});

// =====================================================================================================================
describe("fuso do restaurante", () => {
  const setTz = async (rid: string, tz: string) => expectOk(await admin().from("restaurants").update({ timezone: tz }).eq("id", rid));
  afterAll(async () => void (await setTz(S.id, SP)));

  it("mesmo instante, fusos diferentes: America/Sao_Paulo x Asia/Tokyo mudam os buckets (e batem com o modelo)", async () => {
    const w = NARROW;
    const sp = await ok(dash("ownerA", S.id, iso(w.from), iso(w.to)));
    await setTz(S.id, "Asia/Tokyo");
    const tk = await ok(dash("ownerA", S.id, iso(w.from), iso(w.to)));
    await setTz(S.id, SP);
    expect(sp.period.timezone).toBe(SP);
    expect(tk.period.timezone).toBe("Asia/Tokyo");
    // totais da janela não dependem do fuso; os dias sim
    expect(tk.gross_sales_cents).toBe(sp.gross_sales_cents);
    expect(tk.orders_count).toBe(sp.orders_count);
    expect(sp.sales_series.map((x: any) => x.day)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(tk.sales_series.map((x: any) => x.day)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"]);
    expect(tk.sales_series).toEqual(modelDashboard(rows, w.from, w.to, "Asia/Tokyo").sales_series);
    expect(tk.sales_series).not.toEqual(sp.sales_series);
    expect(tk.sales_series.reduce((t: number, x: any) => t + x.sales_cents, 0)).toBe(tk.gross_sales_cents);
  });

  for (const tz of ["America/Sao_Paulo", "Asia/Tokyo", "America/New_York", "UTC"]) {
    for (const unit of ["day", "week", "month"] as Unit[]) {
      it(`sales_by_period ${unit} em ${tz} (inclui dia de DST em NY) = modelo`, async () => {
        await setTz(S.id, tz);
        try {
          const win = tz === "America/New_York" ? { from: new Date("2026-03-07T12:00:00Z"), to: new Date("2026-03-11T12:00:00Z") } : WIDE;
          const r = await ok(rep("ownerA", S.id, "sales_by_period", iso(win.from), iso(win.to), unit));
          const m = modelPeriod(await loadRows(S.id), win.from, win.to, tz, unit);
          expect(r.period).toMatchObject({ timezone: tz, group: unit });
          expect(r.rows).toEqual(m.rows.map((x) => pick(x, ["period", "orders", "sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count"])));
          expect(r.totals).toEqual(pick(m.totals, ["orders", "sales_cents", "avg_ticket_cents", "completed_sales_cents", "cancelled_count"]));
          expect(r.rows.map((x: any) => x.period)).toEqual(bucketsBetween(win.from, win.to, tz, unit));
          if (tz === "America/New_York" && unit === "day") {
            // 08/03 em NY (dia com 23 h): 05:30Z (00:30 EST) e 03:30Z do dia 09 (23:30 EDT) caem no MESMO dia local
            const d08 = r.rows.find((x: any) => x.period === "2026-03-08");
            expect(d08).toMatchObject({ orders: 2, sales_cents: 1500 });
          }
        } finally {
          await setTz(S.id, SP);
        }
      });
    }
  }

  it("timezone inválido não chega a ser gravado (fallback do relatório fica só como rede de segurança)", async () => {
    const r = await admin().from("restaurants").update({ timezone: "Mars/Olympus" }).eq("id", S.id);
    expect(r.error?.message).toMatch(/INVALID_TIMEZONE/);
    const d = await ok(dash("ownerA", S.id, iso(NARROW.from), iso(NARROW.to)));
    expect(d.period.timezone).toBe(SP);
  });
});

// =====================================================================================================================
describe("restaurant_report: os 7 relatórios", () => {
  const win = WIDE;
  const W = () => [iso(win.from), iso(win.to)] as const;

  for (const unit of ["day", "week", "month"] as Unit[]) {
    it(`sales_by_period (${unit}) = modelo; colunas declaradas batem com as linhas; buckets sem pedido zerados`, async () => {
      const r = await ok(rep("ownerA", S.id, "sales_by_period", ...W(), unit));
      const m = modelPeriod(rows, win.from, win.to, SP, unit);
      expect(r.report).toBe("sales_by_period");
      expect(r.rows).toEqual(m.rows.map((x) => pick(x, ["period", "orders", "sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count"])));
      expect(r.totals).toEqual(pick(m.totals, ["orders", "sales_cents", "avg_ticket_cents", "completed_sales_cents", "cancelled_count"]));
      expect(r.columns.map((c: any) => c.key)).toEqual(["period", "orders", "sales_cents", "completed_sales_cents", "avg_ticket_cents", "cancelled_count"]);
      for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(r.columns.map((c: any) => c.key).sort());
      expect(r.rows.some((x: any) => x.orders === 0 && x.sales_cents === 0 && x.avg_ticket_cents === 0)).toBe(unit !== "month");
      // soma das linhas == totais
      expect(r.rows.reduce((t: number, x: any) => t + x.sales_cents, 0)).toBe(r.totals.sales_cents);
      expect(r.truncated).toBe(false);
    });
  }

  it("semana ISO: 15/03 (domingo 23:59:59) e 16/03 (segunda 00:00:00) ficam em semanas diferentes; início do bucket pode ser anterior a from", async () => {
    const r = await ok(rep("ownerA", S.id, "sales_by_period", iso(new Date(L("03-10", "00:00:00"))), iso(new Date(L("03-17", "00:00:00"))), "week"));
    expect(r.rows.map((x: any) => x.period)).toEqual(["2026-03-09", "2026-03-16"]); // 09/03 < from (10/03)
    expect(r.rows[0].orders).toBe(modelPeriod(rows, new Date(L("03-10", "00:00:00")), new Date(L("03-17", "00:00:00")), SP, "week").rows[0].orders);
    const month = await ok(rep("ownerA", S.id, "sales_by_period", iso(new Date(L("02-27", "00:00:00"))), iso(new Date(L("04-01", "00:00:00"))), "month"));
    expect(month.rows.map((x: any) => x.period)).toEqual(["2026-02-01", "2026-03-01"]);
    expect(month.rows[0].orders).toBe(1); // o17 em 27/02 23:30
  });

  for (const report of ["avg_ticket", "fees_discounts"] as const) {
    for (const unit of ["day", "week"] as Unit[]) {
      it(`${report} (${unit}) = modelo`, async () => {
        const r = await ok(rep("managerA", S.id, report, ...W(), unit));
        const m = modelPeriod(rows, win.from, win.to, SP, unit);
        const keys = report === "avg_ticket" ? ["period", "orders", "sales_cents", "avg_ticket_cents"] : ["period", "orders", "subtotal_cents", "delivery_fee_cents", "discount_cents", "sales_cents"];
        expect(r.rows).toEqual(m.rows.map((x) => pick(x, keys)));
        expect(r.totals).toEqual(pick(m.totals, keys.slice(1)));
        expect(r.columns.map((c: any) => c.key)).toEqual(keys);
      });
    }
  }

  it("fees_discounts: só pedidos gross (taxa/desconto de cancelado/recusado não entram) — conferido à mão em 10–12/03", async () => {
    const r = await ok(rep("ownerA", S.id, "fees_discounts", iso(NARROW.from), iso(NARROW.to), "day"));
    // o03 (taxa 500, desc 200) e o07 (taxa 700, desc 1000); o08 REJECTED (taxa 600) fica de fora
    expect(r.totals).toEqual({ orders: 6, subtotal_cents: 3000 + 4000 + 1250 + 2500 + 6000 + 3500, delivery_fee_cents: 1200, discount_cents: 1200, sales_cents: 20250 });
  });

  it("orders_by_fulfillment, top_products, cancellations e payment_methods = modelo", async () => {
    const inw = ordersIn(rows, NARROW.from, NARROW.to);
    const gross = inw.filter((o) => !DEAD.includes(o.status));
    const f = await ok(rep("ownerA", S.id, "orders_by_fulfillment", iso(NARROW.from), iso(NARROW.to)));
    expect(f.rows).toEqual(
      (["DELIVERY", "PICKUP", "DINE_IN"] as const).map((type) => {
        const l = gross.filter((o) => o.fulfillment_type === type);
        const s = l.reduce((t, o) => t + o.total_cents, 0);
        return { type, orders: l.length, sales_cents: s, avg_ticket_cents: l.length ? Math.round(s / l.length) : 0 };
      }),
    );
    expect(f.totals).toEqual({ orders: 6, sales_cents: 20250, avg_ticket_cents: 3375 });

    const ids = new Set(gross.map((o) => o.id));
    const t = await ok(rep("ownerA", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)));
    const tp = topProducts(rows.items.filter((i) => ids.has(i.order_id)));
    expect(t.rows).toEqual(tp);
    expect(t.totals).toEqual({ quantity: tp.reduce((s, p) => s + p.quantity, 0), sales_cents: tp.reduce((s, p) => s + p.sales_cents, 0) });
    // produtos de pedidos cancelados/recusados/fora da janela não entram
    expect(t.rows.some((p: any) => p.name === "Sobremesa" && p.sales_cents > 1250)).toBe(false);

    const p = await ok(rep("ownerA", S.id, "payment_methods", iso(NARROW.from), iso(NARROW.to)));
    expect(p.rows).toEqual(paymentMethods(rows.pays, NARROW.from, NARROW.to).map((x) => ({ method: x.method, count: x.count, amount_cents: x.amount_cents })));
    expect(p.totals).toEqual({ count: 7, amount_cents: 14500 });
  });

  it("cancellations: motivos agrupados e MASCARADOS (e-mail, telefone), truncados em 80, fórmula preservada (a planilha mitiga)", async () => {
    const r = await ok(rep("ownerA", S.id, "cancellations", iso(NARROW.from), iso(NARROW.to)));
    const dead = ordersIn(rows, NARROW.from, NARROW.to).filter((o) => DEAD.includes(o.status));
    const g = new Map<string, { status: string; reason: string; count: number; lost_sales_cents: number }>();
    for (const o of dead) {
      const reason = maskReason(o.status_reason);
      const k = `${o.status}|${reason}`;
      const e = g.get(k) ?? { status: o.status, reason, count: 0, lost_sales_cents: 0 };
      e.count += 1;
      e.lost_sales_cents += o.total_cents;
      g.set(k, e);
    }
    const expected = [...g.values()].sort((x, y) => y.count - x.count || (x.status < y.status ? -1 : x.status > y.status ? 1 : 0) || (x.reason < y.reason ? -1 : 1));
    expect(r.rows).toEqual(expected);
    expect(r.totals).toEqual({ cancelled_count: 6, rejected_count: 1, count: 7, lost_sales_cents: dead.reduce((s, o) => s + o.total_cents, 0) });
    const text = JSON.stringify(r);
    expect(text).not.toContain("joao@exemplo.com");
    expect(text).not.toContain("exemplo.com");
    expect(text).not.toContain("98765");
    expect(text).not.toContain("11999990001");
    expect(text).not.toContain("98888");
    const reasons: string[] = r.rows.map((x: any) => x.reason);
    expect(reasons).toContain("Cliente pediu: contato [e-mail] ou [número]");
    // dois telefones diferentes colapsam no mesmo motivo mascarado
    expect(r.rows.find((x: any) => x.reason === "Ligou [número] pedindo")).toMatchObject({ status: "CANCELLED", count: 2 });
    expect(r.rows.find((x: any) => x.reason === "Cliente desistiu")).toMatchObject({ status: "CANCELLED", count: 2, lost_sales_cents: 500 + 1250 });
    expect(Math.max(...reasons.map((s) => s.length))).toBeLessThanOrEqual(80);
    expect(reasons.find((s) => s.startsWith("Falta de insumo"))!.length).toBe(80);
    expect(reasons).toContain("=cmd|' /C calc'!A0"); // o banco não altera fórmulas: o CSV do app é quem neutraliza
  });

  it("nomes de relatório e grupo são normalizados (caixa/espaços); grupo vazio/nulo => day", async () => {
    const base = await ok(rep("ownerA", S.id, "sales_by_period", ...W(), "day"));
    for (const [report, group] of [[" SALES_BY_PERIOD ", "DAY"], ["Sales_By_Period", "  "], ["sales_by_period", null]] as [string, string | null][]) {
      expect(await ok(rep("ownerA", S.id, report, ...W(), group))).toEqual(base);
    }
    expect(await ok(rep("ownerA", S.id, "sales_by_period", ...W()))).toEqual(base); // p_group omitido
  });

  it("INVALID_REPORT e INVALID_GROUP (inclusive para relatórios que não agrupam)", async () => {
    for (const bad of ["nope", "", "   ", "sales", "sales_by_period;drop table orders", "payment_methods ' or 1=1 --", "\u0000", "x".repeat(5000)]) {
      const r = await rep("ownerA", S.id, bad, ...W());
      expect(r.error, JSON.stringify(bad.slice(0, 20))).not.toBeNull();
      expect(r.status).toBeLessThan(500);
      if (!bad.includes("\u0000")) expectRule(r, /^INVALID_REPORT/);
    }
    expectRule(await rep("ownerA", S.id, null, ...W()), /^INVALID_REPORT/);
    for (const g of ["year", "hour", "days", "d", "day;", "quarter"]) {
      const r = await rep("ownerA", S.id, "sales_by_period", ...W(), g);
      expectRule(r, /^INVALID_GROUP/);
      expect(r.error!.code).toBe("22023");
    }
    expectRule(await rep("ownerA", S.id, "top_products", ...W(), "year"), /^INVALID_GROUP/);
    // INVALID_REPORT tem precedência sobre INVALID_GROUP e INVALID_PERIOD
    expectRule(await rep("ownerA", S.id, "nope", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", "year"), /^INVALID_REPORT/);
    expectRule(await rep("ownerA", S.id, "top_products", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", "year"), /^INVALID_GROUP/);
  });
});

// =====================================================================================================================
describe("restaurant_report: limite de 5000 linhas / truncated", () => {
  let T: Tenant;
  const w = { from: new Date(L("05-01", "00:00:00")), to: new Date(L("05-02", "00:00:00")) };
  let orderId = "";

  async function addItems(from: number, to: number) {
    const batch = [];
    for (let i = from; i < to; i++) {
      const unit = 100 + (i % 97);
      batch.push({ restaurant_id: T.id, order_id: orderId, product_name: `zz-prod-${String(i).padStart(5, "0")}`, variant_name_snapshot: null, unit_price_cents: unit, modifiers_cents: 0, quantity: 1, line_total_cents: unit });
    }
    for (let i = 0; i < batch.length; i += 1000) expectOk(await admin().from("order_items").insert(batch.slice(i, i + 1000)));
  }
  const total = (n: number) => Array.from({ length: n }, (_, i) => 100 + (i % 97)).reduce((a, b) => a + b, 0);

  beforeAll(async () => {
    T = await makeTenant(cleanup);
    const o = await admin()
      .from("orders")
      .insert({ restaurant_id: T.id, fulfillment_type: "PICKUP", status: "COMPLETED", source: "STAFF", created_at: L("05-01", "12:00:00"), subtotal_cents: 1, total_cents: 1, idempotency_key: `zz-t23-big-${uniq()}`, customer_name: "zz big" })
      .select("id")
      .single();
    orderId = o.data!.id;
  }, 60_000);

  it("exatamente 5000 linhas => truncated=false; 5001 => 5000 linhas, truncated=true e totais sobre TODOS os dados; dashboard limita a 10", async () => {
    await addItems(0, 5000);
    const r1 = await ok(rep("ownerA", T.id, "top_products", iso(w.from), iso(w.to)));
    expect(r1.rows).toHaveLength(5000);
    expect(r1.truncated).toBe(false);
    expect(r1.totals).toEqual({ quantity: 5000, sales_cents: total(5000) });

    await addItems(5000, 5100);
    const r2 = await ok(rep("ownerA", T.id, "top_products", iso(w.from), iso(w.to)));
    expect(r2.rows).toHaveLength(5000);
    expect(r2.truncated).toBe(true);
    expect(r2.totals).toEqual({ quantity: 5100, sales_cents: total(5100) }); // totais não são truncados
    const sales = r2.rows.map((x: any) => x.sales_cents);
    expect([...sales].sort((a, b) => b - a)).toEqual(sales); // ordenado: as 100 linhas cortadas são as de menor faturamento
    expect(r2.rows.reduce((t: number, x: any) => t + x.sales_cents, 0)).toBeLessThanOrEqual(total(5100));
    const d = await ok(dash("ownerA", T.id, iso(w.from), iso(w.to)));
    expect(d.top_products).toHaveLength(10);
    expect(d.top_products.map((p: any) => p.sales_cents)).toEqual(r2.rows.slice(0, 10).map((x: any) => x.sales_cents));
  }, 120_000);
});

// =====================================================================================================================
describe("autorização: papéis, outros tenants e anon", () => {
  const args = (rid: string) => [rid, iso(NARROW.from), iso(NARROW.to)] as const;

  it("owner e manager recebem os dados; cashier, kitchen e waiter => FORBIDDEN (42501) nas duas RPCs", async () => {
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      expect((await ok(dash(who, ...args(S.id)))).orders_count).toBe(13);
      expect((await ok(rep(who, S.id, "sales_by_period", iso(NARROW.from), iso(NARROW.to)))).rows).toHaveLength(3);
    }
    for (const who of ["cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      const d = await dash(who, ...args(S.id));
      expectRule(d, /^FORBIDDEN/);
      expect(d.error!.code).toBe("42501");
      expect(d.data).toBeNull();
      const r = await rep(who, S.id, "sales_by_period", iso(NARROW.from), iso(NARROW.to));
      expectRule(r, /^FORBIDDEN/);
      expect(r.data).toBeNull();
    }
  });

  it("dono de B, usuário sem vínculo, superadmin, suporte e uuid inexistente: RESTAURANT_NOT_FOUND idêntico (mensagem e SQLSTATE)", async () => {
    const ghost = "00000000-0000-4000-8000-00000000dead";
    const outcomes: string[] = [];
    for (const who of ["ownerB", "managerB", "plain", "superadmin", "support"] as AccountKey[]) {
      for (const call of [() => dash(who, ...args(S.id)), () => rep(who, S.id, "top_products", iso(NARROW.from), iso(NARROW.to))]) {
        const r = await call();
        expectRule(r, /^RESTAURANT_NOT_FOUND/);
        outcomes.push(`${r.error!.code}|${r.error!.message}`);
        expect(r.data).toBeNull();
      }
    }
    for (const call of [() => dash("ownerA", ghost, iso(NARROW.from), iso(NARROW.to)), () => rep("ownerA", ghost, "top_products", iso(NARROW.from), iso(NARROW.to)), () => dash("ownerA", null, iso(NARROW.from), iso(NARROW.to))]) {
      const r = await call();
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      outcomes.push(`${r.error!.code}|${r.error!.message}`);
    }
    expect(new Set(outcomes).size).toBe(1);
    // restaurantes DEMO: A não enxerga B (e vice-versa) mesmo sendo owner
    expectRule(await dash("ownerA", world().restaurants.b.id, iso(NARROW.from), iso(NARROW.to)), /^RESTAURANT_NOT_FOUND/);
    expectRule(await dash("ownerB", world().restaurants.a.id, iso(NARROW.from), iso(NARROW.to)), /^RESTAURANT_NOT_FOUND/);
  });

  it("os números de um restaurante nunca aparecem em outro (dono de A em A não vê pedidos de S)", async () => {
    const a = await ok(dash("ownerA", world().restaurants.a.id, iso(NARROW.from), iso(NARROW.to)));
    expect(JSON.stringify(a)).not.toContain("Pizza Calabresa");
    expect(a.gross_sales_cents).toBe(0);
  });

  it("anon sem EXECUTE; UUID malformado => erro de parâmetro (4xx)", async () => {
    expectDenied(await dash("anon", S.id, iso(NARROW.from), iso(NARROW.to)), /42501|permission denied/i);
    expectDenied(await rep("anon", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)), /42501|permission denied/i);
    const bad = await dash("ownerA", "nao-e-uuid", iso(NARROW.from), iso(NARROW.to));
    expect(bad.error).not.toBeNull();
    expect(bad.status).toBeLessThan(500);
  });

  it("restaurante suspenso: até o dono recebe RESTAURANT_NOT_FOUND (restaurado em finally)", async () => {
    const a = admin();
    expectOk(await a.from("restaurants").update({ status: "suspended" }).eq("id", S.id));
    try {
      expectRule(await dash("ownerA", ...args(S.id)), /^RESTAURANT_NOT_FOUND/);
      expectRule(await rep("managerA", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)), /^RESTAURANT_NOT_FOUND/);
    } finally {
      expectOk(await a.from("restaurants").update({ status: "active" }).eq("id", S.id));
    }
    expect((await ok(dash("ownerA", ...args(S.id)))).orders_count).toBe(13);
  });

  it("overrides: reports.view concedido ao caixa libera; removido do gerente bloqueia (restaurado)", async () => {
    const a = admin();
    const ov = (key: AccountKey, granted: boolean) => a.from("membership_permission_overrides").insert({ membership_id: S.members[key]!, restaurant_id: S.id, permission_key: "reports.view", granted });
    expectOk(await ov("cashierA", true));
    expectOk(await ov("managerA", false));
    try {
      expect((await ok(dash("cashierA", ...args(S.id)))).orders_count).toBe(13);
      expectRule(await dash("managerA", ...args(S.id)), /^FORBIDDEN/);
      expectRule(await rep("managerA", S.id, "top_products", iso(NARROW.from), iso(NARROW.to)), /^FORBIDDEN/);
      expect((await ok(dash("ownerA", ...args(S.id)))).orders_count).toBe(13); // dono não é afetado
      expectRule(await dash("kitchenA", ...args(S.id)), /^FORBIDDEN/);
    } finally {
      await a.from("membership_permission_overrides").delete().eq("restaurant_id", S.id);
    }
    expectRule(await dash("cashierA", ...args(S.id)), /^FORBIDDEN/);
  });

  it("a resposta não carrega dados pessoais nem ids internos de cliente/usuário", async () => {
    const texts = [JSON.stringify(await ok(dash("ownerA", ...args(S.id)))), JSON.stringify(await ok(rep("ownerA", S.id, "cancellations", iso(NARROW.from), iso(NARROW.to))))];
    for (const t of texts) {
      expect(t).not.toMatch(/customer_(name|phone|email)|zz DEMO cliente|@exemplo|Rua DEMO/);
    }
  });
});
