/* eslint-disable @typescript-eslint/no-explicit-any */
/** Fábricas de dados efêmeros (service role) com limpeza garantida. Prefixo "zz-" = efêmero. */
import { admin } from "./clients";

export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class Cleanup {
  private fns: Array<() => Promise<unknown>> = [];
  add(fn: () => Promise<unknown>) {
    this.fns.push(fn);
  }
  async run() {
    const errors: unknown[] = [];
    for (const fn of [...this.fns].reverse()) {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    }
    this.fns = [];
    if (errors.length) console.warn(`[cleanup] ${errors.length} falha(s) de limpeza`, errors[0]);
  }
}

function must(res: { data: any; error: { message: string } | null }, what: string): any {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export interface MadeOrder {
  id: string;
  order_number: number;
  restaurant_id: string;
}

export async function makeOrder(
  cleanup: Cleanup,
  rid: string,
  opts: {
    status?: string;
    fulfillment?: "PICKUP" | "DELIVERY" | "DINE_IN";
    totalCents?: number;
    tabId?: string;
    tableId?: string;
    customerId?: string;
  } = {},
): Promise<MadeOrder> {
  const a = admin();
  const total = opts.totalCents ?? 3000;
  const fulfillment = opts.fulfillment ?? "PICKUP";
  const fee = fulfillment === "DELIVERY" ? 500 : 0;
  const body: Record<string, unknown> = {
    restaurant_id: rid,
    fulfillment_type: fulfillment,
    status: opts.status ?? "RECEIVED",
    source: "STAFF",
    subtotal_cents: total - fee,
    delivery_fee_cents: fee,
    total_cents: total,
    customer_name: "zz-DEMO cliente",
    idempotency_key: `zz-${uniq()}`,
    notes: "teste automatizado",
  };
  if (body.status === "REJECTED" || body.status === "CANCELLED") body.status_reason = "seed de teste";
  if (fulfillment === "DELIVERY") body.delivery_address = { street: "Rua DEMO", number: "1" };
  if (opts.tabId) body.tab_id = opts.tabId;
  if (opts.tableId) body.table_id = opts.tableId;
  if (opts.customerId) body.customer_id = opts.customerId;
  const row = must(await a.from("orders").insert(body).select("id,order_number,restaurant_id").single(), "makeOrder");
  cleanup.add(async () => {
    await a.from("payments").delete().eq("order_id", row.id);
    await a.from("print_jobs").delete().eq("order_id", row.id);
    await a.from("orders").delete().eq("id", row.id);
  });
  return row as MadeOrder;
}

export async function makeTable(cleanup: Cleanup, rid: string, opts: { status?: string; name?: string } = {}) {
  const a = admin();
  const row = must(
    await a
      .from("restaurant_tables")
      .insert({ restaurant_id: rid, name: opts.name ?? `zz-mesa-${uniq()}`, status: opts.status ?? "AVAILABLE", capacity: 2 })
      .select("id,name,status")
      .single(),
    "makeTable",
  );
  cleanup.add(async () => {
    await a.from("tabs").delete().eq("table_id", row.id);
    await a.from("restaurant_tables").delete().eq("id", row.id);
  });
  return row as { id: string; name: string; status: string };
}

export async function makeTab(cleanup: Cleanup, rid: string, opts: { tableId?: string | null; openedBy?: string } = {}) {
  const a = admin();
  const row = must(
    await a
      .from("tabs")
      .insert({ restaurant_id: rid, table_id: opts.tableId ?? null, label: `zz-comanda-${uniq()}`, opened_by: opts.openedBy ?? null })
      .select("id,table_id,status")
      .single(),
    "makeTab",
  );
  cleanup.add(async () => {
    await a.from("payments").delete().eq("tab_id", row.id);
    await a.from("print_jobs").delete().eq("tab_id", row.id);
    await a.from("tabs").delete().eq("id", row.id);
  });
  return row as { id: string; table_id: string | null; status: string };
}

export async function makeProduct(cleanup: Cleanup, rid: string, opts: { active?: boolean; name?: string } = {}) {
  const a = admin();
  const row = must(
    await a
      .from("products")
      .insert({ restaurant_id: rid, name: opts.name ?? `zz-produto-${uniq()}`, price_cents: 1000, is_active: opts.active ?? true })
      .select("id,name")
      .single(),
    "makeProduct",
  );
  cleanup.add(async () => {
    await a.from("products").delete().eq("id", row.id);
  });
  return row as { id: string; name: string };
}

export async function makePayment(
  cleanup: Cleanup,
  rid: string,
  target: { orderId?: string; tabId?: string },
  opts: { amount?: number; status?: string; provider?: string | null; reference?: string | null; idem?: string } = {},
) {
  const a = admin();
  const status = opts.status ?? "PAID";
  const res = await a
    .from("payments")
    .insert({
      restaurant_id: rid,
      order_id: target.orderId ?? null,
      tab_id: target.tabId ?? null,
      method: "CASH",
      amount_cents: opts.amount ?? 1000,
      status,
      provider: opts.provider === undefined ? null : opts.provider,
      provider_reference: opts.reference ?? null,
      idempotency_key: opts.idem ?? `zz-${uniq()}`,
      paid_at: status === "PAID" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (res.data) {
    const id = res.data.id;
    cleanup.add(async () => void (await a.from("payments").delete().eq("id", id)));
  }
  return res;
}

export async function orderRow(id: string) {
  return must(await admin().from("orders").select("*").eq("id", id).single(), "orderRow");
}
export async function tabRow(id: string) {
  return must(await admin().from("tabs").select("*").eq("id", id).single(), "tabRow");
}
export async function tableRow(id: string) {
  return must(await admin().from("restaurant_tables").select("*").eq("id", id).single(), "tableRow");
}

/** Espera uma condição com polling até o prazo (sem sleeps cegos). */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor expirou: ${opts.what ?? "condição"}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 150));
  }
}
