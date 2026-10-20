/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 6 (migs. 0128-0130): RPCs `platform_*`, `public_platform_flags`, `register_restaurant` (registro desativável + trial)
 * por clientes AUTENTICADOS reais (superadmin, support, dono, gerente, caixa, cozinha, garçom, sem vínculo, anon).
 * Service role só monta fixtures (restaurantes efêmeros `zz-*`, planos `zz-*`) e lê o estado real do banco.
 * `audit_logs` é append-only: as linhas de teste ficam. Configurações da plataforma e planos são restaurados no fim.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { ACCOUNTS } from "../fixtures/accounts";
import { admin, anon, as, userId, world } from "../helpers/clients";
import { expectOk, expectRule } from "../helpers/expect";
import { Cleanup, makeTable, uniq } from "../helpers/factory";
import { makeTenant, type Tenant } from "../helpers/phase5";

const cleanup = new Cleanup();
const U = uniq();
const T_START = new Date(Date.now() - 2000).toISOString();
type Who = AccountKey | "anon";
const cl = (who: Who) => (who === "anon" ? anon() : as(who));
const GHOST = "00000000-0000-4000-8000-00000000dead";
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;
const FORBIDDEN_WHO: Who[] = ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA", "plain", "anon"];

/** Respostas de leitura de superadmin/support: varridas no fim à procura de dados de cliente. */
const readLog: string[] = [];
const call = (who: Who, fn: string, args: Record<string, unknown> = {}) => cl(who).rpc(fn, args);
const read = async (who: Who, fn: string, args: Record<string, unknown> = {}) => {
  const r = await call(who, fn, args);
  if (!r.error && r.data !== null) readLog.push(JSON.stringify(r.data));
  return r;
};
const ok = async (p: PromiseLike<any>): Promise<any> => {
  const r = await p;
  expectOk(r);
  return r.data;
};
const fail = async (p: PromiseLike<any>, code: RegExp | string) => {
  const r = await p;
  expectRule(r, typeof code === "string" ? new RegExp(`^${code}`) : code);
  return r.error!;
};
const adm = () => admin();
const sub = async (rid: string) => ((await adm().from("subscriptions").select("*").eq("restaurant_id", rid).order("created_at")).data ?? []) as any[];
const live = (rows: any[]) => rows.filter((s) => ["trialing", "active", "past_due"].includes(s.status));
const audits = async (filter: Record<string, string>, like?: string) => {
  let q = adm().from("audit_logs").select("*").order("created_at", { ascending: false });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  if (like) q = q.like("action", like);
  return ((await q.limit(1000)).data ?? []) as any[];
};
const count = async (table: string, f: (q: any) => any = (q) => q) => {
  const r = await f(adm().from(table).select(table === "platform_settings" ? "key" : "id", { count: "exact", head: true }));
  if (r.error) throw new Error(r.error.message);
  return r.count as number;
};

let seq = 0;
async function mkRest(status: "active" | "pending" | "suspended", extra: Record<string, unknown> = {}) {
  const n = ++seq;
  const slug = `zz-p6-${U}-${n}`;
  const r = await adm()
    .from("restaurants")
    .insert({ name: `zz P6 ${U} ${n}`, slug, status, ...extra })
    .select("id,slug,name,created_at")
    .single();
  if (r.error) throw new Error(`mkRest: ${r.error.message}`);
  const id = r.data.id as string;
  cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", id)));
  return r.data as { id: string; slug: string; name: string; created_at: string };
}
async function mkPlan(code: string, price: number, interval: "month" | "year", sort = 5000, active = true) {
  const r = await adm()
    .from("plans")
    .insert({ code, name: `zz ${code}`, price_cents: price, billing_interval: interval, sort_order: sort, is_active: active })
    .select("id,code")
    .single();
  if (r.error) throw new Error(`mkPlan: ${r.error.message}`);
  cleanup.add(async () => {
    await adm().from("subscriptions").delete().eq("plan_id", r.data.id);
    await adm().from("plans").delete().eq("id", r.data.id);
  });
  return r.data as { id: string; code: string };
}
async function mkSub(rid: string, planId: string, status: string, extra: Record<string, unknown> = {}) {
  const r = await adm().from("subscriptions").insert({ restaurant_id: rid, plan_id: planId, status, ...extra }).select("id").single();
  if (r.error) throw new Error(`mkSub: ${r.error.message}`);
  return r.data.id as string;
}
async function mkTicket(rid: string | null, status: string, subject?: string) {
  const r = await adm()
    .from("support_tickets")
    .insert({ restaurant_id: rid, opened_by: userId("waiterA"), subject: subject ?? `zz-tk-${U}-${++seq}`, body: "corpo do chamado de teste", status })
    .select("id,subject")
    .single();
  if (r.error) throw new Error(`mkTicket: ${r.error.message}`);
  cleanup.add(async () => void (await adm().from("support_tickets").delete().eq("id", r.data.id)));
  return r.data as { id: string; subject: string };
}
async function mkOrders(rid: string, specs: { status?: string; at: string; total?: number; fulfillment?: string; pii?: boolean }[]) {
  const batch = specs.map((s, i) => ({
    restaurant_id: rid,
    fulfillment_type: s.fulfillment ?? "PICKUP",
    status: s.status ?? "RECEIVED",
    source: "STAFF",
    created_at: s.at,
    subtotal_cents: s.total ?? 1000,
    total_cents: s.total ?? 1000,
    status_reason: ["CANCELLED", "REJECTED"].includes(s.status ?? "") ? `cancelado, ligar para ${PII.phone} ou ${PII.email}` : null,
    idempotency_key: `zz-t26-${U}-${++seq}-${i}`,
    customer_name: s.pii === false ? "zz anon" : PII.name,
    customer_phone: s.pii === false ? null : PII.phone,
    notes: s.pii === false ? null : PII.notes,
    delivery_address: s.fulfillment === "DELIVERY" ? { street: PII.street, number: "77" } : null,
  }));
  for (let i = 0; i < batch.length; i += 100) {
    const r = await adm().from("orders").insert(batch.slice(i, i + 100));
    if (r.error) throw new Error(`orders: ${r.error.message}`);
  }
}
const PII = {
  name: `Zelda Pii ${U}`,
  phone: "11988776655",
  email: `pii.${U}@cliente-zz.test`,
  street: `Rua Secreta ${U}`,
  notes: `Nota privada ${U}`,
};
const TAB_LABEL = `Mesa do Fulano ${U}`;

let S: Tenant;
let R2: { id: string; slug: string };
let R3: { id: string; slug: string };
let R4: { id: string; slug: string };
let R5: { id: string; slug: string };
let planM: { id: string; code: string };
let planY: { id: string; code: string };
const tickets: Record<string, { id: string; subject: string }> = {};
let before: any;
let expectedN30 = 0;

async function readDashboard(who: Who = "superadmin") {
  return (await ok(read(who, "platform_dashboard"))) as any;
}

beforeAll(async () => {
  // Estado base conhecido das configurações (outros testes podem tê-las alterado)
  await adm().from("platform_settings").upsert([{ key: "registration_enabled", value: true }, { key: "default_trial_days", value: 14 }], { onConflict: "key" });
  cleanup.add(async () => {
    await adm().from("platform_settings").delete().not("key", "in", "(registration_enabled,default_trial_days)");
    await adm().from("platform_settings").upsert([{ key: "registration_enabled", value: true }, { key: "default_trial_days", value: 14 }], { onConflict: "key" });
    await adm().from("plans").update({ is_active: true }).not("code", "like", "zz%");
  });
  await adm().from("support_sessions").update({ ended_at: new Date().toISOString() }).is("ended_at", null);

  before = await readDashboard();
  planM = await mkPlan(`zz-plan-m-${U}`, 10000, "month");
  planY = await mkPlan(`zz-plan-y-${U}`, 100005, "year"); // 100005/12 = 8333,75 -> 8334
  S = await makeTenant(cleanup);
  const rest = async (status: "active" | "pending" | "suspended") => mkRest(status);
  R2 = await rest("active");
  R3 = await rest("pending");
  R4 = await rest("suspended");
  R5 = await rest("active");
  await mkSub(S.id, planM.id, "active");
  await mkSub(R2.id, planM.id, "canceled", { current_period_start: iso(-60 * DAY), current_period_end: iso(-30 * DAY) });
  await mkSub(R2.id, planY.id, "active");
  await mkSub(R3.id, planM.id, "trialing", { trial_ends_at: iso(5 * DAY) });
  await mkSub(R4.id, planY.id, "past_due");
  await mkSub(R5.id, planM.id, "canceled", { current_period_start: iso(-20 * DAY), current_period_end: iso(-1 * DAY) });

  // clientes/pedidos com dados pessoais reconhecíveis (a plataforma nunca pode devolvê-los)
  const cu = await adm().from("customers").insert({ restaurant_id: S.id, name: PII.name, phone: PII.phone, email: PII.email, notes: PII.notes }).select("id").single();
  if (cu.error) throw new Error(cu.error.message);
  await adm().from("customer_addresses").insert({ restaurant_id: S.id, customer_id: cu.data.id, street: PII.street, number: "77", city: "São Paulo", state: "SP", is_default: true });
  await mkOrders(S.id, [
    { at: iso(-31 * DAY), status: "COMPLETED" },
    { at: iso(-29 * DAY), status: "CONFIRMED", fulfillment: "DELIVERY" },
    { at: iso(-5 * DAY), status: "CANCELLED" },
    { at: iso(-1 * DAY), status: "RECEIVED" },
    { at: iso(-1000), status: "RECEIVED" },
  ]);
  await mkOrders(R2.id, [{ at: iso(-2 * DAY) }, { at: iso(-3 * DAY), status: "REJECTED" }]);
  expectedN30 = 4 + 2;

  for (const [k, st] of [["open1", "open"], ["open2", "open"], ["prog", "in_progress"], ["res", "resolved"], ["closed", "closed"]] as const) {
    tickets[k] = await mkTicket(S.id, st);
  }
  // sessões: 1 ativa (conta), 1 expirada e 1 encerrada (não contam)
  const adminId = userId("superadmin");
  const sess = (extra: Record<string, unknown>) => adm().from("support_sessions").insert({ restaurant_id: R2.id, admin_id: adminId, reason: "zz sessao de teste fase 6", ...extra });
  expectOk(await sess({ started_at: iso(-5 * 60_000), expires_at: iso(25 * 60_000) }));
  expectOk(await sess({ started_at: iso(-2 * 3_600_000), expires_at: iso(-3_600_000) }));
  expectOk(await sess({ started_at: iso(-3_600_000), expires_at: iso(-1_800_000), ended_at: iso(-3_500_000) }));
}, 120_000);

afterAll(async () => {
  await adm().from("support_sessions").update({ ended_at: new Date().toISOString() }).is("ended_at", null);
  await cleanup.run();
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------------
// 1. Matriz de papéis
// ---------------------------------------------------------------------------------------------------------------------
describe("matriz de papéis: cada RPC platform_* x 9 perfis", () => {
  const T0 = new Date().toISOString();
  type Op = { fn: string; args: () => Record<string, unknown>; bad: () => Record<string, unknown>; level: "read" | "super" | "ticket" | "overview" };
  const ops: Op[] = [
    { fn: "platform_dashboard", args: () => ({}), bad: () => ({}), level: "read" },
    { fn: "platform_list_restaurants", args: () => ({ p_search: null, p_status: null, p_cursor: null, p_limit: 5 }), bad: () => ({ p_status: "bogus" }), level: "read" },
    { fn: "platform_get_restaurant", args: () => ({ p_restaurant: S.id }), bad: () => ({ p_restaurant: GHOST }), level: "read" },
    { fn: "platform_list_subscriptions", args: () => ({ p_status: null, p_cursor: null, p_limit: 5 }), bad: () => ({ p_status: "bogus" }), level: "read" },
    { fn: "platform_list_support_sessions", args: () => ({ p_active_only: false, p_cursor: null, p_limit: 5 }), bad: () => ({ p_cursor: { t: "x" } }), level: "read" },
    { fn: "platform_list_tickets", args: () => ({ p_status: null, p_cursor: null, p_limit: 5 }), bad: () => ({ p_status: "bogus" }), level: "read" },
    { fn: "platform_get_settings", args: () => ({}), bad: () => ({}), level: "read" },
    { fn: "platform_list_plans", args: () => ({}), bad: () => ({}), level: "read" },
    { fn: "platform_list_audit_logs", args: () => ({ p_restaurant: S.id, p_limit: 5 }), bad: () => ({ p_action_prefix: "x".repeat(70) }), level: "super" },
    { fn: "platform_support_overview", args: () => ({ p_session: GHOST }), bad: () => ({ p_session: GHOST }), level: "overview" },
    { fn: "platform_create_restaurant", args: () => ({ p_name: "zz deny", p_slug: `zz-deny-${U}`, p_owner_email: ACCOUNTS.ownerA.email }), bad: () => ({ p_name: "x", p_slug: "x", p_owner_email: "not-an-email" }), level: "super" },
    { fn: "platform_set_restaurant_status", args: () => ({ p_restaurant: S.id, p_status: "suspended", p_reason: "tentativa de suspensao indevida" }), bad: () => ({ p_restaurant: S.id, p_status: "bogus", p_reason: null }), level: "super" },
    { fn: "platform_upsert_plan", args: () => ({ p_id: null, p_code: `zz-deny-${U}`, p_name: "deny", p_price_cents: 1, p_limits: null, p_features: null, p_is_active: true }), bad: () => ({ p_id: null, p_code: "A!", p_name: "x", p_price_cents: 1 }), level: "super" },
    { fn: "platform_set_subscription", args: () => ({ p_restaurant: S.id, p_plan: planY.id, p_status: "past_due", p_period_end: null, p_note: "nota indevida" }), bad: () => ({ p_restaurant: S.id, p_plan: planY.id, p_status: "bogus" }), level: "super" },
    { fn: "platform_set_setting", args: () => ({ p_key: "default_trial_days", p_value: 99 }), bad: () => ({ p_key: "bogus", p_value: 1 }), level: "super" },
    { fn: "platform_update_ticket", args: () => ({ p_ticket: tickets.open1.id, p_status: "closed", p_note: "nota indevida" }), bad: () => ({ p_ticket: tickets.open1.id, p_status: "bogus" }), level: "ticket" },
  ];
  const forbiddenMsgs = new Set<string>();

  for (const op of ops) {
    it(`${op.fn}: negada a dono/gerente/caixa/cozinha/garçom/sem vínculo/anon (com argumentos válidos E inválidos)`, async () => {
      for (const who of FORBIDDEN_WHO) {
        for (const args of [op.args(), op.bad()]) {
          const r = await call(who, op.fn, args);
          expect(r.error, `${who} ${op.fn}`).not.toBeNull();
          expect(r.data ?? null).toBeNull();
          if (who === "anon") {
            expect(`${r.error!.code} ${r.error!.message}`, "anon").toMatch(/42501|permission denied/i);
          } else {
            expect(r.error!.message, `${who} ${op.fn}`).toMatch(/^FORBIDDEN: /);
            expect(r.error!.code).toBe("42501");
            forbiddenMsgs.add(r.error!.message);
          }
        }
      }
    });

    if (op.level === "read") {
      it(`${op.fn}: superadmin e support leem`, async () => {
        for (const who of ["superadmin", "support"] as const) {
          const r = await read(who, op.fn, op.args());
          expectOk(r);
          expect(r.data).not.toBeNull();
        }
      });
    } else if (op.level === "super") {
      it(`${op.fn}: só superadmin; support recebe FORBIDDEN idêntico ao dos demais`, async () => {
        for (const args of [op.args(), op.bad()]) {
          const r = await call("support", op.fn, args);
          expect(r.error!.message).toMatch(/^FORBIDDEN: /);
          expect(r.error!.code).toBe("42501");
          forbiddenMsgs.add(r.error!.message);
        }
        // superadmin passa da autorização (falha de VALIDAÇÃO, não de permissão; sem efeito colateral)
        const bad = await call("superadmin", op.fn, op.bad());
        expect(bad.error, op.fn).not.toBeNull();
        expect(bad.error!.message).not.toMatch(/FORBIDDEN|UNAUTHENTICATED/);
      });
    } else if (op.level === "ticket") {
      it(`${op.fn}: superadmin e support passam da autorização`, async () => {
        for (const who of ["superadmin", "support"] as const) {
          const bad = await call(who, op.fn, op.bad());
          expectRule(bad, /^INVALID_STATUS/);
        }
      });
    } else {
      it(`${op.fn}: superadmin e support passam da autorização (sessão inexistente => SUPPORT_SESSION_INVALID)`, async () => {
        for (const who of ["superadmin", "support"] as const) expectRule(await call(who, op.fn, op.args()), /^SUPPORT_SESSION_INVALID/);
      });
    }
  }

  it("a mensagem de FORBIDDEN é UMA só em todas as RPCs e perfis (sem oráculo de papel)", () => {
    expect([...forbiddenMsgs]).toEqual(["FORBIDDEN: acesso restrito à plataforma"]);
  });

  it("nenhuma tentativa negada teve efeito: restaurante, assinatura, plano, configuração, chamado e auditoria intactos", async () => {
    expect((await adm().from("restaurants").select("status").eq("id", S.id).single()).data!.status).toBe("active");
    expect((await adm().from("restaurants").select("id").eq("slug", `zz-deny-${U}`)).data).toEqual([]);
    expect((await adm().from("plans").select("id").eq("code", `zz-deny-${U}`)).data).toEqual([]);
    const subs = await sub(S.id);
    expect(subs.map((s) => [s.plan_id, s.status])).toEqual([[planM.id, "active"]]);
    expect((await adm().from("platform_settings").select("value").eq("key", "default_trial_days").single()).data!.value).toBe(14);
    expect((await adm().from("support_tickets").select("status").eq("id", tickets.open1.id).single()).data!.status).toBe("open");
    const platformRows = (await adm().from("audit_logs").select("action").like("action", "platform.%").gte("created_at", T0)).data ?? [];
    expect(platformRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Dashboard
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_dashboard: agregados batem com o cálculo independente", () => {
  it("delta das fixtures = esperado (restaurantes em vários status, assinaturas, MRR com anual/12, pedidos 30d, chamados, sessões)", async () => {
    const after = await readDashboard();
    const d = (path: (x: any) => number) => path(after) - path(before);
    expect(d((x) => x.restaurants.total)).toBe(5);
    expect(d((x) => x.restaurants.active)).toBe(3);
    expect(d((x) => x.restaurants.pending)).toBe(1);
    expect(d((x) => x.restaurants.suspended)).toBe(1);
    expect(d((x) => x.restaurants.new_30d)).toBe(5);
    expect(d((x) => x.subscriptions.active)).toBe(2);
    expect(d((x) => x.subscriptions.trial)).toBe(1);
    expect(d((x) => x.subscriptions.past_due)).toBe(1);
    expect(d((x) => x.subscriptions.cancelled)).toBe(2);
    expect(d((x) => x.mrr_cents)).toBe(10000 + 8334);
    expect(d((x) => x.orders_30d)).toBe(expectedN30);
    expect(d((x) => x.tickets_open)).toBe(2);
    expect(d((x) => x.tickets_in_progress)).toBe(1);
    expect(d((x) => x.support_sessions_active)).toBe(1);
  });

  it("valores absolutos = recontagem independente pelo service role em TODAS as linhas do banco", async () => {
    const now = Date.now();
    const rs = ((await adm().from("restaurants").select("status,created_at")).data ?? []) as any[];
    const subs = ((await adm().from("subscriptions").select("status,plan_id")).data ?? []) as any[];
    const plans = new Map((((await adm().from("plans").select("id,price_cents,billing_interval")).data ?? []) as any[]).map((p) => [p.id, p]));
    const since = new Date(now - 30 * DAY).toISOString();
    const got = await readDashboard();
    expect(got.restaurants).toEqual({
      total: rs.length,
      pending: rs.filter((r) => r.status === "pending").length,
      active: rs.filter((r) => r.status === "active").length,
      suspended: rs.filter((r) => r.status === "suspended").length,
      new_30d: rs.filter((r) => Date.parse(r.created_at) >= now - 30 * DAY).length,
    });
    expect(got.subscriptions).toEqual({
      active: subs.filter((s) => s.status === "active").length,
      trial: subs.filter((s) => s.status === "trialing").length,
      past_due: subs.filter((s) => s.status === "past_due").length,
      cancelled: subs.filter((s) => s.status === "canceled").length,
    });
    const mrr = subs
      .filter((s) => s.status === "active")
      .reduce((sum, s) => {
        const p: any = plans.get(s.plan_id);
        return sum + (p.billing_interval === "year" ? Math.round(p.price_cents / 12) : p.price_cents);
      }, 0);
    expect(got.mrr_cents).toBe(mrr);
    expect(got.orders_30d).toBe(await count("orders", (q) => q.gte("created_at", since)));
    expect(got.tickets_open).toBe(await count("support_tickets", (q) => q.eq("status", "open")));
    expect(got.support_sessions_active).toBe(await count("support_sessions", (q) => q.is("ended_at", null).gt("expires_at", new Date().toISOString())));
  });

  it("support lê o MESMO dashboard; as chaves são exatamente as do contrato (só agregados)", async () => {
    const a = await readDashboard("superadmin");
    const b = await readDashboard("support");
    expect(b).toEqual(a);
    expect(Object.keys(a).sort()).toEqual(["mrr_cents", "orders_30d", "restaurants", "subscriptions", "support_sessions_active", "tickets_in_progress", "tickets_open"]);
    for (const v of [a.restaurants, a.subscriptions]) for (const x of Object.values(v)) expect(typeof x).toBe("number");
    expect(Object.keys(a.restaurants).sort()).toEqual(["active", "new_30d", "pending", "suspended", "total"]);
    expect(Object.keys(a.subscriptions).sort()).toEqual(["active", "cancelled", "past_due", "trial"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Listagens
// ---------------------------------------------------------------------------------------------------------------------
async function pageAll(who: Who, fn: string, base: Record<string, unknown>, limit: number) {
  const seen: any[] = [];
  let cursor: unknown = null;
  for (let guard = 0; guard < 400; guard++) {
    const r = (await ok(read(who, fn, { ...base, p_cursor: cursor, p_limit: limit }))) as any;
    expect(r.rows.length).toBeLessThanOrEqual(limit);
    seen.push(...r.rows);
    cursor = r.next_cursor;
    if (!cursor) return seen;
    expect(r.rows.length, "página cheia quando há próxima").toBe(limit);
  }
  throw new Error("paginação sem fim");
}
const noRepeat = (rowsIn: any[], key = "id") => expect(new Set(rowsIn.map((r) => r[key])).size).toBe(rowsIn.length);
const sortedDesc = (rowsIn: any[], field: string) => {
  for (let i = 1; i < rowsIn.length; i++) {
    const a = rowsIn[i - 1];
    const b = rowsIn[i];
    const ta = Date.parse(a[field]);
    const tb = Date.parse(b[field]);
    expect(ta > tb || (ta === tb && a.id > b.id), `ordem ${i}`).toBe(true);
  }
};

describe("platform_list_restaurants: keyset, limites, filtros e busca literal", () => {
  const T = "2026-03-01T12:00:00.000Z";
  const pg: { id: string; slug: string; name: string }[] = [];
  const lit: Record<string, { id: string; name: string }> = {};

  beforeAll(async () => {
    const mk = async (name: string, slug: string, created_at: string, status = "active") => {
      const r = await adm().from("restaurants").insert({ name, slug, status, created_at }).select("id,slug,name").single();
      if (r.error) throw new Error(r.error.message);
      cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", r.data.id)));
      return r.data as any;
    };
    // 4 com o MESMO created_at (desempate por id) + 3 distintos
    for (let i = 0; i < 4; i++) pg.push(await mk(`Pg${U} ${i}`, `zz-pg-${U}-${i}`, T));
    for (let i = 4; i < 7; i++) pg.push(await mk(`Pg${U} ${i}`, `zz-pg-${U}-${i}`, `2026-03-0${i - 1}T12:00:00.000Z`));
    lit.pct = await mk(`Lit${U} 100% real`, `zz-lit-${U}-a`, "2026-02-01T00:00:00Z");
    lit.plain = await mk(`Lit${U} 100 real`, `zz-lit-${U}-b`, "2026-02-01T00:00:01Z");
    lit.under = await mk(`Lit${U}_Under`, `zz-lit-${U}-c`, "2026-02-01T00:00:02Z");
    lit.xunder = await mk(`Lit${U}xUnder`, `zz-lit-${U}-d`, "2026-02-01T00:00:03Z");
    lit.back = await mk(`Lit${U}\\Back`, `zz-lit-${U}-e`, "2026-02-01T00:00:04Z");
    lit.slash = await mk(`Lit${U}/Back`, `zz-lit-${U}-f`, "2026-02-01T00:00:05Z");
  });

  const list = async (args: Record<string, unknown>) => (await ok(read("superadmin", "platform_list_restaurants", { p_search: null, p_status: null, p_cursor: null, p_limit: 25, ...args }))) as any;

  it("keyset sem repetir nem perder (limite 3, 4 empatados em created_at); ordem created_at desc, id desc; última página sem cursor", async () => {
    const got = await pageAll("superadmin", "platform_list_restaurants", { p_search: `Pg${U}`, p_status: null }, 3);
    expect(got).toHaveLength(7);
    noRepeat(got);
    expect(got.map((r) => r.id).sort()).toEqual(pg.map((r) => r.id).sort());
    sortedDesc(got, "created_at");
    const one = await pageAll("support", "platform_list_restaurants", { p_search: `Pg${U}`, p_status: null }, 1);
    expect(one.map((r) => r.id)).toEqual(got.map((r) => r.id));
  });

  it("lista completa (sem busca) percorre TODOS os restaurantes uma vez cada", async () => {
    const got = await pageAll("superadmin", "platform_list_restaurants", { p_search: null, p_status: null }, 40);
    noRepeat(got);
    expect(got).toHaveLength(await count("restaurants"));
    sortedDesc(got, "created_at");
  });

  it("cursor adulterado => INVALID_CURSOR (array, string, número, chave extra/faltando, tipos, uuid/timestamp inválido, t longo)", async () => {
    const good = { t: "2026-03-01T12:00:00.000000Z", id: pg[0].id };
    const bad: unknown[] = [[], "x", 7, true, { t: good.t }, { id: good.id }, { ...good, extra: 1 }, { t: 5, id: good.id }, { t: good.t, id: 5 }, { t: "ontem", id: good.id }, { t: good.t, id: "nao-uuid" }, { t: "2026-03-01T12:00:00Z".padEnd(60, "0"), id: good.id }, { t: null, id: null }, {}];
    for (const c of bad) {
      for (const fn of ["platform_list_restaurants", "platform_list_subscriptions", "platform_list_tickets", "platform_list_support_sessions"]) {
        const r = await call("superadmin", fn, { p_cursor: c });
        expect(r.error?.message, `${fn} ${JSON.stringify(c)}`).toMatch(/^INVALID_CURSOR/);
        expect(r.error!.code).toBe("22023");
      }
      expectRule(await call("superadmin", "platform_list_audit_logs", { p_cursor: c }), /^INVALID_CURSOR/);
    }
    // jsonb null = sem cursor
    expectOk(await call("superadmin", "platform_list_restaurants", { p_cursor: null }));
  });

  it("limites com clamp: 0/-5 => 1; 1000 => <= 100; null => padrão 25", async () => {
    const total = await count("restaurants");
    expect((await list({ p_limit: 0 })).rows).toHaveLength(1);
    expect((await list({ p_limit: -5 })).rows).toHaveLength(1);
    expect((await list({ p_limit: 1000 })).rows).toHaveLength(Math.min(total, 100));
    expect((await list({ p_limit: null })).rows).toHaveLength(Math.min(total, 25));
    expect((await list({ p_limit: 2147483647 })).rows.length).toBeLessThanOrEqual(100);
  });

  it("busca LITERAL de % _ \\ (nome e slug); espaços/vazio = sem filtro; hostil não quebra", async () => {
    const ids = async (s: string) => ((await list({ p_search: s })).rows as any[]).map((r) => r.id).sort();
    expect(await ids(`Lit${U} 100%`)).toEqual([lit.pct.id]);
    expect(await ids(`${U}_Under`)).toEqual([lit.under.id]); // '_' sem escape casaria também 'xUnder'
    expect(await ids(`${U}\\Back`)).toEqual([lit.back.id]);
    expect(await ids(`${U}/Back`)).toEqual([lit.slash.id]);
    expect(await ids(`%`)).toEqual([lit.pct.id]); // só o nome com % literal
    expect(await ids(`LIT${U}`)).toHaveLength(6); // sem distinção de caixa
    expect(await ids(`zz-lit-${U}-c`)).toEqual([lit.under.id]); // por slug
    expect((await list({ p_search: "   " })).rows.length).toBeGreaterThan(0);
    expect((await list({ p_search: "'; drop table restaurants; --" })).rows).toEqual([]);
    expect((await list({ p_search: "x".repeat(500) })).rows).toEqual([]);
    expect(await count("restaurants")).toBeGreaterThan(5);
  });

  it("filtro de status: pending/active/suspended; inválido (inclusive 'ACTIVE' e 'trial') => INVALID_STATUS", async () => {
    for (const [st, fx] of [["pending", R3], ["suspended", R4], ["active", R2]] as const) {
      const r = (await pageAll("superadmin", "platform_list_restaurants", { p_search: `zz P6 ${U}`, p_status: st }, 50)) as any[];
      expect(r.length).toBeGreaterThan(0);
      for (const row of r) expect(row.status).toBe(st);
      expect(r.map((x) => x.id)).toContain(fx.id);
    }
    expect((await list({ p_status: " active " })).rows.length).toBeGreaterThan(0);
    for (const s of ["ACTIVE", "trial", "bogus", "active;"]) await fail(call("superadmin", "platform_list_restaurants", { p_status: s }), "INVALID_STATUS");
  });

  it("linha: só metadados (chaves exatas); plano/assinatura no vocabulário do contrato; dono = nome+e-mail; sem pedidos/clientes", async () => {
    const rowsOut = [...((await list({ p_search: `zz P6 ${U}`, p_limit: 100 })).rows as any[]), ...((await list({ p_search: S.slug })).rows as any[])];
    const byId = new Map(rowsOut.map((r) => [r.id, r]));
    for (const r of rowsOut) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "id", "members_count", "name", "owner_email", "owner_name", "plan_name", "slug", "status", "subscription_status"]);
    }
    const s = byId.get(S.id);
    expect(s.subscription_status).toBe("active");
    expect(s.plan_name).toBe(`zz ${planM.code}`);
    expect(s.members_count).toBe(5);
    expect(s.owner_email).toBe(ACCOUNTS.ownerA.email);
    expect(s.owner_name).toBe(ACCOUNTS.ownerA.fullName);
    expect(byId.get(R2.id).subscription_status).toBe("active"); // vigente prevalece sobre o histórico cancelado
    expect(byId.get(R2.id).plan_name).toBe(`zz ${planY.code}`);
    expect(byId.get(R3.id).subscription_status).toBe("trial");
    expect(byId.get(R4.id).subscription_status).toBe("past_due");
    expect(byId.get(R5.id).subscription_status).toBe("cancelled");
    expect(byId.get(R2.id).owner_email).toBeNull();
  });
});

describe("platform_get_restaurant", () => {
  const get = async (who: Who, id: string) => (await ok(read(who, "platform_get_restaurant", { p_restaurant: id }))) as any;

  it("metadados + assinatura + equipe (sem telefone/e-mail) + auditoria; restaurante inexistente => RESTAURANT_NOT_FOUND", async () => {
    await fail(call("superadmin", "platform_get_restaurant", { p_restaurant: GHOST }), "RESTAURANT_NOT_FOUND");
    await fail(call("support", "platform_get_restaurant", { p_restaurant: null }), "RESTAURANT_NOT_FOUND");
    const g = await get("superadmin", S.id);
    expect(Object.keys(g).sort()).toEqual(["audit", "restaurant", "subscription", "team"]);
    expect(g.restaurant).toMatchObject({ id: S.id, slug: S.slug, status: "active", owner_email: ACCOUNTS.ownerA.email, owner_name: ACCOUNTS.ownerA.fullName });
    expect(g.subscription).toMatchObject({ plan_code: planM.code, status: "active", price_cents: 10000, currency: "BRL" });
    expect(g.team).toHaveLength(5);
    for (const m of g.team) expect(Object.keys(m).sort()).toEqual(["created_at", "full_name", "membership_id", "role", "status"]);
    expect(g.audit.length).toBeLessThanOrEqual(20);
    expect(await get("support", S.id)).toEqual(g);
    // assinatura vigente prevalece; só cancelada => 'cancelled'; sem assinatura => null
    expect((await get("superadmin", R2.id)).subscription.plan_code).toBe(planY.code);
    expect((await get("superadmin", R5.id)).subscription.status).toBe("cancelled");
    const bare = await mkRest("active");
    expect((await get("superadmin", bare.id)).subscription).toBeNull();
    expect((await get("superadmin", bare.id)).team).toEqual([]);
  });

  it("auditoria do restaurante: últimas 20, metadata sem e-mail/telefone/endereço/segredos (recursivo)", async () => {
    for (let i = 0; i < 24; i++) {
      expectOk(
        await adm().rpc("log_audit", {
          p_restaurant: S.id,
          p_action: i === 23 ? "zz.metadata" : "zz.filler",
          p_resource_type: "restaurant",
          p_resource_id: S.id,
          p_metadata: i === 23 ? { email: "x@y.test", customer_phone: "11999", nested: { address: "Rua", telefone: "1", keep: "ok", token: "t0k", deep: [{ cpf: "1", api_key: "k", fine: 1 }] }, note: "visível", password: "p" } : { i },
        }),
      );
    }
    const g = await get("superadmin", S.id);
    expect(g.audit).toHaveLength(20);
    expect(g.audit[0].action).toBe("zz.metadata");
    expect(g.audit[0].metadata).toEqual({ nested: { keep: "ok", deep: [{ fine: 1 }] }, note: "visível" });
    const created = g.audit.map((a: any) => Date.parse(a.created_at));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    expect(JSON.stringify(g)).not.toMatch(/x@y\.test|t0k|11999/);
  });
});

describe("listas de assinaturas, chamados e sessões", () => {
  it("assinaturas: vocabulário do contrato, filtro com os dois vocabulários, INVALID_STATUS, keyset completo", async () => {
    const all = await pageAll("superadmin", "platform_list_subscriptions", { p_status: null }, 4);
    noRepeat(all);
    expect(all).toHaveLength(await count("subscriptions"));
    sortedDesc(all, "created_at");
    for (const r of all) expect(["trial", "active", "past_due", "cancelled"]).toContain(r.status);
    expect(Object.keys(all[0]).sort()).toEqual(["cancel_at_period_end", "created_at", "current_period_end", "current_period_start", "id", "plan_code", "plan_id", "plan_name", "price_cents", "restaurant_id", "restaurant_name", "restaurant_slug", "restaurant_status", "status", "trial_ends_at", "updated_at"]);
    for (const [a, b, out] of [["trial", "trialing", "trial"], ["cancelled", "canceled", "cancelled"], ["active", "ACTIVE", "active"], ["past_due", " past_due ", "past_due"]] as const) {
      const ra = await pageAll("support", "platform_list_subscriptions", { p_status: a }, 50);
      const rb = await pageAll("support", "platform_list_subscriptions", { p_status: b }, 50);
      expect(ra.map((r) => r.id).sort()).toEqual(rb.map((r) => r.id).sort());
      expect(ra.length).toBeGreaterThan(0);
      for (const r of ra) expect(r.status).toBe(out);
    }
    for (const s of ["bogus", "paid", "trial;"]) await fail(call("superadmin", "platform_list_subscriptions", { p_status: s }), "INVALID_STATUS");
  });

  it("chamados: filtro por status, INVALID_STATUS, keyset, linha traz assunto/corpo/restaurante e nada além", async () => {
    const all = await pageAll("superadmin", "platform_list_tickets", { p_status: null }, 3);
    noRepeat(all);
    expect(all).toHaveLength(await count("support_tickets"));
    sortedDesc(all, "created_at");
    for (const st of ["open", "in_progress", "resolved", "closed"]) {
      const r = await pageAll("support", "platform_list_tickets", { p_status: st }, 50);
      for (const x of r) expect(x.status).toBe(st);
    }
    const mine = all.find((t) => t.id === tickets.open1.id);
    expect(mine).toMatchObject({ subject: tickets.open1.subject, restaurant_id: S.id, restaurant_slug: S.slug, status: "open" });
    expect(Object.keys(mine).sort()).toEqual(["body", "created_at", "id", "opened_by", "opened_by_name", "restaurant_id", "restaurant_name", "restaurant_slug", "status", "subject", "updated_at"]);
    for (const s of ["bogus", "OPEN", "done"]) await fail(call("superadmin", "platform_list_tickets", { p_status: s }), "INVALID_STATUS");
  });

  it("sessões: active_only só traz as vigentes (não encerradas e não expiradas); keyset por started_at", async () => {
    const all = await pageAll("superadmin", "platform_list_support_sessions", { p_active_only: false }, 2);
    noRepeat(all);
    expect(all).toHaveLength(await count("support_sessions"));
    for (let i = 1; i < all.length; i++) expect(Date.parse(all[i - 1].started_at)).toBeGreaterThanOrEqual(Date.parse(all[i].started_at));
    const act = await pageAll("support", "platform_list_support_sessions", { p_active_only: true }, 50);
    for (const s of act) {
      expect(s.active).toBe(true);
      expect(s.ended_at).toBeNull();
      expect(Date.parse(s.expires_at)).toBeGreaterThan(Date.now());
    }
    expect(act.length).toBe(await count("support_sessions", (q) => q.is("ended_at", null).gt("expires_at", new Date().toISOString())));
    const mineR2 = all.filter((s) => s.restaurant_id === R2.id);
    expect(mineR2).toHaveLength(3);
    expect(mineR2.filter((s) => s.active)).toHaveLength(1);
    expect(Object.keys(mineR2[0]).sort()).toEqual(["active", "admin_id", "admin_name", "created_at", "ended_at", "expires_at", "id", "reason", "restaurant_id", "restaurant_name", "restaurant_slug", "started_at"]);
  });

  it("planos (extra): contagem de assinaturas total/vigentes", async () => {
    const r = (await ok(read("support", "platform_list_plans"))) as any;
    const m = r.rows.find((p: any) => p.id === planM.id);
    expect(m).toMatchObject({ code: planM.code, subscriptions_total: 4, subscriptions_live: 2, price_cents: 10000, is_active: true });
    const ordered = r.rows.map((p: any) => [p.sort_order, p.code]);
    expect(ordered).toEqual([...ordered].sort((a: any, b: any) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Criação de restaurante
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_create_restaurant", () => {
  const create = (name: unknown, slug: unknown, email: unknown, who: Who = "superadmin") => call(who, "platform_create_restaurant", { p_name: name, p_slug: slug, p_owner_email: email });
  const owner = ACCOUNTS.ownerA.email;

  it("cria ativo + vínculo owner + trial com default_trial_days (e-mail e slug normalizados) + auditoria", async () => {
    const slug = `zz-cr-${U}`;
    const t0 = Date.now();
    const out = (await ok(create("  zz Criado Pela Plataforma  ", `  ZZ-CR-${U.toUpperCase()} `, `  ${owner.toUpperCase()} `))) as any;
    cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", out.id)));
    expect(out).toMatchObject({ slug, name: "zz Criado Pela Plataforma", status: "active", owner_id: userId("ownerA") });
    expect(out.subscription_id).toEqual(expect.any(String));
    const r = (await adm().from("restaurants").select("*").eq("id", out.id).single()).data!;
    expect(r).toMatchObject({ status: "active", slug, created_by: userId("superadmin") });
    const m = ((await adm().from("restaurant_memberships").select("role,status,user_id").eq("restaurant_id", out.id)).data ?? []) as any[];
    expect(m).toEqual([{ role: "owner", status: "active", user_id: userId("ownerA") }]);
    const subs = await sub(out.id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: "trialing", id: out.subscription_id });
    const plan = (await adm().from("plans").select("id").eq("is_active", true).order("sort_order").order("created_at").order("code").limit(1).single()).data!;
    expect(subs[0].plan_id).toBe(plan.id);
    const end = Date.parse(subs[0].trial_ends_at);
    expect(end).toBeGreaterThan(t0 + 14 * DAY - 60_000);
    expect(end).toBeLessThan(Date.now() + 14 * DAY + 60_000);
    expect(Date.parse(subs[0].current_period_end)).toBe(end);
    const acts = (await audits({ restaurant_id: out.id })).map((a) => a.action).sort();
    expect(acts).toEqual(["platform.restaurant_created", "restaurant.created"]);
    for (const a of await audits({ restaurant_id: out.id })) expect(a.actor_id).toBe(userId("superadmin"));
    // o dono enxerga o restaurante criado
    expect(((await as("ownerA").from("restaurants").select("id").eq("id", out.id)).data ?? []).length).toBe(1);
    // slug repetido (mesmo em outra caixa) => SLUG_UNAVAILABLE
    await fail(create("zz Dup", slug.toUpperCase(), owner), "SLUG_UNAVAILABLE");
    await fail(create("zz Dup", "demo-a", owner), "SLUG_UNAVAILABLE");
  });

  it("OWNER_NOT_FOUND, INVALID_EMAIL, INVALID_SLUG (formato/tamanho/reservado), INVALID_NAME: sem criar nada", async () => {
    const restBefore = await count("restaurants");
    await fail(create("zz Sem Dono", `zz-nd-${U}`, `ninguem.${U}@example.test`), "OWNER_NOT_FOUND");
    for (const e of ["", "   ", "abc", "a@b", "a b@c.de", "@c.de", "a@@c.de", `${"x".repeat(250)}@a.bc`, null, 42]) {
      await fail(create("zz Email", `zz-em-${U}`, e), "INVALID_EMAIL");
    }
    for (const s of ["", "ab", "-abc", "abc-", "a--b-", "a_b_c", "ab cd", "x".repeat(64), "áéí", "admin", "platform", "support", "plans", null]) {
      const r = await create("zz Slug", s, owner);
      expect(r.error?.message, JSON.stringify(s)).toMatch(/^INVALID_SLUG/);
      expect(r.error!.code).toBe("23514");
    }
    for (const n of ["", " ", "a", "x".repeat(121), null]) await fail(create(n, `zz-nm-${U}`, owner), "INVALID_NAME");
    expect(await count("restaurants")).toBe(restBefore);
  });

  it("com a fila de cadastros desativada a plataforma ainda cria (REGISTRATION_DISABLED vale só para o auto-cadastro)", async () => {
    await ok(call("superadmin", "platform_set_setting", { p_key: "registration_enabled", p_value: false }));
    try {
      const out = (await ok(create("zz Criado Com Registro Off", `zz-cr2-${U}`, owner))) as any;
      cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", out.id)));
      expect(out.status).toBe("active");
    } finally {
      await ok(call("superadmin", "platform_set_setting", { p_key: "registration_enabled", p_value: true }));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Suspensão
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_set_restaurant_status", () => {
  const setStatus = (rid: unknown, status: unknown, reason: unknown = null, who: Who = "superadmin") => call(who, "platform_set_restaurant_status", { p_restaurant: rid, p_status: status, p_reason: reason });
  const REASON = "inadimplência recorrente e fraude";
  let T: Tenant;

  beforeAll(async () => {
    T = await makeTenant(cleanup);
    expectOk(await adm().from("orders").insert({ restaurant_id: T.id, fulfillment_type: "PICKUP", status: "RECEIVED", source: "STAFF", subtotal_cents: 1000, total_cents: 1000, idempotency_key: `zz-t26-susp-${U}`, customer_name: "zz susp" }));
    expectOk(await adm().from("products").insert({ restaurant_id: T.id, name: "zz prod susp", price_cents: 100, is_active: true }));
  });

  it("validação: motivo >= 10 (após trim) para suspender, <= 500; status só active|suspended; inexistente", async () => {
    for (const reason of [null, "", "   ", "123456789", "  123456789  ", "curto"]) await fail(setStatus(T.id, "suspended", reason), "REASON_REQUIRED");
    await fail(setStatus(T.id, "suspended", "x".repeat(501)), "INVALID_REASON");
    await fail(setStatus(T.id, "active", "x".repeat(501)), "INVALID_REASON");
    for (const st of ["pending", "bogus", "", null, "SUSPENDED"]) await fail(setStatus(T.id, st, REASON), "INVALID_STATUS");
    await fail(setStatus(GHOST, "suspended", REASON), "RESTAURANT_NOT_FOUND");
    await fail(setStatus(null, "active"), "RESTAURANT_NOT_FOUND");
    expect((await adm().from("restaurants").select("status").eq("id", T.id).single()).data!.status).toBe("active");
  });

  it("suspender: o dono e a equipe perdem is_member/permissões NA HORA e deixam de ler dados; reativar devolve; repetir = changed:false sem nova auditoria", async () => {
    const readable = async (who: AccountKey) => {
      const o = ((await as(who).from("orders").select("id").eq("restaurant_id", T.id)).data ?? []).length;
      const p = ((await as(who).from("products").select("id").eq("restaurant_id", T.id)).data ?? []).length;
      return { o, p, member: (await as(who).rpc("is_member", { rid: T.id })).data, perm: (await as(who).rpc("has_permission", { rid: T.id, perm: "orders.view" })).data };
    };
    expect(await readable("ownerA")).toEqual({ o: 1, p: 1, member: true, perm: true });
    expect(await readable("cashierA")).toMatchObject({ o: 1, member: true });
    const nAudit = async () => (await audits({ restaurant_id: T.id }, "platform.restaurant_status_changed")).length;

    const s1 = (await ok(setStatus(T.id, "suspended", `  ${REASON}  `))) as any;
    expect(s1).toEqual({ id: T.id, status: "suspended", previous_status: "active", changed: true });
    expect(await readable("ownerA")).toEqual({ o: 0, p: 0, member: false, perm: false });
    expect(await readable("cashierA")).toEqual({ o: 0, p: 0, member: false, perm: false });
    for (const who of ["ownerA", "managerA", "cashierA"] as const) {
      expect((await as(who).rpc("list_team", { p_restaurant: T.id })).error, who).not.toBeNull();
      expect((await as(who).rpc("list_customers", { p_restaurant: T.id, p_search: null, p_cursor: null, p_limit: 5 })).error, who).not.toBeNull();
    }
    expect((await anon().from("restaurants").select("id").eq("id", T.id)).data ?? []).toEqual([]);
    // a plataforma continua vendo o restaurante e seu estado
    expect((await ok(read("superadmin", "platform_get_restaurant", { p_restaurant: T.id }))).restaurant.status).toBe("suspended");

    const n1 = await nAudit();
    expect(n1).toBe(1);
    const log = (await audits({ restaurant_id: T.id }, "platform.restaurant_status_changed"))[0];
    expect(log.metadata).toEqual({ status_from: "active", status_to: "suspended", reason: REASON });
    expect(log.actor_id).toBe(userId("superadmin"));
    // repetir: no-op, sem auditoria
    expect(await ok(setStatus(T.id, "suspended", REASON))).toEqual({ id: T.id, status: "suspended", previous_status: "suspended", changed: false });
    expect(await nAudit()).toBe(1);

    const s2 = (await ok(setStatus(T.id, "active"))) as any;
    expect(s2).toEqual({ id: T.id, status: "active", previous_status: "suspended", changed: true });
    expect(await readable("ownerA")).toEqual({ o: 1, p: 1, member: true, perm: true });
    expect(await ok(setStatus(T.id, "active"))).toMatchObject({ changed: false, previous_status: "active" });
    expect(await nAudit()).toBe(2);
  });

  it("pending só pode ir para active (INVALID_TRANSITION); ninguém volta a pending", async () => {
    const p = await mkRest("pending");
    await fail(setStatus(p.id, "suspended", REASON), "INVALID_TRANSITION");
    await fail(setStatus(p.id, "pending", REASON), "INVALID_STATUS");
    expect((await adm().from("restaurants").select("status").eq("id", p.id).single()).data!.status).toBe("pending");
    expect(await ok(setStatus(p.id, "active"))).toEqual({ id: p.id, status: "active", previous_status: "pending", changed: true });
    await fail(setStatus(p.id, "pending"), "INVALID_STATUS");
  });

  it("concorrência: 2 e 6 suspensões simultâneas => exatamente uma muda (changed:true), as demais changed:false, 1 auditoria; idem reativar", async () => {
    const c = await mkRest("active");
    for (const [round, target] of [[2, "suspended"], [6, "active"], [6, "suspended"], [2, "active"]] as const) {
      const rs = await Promise.all(Array.from({ length: round }, () => setStatus(c.id, target, REASON)));
      for (const r of rs) expectOk(r);
      const changed = rs.map((r) => (r.data as any).changed);
      expect(changed.filter(Boolean), `${round}x ${target}`).toHaveLength(1);
      expect(changed.filter((x) => !x)).toHaveLength(round - 1);
    }
    expect((await audits({ restaurant_id: c.id }, "platform.restaurant_status_changed")).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Planos
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_upsert_plan", () => {
  const up = (args: Record<string, unknown>, who: Who = "superadmin") => call(who, "platform_upsert_plan", { p_id: null, p_code: null, p_name: null, p_price_cents: null, p_limits: null, p_features: null, p_is_active: null, ...args });
  const created: string[] = [];
  const mk = async (suffix: string, extra: Record<string, unknown> = {}) => {
    const code = `zz-up-${U}-${suffix}`;
    const out = (await ok(up({ p_code: code, p_name: `zz Plano ${suffix}`, p_price_cents: 4990, ...extra }))) as any;
    created.push(out.id);
    cleanup.add(async () => {
      await adm().from("subscriptions").delete().eq("plan_id", out.id);
      await adm().from("plans").delete().eq("id", out.id);
    });
    return out;
  };

  it("cria (sort_order = maior + 10, ativo por padrão, limits/features) e audita platform.plan_created sem restaurante", async () => {
    const maxBefore = Math.max(...(((await adm().from("plans").select("sort_order")).data ?? []) as any[]).map((p) => p.sort_order));
    const p = await mk("a", { p_limits: { max_members: 3, max_tables: null, max_menu_items: 10, max_print_jobs_per_month: 0, max_products: 7 }, p_features: { reports: true, support: "email" } });
    expect(p).toMatchObject({ created: true, price_cents: 4990, is_active: true, currency: "BRL", billing_interval: "month", features: { reports: true, support: "email" } });
    expect(p.limits).toEqual({ max_members: 3, max_tables: null, max_menu_items: 10, max_print_jobs_per_month: 0, max_products: 7 });
    expect(p.sort_order).toBe(maxBefore + 10);
    const row = (await adm().from("plans").select("*").eq("id", p.id).single()).data!;
    expect(row.code).toBe(`zz-up-${U}-a`);
    const a = (await audits({ resource_id: p.id }, "platform.plan_created"))[0];
    expect(a.restaurant_id).toBeNull();
    expect(a.actor_id).toBe(userId("superadmin"));
    expect(a.metadata).toMatchObject({ code: p.code, price_cents: 4990 });
    // cria plano inativo e código em maiúsculas é normalizado
    const q = await mk("B1", {});
    expect(q.code).toBe(`zz-up-${U}-b1`);
  });

  it("validação de criação: código, nome, preço, limits, features", async () => {
    const base = { p_code: `zz-v-${U}`, p_name: "ok", p_price_cents: 100 };
    for (const c of ["A", "a", "ab_c", "a b", "x".repeat(41), "ação", "a/b", "../x", null, "", "  "]) {
      await fail(up({ ...base, p_code: c }), "INVALID_CODE");
    }
    for (const n of [null, "", "  ", "a", "x".repeat(81)]) await fail(up({ ...base, p_name: n }), "INVALID_NAME");
    await fail(up({ ...base, p_price_cents: null }), "INVALID_PRICE");
    for (const pr of [-1, 100000001]) await fail(up({ ...base, p_price_cents: pr }), "INVALID_PRICE");
    for (const l of [[], "x", 5, true, { foo: 1 }, { max_members: -1 }, { max_members: 1.5 }, { max_members: "3" }, { max_members: 2147483648 }, { max_members: true }, { max_tables: {} }, { max_products: [] }, { Max_Members: 1 }, { "max_members ": 1 }, { max_members: 1, extra: 1 }]) {
      await fail(up({ ...base, p_limits: l }), "INVALID_LIMITS");
    }
    for (const f of [[], "x", 5, true, { big: "x".repeat(4001) }]) await fail(up({ ...base, p_features: f }), "INVALID_FEATURES");
    expect((await adm().from("plans").select("id").like("code", `zz-v-${U}%`)).data).toEqual([]);
    // limites de borda aceitos
    const edge = await mk("edge", { p_limits: { max_members: 0, max_tables: 2147483647, max_products: null }, p_features: {} });
    expect(edge.limits).toEqual({ max_members: 0, max_tables: 2147483647, max_products: null });
  });

  it("código duplicado (inclusive em outra caixa) => CODE_TAKEN; atualizar para código alheio => CODE_TAKEN; PLAN_NOT_FOUND", async () => {
    const a = await mk("dup1");
    const b = await mk("dup2");
    await fail(up({ p_code: a.code.toUpperCase(), p_name: "xx", p_price_cents: 1 }), "CODE_TAKEN");
    await fail(up({ p_id: b.id, p_code: a.code }), "CODE_TAKEN");
    await fail(up({ p_id: GHOST, p_name: "fantasma" }), "PLAN_NOT_FOUND");
    expect((await adm().from("plans").select("code").eq("id", b.id).single()).data!.code).toBe(b.code);
    expect(await count("plans", (q) => q.eq("code", a.code))).toBe(1);
  });

  it("concorrência: criar o mesmo código 4x em paralelo => 1 cria, 3 CODE_TAKEN", async () => {
    const code = `zz-up-${U}-race`;
    const rs = await Promise.all(Array.from({ length: 4 }, () => up({ p_code: code, p_name: "race", p_price_cents: 1 })));
    const okRows = rs.filter((r) => !r.error);
    expect(okRows).toHaveLength(1);
    for (const r of rs.filter((x) => x.error)) expect(r.error!.message).toMatch(/^CODE_TAKEN/);
    const id = (okRows[0].data as any).id;
    cleanup.add(async () => void (await adm().from("plans").delete().eq("id", id)));
  });

  it("atualizar: parâmetros NULL mantêm; substitui limits por inteiro; auditoria com valores anteriores; nunca apaga", async () => {
    const p = await mk("upd", { p_limits: { max_members: 5, max_menu_items: 150 }, p_features: { a: true } });
    const u1 = (await ok(up({ p_id: p.id, p_name: "Renomeado" }))) as any;
    expect(u1).toMatchObject({ created: false, name: "Renomeado", code: p.code, price_cents: 4990, limits: { max_members: 5, max_menu_items: 150 }, features: { a: true }, is_active: true });
    const u2 = (await ok(up({ p_id: p.id, p_price_cents: 0, p_limits: { max_tables: 9 } }))) as any;
    expect(u2.price_cents).toBe(0);
    expect(u2.limits).toEqual({ max_tables: 9 }); // o banco SUBSTITUI limits (o app preserva as demais chaves)
    const au = (await audits({ resource_id: p.id }, "platform.plan_updated"))[0];
    expect(au.metadata.previous).toMatchObject({ price_cents: 4990, limits: { max_members: 5, max_menu_items: 150 } });
    expect(au.restaurant_id).toBeNull();
    // nenhuma RPC apaga plano; F-50: o superadmin ainda apaga plano SEM assinaturas por REST direto (sem auditoria) -> ver FINDINGS
    expect(await count("plans", (q) => q.eq("id", p.id))).toBe(1);
  });

  it("PLAN_IN_USE: código de plano com assinatura não muda (mesmo código e demais campos podem); PLAN_INACTIVE ao atribuir plano inativo", async () => {
    const p = await mk("use");
    const r = await mkRest("active");
    await ok(call("superadmin", "platform_set_subscription", { p_restaurant: r.id, p_plan: p.id, p_status: "active", p_period_end: null, p_note: null }));
    await fail(up({ p_id: p.id, p_code: `zz-up-${U}-use2` }), "PLAN_IN_USE");
    // plano em uso nunca é apagado (FK RESTRICT), nem pelo superadmin por REST
    const delUsed = await as("superadmin").from("plans").delete().eq("id", p.id).select("id");
    expect(delUsed.error?.code).toBe("23503");
    expect(await count("plans", (q) => q.eq("id", p.id))).toBe(1);
    expect((await adm().from("plans").select("code").eq("id", p.id).single()).data!.code).toBe(p.code);
    await ok(up({ p_id: p.id, p_code: p.code.toUpperCase(), p_name: "Mesmo código", p_price_cents: 1 }));
    // um plano sem assinatura pode mudar de código
    const free = await mk("free");
    expect(((await ok(up({ p_id: free.id, p_code: `zz-up-${U}-free2` }))) as any).code).toBe(`zz-up-${U}-free2`);
    // inativar um plano em uso é permitido; mas não pode ser atribuído a outro restaurante
    await ok(up({ p_id: p.id, p_is_active: false }));
    const r2 = await mkRest("active");
    await fail(call("superadmin", "platform_set_subscription", { p_restaurant: r2.id, p_plan: p.id, p_status: "active", p_period_end: null, p_note: null }), "PLAN_INACTIVE");
    // o restaurante que já o usa mantém (mesmo plano inativo) e pode ser cancelado
    await ok(call("superadmin", "platform_set_subscription", { p_restaurant: r.id, p_plan: p.id, p_status: "past_due", p_period_end: null, p_note: null }));
    await ok(call("superadmin", "platform_set_subscription", { p_restaurant: r.id, p_plan: null, p_status: "cancelled", p_period_end: null, p_note: null }));
    expect(live(await sub(r.id))).toHaveLength(0);
    expect(live(await sub(r2.id))).toHaveLength(0);
  });

  it("LAST_ACTIVE_PLAN: não inativa o último plano ativo (estado global restaurado em finally)", async () => {
    const all = ((await adm().from("plans").select("id,is_active")).data ?? []) as any[];
    const wasActive = all.filter((p) => p.is_active).map((p) => p.id);
    const keep = await mk("last");
    try {
      const others = wasActive.filter((id) => id !== keep.id);
      if (others.length) await adm().from("plans").update({ is_active: false }).in("id", others);
      await fail(up({ p_id: keep.id, p_is_active: false }), "LAST_ACTIVE_PLAN");
      expect((await adm().from("plans").select("is_active").eq("id", keep.id).single()).data!.is_active).toBe(true);
      // inativar o que já está inativo / reativar outro não dispara a regra
      await ok(up({ p_id: others[0], p_is_active: true }));
      await ok(up({ p_id: keep.id, p_is_active: false }));
      await ok(up({ p_id: keep.id, p_is_active: true }));
    } finally {
      const ids = wasActive.filter((id) => id !== keep.id);
      if (ids.length) await adm().from("plans").update({ is_active: true }).in("id", ids);
    }
    expect(await count("plans", (q) => q.eq("is_active", true))).toBeGreaterThanOrEqual(wasActive.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Assinaturas
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_set_subscription", () => {
  const setSub = (rid: unknown, plan: unknown, status: unknown, end: unknown = null, note: unknown = null, who: Who = "superadmin") =>
    call(who, "platform_set_subscription", { p_restaurant: rid, p_plan: plan, p_status: status, p_period_end: end, p_note: note });
  let P1: { id: string; code: string };
  let P2: { id: string; code: string };
  beforeAll(async () => {
    P1 = await mkPlan(`zz-sb1-${U}`, 5000, "month");
    P2 = await mkPlan(`zz-sb2-${U}`, 7000, "month");
  });

  it("validação: status (e vocabulário), nota, restaurante/plano inexistentes, sem plano, cancelar sem vigente", async () => {
    const r = await mkRest("active");
    for (const st of ["bogus", "", null, "paid", "trial;", "expired"]) await fail(setSub(r.id, P1.id, st), "INVALID_STATUS");
    await fail(setSub(r.id, P1.id, "active", null, "n".repeat(501)), "INVALID_NOTE");
    await fail(setSub(GHOST, P1.id, "active"), "RESTAURANT_NOT_FOUND");
    await fail(setSub(r.id, GHOST, "active"), "PLAN_NOT_FOUND");
    await fail(setSub(r.id, null, "active"), "PLAN_NOT_FOUND");
    await fail(setSub(r.id, P1.id, "cancelled"), "SUBSCRIPTION_NOT_FOUND");
    await fail(setSub(r.id, null, "canceled"), "SUBSCRIPTION_NOT_FOUND");
    expect(await sub(r.id)).toEqual([]);
  });

  it("period_end no passado é recusado (nova linha e vigente) e fim <= início também; futuro ok", async () => {
    const r = await mkRest("active");
    for (const st of ["trial", "active", "past_due", "trialing"]) await fail(setSub(r.id, P1.id, st, iso(-DAY)), "INVALID_PERIOD");
    expect(await sub(r.id)).toEqual([]);
    const created = (await ok(setSub(r.id, P1.id, "active", iso(30 * DAY)))) as any;
    expect(created.status).toBe("active");
    for (const st of ["trial", "active", "past_due"]) await fail(setSub(r.id, null, st, iso(-DAY)), "INVALID_PERIOD");
    await fail(setSub(r.id, null, "active", iso(-1000)), "INVALID_PERIOD");
    const row = (await sub(r.id))[0];
    expect(Date.parse(row.current_period_end)).toBe(Date.parse(created.current_period_end));
  });

  it("vocabulário: trial/trialing e cancelled/canceled (qualquer caixa) entram; as saídas usam trial/cancelled; NO MÁXIMO 1 vigente", async () => {
    const r = await mkRest("active");
    const a = (await ok(setSub(r.id, P1.id, " TRIAL ", iso(10 * DAY)))) as any;
    expect(a.status).toBe("trial");
    expect(a.trial_ends_at).toBe(a.current_period_end);
    expect((await sub(r.id))[0].status).toBe("trialing");
    const b = (await ok(setSub(r.id, P2.id, "active", iso(40 * DAY)))) as any;
    expect(b).toMatchObject({ id: a.id, status: "active", plan_id: P2.id, plan_code: P2.code }); // atualiza a vigente, não cria outra
    expect(live(await sub(r.id))).toHaveLength(1);
    expect(((await ok(setSub(r.id, null, "past_due"))) as any)).toMatchObject({ id: a.id, status: "past_due", plan_id: P2.id });
    expect(((await ok(setSub(r.id, P1.id, "trialing"))) as any).status).toBe("trial");
    const c = (await ok(setSub(r.id, null, "CANCELED"))) as any;
    expect(c).toMatchObject({ id: a.id, status: "cancelled", cancel_at_period_end: false });
    expect(live(await sub(r.id))).toHaveLength(0);
    // reativar cria NOVA linha (histórico preservado)
    const d = (await ok(setSub(r.id, P1.id, "active"))) as any;
    expect(d.id).not.toBe(a.id);
    const all = await sub(r.id);
    expect(all).toHaveLength(2);
    expect(live(all)).toHaveLength(1);
    expect(all.find((s) => s.id === a.id).status).toBe("canceled");
    // o plano da assinatura cancelada pode ser trocado junto (plano ativo)
    expect(((await ok(setSub(r.id, P2.id, "cancelled"))) as any).plan_id).toBe(P2.id);
    // auditoria no vocabulário do contrato
    const ac = (await audits({ restaurant_id: r.id }, "platform.subscription_changed")).map((x) => x.metadata);
    expect(ac.some((m) => m.status_from === "trial" && m.status_to === "active")).toBe(true);
    expect(ac.some((m) => m.status_to === "cancelled")).toBe(true);
    for (const m of ac) {
      for (const v of [m.status_from, m.status_to]) expect(v === null || ["trial", "active", "past_due", "cancelled"].includes(v)).toBe(true);
    }
  });

  it("concorrência: 6 platform_set_subscription simultâneos (estados e planos diferentes) => nenhuma falha e exatamente 1 vigente", async () => {
    for (const fresh of [true, false]) {
      const r = await mkRest("active");
      if (!fresh) await ok(setSub(r.id, P1.id, "trial", iso(5 * DAY)));
      const plans = [P1.id, P2.id];
      const sts = ["active", "trial", "past_due", "active", "trial", "past_due"];
      const rs = await Promise.all(sts.map((st, i) => setSub(r.id, plans[i % 2], st, iso(20 * DAY))));
      for (const x of rs) expectOk(x);
      const all = await sub(r.id);
      expect(live(all), `fresh=${fresh}`).toHaveLength(1);
      expect(all).toHaveLength(1);
      // cancelamento x reativação em paralelo também termina com no máximo 1
      const mix = await Promise.all([setSub(r.id, null, "cancelled"), setSub(r.id, P1.id, "active"), setSub(r.id, P2.id, "past_due"), setSub(r.id, null, "cancelled")]);
      for (const x of mix) if (x.error) expect(x.error.message).toMatch(/^SUBSCRIPTION_NOT_FOUND/);
      expect(live(await sub(r.id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("notas são INTERNAS: só na auditoria da plataforma (restaurant_id NULL); nem o dono nem support leem", async () => {
    const note = `nota-interna-sub-${U}`;
    const rid = S.id;
    const before = await sub(rid);
    await ok(setSub(rid, planM.id, "active", iso(60 * DAY), `  ${note}  `));
    const notes = (await audits({}, "platform.subscription_note")).filter((a) => JSON.stringify(a.metadata).includes(note));
    expect(notes).toHaveLength(1);
    expect(notes[0].restaurant_id).toBeNull();
    expect(notes[0].metadata).toEqual({ restaurant_id: rid, note });
    expect(notes[0].resource_id).toBe(before[0].id);
    const changed = (await audits({ restaurant_id: rid }, "platform.subscription_changed"))[0];
    expect(JSON.stringify(changed)).not.toContain(note);
    // superadmin enxerga na auditoria da plataforma; support não (FORBIDDEN)
    const pl = (await ok(read("superadmin", "platform_list_audit_logs", { p_action_prefix: "platform.subscription_note", p_limit: 20 }))) as any;
    expect(pl.rows.find((r: any) => r.metadata?.note === note)).toMatchObject({ restaurant_id: null, action: "platform.subscription_note" });
    expect((await call("support", "platform_list_audit_logs", { p_action_prefix: "platform.", p_limit: 5 })).error!.message).toMatch(/^FORBIDDEN/);
    // dono/equipe: REST direto e RPC list_audit_logs não trazem a linha da nota
    for (const who of ["ownerA", "managerA"] as const) {
      const rest = await as(who).from("audit_logs").select("*").like("action", "platform.%").limit(1000);
      expect(JSON.stringify(rest.data ?? [])).not.toContain(note);
      for (const a of (rest.data ?? []) as any[]) expect(["platform.subscription_note", "platform.ticket_note", "platform.setting_updated", "platform.plan_created", "platform.plan_updated"]).not.toContain(a.action);
      const rpc = await as(who).rpc("list_audit_logs", { p_restaurant: rid, p_action_prefix: null, p_from: null, p_to: null, p_limit: 200, p_before: null });
      expect(JSON.stringify(rpc.data ?? null)).not.toContain(note);
    }
    // a plataforma sem sessão também não os recebe por get_restaurant (só linhas do restaurante)
    expect(JSON.stringify(await ok(read("support", "platform_get_restaurant", { p_restaurant: rid })))).not.toContain(note);
    // nota em branco não gera linha
    const nBefore = (await audits({}, "platform.subscription_note")).length;
    await ok(setSub(rid, null, "active", null, "   "));
    expect((await audits({}, "platform.subscription_note")).length).toBe(nBefore);
    await ok(setSub(rid, planM.id, "active"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. Chamados
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_update_ticket", () => {
  const upd = (id: unknown, st: unknown, note: unknown = null, who: Who = "superadmin") => call(who, "platform_update_ticket", { p_ticket: id, p_status: st, p_note: note });

  it("superadmin e support alteram o estado (qualquer transição); validação; inexistente", async () => {
    const t = await mkTicket(S.id, "open");
    for (const st of ["bogus", "", null, "OPEN", "done"]) await fail(upd(t.id, st), "INVALID_STATUS");
    await fail(upd(t.id, "closed", "n".repeat(1001)), "INVALID_NOTE");
    await fail(upd(GHOST, "closed"), "TICKET_NOT_FOUND");
    await fail(upd(null, "closed"), "TICKET_NOT_FOUND");
    expect((await adm().from("support_tickets").select("status").eq("id", t.id).single()).data!.status).toBe("open");
    const r1 = (await ok(upd(t.id, "in_progress", null, "support"))) as any;
    expect(r1).toMatchObject({ id: t.id, restaurant_id: S.id, status: "in_progress" });
    expect(Object.keys(r1).sort()).toEqual(["id", "restaurant_id", "status", "updated_at"]);
    for (const [who, st] of [["superadmin", "resolved"], ["support", "closed"], ["superadmin", "open"]] as const) {
      expect(((await ok(upd(t.id, st, null, who))) as any).status).toBe(st);
    }
    const acts = await audits({ resource_id: t.id }, "platform.ticket_updated");
    expect(acts.map((a) => a.metadata.status_to).sort()).toEqual(["closed", "in_progress", "open", "resolved"]);
    expect(acts.every((a) => a.restaurant_id === S.id)).toBe(true);
    expect(new Set(acts.map((a) => a.actor_id))).toEqual(new Set([userId("superadmin"), userId("support")]));
  });

  it("nota INTERNA: auditoria da plataforma (restaurant_id NULL); o autor do chamado e o dono não a leem", async () => {
    const t = await mkTicket(S.id, "open");
    const note = `nota-interna-tk-${U}`;
    await ok(upd(t.id, "resolved", note, "support"));
    const rows = (await audits({ resource_id: t.id }, "platform.ticket_note")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].restaurant_id).toBeNull();
    expect(rows[0].metadata).toEqual({ restaurant_id: S.id, note });
    expect(rows[0].actor_id).toBe(userId("support"));
    const own = await as("waiterA").from("support_tickets").select("*").eq("id", t.id).single();
    expect(own.data!.status).toBe("resolved");
    expect(JSON.stringify(own.data)).not.toContain(note);
    for (const who of ["ownerA", "managerA", "waiterA"] as const) {
      expect(JSON.stringify((await as(who).from("audit_logs").select("*").limit(1000)).data ?? [])).not.toContain(note);
    }
    const ticketRow = ((await ok(read("superadmin", "platform_list_tickets", { p_status: "resolved", p_limit: 100 }))) as any).rows.find((x: any) => x.id === t.id);
    expect(JSON.stringify(ticketRow)).not.toContain(note); // a nota não vive no chamado
  });

  it("chamado sem restaurante (restaurante apagado) pode ser atualizado; auditoria sem restaurante", async () => {
    const t = await mkTicket(null, "open");
    const out = (await ok(upd(t.id, "closed"))) as any;
    expect(out.restaurant_id).toBeNull();
    const row = ((await ok(read("superadmin", "platform_list_tickets", { p_status: "closed", p_limit: 100 }))) as any).rows.find((x: any) => x.id === t.id);
    expect(row).toMatchObject({ restaurant_id: null, restaurant_name: null, restaurant_slug: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. Configurações da plataforma
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_set_setting, platform_get_settings, public_platform_flags, register_restaurant", () => {
  const set = (key: unknown, value: unknown, who: Who = "superadmin") => call(who, "platform_set_setting", { p_key: key, p_value: value });
  const settings = async (who: Who = "superadmin") => (await ok(read(who, "platform_get_settings"))) as any;
  const stored = async (key: string) => (await adm().from("platform_settings").select("value").eq("key", key).maybeSingle()).data?.value;

  afterAll(async () => {
    await adm().from("platform_settings").delete().not("key", "in", "(registration_enabled,default_trial_days)");
    await adm().from("platform_settings").upsert([{ key: "registration_enabled", value: true }, { key: "default_trial_days", value: 14 }], { onConflict: "key" });
  });

  it("get_settings (superadmin e support): 4 chaves + updated_at; padrões", async () => {
    const s = await settings();
    expect(Object.keys(s).sort()).toEqual(["default_trial_days", "maintenance_message", "registration_enabled", "support_email", "updated_at"]);
    expect(s).toMatchObject({ registration_enabled: true, default_trial_days: 14 });
    expect(await settings("support")).toEqual(s);
  });

  it("chave inválida (inclusive caixa/espaços internos/nula/injeção) => INVALID_SETTING_KEY; nada gravado", async () => {
    const rowsBefore = await count("platform_settings");
    for (const k of ["bogus", "REGISTRATION_ENABLED", "registration enabled", "", null, "support_email;drop", "default_trial_days ' or 1=1", "__proto__"]) {
      await fail(set(k, true), "INVALID_SETTING_KEY");
    }
    expect(await count("platform_settings")).toBe(rowsBefore);
  });

  it("valores inválidos/faixas => INVALID_SETTING_VALUE; limites 0 e 365 aceitos", async () => {
    for (const v of ["true", 1, 0, null, {}, [], "sim"]) await fail(set("registration_enabled", v), "INVALID_SETTING_VALUE");
    for (const v of [-1, 366, 1.5, 365.0001, "7", true, null, [], {}, 1e9]) await fail(set("default_trial_days", v), "INVALID_SETTING_VALUE");
    await fail(set("support_email", 5), "INVALID_SETTING_VALUE");
    await fail(set("support_email", "a".repeat(201)), "INVALID_SETTING_VALUE");
    await fail(set("support_email", true), "INVALID_SETTING_VALUE");
    await fail(set("maintenance_message", 5), "INVALID_SETTING_VALUE");
    await fail(set("maintenance_message", "m".repeat(301)), "INVALID_SETTING_VALUE");
    await fail(set("maintenance_message", { a: 1 }), "INVALID_SETTING_VALUE");
    expect(await stored("default_trial_days")).toBe(14);
    expect(await stored("registration_enabled")).toBe(true);
    for (const v of [0, 365, 7.0]) {
      const out = (await ok(set("default_trial_days", v))) as any;
      expect(out).toEqual({ key: "default_trial_days", value: v });
      expect(await stored("default_trial_days")).toBe(v);
    }
    await ok(set("default_trial_days", 14));
  });

  it("texto: apara espaços, vazio/null viram null, 200/300 caracteres aceitos; auditoria platform.setting_updated sem restaurante", async () => {
    expect(await ok(set("support_email", "  ajuda@plataforma.test  "))).toEqual({ key: "support_email", value: "ajuda@plataforma.test" });
    expect((await settings()).support_email).toBe("ajuda@plataforma.test");
    expect(await ok(set("support_email", "   "))).toEqual({ key: "support_email", value: null });
    expect(await ok(set("support_email", "e".repeat(200)))).toMatchObject({ value: "e".repeat(200) });
    expect(await ok(set("support_email", null))).toEqual({ key: "support_email", value: null });
    expect(await ok(set("maintenance_message", "m".repeat(300)))).toMatchObject({ value: "m".repeat(300) });
    expect(await ok(set("maintenance_message", "  Voltamos às 10h  "))).toEqual({ key: "maintenance_message", value: "Voltamos às 10h" });
    expect((await settings()).maintenance_message).toBe("Voltamos às 10h");
    await ok(set("maintenance_message", null));
    expect((await settings()).maintenance_message).toBeNull();
    const logs = (await audits({}, "platform.setting_updated")).filter((a) => a.metadata.key === "maintenance_message");
    expect(logs[0].metadata).toEqual({ key: "maintenance_message", from: "Voltamos às 10h", to: null });
    expect(logs[0].restaurant_id).toBeNull();
    expect(logs[0].actor_id).toBe(userId("superadmin"));
  });

  it("tabela platform_settings: sem SELECT/INSERT/UPDATE/DELETE direto para NENHUM cliente (nem superadmin)", async () => {
    for (const who of ["superadmin", "support", "ownerA", "plain", "anon"] as Who[]) {
      const c = cl(who);
      const sel = await c.from("platform_settings").select("*");
      expect(sel.error, `select ${who}`).not.toBeNull();
      expect(`${sel.error!.code} ${sel.error!.message}`).toMatch(/42501|permission denied/i);
      for (const r of [
        await c.from("platform_settings").insert({ key: "support_email", value: "x@y.z" }).select(),
        await c.from("platform_settings").update({ value: false }).eq("key", "registration_enabled").select(),
        await c.from("platform_settings").delete().eq("key", "registration_enabled").select(),
        await c.from("platform_settings").upsert({ key: "registration_enabled", value: false }).select(),
      ]) {
        expect(r.error, `write ${who}`).not.toBeNull();
        expect(`${r.error!.code} ${r.error!.message}`).toMatch(/42501|permission denied/i);
      }
    }
    expect(await stored("registration_enabled")).toBe(true);
    expect(await stored("default_trial_days")).toBe(14);
  });

  it("public_platform_flags: anon e authenticated recebem SÓ {registration_enabled}", async () => {
    for (const who of ["anon", "plain", "ownerA", "superadmin"] as Who[]) {
      const r = await call(who, "public_platform_flags");
      expectOk(r);
      expect(r.data).toEqual({ registration_enabled: true });
    }
    await ok(set("support_email", "interno@plataforma.test"));
    await ok(set("maintenance_message", "interno"));
    await ok(set("registration_enabled", false));
    try {
      for (const who of ["anon", "plain"] as Who[]) expect((await call(who, "public_platform_flags")).data).toEqual({ registration_enabled: false });
      expect((await settings()).registration_enabled).toBe(false);
    } finally {
      await ok(set("registration_enabled", true));
      await ok(set("support_email", null));
      await ok(set("maintenance_message", null));
    }
    expect((await call("anon", "public_platform_flags")).data).toEqual({ registration_enabled: true });
  });

  it("registration_enabled=false => register_restaurant falha com REGISTRATION_DISABLED (P0001) sem criar nada; reabrir libera", async () => {
    const slug = `zz-reg-${U}-off`;
    await ok(set("registration_enabled", false));
    try {
      const r = await call("plain", "register_restaurant", { p_name: "zz Registro Off", p_slug: slug });
      expect(r.error?.message).toMatch(/^REGISTRATION_DISABLED/);
      expect(r.error!.code).toBe("P0001");
      // a verificação vem antes da validação dos campos (nome/slug inválidos recebem o mesmo erro)
      expect((await call("plain", "register_restaurant", { p_name: "x", p_slug: "!" })).error!.message).toMatch(/^REGISTRATION_DISABLED/);
      expect((await adm().from("restaurants").select("id").eq("slug", slug)).data).toEqual([]);
      expect((await call("anon", "register_restaurant", { p_name: "zz", p_slug: slug })).error).not.toBeNull();
    } finally {
      await ok(set("registration_enabled", true));
    }
    const r = await call("plain", "register_restaurant", { p_name: "zz Registro On", p_slug: slug });
    expectOk(r);
    const id = r.data as string;
    cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", id)));
    expect((await adm().from("restaurants").select("status").eq("id", id).single()).data!.status).toBe("pending");
  });

  it("default_trial_days é aplicado ao trial de register_restaurant e platform_create_restaurant (0 => trial já vencido, sem fim de período)", async () => {
    try {
      for (const days of [3, 0, 365]) {
        await ok(set("default_trial_days", days));
        const t0 = Date.now();
        const reg = await call("plain", "register_restaurant", { p_name: `zz Trial ${days}`, p_slug: `zz-tr-${U}-${days}` });
        expectOk(reg);
        const rid = reg.data as string;
        cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", rid)));
        const crt = (await ok(call("superadmin", "platform_create_restaurant", { p_name: `zz TrialP ${days}`, p_slug: `zz-trp-${U}-${days}`, p_owner_email: ACCOUNTS.ownerA.email }))) as any;
        cleanup.add(async () => void (await adm().from("restaurants").delete().eq("id", crt.id)));
        for (const id of [rid, crt.id]) {
          const [s] = await sub(id);
          expect(s.status).toBe("trialing");
          const end = Date.parse(s.trial_ends_at);
          expect(end).toBeGreaterThan(t0 + days * DAY - 5000);
          expect(end).toBeLessThan(Date.now() + days * DAY + 5000);
          if (days === 0) expect(s.current_period_end).toBeNull();
          else expect(Date.parse(s.current_period_end)).toBe(end);
        }
      }
    } finally {
      await ok(set("default_trial_days", 14));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. Sessão de suporte e visão de suporte
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_support_overview e isolamento do superadmin", () => {
  let sidSuper: string;
  let sidSupport: string;
  let tabId: string;
  const overview = (who: Who, sid: unknown) => call(who, "platform_support_overview", { p_session: sid });
  const viewed = async (rid: string) => (await audits({ restaurant_id: rid }, "support.overview_viewed")).length;

  beforeAll(async () => {
    expectOk(await adm().from("restaurant_settings").update({ phone: "1133334444", whatsapp: "11955556666", address_text: "Av. do Restaurante, 1" }).eq("restaurant_id", S.id));
    const cat = await adm().from("menu_categories").insert([
      { restaurant_id: S.id, name: "zz cat A", sort_order: 1, is_active: true },
      { restaurant_id: S.id, name: "zz cat B", sort_order: 2, is_active: false },
    ]);
    expectOk(cat);
    expectOk(
      await adm().from("products").insert([
        { restaurant_id: S.id, name: "zz p1", price_cents: 100, is_active: true, is_available: true },
        { restaurant_id: S.id, name: "zz p2", price_cents: 100, is_active: true, is_available: false },
        { restaurant_id: S.id, name: "zz p3", price_cents: 100, is_active: false, is_available: true },
      ]),
    );
    await makeTable(cleanup, S.id);
    await makeTable(cleanup, S.id);
    const tab = await adm().from("tabs").insert({ restaurant_id: S.id, label: TAB_LABEL, opened_by: userId("cashierA") }).select("id").single();
    expectOk(tab);
    tabId = tab.data!.id;
    // 60 pedidos extras (total 65 > 50), horários distintos
    await mkOrders(S.id, Array.from({ length: 60 }, (_, i) => ({ at: iso(-(i + 2) * 60_000), total: 1000 + i, status: i % 7 === 0 ? "CANCELLED" : "CONFIRMED", fulfillment: i % 3 === 0 ? "DELIVERY" : "PICKUP" })));
  });

  it("superadmin SEM sessão não lê pedidos/clientes/comandas/itens/pagamentos de restaurante por REST direto (regressão do isolamento)", async () => {
    for (const who of ["superadmin", "support"] as const) {
      for (const table of ["orders", "order_items", "customers", "customer_addresses", "tabs", "payments", "print_jobs", "restaurant_tables", "business_hours"]) {
        const r = await as(who).from(table).select("*").eq("restaurant_id", S.id).limit(5);
        if (r.error) expect(`${r.error.code} ${r.error.message}`).toMatch(/42501|permission denied/i);
        else expect(r.data, `${who} ${table}`).toEqual([]);
      }
      const rpc = await as(who).rpc("list_customers", { p_restaurant: S.id, p_search: null, p_cursor: null, p_limit: 5 });
      expect(rpc.error).not.toBeNull();
      expect((await as(who).rpc("is_member", { rid: S.id })).data).toBe(false);
    }
  });

  it("abre sessões (RPC existente); a plataforma enxerga ambas; o restaurante (team.manage) as vê na auditoria", async () => {
    sidSuper = (await ok(call("superadmin", "open_support_session", { p_restaurant: S.id, p_reason: "investigar chamado do restaurante", p_minutes: 30 }))) as string;
    sidSupport = (await ok(call("support", "open_support_session", { p_restaurant: S.id, p_reason: "apoio ao chamado do restaurante", p_minutes: 15 }))) as string;
    const list = (await pageAll("superadmin", "platform_list_support_sessions", { p_active_only: true }, 50)) as any[];
    expect(list.filter((s) => s.restaurant_id === S.id).map((s) => s.id).sort()).toEqual([sidSuper, sidSupport].sort());
    expect(list.find((s) => s.id === sidSuper)).toMatchObject({ admin_id: userId("superadmin"), reason: "investigar chamado do restaurante", active: true });
    const own = (await ok(as("ownerA").rpc("list_audit_logs", { p_restaurant: S.id, p_action_prefix: "support.", p_from: null, p_to: null, p_limit: 50, p_before: null }))) as any;
    expect(own.rows.filter((r: any) => r.action === "support.session_opened")).toHaveLength(2);
    expect(JSON.stringify(own.rows)).toContain("investigar chamado do restaurante");
    // quem não tem team.manage não vê
    expect((await as("cashierA").rpc("list_audit_logs", { p_restaurant: S.id, p_action_prefix: null, p_from: null, p_to: null, p_limit: 5, p_before: null })).error).not.toBeNull();
  });

  it("sem sessão / sessão de OUTRO admin / inexistente / nula => SUPPORT_SESSION_INVALID com a MESMA mensagem; nada é auditado", async () => {
    const n0 = await viewed(S.id);
    const msgs = new Set<string>();
    for (const [who, sid] of [["superadmin", GHOST], ["superadmin", null], ["superadmin", sidSupport], ["support", sidSuper], ["support", GHOST]] as const) {
      const r = await overview(who, sid);
      expect(r.error?.message, `${who} ${sid}`).toMatch(/^SUPPORT_SESSION_INVALID/);
      expect(r.error!.code).toBe("42501");
      msgs.add(r.error!.message);
    }
    expect(msgs.size).toBe(1);
    expect(await viewed(S.id)).toBe(n0);
  });

  it("sessão expirada / encerrada => mesmo erro idêntico", async () => {
    const mk = async (extra: Record<string, unknown>) => {
      const r = await adm().from("support_sessions").insert({ restaurant_id: S.id, admin_id: userId("superadmin"), reason: "zz sessao antiga de teste", ...extra }).select("id").single();
      expectOk(r);
      return r.data!.id as string;
    };
    const expired = await mk({ started_at: iso(-2 * 3_600_000), expires_at: iso(-3_600_000) });
    const ended = await mk({ started_at: iso(-3_600_000), expires_at: iso(-60_000), ended_at: iso(-120_000) });
    const msgs = new Set<string>();
    for (const sid of [expired, ended]) {
      const r = await overview("superadmin", sid);
      expect(r.error?.message).toMatch(/^SUPPORT_SESSION_INVALID/);
      msgs.add(r.error!.message);
    }
    // sessão que expira DEPOIS de aberta
    const soon = await mk({ started_at: iso(-30 * 60_000), expires_at: iso(25 * 60_000) });
    expectOk(await overview("superadmin", soon));
    expectOk(await adm().from("support_sessions").update({ expires_at: iso(-1000) }).eq("id", soon));
    const r = await overview("superadmin", soon);
    expect(r.error?.message).toMatch(/^SUPPORT_SESSION_INVALID/);
    msgs.add(r.error!.message);
    expect(msgs.size).toBe(1);
    expect([...msgs][0]).toBe((await overview("superadmin", GHOST)).error!.message);
  });

  it("com sessão ativa devolve a visão SEM PII (compara com os valores reais) e grava support.overview_viewed", async () => {
    const n0 = await viewed(S.id);
    const r = await read("superadmin", "platform_support_overview", { p_session: sidSuper });
    expectOk(r);
    const o = r.data as any;
    expect(Object.keys(o).sort()).toEqual(["menu", "open_tabs", "recent_orders", "restaurant", "session", "settings", "team"]);
    expect(o.session).toMatchObject({ id: sidSuper, restaurant_id: S.id, reason: "investigar chamado do restaurante" });
    expect(o.restaurant).toMatchObject({ id: S.id, slug: S.slug, status: "active", timezone: "America/Sao_Paulo" });
    expect(o.menu).toEqual({ categories: 2, categories_active: 1, products: 3, products_active: 2, products_available: 1, tables: 2 });
    expect(o.team).toHaveLength(5);
    for (const m of o.team) expect(Object.keys(m).sort()).toEqual(["full_name", "role", "status"]);
    expect(o.settings).toMatchObject({ accepts_orders: true, phone: "1133334444", whatsapp: "11955556666", address_text: "Av. do Restaurante, 1" });
    // pedidos: os 50 mais recentes, só 6 campos, sem dados do cliente
    const real = ((await adm().from("orders").select("order_number,status,fulfillment_type,payment_status,total_cents,created_at").eq("restaurant_id", S.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50)).data ?? []) as any[];
    expect(o.recent_orders).toHaveLength(50);
    expect(o.recent_orders.map((x: any) => x.order_number)).toEqual(real.map((x) => x.order_number));
    for (const x of o.recent_orders) expect(Object.keys(x).sort()).toEqual(["created_at", "fulfillment_type", "order_number", "payment_status", "status", "total_cents"]);
    expect(await count("orders", (q) => q.eq("restaurant_id", S.id))).toBeGreaterThan(50);
    // comandas abertas: rótulo (texto livre digitado pela equipe — DECISÃO: pode conter nomes) e total
    expect(o.open_tabs).toEqual([{ label: TAB_LABEL, total_cents: 0, opened_at: expect.any(String) }]);
    // nenhum dado pessoal de cliente em nenhum lugar
    const text = JSON.stringify(o);
    for (const v of [PII.name, PII.phone, PII.email, PII.street, PII.notes]) expect(text, v).not.toContain(v);
    const customers = ((await adm().from("customers").select("name,phone,email").eq("restaurant_id", S.id)).data ?? []) as any[];
    for (const c of customers) for (const v of [c.name, c.phone, c.email]) if (v) expect(text).not.toContain(v);
    // auditoria: 1 linha por consulta, ator = o admin, metadata só com a sessão
    expect(await viewed(S.id)).toBe(n0 + 1);
    const log = (await audits({ restaurant_id: S.id }, "support.overview_viewed"))[0];
    expect(log).toMatchObject({ actor_id: userId("superadmin"), resource_type: "support_session", resource_id: sidSuper });
    expect(log.metadata).toEqual({ session_id: sidSuper });
    // support com a PRÓPRIA sessão lê o mesmo restaurante
    expectOk(await read("support", "platform_support_overview", { p_session: sidSupport }));
    expect(await viewed(S.id)).toBe(n0 + 2);
  });

  it("o restaurante vê a consulta (team.manage) e quem a fez; gerente/caixa não", async () => {
    const own = (await ok(as("ownerA").rpc("list_audit_logs", { p_restaurant: S.id, p_action_prefix: "support.", p_from: null, p_to: null, p_limit: 100, p_before: null }))) as any;
    const v = own.rows.filter((r: any) => r.action === "support.overview_viewed");
    expect(v.length).toBeGreaterThanOrEqual(2);
    const direct = (await as("ownerA").from("audit_logs").select("action").eq("restaurant_id", S.id).eq("action", "support.overview_viewed")).data ?? [];
    expect(direct.length).toBe(await viewed(S.id));
    for (const who of ["cashierA", "waiterA"] as const) expect(((await as(who).from("audit_logs").select("id").eq("restaurant_id", S.id).like("action", "support.%")).data ?? [])).toEqual([]);
  });

  it("controle positivo e fim do acesso: COM sessão o superadmin lê pedidos por REST (RLS); ao encerrar, volta a não ler", async () => {
    const withSession = await as("superadmin").from("orders").select("id").eq("restaurant_id", S.id).limit(3);
    expect((withSession.data ?? []).length).toBeGreaterThan(0);
    expectOk(await call("superadmin", "close_support_session", { p_session: sidSuper }));
    expectOk(await call("support", "close_support_session", { p_session: sidSupport }));
    for (const who of ["superadmin", "support"] as const) {
      expect((await as(who).from("orders").select("id").eq("restaurant_id", S.id).limit(3)).data ?? []).toEqual([]);
      expect((await as(who).from("customers").select("id").eq("restaurant_id", S.id).limit(3)).data ?? []).toEqual([]);
    }
    expect((await overview("superadmin", sidSuper)).error!.message).toMatch(/^SUPPORT_SESSION_INVALID/);
    expect((await overview("support", sidSupport)).error!.message).toMatch(/^SUPPORT_SESSION_INVALID/);
    const act = (await pageAll("superadmin", "platform_list_support_sessions", { p_active_only: true }, 50)) as any[];
    expect(act.map((s) => s.id)).not.toContain(sidSuper);
    await adm().from("tabs").update({ status: "CANCELLED" }).eq("id", tabId);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. Auditoria da plataforma
// ---------------------------------------------------------------------------------------------------------------------
describe("platform_list_audit_logs (superadmin)", () => {
  const list = async (args: Record<string, unknown>) => (await ok(read("superadmin", "platform_list_audit_logs", { p_limit: 50, ...args }))) as any;

  it("keyset completo por restaurante (sem repetir/perder; empates de created_at) e ordem estável", async () => {
    const got = await pageAll("superadmin", "platform_list_audit_logs", { p_restaurant: S.id }, 7);
    noRepeat(got);
    sortedDesc(got, "created_at");
    const real = (await adm().from("audit_logs").select("id").eq("restaurant_id", S.id)).data ?? [];
    expect(got.map((r) => r.id).sort()).toEqual(real.map((r: any) => r.id).sort());
    expect(got.length).toBeGreaterThan(30);
    for (const r of got.slice(0, 3)) expect(Object.keys(r).sort()).toEqual(["action", "actor_id", "actor_name", "created_at", "id", "metadata", "resource_id", "resource_type", "restaurant_id", "restaurant_name"]);
  });

  it("limites: 0/-1 => 1; 1000 => <= 100; padrão 50", async () => {
    expect((await list({ p_limit: 0 })).rows).toHaveLength(1);
    expect((await list({ p_limit: -1 })).rows).toHaveLength(1);
    expect((await list({ p_limit: 1000 })).rows).toHaveLength(100);
    expect((await list({ p_limit: null })).rows).toHaveLength(50);
  });

  it("filtros: ator, restaurante, prefixo LITERAL (% e _ não são curinga), período; INVALID_PREFIX/INVALID_PERIOD", async () => {
    const bySuper = await pageAll("superadmin", "platform_list_audit_logs", { p_actor: userId("support") }, 50);
    expect(bySuper.length).toBeGreaterThan(0);
    for (const r of bySuper) expect(r.actor_id).toBe(userId("support"));
    const pl = await pageAll("superadmin", "platform_list_audit_logs", { p_action_prefix: "platform.", p_from: T_START }, 100);
    expect(pl.length).toBeGreaterThan(10);
    for (const r of pl) expect(r.action.startsWith("platform.")).toBe(true);
    expect(pl.length).toBe((await adm().from("audit_logs").select("id").like("action", "platform.%").gte("created_at", T_START)).data!.length);
    for (const bad of ["%", "_", "platform_", "pl%", "\\", "platform.%"]) expect((await list({ p_action_prefix: bad })).rows, bad).toEqual([]);
    expect((await list({ p_action_prefix: "support.session_" , p_restaurant: S.id})).rows.length).toBeGreaterThan(0);
    await fail(call("superadmin", "platform_list_audit_logs", { p_action_prefix: "x".repeat(65) }), "INVALID_PREFIX");
    expect((await list({ p_action_prefix: "   " })).rows.length).toBeGreaterThan(0); // vazio = sem filtro
    await fail(call("superadmin", "platform_list_audit_logs", { p_from: iso(0), p_to: iso(-1000) }), "INVALID_PERIOD");
    await fail(call("superadmin", "platform_list_audit_logs", { p_from: iso(0), p_to: iso(0) }), "INVALID_PERIOD");
    const win = await list({ p_from: iso(-3_600_000), p_to: iso(3_600_000), p_limit: 100 });
    expect(win.rows.length).toBeGreaterThan(0);
    expect((await list({ p_from: iso(3_600_000) })).rows).toEqual([]);
    expect((await list({ p_to: "2000-01-01T00:00:00Z" })).rows).toEqual([]);
  });

  it("metadata sanitizado (segredos removidos, recursivo); ações da plataforma completas e SEM dados de cliente", async () => {
    expectOk(
      await adm().rpc("log_audit", { p_restaurant: R2.id, p_action: "zz.sanitize", p_resource_type: "x", p_resource_id: null, p_metadata: { password: "pw-secreto", api_key: "k-secreta", nested: { token: "tok-secreto", ok: 1 }, authorization: "Bearer eyJabc.def.ghi", visible: "sim" } }),
    );
    const r = (await list({ p_action_prefix: "zz.sanitize", p_restaurant: R2.id })).rows[0];
    expect(r.metadata).toEqual({ nested: { ok: 1 }, visible: "sim" });
    expect(JSON.stringify(r)).not.toMatch(/pw-secreto|k-secreta|tok-secreto|eyJabc/);
    const actions = new Set((await pageAll("superadmin", "platform_list_audit_logs", { p_action_prefix: "platform.", p_from: T_START }, 100)).map((x) => x.action));
    for (const a of ["platform.restaurant_created", "platform.restaurant_status_changed", "platform.plan_created", "platform.plan_updated", "platform.subscription_changed", "platform.subscription_note", "platform.ticket_updated", "platform.ticket_note", "platform.setting_updated"]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 12. Varredura final: nenhuma resposta de leitura contém dados de cliente
// ---------------------------------------------------------------------------------------------------------------------
describe("varredura de PII em TODAS as respostas de leitura de superadmin/support", () => {
  it("marcadores das fixtures e valores reais de customers/orders (nome, telefone, e-mail, endereço) não aparecem em nenhuma resposta", async () => {
    expect(readLog.length).toBeGreaterThan(100); // a varredura não é vacuosa
    // passagem extra: as visões mais ricas, agora com TODO o dado de teste no banco
    for (const who of ["superadmin", "support"] as const) {
      await read(who, "platform_dashboard");
      await read(who, "platform_get_restaurant", { p_restaurant: S.id });
      await read(who, "platform_list_restaurants", { p_search: null, p_limit: 100 });
    }
    await read("superadmin", "platform_list_audit_logs", { p_restaurant: S.id, p_limit: 100 });
    await read("superadmin", "platform_list_audit_logs", { p_limit: 100 });
    const blob = readLog.join("\n").toLowerCase();

    const legit = new Set<string>();
    for (const t of ["restaurants", "plans"] as const) for (const r of ((await adm().from(t).select("*")).data ?? []) as any[]) for (const v of Object.values(r)) if (typeof v === "string") legit.add(v.toLowerCase());
    for (const r of ((await adm().from("profiles").select("full_name")).data ?? []) as any[]) if (r.full_name) legit.add(String(r.full_name).toLowerCase());
    for (const k of Object.keys(ACCOUNTS) as AccountKey[]) legit.add(ACCOUNTS[k].email.toLowerCase());

    const values = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === "string" && v.trim().length >= 6 && !legit.has(v.toLowerCase())) values.add(v.toLowerCase());
    };
    for (const c of ((await adm().from("customers").select("name,phone,email,notes")).data ?? []) as any[]) for (const v of Object.values(c)) add(v);
    for (const o of ((await adm().from("orders").select("customer_name,customer_phone,notes,status_reason").limit(5000)).data ?? []) as any[]) for (const v of Object.values(o)) add(v);
    for (const a of ((await adm().from("customer_addresses").select("street,neighborhood,postal_code")).data ?? []) as any[]) for (const v of Object.values(a)) add(v);
    for (const v of [PII.name, PII.phone, PII.email, PII.street, PII.notes, `cancelado, ligar para ${PII.phone} ou ${PII.email}`]) values.add(v.toLowerCase());
    expect(values.size).toBeGreaterThan(5);
    const leaks = [...values].filter((v) => blob.includes(v));
    expect(leaks).toEqual([]);
    // dígitos do telefone mesmo formatados
    expect(blob).not.toContain("98877");
    expect(blob).not.toMatch(/pii\.[a-z0-9]+@cliente-zz/);
    // a única coisa "de cliente" permitida: o rótulo de comanda na visão de suporte (decisão documentada)
    expect(blob).toContain(TAB_LABEL.toLowerCase());
  });
});
