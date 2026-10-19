/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Apoio dos testes da Fase 5 (painel do dono): restaurante efêmero com a equipe DEMO vinculada e um "modelo" independente
 * (em JS puro) para calcular o resultado esperado de dashboard_metrics / restaurant_report a partir das linhas reais.
 */
import type { AccountKey, Role } from "../fixtures/accounts";
import { admin, world } from "./clients";
import { Cleanup, uniq } from "./factory";

export const ROLE_OF: Partial<Record<AccountKey, Role>> = {
  ownerA: "owner",
  managerA: "manager",
  cashierA: "cashier",
  kitchenA: "kitchen",
  waiterA: "waiter",
};

export interface Tenant {
  id: string;
  slug: string;
  /** id do vínculo (restaurant_memberships) por conta, neste restaurante. */
  members: Partial<Record<AccountKey, string>>;
}

/**
 * Restaurante efêmero `zz-t5-*` onde as contas DEMO de A (dono, gerente, caixa, cozinha, garçom) também têm vínculo.
 * Dono de B, `plain`, superadmin e suporte NÃO têm vínculo (são os "de fora"). Tudo é removido no cleanup.
 */
export async function makeTenant(cleanup: Cleanup, opts: { timezone?: string; withTeam?: boolean } = {}): Promise<Tenant> {
  const a = admin();
  const slug = `zz-t5-${uniq()}`;
  const r = await a
    .from("restaurants")
    .insert({ name: `zz DEMO T5 ${slug}`, slug, status: "active", timezone: opts.timezone ?? "America/Sao_Paulo" })
    .select("id")
    .single();
  if (r.error) throw new Error(`makeTenant: ${r.error.message}`);
  const id = r.data.id as string;
  cleanup.add(async () => void (await a.from("restaurants").delete().eq("id", id)));
  const members: Tenant["members"] = {};
  if (opts.withTeam !== false) {
    for (const [key, role] of Object.entries(ROLE_OF) as [AccountKey, Role][]) {
      const m = await a
        .from("restaurant_memberships")
        .insert({ restaurant_id: id, user_id: world().users[key].id, role, status: "active" })
        .select("id")
        .single();
      if (m.error) throw new Error(`makeTenant membership ${key}: ${m.error.message}`);
      members[key] = m.data.id as string;
    }
  }
  return { id, slug, members };
}

// ---------------------------------------------------------------------------------------------------------------------
// Modelo independente: datas locais, buckets e agregações
// ---------------------------------------------------------------------------------------------------------------------
const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Data local (YYYY-MM-DD) de um instante em um fuso IANA. */
export function localDate(at: Date | string, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f.format(typeof at === "string" ? new Date(at) : at);
}

const parts = (d: string) => d.split("-").map(Number) as [number, number, number];
const toStr = (t: Date) => t.toISOString().slice(0, 10);
const utcOf = (d: string) => {
  const [y, m, dd] = parts(d);
  return new Date(Date.UTC(y, m - 1, dd));
};

export type Unit = "day" | "week" | "month";

/** Início do bucket (data local) que contém a data local `d` (semana ISO começa na segunda). */
export function bucketStart(d: string, unit: Unit): string {
  const t = utcOf(d);
  if (unit === "day") return d;
  if (unit === "month") return `${d.slice(0, 7)}-01`;
  const dow = (t.getUTCDay() + 6) % 7; // 0 = segunda
  t.setUTCDate(t.getUTCDate() - dow);
  return toStr(t);
}

export function nextBucket(b: string, unit: Unit): string {
  const t = utcOf(b);
  if (unit === "day") t.setUTCDate(t.getUTCDate() + 1);
  else if (unit === "week") t.setUTCDate(t.getUTCDate() + 7);
  else t.setUTCMonth(t.getUTCMonth() + 1);
  return toStr(t);
}

/** Todos os buckets que a janela [from, to) toca (inclusive os sem pedidos). */
export function bucketsBetween(from: Date, to: Date, tz: string, unit: Unit): string[] {
  const last = localDate(new Date(to.getTime() - 1), tz);
  const out: string[] = [];
  for (let b = bucketStart(localDate(from, tz), unit); b <= last; b = nextBucket(b, unit)) out.push(b);
  return out;
}

export interface OrderRow {
  id: string;
  created_at: string;
  status: string;
  fulfillment_type: "DELIVERY" | "PICKUP" | "DINE_IN";
  subtotal_cents: number;
  delivery_fee_cents: number;
  discount_cents: number;
  total_cents: number;
  status_reason: string | null;
}
export interface ItemRow {
  order_id: string;
  product_name: string;
  variant_name_snapshot: string | null;
  quantity: number;
  line_total_cents: number;
}
export interface PayRow {
  method: string;
  status: string;
  amount_cents: number;
  paid_at: string | null;
}

export const DEAD = ["CANCELLED", "REJECTED"];
export const IN_PROGRESS = ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY"];
const avg = (sum: number, n: number) => (n === 0 ? 0 : Math.round(sum / n));
const inWin = (iso: string | null, from: Date, to: Date) => iso !== null && new Date(iso) >= from && new Date(iso) < to;

export async function loadRows(rid: string) {
  const a = admin();
  const orders = ((await a.from("orders").select("id,created_at,status,fulfillment_type,subtotal_cents,delivery_fee_cents,discount_cents,total_cents,status_reason").eq("restaurant_id", rid).limit(10000)).data ?? []) as OrderRow[];
  const items: ItemRow[] = [];
  for (let off = 0; ; off += 1000) {
    const page = ((await a.from("order_items").select("order_id,product_name,variant_name_snapshot,quantity,line_total_cents").eq("restaurant_id", rid).order("id").range(off, off + 999)).data ?? []) as ItemRow[];
    items.push(...page);
    if (page.length < 1000) break;
  }
  const pays = ((await a.from("payments").select("method,status,amount_cents,paid_at").eq("restaurant_id", rid).limit(10000)).data ?? []) as PayRow[];
  return { orders, items, pays };
}
export type Rows = Awaited<ReturnType<typeof loadRows>>;

/** Pedidos da janela [from, to). */
export const ordersIn = (rows: Rows, from: Date, to: Date) => rows.orders.filter((o) => inWin(o.created_at, from, to));

export function modelDashboard(rows: Rows, from: Date, to: Date, tz: string) {
  const inw = ordersIn(rows, from, to);
  const gross = inw.filter((o) => !DEAD.includes(o.status));
  const grossSum = gross.reduce((s, o) => s + o.total_cents, 0);
  const byId = new Set(gross.map((o) => o.id));
  const byFul = (["DELIVERY", "PICKUP", "DINE_IN"] as const).map((type) => {
    const l = gross.filter((o) => o.fulfillment_type === type);
    return { type, orders: l.length, sales_cents: l.reduce((s, o) => s + o.total_cents, 0) };
  });
  const series = bucketsBetween(from, to, tz, "day").map((day) => {
    const l = gross.filter((o) => localDate(o.created_at, tz) === day);
    return { day, orders: l.length, sales_cents: l.reduce((s, o) => s + o.total_cents, 0) };
  });
  return {
    orders_count: inw.length,
    gross_orders_count: gross.length,
    gross_sales_cents: grossSum,
    completed_sales_cents: inw.filter((o) => o.status === "COMPLETED").reduce((s, o) => s + o.total_cents, 0),
    avg_ticket_cents: avg(grossSum, gross.length),
    cancelled_count: inw.filter((o) => o.status === "CANCELLED").length,
    rejected_count: inw.filter((o) => o.status === "REJECTED").length,
    by_fulfillment: byFul,
    top_products: topProducts(rows.items.filter((i) => byId.has(i.order_id))).slice(0, 10),
    sales_series: series,
    payment_methods: paymentMethods(rows.pays, from, to),
  };
}

export function topProducts(items: ItemRow[]) {
  const m = new Map<string, { name: string; variant: string | null; quantity: number; sales_cents: number }>();
  for (const i of items) {
    const k = `${i.product_name}\u0000${i.variant_name_snapshot ?? "\u0001"}`;
    const e = m.get(k) ?? { name: i.product_name, variant: i.variant_name_snapshot, quantity: 0, sales_cents: 0 };
    e.quantity += i.quantity;
    e.sales_cents += i.line_total_cents;
    m.set(k, e);
  }
  return [...m.values()].sort(
    (x, y) =>
      y.sales_cents - x.sales_cents ||
      y.quantity - x.quantity ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0) ||
      (x.variant === null ? -1 : y.variant === null ? 1 : x.variant < y.variant ? -1 : x.variant > y.variant ? 1 : 0),
  );
}

export function paymentMethods(pays: PayRow[], from: Date, to: Date) {
  const m = new Map<string, { method: string; amount_cents: number; count: number }>();
  for (const p of pays) {
    if (p.status !== "PAID" || !inWin(p.paid_at, from, to)) continue;
    const e = m.get(p.method) ?? { method: p.method, amount_cents: 0, count: 0 };
    e.amount_cents += p.amount_cents;
    e.count += 1;
    m.set(p.method, e);
  }
  return [...m.values()].sort((x, y) => y.amount_cents - x.amount_cents || (x.method < y.method ? -1 : 1));
}

/** Linhas + totais de sales_by_period / avg_ticket / fees_discounts. */
export function modelPeriod(rows: Rows, from: Date, to: Date, tz: string, unit: Unit) {
  const inw = ordersIn(rows, from, to);
  const sum = (l: OrderRow[], f: (o: OrderRow) => number) => l.reduce((s, o) => s + f(o), 0);
  const rowsOut = bucketsBetween(from, to, tz, unit).map((period) => {
    const l = inw.filter((o) => bucketStart(localDate(o.created_at, tz), unit) === period);
    const g = l.filter((o) => !DEAD.includes(o.status));
    const sales = sum(g, (o) => o.total_cents);
    return {
      period,
      orders: g.length,
      sales_cents: sales,
      completed_sales_cents: sum(l.filter((o) => o.status === "COMPLETED"), (o) => o.total_cents),
      avg_ticket_cents: avg(sales, g.length),
      cancelled_count: l.length - g.length,
      subtotal_cents: sum(g, (o) => o.subtotal_cents),
      delivery_fee_cents: sum(g, (o) => o.delivery_fee_cents),
      discount_cents: sum(g, (o) => o.discount_cents),
    };
  });
  const g = inw.filter((o) => !DEAD.includes(o.status));
  const sales = sum(g, (o) => o.total_cents);
  const totals = {
    orders: g.length,
    sales_cents: sales,
    avg_ticket_cents: avg(sales, g.length),
    completed_sales_cents: sum(inw.filter((o) => o.status === "COMPLETED"), (o) => o.total_cents),
    cancelled_count: inw.length - g.length,
    subtotal_cents: sum(g, (o) => o.subtotal_cents),
    delivery_fee_cents: sum(g, (o) => o.delivery_fee_cents),
    discount_cents: sum(g, (o) => o.discount_cents),
  };
  return { rows: rowsOut, totals };
}

export const pick = <T extends Record<string, any>>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** Mascara de motivo de cancelamento (mesma regra documentada na mig. 0124) — usada só para confrontar a saída. */
export function maskReason(raw: string | null): string {
  let s = (raw ?? "").slice(0, 300).replace(/[\u0000-\u001f\u007f]+/g, " ");
  s = s.replace(/[^\s@]+@[^\s@]+/g, "[e-mail]");
  s = s.replace(/[0-9][0-9 ().+-]{4,}[0-9]/g, "[número]");
  s = s.trim().slice(0, 80);
  return s === "" ? "(sem motivo)" : s;
}
