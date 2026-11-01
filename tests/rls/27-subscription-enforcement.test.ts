/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 8 (migs. 0131-0133): planos e assinaturas APLICADOS, limites do plano, tetos anti-abuso do pedido público,
 * `restaurant_subscription_status`, `save_business_hours`, S-08 (`qr_token`), F-50, S-12 e sanitização da auditoria.
 *
 * Tudo roda em restaurantes efêmeros `zz-t5-*` (equipe DEMO vinculada via `makeTenant`) com planos `zz-p27-*` criados aqui
 * (o seed apaga sobras). A assinatura do restaurante é trocada por service role a cada cenário. Os DEMO A/B só são tocados
 * onde o cenário exige um "outro tenant" (leitura/negação, nunca escrita). `audit_logs` é append-only: as linhas ficam.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { TEST_PASSWORD } from "../fixtures/accounts";
import { admin, anon, as, realtimeAs, signInAs, userId, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeTab, makeTable, uniq, waitFor } from "../helpers/factory";
import { BASE_FULFILLMENT, makeMenuFixture, setOpenToday, type MenuFixture } from "../helpers/menu";
import { makeTenant, type Tenant } from "../helpers/phase5";

const cleanup = new Cleanup();
const U = uniq();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const B = () => world().restaurants.b;
const adm = () => admin();
let seq = 0;
const key = () => `zz-t27-${U}-${++seq}`;
const phone = () => `119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const codes = (r: { data: any }) => ((r.data?.errors ?? []) as any[]).map((e) => e.code);

let T: Tenant; // restaurante principal dos cenários de estado/limites/horários
let fx: MenuFixture;
let planUnl: { id: string };
let planLim: { id: string };

async function mkPlan(code: string, limits: Record<string, unknown>) {
  const r = await adm()
    .from("plans")
    .insert({ code: `zz-p27-${U}-${code}`, name: `zz P27 ${code}`, price_cents: 1000, billing_interval: "month", limits, sort_order: 6000, is_active: true })
    .select("id")
    .single();
  if (r.error) throw new Error(`mkPlan: ${r.error.message}`);
  cleanup.add(async () => {
    await adm().from("subscriptions").delete().eq("plan_id", r.data.id);
    await adm().from("plans").delete().eq("id", r.data.id);
  });
  return r.data as { id: string };
}

/** Troca a assinatura do restaurante (apaga as anteriores). `null` = sem assinatura (estado none). */
async function setSub(rid: string, spec: null | { status: "trialing" | "active" | "past_due" | "canceled"; plan?: { id: string }; trialEnd?: number | null; periodEnd?: number | null }) {
  await adm().from("subscriptions").delete().eq("restaurant_id", rid);
  if (!spec) return;
  const row: Record<string, unknown> = {
    restaurant_id: rid,
    plan_id: (spec.plan ?? planUnl).id,
    status: spec.status,
    current_period_start: iso(-60 * DAY),
  };
  if (spec.trialEnd !== undefined) row.trial_ends_at = spec.trialEnd === null ? null : iso(spec.trialEnd);
  if (spec.periodEnd !== undefined) row.current_period_end = spec.periodEnd === null ? null : iso(spec.periodEnd);
  const r = await adm().from("subscriptions").insert(row);
  if (r.error) throw new Error(`setSub: ${r.error.message}`);
}

function orderArgs(rid: { slug: string }, over: Record<string, unknown> = {}, fxx: MenuFixture = fx) {
  return {
    p_slug: rid.slug,
    p_fulfillment: "PICKUP",
    p_items: [{ product_id: fxx.pPlain.id, quantity: 1, modifier_ids: [] }],
    p_customer: { name: "zz-Maria Souza", phone: phone(), email: null },
    p_address: null,
    p_delivery_zone_id: null,
    p_notes: null,
    p_idempotency_key: key(),
    p_payment: { method: "PIX" },
    ...over,
  };
}
const pub = (rid: { slug: string }, over: Record<string, unknown> = {}, fxx?: MenuFixture) => adm().rpc("create_public_order", orderArgs(rid, over, fxx));
const ordersOf = async (rid: string) => (await adm().from("orders").select("id", { count: "exact", head: true }).eq("restaurant_id", rid)).count ?? 0;

let tab: { id: string };
const staff = (who: AccountKey = "waiterA", tabId = tab.id) =>
  as(who).rpc("create_staff_order", { p_tab: tabId, p_items: [{ product_id: fx.pPlain.id, quantity: 1, modifier_ids: [] }], p_idempotency_key: key() });
const status = (who: AccountKey | "anon", rid: string) => (who === "anon" ? anon() : as(who)).rpc("restaurant_subscription_status", { p_restaurant: rid });

async function newTenant(opts: { withTeam?: boolean } = {}) {
  const t = await makeTenant(cleanup, opts);
  await adm().from("restaurant_settings").upsert({ restaurant_id: t.id, accepts_orders: true, min_order_cents: 0, enabled_fulfillment_types: BASE_FULFILLMENT }, { onConflict: "restaurant_id" });
  await setOpenToday(t.id, true);
  const f = await makeMenuFixture(cleanup, t.id);
  await setSub(t.id, { status: "active", periodEnd: 30 * DAY });
  return { t, f };
}

beforeAll(async () => {
  planUnl = await mkPlan("unl", {});
  planLim = await mkPlan("lim", { max_members: 100, max_tables: 100, max_products: 1000 });
  ({ t: T, f: fx } = await newTenant());
  const table = await makeTable(cleanup, T.id);
  tab = await makeTab(cleanup, T.id, { tableId: table.id, openedBy: userId("waiterA") });
  cleanup.add(async () => {
    await adm().from("orders").delete().like("idempotency_key", "zz-t27-%");
    await adm().from("orders").delete().like("idempotency_key", `STAFF:${tab.id}:zz-t27-%`);
  });
}, 120_000);

afterAll(async () => {
  await cleanup.run();
  await adm().from("support_tickets").delete().like("subject", "zz-t27-%");
}, 120_000);

// =====================================================================================================================
describe("estado da assinatura x pedido público e pedido de salão", () => {
  type Case = { name: string; sub: Parameters<typeof setSub>[1]; state: string; allowed: boolean };
  const cases: Case[] = [
    { name: "trial vigente", sub: { status: "trialing", trialEnd: 5 * DAY, periodEnd: 5 * DAY }, state: "trial", allowed: true },
    { name: "trial vencido", sub: { status: "trialing", trialEnd: -DAY, periodEnd: null }, state: "expired", allowed: false },
    { name: "active vigente", sub: { status: "active", periodEnd: 30 * DAY }, state: "active", allowed: true },
    { name: "active sem fim de período", sub: { status: "active", periodEnd: null }, state: "active", allowed: true },
    { name: "active vencido", sub: { status: "active", periodEnd: -DAY }, state: "expired", allowed: false },
    { name: "past_due dentro da tolerância (3 dias)", sub: { status: "past_due", periodEnd: -3 * DAY }, state: "past_due", allowed: true },
    { name: "past_due fora da tolerância (8 dias)", sub: { status: "past_due", periodEnd: -8 * DAY }, state: "past_due", allowed: false },
    { name: "cancelled", sub: { status: "canceled", periodEnd: 30 * DAY }, state: "cancelled", allowed: false },
    { name: "none (sem assinatura)", sub: null, state: "none", allowed: true },
  ];

  for (const c of cases) {
    it(`${c.name}: estado=${c.state}; pedido público ${c.allowed ? "liberado" : "SUBSCRIPTION_INACTIVE"}; pedido de salão ${c.allowed ? "liberado" : "SUBSCRIPTION_INACTIVE"}; leituras continuam`, async () => {
      await setSub(T.id, c.sub);
      const s = await status("ownerA", T.id);
      expectOk(s);
      expect((s.data as any).state).toBe(c.state);
      expect((s.data as any).blocked).toBe(!c.allowed);

      const before = await ordersOf(T.id);
      const p = await pub(T);
      expect(p.error, JSON.stringify(p.error)).toBeNull();
      const st = await staff();
      if (c.allowed) {
        expect(p.data.ok, JSON.stringify(p.data)).toBe(true);
        expectOk(st);
        expect(await ordersOf(T.id)).toBe(before + 2);
      } else {
        expect(p.data.ok).toBe(false);
        expect(codes(p)).toEqual(["SUBSCRIPTION_INACTIVE"]);
        expectRule(st, /^SUBSCRIPTION_INACTIVE/);
        expect(await ordersOf(T.id)).toBe(before); // nada gravado
      }
      // leituras e relatórios seguem liberados em qualquer estado
      expectOk(await as("ownerA").from("orders").select("id").eq("restaurant_id", T.id).limit(5));
      expectOk(await as("ownerA").rpc("dashboard_metrics", { p_restaurant: T.id, p_from: iso(-7 * DAY), p_to: iso(DAY) }));
      expect((await anon().rpc("public_menu", { p_slug: T.slug })).data).not.toBeNull();
    });
  }

  it("assinatura viva vence a antiga: restaurante com trial vencido (histórico) e assinatura ativa nova volta a aceitar pedidos", async () => {
    await adm().from("subscriptions").delete().eq("restaurant_id", T.id);
    await adm().from("subscriptions").insert({ restaurant_id: T.id, plan_id: planUnl.id, status: "canceled", current_period_start: iso(-90 * DAY), current_period_end: iso(-60 * DAY) });
    expect((await status("ownerA", T.id)).data.state).toBe("cancelled");
    await adm().from("subscriptions").insert({ restaurant_id: T.id, plan_id: planUnl.id, status: "active", current_period_start: iso(-DAY), current_period_end: iso(30 * DAY) });
    expect((await status("ownerA", T.id)).data.state).toBe("active");
    expect((await pub(T)).data.ok).toBe(true);
  });

  it("replay idempotente de pedido público feito antes do vencimento continua devolvendo o recibo? Não: o gate vem antes — vencida a assinatura, nem o replay passa", async () => {
    await setSub(T.id, { status: "active", periodEnd: 30 * DAY });
    const k = key();
    const first = await pub(T, { p_idempotency_key: k });
    expect(first.data.ok).toBe(true);
    await setSub(T.id, { status: "active", periodEnd: -DAY });
    const again = await pub(T, { p_idempotency_key: k });
    expect(codes(again)).toEqual(["SUBSCRIPTION_INACTIVE"]);
    await setSub(T.id, { status: "active", periodEnd: 30 * DAY });
  });
});

// =====================================================================================================================
describe("limites do plano (PLAN_LIMIT_REACHED)", () => {
  const usage = async (who: AccountKey = "ownerA") => ((await status(who, T.id)).data as any).usage as { members: number; tables: number; products: number };
  const setLimits = async (limits: Record<string, unknown>) => {
    const r = await adm().from("plans").update({ limits }).eq("id", planLim.id);
    expect(r.error).toBeNull();
    await setSub(T.id, { status: "active", plan: planLim, periodEnd: 30 * DAY });
  };
  const addMember = (uid: string, st: "active" | "invited" | "revoked" = "invited") =>
    adm().from("restaurant_memberships").insert({ restaurant_id: T.id, user_id: uid, role: "waiter", status: st }).select("id").single();

  it("membros: active+invited contam; revogados não; limite vale na criação e na reativação; liberar vaga permite de novo", async () => {
    const u0 = await usage();
    expect(u0.members).toBe(5);
    await setLimits({ max_members: u0.members + 1 });
    const m1 = await addMember(userId("plain"), "invited");
    expectOk(m1);
    expect((await usage()).members).toBe(6);
    const over = await addMember(userId("ownerB"), "invited");
    expectRule(over, /^PLAN_LIMIT_REACHED/);
    expectRule(await addMember(userId("managerB"), "active"), /^PLAN_LIMIT_REACHED/);
    // revogado não conta nem é barrado
    const rev = await addMember(userId("managerB"), "revoked");
    expectOk(rev);
    expect((await usage()).members).toBe(6);
    // reativar um revogado estoura o limite (trigger também no UPDATE de status)
    expectRule(await adm().from("restaurant_memberships").update({ status: "active" }).eq("id", rev.data!.id).select("id"), /^PLAN_LIMIT_REACHED/);
    // mudar de active para invited (já conta) não é barrado
    expectOk(await adm().from("restaurant_memberships").update({ status: "active" }).eq("id", m1.data!.id).select("id"));
    // libera uma vaga: revoga o convidado e agora o revogado pode voltar
    expectOk(await adm().from("restaurant_memberships").update({ status: "revoked" }).eq("id", m1.data!.id).select("id"));
    expectOk(await adm().from("restaurant_memberships").update({ status: "active" }).eq("id", rev.data!.id).select("id"));
    expect((await usage()).members).toBe(6);
    // sem prejuízo do restante: limite 0 não derruba quem já está dentro (só bloqueia novas entradas)
    await adm().from("restaurant_memberships").delete().in("id", [m1.data!.id, rev.data!.id]);
    expect((await usage()).members).toBe(5);
  });

  it("mesas: limite = uso atual + 1 => a 2ª recebe PLAN_LIMIT_REACHED (também pelo cliente autenticado); apagar libera", async () => {
    const u = await usage();
    await setLimits({ max_tables: u.tables + 1 });
    const mine: string[] = [];
    const t1 = await as("ownerA").from("restaurant_tables").insert({ restaurant_id: T.id, name: `zz-lim-${U}-1` }).select("id").single();
    expectOk(t1);
    mine.push(t1.data!.id);
    const t2 = await as("managerA").from("restaurant_tables").insert({ restaurant_id: T.id, name: `zz-lim-${U}-2` }).select("id");
    expectRule(t2, /^PLAN_LIMIT_REACHED/);
    expect(rows(await adm().from("restaurant_tables").select("id").eq("restaurant_id", T.id).eq("name", `zz-lim-${U}-2`))).toHaveLength(0);
    await adm().from("restaurant_tables").delete().eq("id", t1.data!.id);
    expectOk(await as("ownerA").from("restaurant_tables").insert({ restaurant_id: T.id, name: `zz-lim-${U}-3` }).select("id"));
    // concorrência: 6 inserts paralelos com 1 vaga => exatamente 0 (já cheio)
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => as("ownerA").from("restaurant_tables").insert({ restaurant_id: T.id, name: `zz-lim-${U}-c${i}` }).select("id")));
    expect(res.filter((r) => !r.error)).toHaveLength(0);
    await adm().from("restaurant_tables").delete().eq("restaurant_id", T.id).like("name", `zz-lim-${U}-%`);
  });

  it("produtos: max_products governa; max_menu_items vale só quando max_products ausente (max_products tem precedência)", async () => {
    const u = await usage();
    // só max_menu_items
    await setLimits({ max_menu_items: u.products + 1 });
    const p1 = await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-1`, price_cents: 100 }).select("id").single();
    expectOk(p1);
    expectRule(await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-2`, price_cents: 100 }).select("id"), /^PLAN_LIMIT_REACHED/);
    // max_products presente (folgado) sobrepõe max_menu_items apertado
    await setLimits({ max_products: u.products + 50, max_menu_items: 1 });
    expectOk(await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-3`, price_cents: 100 }).select("id"));
    // max_products apertado barra mesmo com max_menu_items folgado
    const now = (await usage()).products;
    await setLimits({ max_products: now, max_menu_items: 9999 });
    expectRule(await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-4`, price_cents: 100 }).select("id"), /^PLAN_LIMIT_REACHED/);
    // limite 0 barra tudo; negativo/texto/nulo = ilimitado
    await setLimits({ max_products: 0 });
    expectRule(await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-5`, price_cents: 100 }).select("id"), /^PLAN_LIMIT_REACHED/);
    for (const v of [null, "abc", -1]) {
      await setLimits({ max_products: v });
      expectOk(await adm().from("products").insert({ restaurant_id: T.id, name: `zz-lim-prod-${U}-u${String(v)}`, price_cents: 100 }).select("id"));
    }
    await adm().from("products").delete().eq("restaurant_id", T.id).like("name", `zz-lim-prod-${U}-%`);
  });

  it("ilimitado: plano sem limites, restaurante sem assinatura e limites ausentes não barram membros/mesas/produtos", async () => {
    for (const sub of [{ status: "active" as const, plan: planUnl, periodEnd: 30 * DAY }, null]) {
      await setSub(T.id, sub);
      const t = await adm().from("restaurant_tables").insert({ restaurant_id: T.id, name: `zz-unl-${U}-${seq++}` }).select("id").single();
      expectOk(t);
      const p = await adm().from("products").insert({ restaurant_id: T.id, name: `zz-unl-prod-${U}-${seq++}`, price_cents: 100 }).select("id").single();
      expectOk(p);
      const m = await addMember(userId("plain"), "invited");
      expectOk(m);
      await adm().from("restaurant_memberships").delete().eq("id", m.data!.id);
      await adm().from("restaurant_tables").delete().eq("id", t.data!.id);
      await adm().from("products").delete().eq("id", p.data!.id);
    }
    await setSub(T.id, { status: "active", periodEnd: 30 * DAY });
  });
});

// =====================================================================================================================
describe("restaurant_subscription_status", () => {
  it("formato, plano, limites e uso (members/tables/products) = contagem real; membros de qualquer papel leem", async () => {
    await adm().from("plans").update({ limits: { max_members: 50, max_tables: 40, max_products: 500 } }).eq("id", planLim.id);
    await setSub(T.id, { status: "trialing", plan: planLim, trialEnd: 5 * DAY + 3_600_000, periodEnd: 5 * DAY + 3_600_000 });
    const sub = (await adm().from("subscriptions").select("*").eq("restaurant_id", T.id).single()).data as any;
    for (const who of ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      const r = await status(who, T.id);
      expectOk(r);
      const d = r.data as any;
      expect(Object.keys(d).sort(), who).toEqual(["blocked", "current_period_end", "days_left", "grace_ends_at", "limits", "plan_code", "plan_name", "state", "trial_ends_at", "usage"].sort());
      expect(d).toMatchObject({ state: "trial", blocked: false, plan_name: "zz P27 lim", limits: { max_members: 50, max_tables: 40, max_products: 500 }, grace_ends_at: null, days_left: 6 });
      expect(Date.parse(d.trial_ends_at)).toBe(Date.parse(sub.trial_ends_at));
    }
    const counts = {
      members: (await adm().from("restaurant_memberships").select("id", { count: "exact", head: true }).eq("restaurant_id", T.id).in("status", ["active", "invited"])).count,
      tables: (await adm().from("restaurant_tables").select("id", { count: "exact", head: true }).eq("restaurant_id", T.id)).count,
      products: (await adm().from("products").select("id", { count: "exact", head: true }).eq("restaurant_id", T.id)).count,
    };
    expect((await status("ownerA", T.id)).data.usage).toEqual(counts);
  });

  it("past_due informa grace_ends_at (+7 dias), blocked reflete a tolerância; sem assinatura: state none, plano nulo, limits {}", async () => {
    await setSub(T.id, { status: "past_due", periodEnd: -3 * DAY });
    const d = (await status("ownerA", T.id)).data as any;
    expect(d.state).toBe("past_due");
    expect(d.blocked).toBe(false);
    const end = Date.parse((await adm().from("subscriptions").select("current_period_end").eq("restaurant_id", T.id).single()).data!.current_period_end);
    expect(Date.parse(d.grace_ends_at)).toBe(end + 7 * DAY);
    expect(d.days_left).toBe(0);
    await setSub(T.id, { status: "past_due", periodEnd: -8 * DAY });
    expect((await status("ownerA", T.id)).data.blocked).toBe(true);
    await setSub(T.id, null);
    expect((await status("ownerA", T.id)).data).toMatchObject({ state: "none", blocked: false, plan_code: null, plan_name: null, limits: {}, days_left: null });
    await setSub(T.id, { status: "active", periodEnd: 30 * DAY });
  });

  it("outro tenant, sem vínculo, restaurante inexistente e nulo => RESTAURANT_NOT_FOUND idêntico; anon sem EXECUTE", async () => {
    const msgs = new Set<string>();
    for (const [who, rid] of [["ownerB", T.id], ["plain", T.id], ["superadmin", T.id], ["ownerA", B().id], ["ownerA", "00000000-0000-4000-8000-00000000dead"]] as [AccountKey, string][]) {
      const r = await status(who, rid);
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      msgs.add(r.error!.message);
    }
    expect(msgs.size).toBe(1);
    expectRule(await as("ownerA").rpc("restaurant_subscription_status", { p_restaurant: null }), /^RESTAURANT_NOT_FOUND/);
    expectDenied(await status("anon", T.id), /42501|permission denied/i);
  });
});

// =====================================================================================================================
describe("tetos de abuso no pedido público (RATE_LIMITED)", () => {
  it("6º pedido do mesmo telefone na hora => RATE_LIMITED (customer.phone); outro telefone segue; replay idempotente não conta e devolve o recibo", async () => {
    const { t, f } = await newTenant({ withTeam: false });
    const ph = phone();
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const k = key();
      keys.push(k);
      const r = await pub(t, { p_idempotency_key: k, p_customer: { name: "zz-Spammer", phone: ph } }, f);
      expect(r.data.ok, `pedido ${i + 1}: ${JSON.stringify(r.data)}`).toBe(true);
    }
    const sixth = await pub(t, { p_customer: { name: "zz-Spammer", phone: ph } }, f);
    expect(sixth.data.ok).toBe(false);
    expect(sixth.data.errors).toEqual([expect.objectContaining({ code: "RATE_LIMITED", field: "customer.phone" })]);
    expect(await ordersOf(t.id)).toBe(5);
    // telefone mascarado/com 55 é o mesmo telefone normalizado
    const masked = await pub(t, { p_customer: { name: "zz-Spammer", phone: `+55 (${ph.slice(0, 2)}) ${ph.slice(2, 7)}-${ph.slice(7)}` } }, f);
    expect(codes(masked)).toEqual(["RATE_LIMITED"]);
    // replay (mesma chave de um dos 5) devolve o recibo e não conta contra o teto
    const replay = await pub(t, { p_idempotency_key: keys[0], p_customer: { name: "zz-Spammer", phone: ph } }, f);
    expect(replay.data).toMatchObject({ ok: true, idempotent_replay: true });
    expect(await ordersOf(t.id)).toBe(5);
    // outro telefone no mesmo restaurante não é afetado
    expect((await pub(t, {}, f)).data.ok).toBe(true);
    // telefone igual em OUTRO restaurante tem contagem própria
    const other = await newTenant({ withTeam: false });
    expect((await pub(other.t, { p_customer: { name: "zz-Spammer", phone: ph } }, other.f)).data.ok).toBe(true);
  }, 120_000);

  it("concorrência: 12 sessões simultâneas com o mesmo telefone criam EXATAMENTE 5 pedidos", async () => {
    const { t, f } = await newTenant({ withTeam: false });
    const ph = phone();
    const res = await Promise.all(Array.from({ length: 12 }, () => pub(t, { p_customer: { name: "zz-Rajada", phone: ph } }, f)));
    for (const r of res) expect(r.error).toBeNull();
    const okCount = res.filter((r) => r.data.ok).length;
    expect(okCount).toBe(5);
    for (const r of res.filter((x) => !x.data.ok)) expect(codes(r)).toEqual(["RATE_LIMITED"]);
    expect(await ordersOf(t.id)).toBe(5);
  }, 120_000);

  it("61º pedido no mesmo minuto no restaurante => RATE_LIMITED (sem campo); pedidos de salão (STAFF) não contam; outro restaurante não é afetado", async () => {
    const { t, f } = await newTenant({ withTeam: false });
    const batches = 4;
    let made = 0;
    for (let b = 0; b < batches; b++) {
      const res = await Promise.all(Array.from({ length: 15 }, () => pub(t, {}, f)));
      for (const r of res) expect(r.data.ok, JSON.stringify(r.data)).toBe(true);
      made += res.length;
    }
    expect(made).toBe(60);
    const r61 = await pub(t, {}, f);
    expect(r61.data.ok).toBe(false);
    expect(codes(r61)).toEqual(["RATE_LIMITED"]);
    expect(r61.data.errors[0].field ?? null).toBeNull();
    expect(await ordersOf(t.id)).toBe(60);
    const other = await newTenant({ withTeam: false });
    expect((await pub(other.t, {}, other.f)).data.ok).toBe(true);
  }, 180_000);

  it("S-04: telefone que já existe NUNCA tem o e-mail sobrescrito nem preenchido; cliente novo guarda o e-mail informado", async () => {
    const { t, f } = await newTenant({ withTeam: false });
    const ph = phone();
    const seeded = await adm().from("customers").insert({ restaurant_id: t.id, name: "zz-Dono do Telefone", phone: ph, email: "zz.dono@example.test" }).select("id").single();
    expectOk(seeded);
    const empty = await adm().from("customers").insert({ restaurant_id: t.id, name: "zz-Sem Email", phone: phone(), email: null }).select("id,phone").single();
    expectOk(empty);
    const k1 = key();
    const k2 = key();
    expect((await pub(t, { p_idempotency_key: k1, p_customer: { name: "zz-Atacante", phone: ph, email: "zz.atacante@example.test" } }, f)).data.ok).toBe(true);
    expect((await pub(t, { p_idempotency_key: k2, p_customer: { name: "zz-Atacante", phone: empty.data!.phone, email: "zz.atacante@example.test" } }, f)).data.ok).toBe(true);
    const c1 = (await adm().from("customers").select("name,email").eq("id", seeded.data!.id).single()).data;
    const c2 = (await adm().from("customers").select("name,email").eq("id", empty.data!.id).single()).data;
    expect(c1).toEqual({ name: "zz-Dono do Telefone", email: "zz.dono@example.test" });
    expect(c2).toEqual({ name: "zz-Sem Email", email: null });
    // o snapshot do pedido guarda o e-mail informado naquele pedido
    expect((await adm().from("orders").select("customer_email").eq("idempotency_key", k1).single()).data!.customer_email).toBe("zz.atacante@example.test");
    // cliente novo: e-mail gravado
    const phNew = phone();
    expect((await pub(t, { p_customer: { name: "zz-Novo", phone: phNew, email: "zz.novo@example.test" } }, f)).data.ok).toBe(true);
    expect((await adm().from("customers").select("email").eq("restaurant_id", t.id).eq("phone", phNew).single()).data!.email).toBe("zz.novo@example.test");
  }, 120_000);
});

// =====================================================================================================================
describe("save_business_hours (atômico)", () => {
  const save = (who: AccountKey | "anon", rid: string, hours: unknown) => (who === "anon" ? anon() : as(who)).rpc("save_business_hours", { p_restaurant: rid, p_hours: hours });
  const saved = async (rid = T.id) =>
    rows(await adm().from("business_hours").select("weekday,opens_at,closes_at").eq("restaurant_id", rid).order("weekday").order("opens_at")).map((h) => `${h.weekday} ${String(h.opens_at).slice(0, 5)}-${String(h.closes_at).slice(0, 5)}`);
  const h = (weekday: number, opens_at: string, closes_at: string) => ({ weekday, opens_at, closes_at });

  beforeAll(async () => {
    await adm().from("business_hours").delete().eq("restaurant_id", T.id);
  });

  it("válido: grava, substitui TUDO, devolve {ok,count,hours} com HH:MM; aceita HH:MM:SS; [] limpa; faixas no mesmo dia sem sobreposição", async () => {
    const r = await save("ownerA", T.id, [h(1, "09:00", "12:00"), h(1, "13:00:00", "18:00"), h(0, "10:00", "22:00")]);
    expectOk(r);
    expect(r.data).toEqual({ ok: true, count: 3, hours: [h(0, "10:00", "22:00"), h(1, "09:00", "12:00"), h(1, "13:00", "18:00")] });
    expect(await saved()).toEqual(["0 10:00-22:00", "1 09:00-12:00", "1 13:00-18:00"]);
    // substitui (não acumula)
    expectOk(await save("managerA", T.id, [h(2, "08:00", "17:00")]));
    expect(await saved()).toEqual(["2 08:00-17:00"]);
    expectOk(await save("ownerA", T.id, []));
    expect(await saved()).toEqual([]);
    // auditoria
    const log = await adm().from("audit_logs").select("metadata,actor_id").eq("restaurant_id", T.id).eq("action", "settings.business_hours_saved").order("created_at", { ascending: false }).limit(1);
    expect(rows(log)[0]).toMatchObject({ actor_id: userId("ownerA"), metadata: { count: 0 } });
  });

  it("virada de dia: 18:00->02:00 pertence ao dia de abertura; a cauda não pode invadir a faixa do dia seguinte (inclusive domingo->segunda)", async () => {
    expectOk(await save("ownerA", T.id, [h(5, "18:00", "02:00"), h(6, "02:00", "04:00")]));
    expect(await saved()).toEqual(["5 18:00-02:00", "6 02:00-04:00"]);
    expectRule(await save("ownerA", T.id, [h(5, "18:00", "02:00"), h(6, "01:00", "03:00")]), /^BUSINESS_HOURS_OVERLAP/);
    expectRule(await save("ownerA", T.id, [h(6, "20:00", "03:00"), h(0, "01:00", "05:00")]), /^BUSINESS_HOURS_OVERLAP/);
    // atomicidade: o estado anterior permanece
    expect(await saved()).toEqual(["5 18:00-02:00", "6 02:00-04:00"]);
  });

  it("sobreposição no mesmo dia e mais de 6 faixas/dia são recusadas e NADA muda (atomicidade: nem o DELETE prévio persiste)", async () => {
    expectOk(await save("ownerA", T.id, [h(3, "09:00", "12:00")]));
    const before = await saved();
    expectRule(await save("ownerA", T.id, [h(4, "09:00", "12:00"), h(4, "11:00", "14:00")]), /^BUSINESS_HOURS_OVERLAP/);
    expect(await saved()).toEqual(before);
    const seven = Array.from({ length: 7 }, (_, i) => h(4, `${String(i * 3).padStart(2, "0")}:00`, `${String(i * 3 + 1).padStart(2, "0")}:00`));
    expectRule(await save("ownerA", T.id, seven), /^BUSINESS_HOURS_LIMIT/);
    expect(await saved()).toEqual(before);
    expectOk(await save("ownerA", T.id, seven.slice(0, 6)));
    expect(await saved()).toHaveLength(6);
    // falha na ÚLTIMA faixa de uma lista grande desfaz tudo
    expectOk(await save("ownerA", T.id, [h(3, "09:00", "12:00")]));
    expectRule(await save("ownerA", T.id, [h(0, "09:00", "10:00"), h(1, "09:00", "10:00"), h(2, "09:00", "10:00"), h(2, "09:30", "11:00")]), /^BUSINESS_HOURS_OVERLAP/);
    expect(await saved()).toEqual(["3 09:00-12:00"]);
  });

  it("entradas inválidas => INVALID_BUSINESS_HOURS sem alterar nada (não array, nulo, >42 faixas, dia fora de 0-6, hora inválida, abre = fecha, tipos errados, campos faltando)", async () => {
    expectOk(await save("ownerA", T.id, [h(3, "09:00", "12:00")]));
    const bad: unknown[] = [
      null,
      {},
      "texto",
      42,
      Array.from({ length: 43 }, (_, i) => h(i % 7, "01:00", "02:00")),
      [h(7, "09:00", "10:00")],
      [h(-1, "09:00", "10:00")],
      [h(1, "25:00", "26:00")],
      [h(1, "09:60", "10:00")],
      [h(1, "9:00", "10:00")],
      [h(1, "09:00", "09:00")],
      [h(1.5 as number, "09:00", "10:00")],
      [{ weekday: "1", opens_at: "09:00", closes_at: "10:00" }],
      [{ weekday: 1, opens_at: 900, closes_at: "10:00" }],
      [{ weekday: 1, opens_at: "09:00" }],
      [{ weekday: 1, closes_at: "10:00" }],
      [{ opens_at: "09:00", closes_at: "10:00" }],
      ["09:00-10:00"],
      [null],
      [h(1, "09:00\u0000", "10:00")],
    ];
    for (const [i, payload] of bad.entries()) {
      const r = await save("ownerA", T.id, payload);
      expect(r.error, `caso ${i}: ${JSON.stringify(payload).slice(0, 80)}`).not.toBeNull();
      expect(r.error!.message, `caso ${i}`).toMatch(/^(INVALID_BUSINESS_HOURS|BUSINESS_HOURS_)|unsupported Unicode/);
    }
    // 42 faixas exatas (6 por dia) são aceitas
    const forty2 = Array.from({ length: 42 }, (_, i) => h(Math.floor(i / 6), `${String((i % 6) * 3).padStart(2, "0")}:00`, `${String((i % 6) * 3 + 1).padStart(2, "0")}:00`));
    expectOk(await save("ownerA", T.id, forty2));
    expect(await saved()).toHaveLength(42);
    expectOk(await save("ownerA", T.id, [h(3, "09:00", "12:00")]));
  });

  it("permissões: só restaurant.settings.manage (dono/gerente); caixa/cozinha/garçom FORBIDDEN; de fora e outro tenant RESTAURANT_NOT_FOUND; anon sem EXECUTE; nada muda", async () => {
    expectOk(await save("ownerA", T.id, [h(3, "09:00", "12:00")]));
    const before = await saved();
    for (const who of ["cashierA", "kitchenA", "waiterA"] as AccountKey[]) expectRule(await save(who, T.id, [h(1, "08:00", "09:00")]), /^FORBIDDEN/);
    for (const who of ["plain", "ownerB", "superadmin", "support"] as AccountKey[]) expectRule(await save(who, T.id, [h(1, "08:00", "09:00")]), /^RESTAURANT_NOT_FOUND/);
    expectDenied(await save("anon", T.id, []), /42501|permission denied/i);
    expect(await saved()).toEqual(before);
    // dono de A tentando gravar no restaurante B (o seed de B não pode mudar)
    const bBefore = await saved(B().id);
    expectRule(await save("ownerA", B().id, []), /^RESTAURANT_NOT_FOUND/);
    expectRule(await save("ownerA", "00000000-0000-4000-8000-00000000dead", []), /^RESTAURANT_NOT_FOUND/);
    expect(await saved(B().id)).toEqual(bBefore);
  });

  it("concorrência: 6 salvamentos simultâneos de listas diferentes terminam com UMA das listas inteira (nunca mistura)", async () => {
    const lists = Array.from({ length: 6 }, (_, i) => [h(i % 7, "08:00", "09:00"), h((i + 1) % 7, "10:00", "11:00")]);
    const res = await Promise.all(lists.map((l) => save("ownerA", T.id, l)));
    for (const r of res) expect(r.error, r.error?.message).toBeNull();
    const final = await saved();
    const expected = lists.map((l) => l.map((x) => `${x.weekday} ${x.opens_at}-${x.closes_at}`).sort());
    expect(expected.some((e) => JSON.stringify(e) === JSON.stringify([...final].sort()))).toBe(true);
    await adm().from("business_hours").delete().eq("restaurant_id", T.id);
  });
});

// =====================================================================================================================
describe("S-08: qr_token fora do alcance dos clientes", () => {
  let table: { id: string; name: string };
  beforeAll(async () => {
    table = await makeTable(cleanup, T.id, { name: `zz-qr27-${U}` });
  });

  it("authenticated (qualquer papel) não lê `qr_token`: select(*), coluna explícita e filtro/ordenação por ele => permission denied; colunas permitidas funcionam", async () => {
    for (const who of ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      expectDenied(await as(who).from("restaurant_tables").select("*").eq("restaurant_id", T.id), /42501|permission denied/i);
      expectDenied(await as(who).from("restaurant_tables").select("id,qr_token").eq("restaurant_id", T.id), /42501|permission denied/i);
      expectDenied(await as(who).from("restaurant_tables").select("id").eq("qr_token", "x").limit(1), /42501|permission denied/i);
      expectDenied(await as(who).from("restaurant_tables").select("id").order("qr_token").limit(1), /42501|permission denied/i);
    }
    const ok = await as("ownerA").from("restaurant_tables").select("id,name,area,capacity,status,sort_order,created_at,updated_at,restaurant_id").eq("id", table.id);
    expectOk(ok);
    expect(rows(ok)).toHaveLength(1);
    expect(Object.keys(rows(ok)[0])).not.toContain("qr_token");
    // anon nem a tabela lê
    expectDenied(await anon().from("restaurant_tables").select("id").limit(1), /42501|permission denied/i);
    // UPDATE ... RETURNING qr_token também é negado, e a mesa não muda
    expectDenied(await as("ownerA").from("restaurant_tables").update({ name: `zz-qr27-${U}` }).eq("id", table.id).select("id,qr_token"), /42501|permission denied/i);
  });

  it("list_table_qr_tokens: só tables.manage (dono/gerente) e devolve o token real; demais papéis FORBIDDEN; de fora/outro tenant NOT_FOUND idêntico; anon sem EXECUTE", async () => {
    const real = (await adm().from("restaurant_tables").select("id,qr_token").eq("restaurant_id", T.id)).data as any[];
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      const r = await as(who).rpc("list_table_qr_tokens", { p_restaurant: T.id });
      expectOk(r);
      const list = r.data as any[];
      expect(list).toHaveLength(real.length);
      for (const row of real) expect(list.find((x) => x.id === row.id)).toMatchObject({ qr_token: row.qr_token });
      expect(Object.keys(list[0]).sort()).toEqual(["id", "name", "qr_token"]);
    }
    for (const who of ["cashierA", "kitchenA", "waiterA"] as AccountKey[]) expectRule(await as(who).rpc("list_table_qr_tokens", { p_restaurant: T.id }), /^FORBIDDEN/);
    const m = new Set<string>();
    for (const [who, rid] of [["ownerB", T.id], ["plain", T.id], ["ownerA", B().id], ["ownerA", "00000000-0000-4000-8000-00000000dead"]] as [AccountKey, string][]) {
      const r = await as(who).rpc("list_table_qr_tokens", { p_restaurant: rid });
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      m.add(r.error!.message);
    }
    expect(m.size).toBe(1);
    expectDenied(await anon().rpc("list_table_qr_tokens", { p_restaurant: T.id }), /42501|permission denied/i);
  });

  it("rotate_table_qr só com tables.manage: garçom/caixa/cozinha FORBIDDEN e o token não muda; dono rotaciona e o novo token aparece em list_table_qr_tokens", async () => {
    const tokenOf = async () => (await adm().from("restaurant_tables").select("qr_token").eq("id", table.id).single()).data!.qr_token as string;
    const t0 = await tokenOf();
    for (const who of ["waiterA", "cashierA", "kitchenA"] as AccountKey[]) expectRule(await as(who).rpc("rotate_table_qr", { p_table: table.id }), /^FORBIDDEN/);
    expectRule(await as("ownerB").rpc("rotate_table_qr", { p_table: table.id }), /TABLE_NOT_FOUND/);
    expect(await tokenOf()).toBe(t0);
    const r = await as("managerA").rpc("rotate_table_qr", { p_table: table.id });
    expectOk(r);
    const t1 = await tokenOf();
    expect(t1).not.toBe(t0);
    const list = (await as("ownerA").rpc("list_table_qr_tokens", { p_restaurant: T.id })).data as any[];
    expect(list.find((x) => x.id === table.id).qr_token).toBe(t1);
  });

  it("Realtime de restaurant_tables não traz qr_token (nem na linha nova nem na antiga)", async () => {
    const client = realtimeAs("ownerA");
    const events: any[] = [];
    const channel = client.channel(`rt27-${uniq()}`);
    channel.on("postgres_changes" as never, { event: "*", schema: "public", table: "restaurant_tables", filter: `restaurant_id=eq.${T.id}` } as never, (p: any) => events.push(p));
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("realtime não inscreveu")), 20_000);
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED") (clearTimeout(to), resolve());
        if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") (clearTimeout(to), reject(new Error(`realtime ${s}`)));
      });
    });
    try {
      let n = 0;
      const got = await waitFor(
        async () => {
          await adm().from("restaurant_tables").update({ name: `zz-qr27-${U}-r${++n}` }).eq("id", table.id);
          await new Promise((r) => setTimeout(r, 700));
          return events.length > 0 ? events : null;
        },
        { timeoutMs: 40_000, intervalMs: 100, what: "evento de restaurant_tables" },
      );
      for (const p of got) {
        expect(JSON.stringify(p)).not.toMatch(/qr_token/);
        expect(p.new?.id ?? p.old?.id).toBeDefined();
      }
    } finally {
      await client.removeChannel(channel).catch(() => undefined);
    }
  }, 90_000);
});

// =====================================================================================================================
describe("F-50, S-12 e sanitização da auditoria", () => {
  it("F-50: plano não é apagável por DELETE direto (superadmin, dono, anon); continua existindo; inativar (UPDATE is_active) segue funcionando para a plataforma", async () => {
    const p = await mkPlan("f50", {});
    expectNotApplied(await as("superadmin").from("plans").delete().eq("id", p.id).select("id"));
    expectNotApplied(await as("ownerA").from("plans").delete().eq("id", p.id).select("id"));
    expectNotApplied(await anon().from("plans").delete().eq("id", p.id).select("id"));
    expect(rows(await adm().from("plans").select("id").eq("id", p.id))).toHaveLength(1);
    expect(
      expectOk(await as("superadmin").from("plans").update({ is_active: false }).eq("id", p.id).select("id")),
    ).toBeUndefined();
    expect((await adm().from("plans").select("is_active").eq("id", p.id).single()).data!.is_active).toBe(false);
  });

  it("S-12: 20 chamados/hora por usuário; o 21º => RATE_LIMITED; outro usuário não é afetado; o teto é por usuário (não por restaurante)", async () => {
    const email = `zz-t27-${U}@example.test`;
    const created = await adm().auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: "zz T27 Chamados" } });
    expect(created.error).toBeNull();
    const uid = created.data.user!.id;
    cleanup.add(async () => void (await adm().auth.admin.deleteUser(uid)));
    expectOk(await adm().from("restaurant_memberships").insert({ restaurant_id: T.id, user_id: uid, role: "waiter", status: "active" }));
    const me = await signInAs(email, TEST_PASSWORD);
    const open = (client: any, n: number) => client.from("support_tickets").insert({ restaurant_id: T.id, subject: `zz-t27-${U}-${n}`, body: "teste" }).select("id");
    for (let i = 1; i <= 20; i++) {
      const r = await open(me.client, i);
      expect(r.error, `chamado ${i}: ${r.error?.message}`).toBeNull();
    }
    expectRule(await open(me.client, 21), /^RATE_LIMITED/);
    expect(rows(await adm().from("support_tickets").select("id").eq("opened_by", uid))).toHaveLength(20);
    // outro usuário do mesmo restaurante abre normalmente
    expectOk(await open(as("waiterA"), 1));
  }, 120_000);

  it("auditoria (list_audit_logs): chaves senha/segredo/chave*/Bearer/JWT removidas; valores comuns preservados; fora do padrão não são mutilados", async () => {
    const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const action = `zz.t27.sanit.${U}`;
    const ins = await adm()
      .from("audit_logs")
      .insert({
        restaurant_id: T.id,
        actor_id: userId("ownerA"),
        action,
        resource_type: "zz",
        metadata: {
          ok: 1,
          texto: "pedido #123 de Maria",
          senha: "MINHASENHA",
          nova_senha: "MINHASENHA2",
          segredo: "MEUSEGREDO",
          segredo_cliente: "MEUSEGREDO2",
          chave_api: "CHAVE1",
          chave: "CHAVE2",
          header: `Bearer ${JWT}`,
          nota: ` ${JWT}`,
          direto: JWT,
          aninhado: { password: "P1", senha: "P2", bearer: "B1", mantido: "sim", lista: [{ segredo: "X" }, `Bearer ${JWT}`, "ok"] },
        },
      })
      .select("id");
    expectOk(ins);
    const r = await as("ownerA").rpc("list_audit_logs", { p_restaurant: T.id, p_action_prefix: action, p_from: null, p_to: null, p_limit: 10, p_before: null });
    expectOk(r);
    const row = (r.data as any).rows[0];
    const text = JSON.stringify(row.metadata);
    for (const leak of ["MINHASENHA", "MEUSEGREDO", "CHAVE1", "CHAVE2", "eyJhbGci", "P1", "P2", "B1"]) expect(text, leak).not.toContain(leak);
    expect(row.metadata).toMatchObject({ ok: 1, texto: "pedido #123 de Maria", header: "[removido]", nota: "[removido]", direto: "[removido]" });
    expect(row.metadata.aninhado).toMatchObject({ mantido: "sim", lista: [{}, "[removido]", "ok"] });
    expect(Object.keys(row.metadata)).not.toEqual(expect.arrayContaining(["senha", "segredo", "chave_api", "chave"]));
  });
});
