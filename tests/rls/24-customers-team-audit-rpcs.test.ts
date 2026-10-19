/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 5 (migs. 0125 + 0127): list_customers, get_customer, list_team e list_audit_logs por clientes AUTENTICADOS reais.
 * Service role só monta fixtures (restaurante efêmero `zz-t5-*` com a equipe DEMO de A vinculada, ~135 clientes, pedidos,
 * linhas de audit_logs com metadata hostil) e lê o estado real. `audit_logs` é append-only: as linhas de teste ficam
 * (ligadas a um restaurante que deixa de existir) — mesmo comportamento dos demais testes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, anon, as, userId, world } from "../helpers/clients";
import { expectDenied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";
import { makeTenant, type Tenant } from "../helpers/phase5";
import { dockerAvailable, psql } from "../helpers/psql";

const cleanup = new Cleanup();
type Client = AccountKey | "anon";
const cl = (who: Client) => (who === "anon" ? anon() : as(who));
const listC = (who: Client, rid: string | null, search: string | null = null, cursor: unknown = null, limit: number | null = 25) =>
  cl(who).rpc("list_customers", { p_restaurant: rid, p_search: search, p_cursor: cursor, p_limit: limit });
const getC = (who: Client, rid: string | null, id: string | null) => cl(who).rpc("get_customer", { p_restaurant: rid, p_customer: id });
const team = (who: Client, rid: string | null) => cl(who).rpc("list_team", { p_restaurant: rid });
const audit = (who: Client, rid: string | null, extra: Record<string, unknown> = {}) =>
  cl(who).rpc("list_audit_logs", { p_restaurant: rid, p_action_prefix: null, p_from: null, p_to: null, p_limit: 50, p_before: null, ...extra });
const ok = async (p: PromiseLike<any>): Promise<any> => {
  const r = await p;
  expectOk(r);
  return r.data;
};
const GHOST = "00000000-0000-4000-8000-00000000dead";

let S: Tenant;
let S3: Tenant; // outro tenant efêmero (isolamento de auditoria)
interface Cust {
  id: string;
  name: string;
  phone: string | null;
  created_at: string;
}
let custs: Cust[] = [];
const byName: Record<string, Cust> = {};
let lastOrderAt = new Map<string, string>();
let orderStats = new Map<string, { cnt: number; spent: number }>();

const DEAD = ["CANCELLED", "REJECTED"];
const T0 = "2026-04-10T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse("2026-04-01T00:00:00Z") + min * 60_000).toISOString();

async function mkOrders(cid: string, specs: { status: string; total: number; at: string }[]) {
  const batch = specs.map((s, i) => ({
    restaurant_id: S.id,
    customer_id: cid,
    fulfillment_type: "PICKUP",
    status: s.status,
    source: "STAFF",
    created_at: s.at,
    subtotal_cents: s.total,
    total_cents: s.total,
    status_reason: DEAD.includes(s.status) ? "teste" : null,
    idempotency_key: `zz-t24-${uniq()}-${i}`,
    customer_name: "zz cli",
  }));
  for (let i = 0; i < batch.length; i += 100) {
    const r = await admin().from("orders").insert(batch.slice(i, i + 100));
    if (r.error) throw new Error(`orders: ${r.error.message}`);
  }
}

beforeAll(async () => {
  const a = admin();
  S = await makeTenant(cleanup);
  S3 = await makeTenant(cleanup, { withTeam: false });
  const special: [string, string | null, string | null][] = [
    ["Ana 100% Real", "11955550001", "ana@exemplo.test"],
    ["Bob_Under", "11955550002", null],
    ["Carlos\\Back", "11955550003", null],
    ["Dani Formatada", "+55 11 97777-6666", "dani@exemplo.test"],
    ["Eva Normal", "11955550005", "eva@exemplo.test"],
    ["Evandro Normal", "11955550006", null],
    ["Sem Telefone", null, null],
    ["Fulano Cancelado", "11955550008", null],
  ];
  const all: Record<string, unknown>[] = special.map(([name, phone, email], i) => ({ restaurant_id: S.id, name, phone, email, notes: "obs interna", created_at: at(-1000 + i) }));
  for (let i = 0; i < 125; i++) all.push({ restaurant_id: S.id, name: `zz-cli-${String(i).padStart(3, "0")}`, phone: `119000${String(i).padStart(5, "0")}`, created_at: at(-500 + i) });
  const ins = await a.from("customers").insert(all).select("id,name,phone,created_at");
  if (ins.error) throw new Error(`customers: ${ins.error.message}`);
  custs = ins.data as Cust[];
  for (const c of custs) byName[c.name] = c;

  // pedidos: 0..79 com horários distintos; 80..99 compartilham o MESMO instante (desempate por id); 100..124 sem pedido
  for (let i = 0; i < 80; i++) await mkOrders(byName[`zz-cli-${String(i).padStart(3, "0")}`].id, [{ status: "COMPLETED", total: 1000 + i, at: at(i) }]);
  const tie = [];
  for (let i = 80; i < 100; i++) tie.push(mkOrders(byName[`zz-cli-${String(i).padStart(3, "0")}`].id, [{ status: "COMPLETED", total: 500, at: T0 }]));
  await Promise.all(tie);
  const ful = byName["Fulano Cancelado"].id;
  await mkOrders(ful, [
    { status: "COMPLETED", total: 1000, at: at(1000) },
    { status: "PREPARING", total: 500, at: at(1001) },
    { status: "CANCELLED", total: 7000, at: at(1002) },
    { status: "REJECTED", total: 8000, at: at(1003) },
  ]);
  await mkOrders(byName["Ana 100% Real"].id, [{ status: "COMPLETED", total: 2500, at: at(1100) }]);
  await mkOrders(byName["Dani Formatada"].id, [{ status: "CANCELLED", total: 900, at: at(1200) }]); // só cancelado
  // 205 pedidos para o limite de 200 do get_customer
  await mkOrders(byName["Eva Normal"].id, Array.from({ length: 205 }, (_, i) => ({ status: "COMPLETED", total: 100, at: at(2000 + i) })));
  for (const [i, c] of [["Ana 100% Real", 0], ["Dani Formatada", 1]] as const) {
    expectOk(await a.from("customer_addresses").insert({ restaurant_id: S.id, customer_id: byName[i].id, street: `Rua ${c}`, number: "10", city: "São Paulo", state: "SP", is_default: true }));
  }

  // modelo independente de agregação por cliente
  const os = ((await a.from("orders").select("customer_id,status,total_cents,created_at").eq("restaurant_id", S.id).not("customer_id", "is", null).limit(10000)).data ?? []) as any[];
  lastOrderAt = new Map();
  orderStats = new Map();
  for (const o of os) {
    const prev = lastOrderAt.get(o.customer_id);
    if (!prev || Date.parse(o.created_at) > Date.parse(prev)) lastOrderAt.set(o.customer_id, o.created_at);
    const s = orderStats.get(o.customer_id) ?? { cnt: 0, spent: 0 };
    s.cnt += 1;
    if (!DEAD.includes(o.status)) s.spent += o.total_cents;
    orderStats.set(o.customer_id, s);
  }
}, 180_000);

afterAll(async () => {
  await cleanup.run();
});

const sortAt = (c: Cust) => Date.parse(lastOrderAt.get(c.id) ?? c.created_at);
const expectedOrder = () => [...custs].sort((x, y) => sortAt(y) - sortAt(x) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
const digitsOf = (s: string) => s.replace(/\D/g, "");
function expectedSearch(q: string): Cust[] {
  const pat = q.slice(0, 100).trim().toLowerCase();
  if (!pat) return expectedOrder();
  const d = digitsOf(pat);
  return expectedOrder().filter(
    (c) => c.name.toLowerCase().includes(pat) || (c.phone ?? "").toLowerCase().includes(pat) || (d.length >= 3 && digitsOf(c.phone ?? "").includes(d)),
  );
}

// =====================================================================================================================
describe("list_customers / get_customer: permissão (reports.view, mig. 0127)", () => {
  it("owner e manager listam e veem; cashier, kitchen e waiter => FORBIDDEN (42501), sem dados", async () => {
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      expect((await ok(listC(who, S.id))).rows.length).toBe(25);
      expect((await ok(getC(who, S.id, byName["Eva Normal"].id))).customer.name).toBe("Eva Normal");
    }
    for (const who of ["cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      const l = await listC(who, S.id);
      expectRule(l, /^FORBIDDEN/);
      expect(l.error!.code).toBe("42501");
      expect(l.data).toBeNull();
      const g = await getC(who, S.id, byName["Eva Normal"].id);
      expectRule(g, /^FORBIDDEN/);
      expect(g.data).toBeNull();
    }
  });

  it("override reports.view=true libera o caixa; reports.view=false bloqueia o gerente (restaurado)", async () => {
    const a = admin();
    const ov = (k: AccountKey, granted: boolean) => a.from("membership_permission_overrides").insert({ membership_id: S.members[k]!, restaurant_id: S.id, permission_key: "reports.view", granted });
    expectOk(await ov("cashierA", true));
    expectOk(await ov("managerA", false));
    try {
      expect((await ok(listC("cashierA", S.id))).rows).toHaveLength(25);
      expectRule(await listC("managerA", S.id), /^FORBIDDEN/);
      expectRule(await getC("managerA", S.id, byName["Eva Normal"].id), /^FORBIDDEN/);
    } finally {
      await a.from("membership_permission_overrides").delete().eq("restaurant_id", S.id);
    }
    expectRule(await listC("cashierA", S.id), /^FORBIDDEN/);
  });

  it("de fora (dono de B, sem vínculo, superadmin, suporte) e id inexistente: RESTAURANT_NOT_FOUND idêntico", async () => {
    const outcomes = new Set<string>();
    for (const who of ["ownerB", "plain", "superadmin", "support"] as AccountKey[]) {
      for (const r of [await listC(who, S.id), await getC(who, S.id, byName["Eva Normal"].id)]) {
        expectRule(r, /^RESTAURANT_NOT_FOUND/);
        outcomes.add(`${r.error!.code}|${r.error!.message}`);
      }
    }
    for (const r of [await listC("ownerA", GHOST), await getC("ownerA", GHOST, byName["Eva Normal"].id), await listC("ownerA", null), await getC("ownerA", null, null)]) {
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      outcomes.add(`${r.error!.code}|${r.error!.message}`);
    }
    expect(outcomes.size).toBe(1);
  });

  it("cliente de outro restaurante == cliente inexistente (CUSTOMER_NOT_FOUND idêntico, sem oráculo)", async () => {
    const bCustomer = world().restaurants.b.customerId;
    const msgs = new Set<string>();
    for (const r of [
      await getC("ownerA", S.id, bCustomer), // cliente de B pedido dentro de S
      await getC("ownerA", S.id, GHOST),
      await getC("ownerB", world().restaurants.b.id, byName["Eva Normal"].id), // cliente de S pedido dentro de B
      await getC("ownerB", world().restaurants.b.id, GHOST),
    ]) {
      expectRule(r, /^CUSTOMER_NOT_FOUND/);
      expect(r.error!.code).toBe("P0002");
      msgs.add(r.error!.message);
    }
    expect(msgs.size).toBe(1);
    // ownerA (dono em A e em S) não enxerga B mesmo tentando o id de B como restaurante
    expectRule(await getC("ownerA", world().restaurants.b.id, bCustomer), /^RESTAURANT_NOT_FOUND/);
    expectRule(await listC("ownerA", world().restaurants.b.id), /^RESTAURANT_NOT_FOUND/);
    // id malformado: erro de parâmetro (4xx), nunca 5xx
    const bad = await getC("ownerA", S.id, "nao-e-uuid");
    expect(bad.error).not.toBeNull();
    expect(bad.status).toBeLessThan(500);
  });

  it("anon sem EXECUTE nas quatro RPCs", async () => {
    for (const r of [await listC("anon", S.id), await getC("anon", S.id, byName["Eva Normal"].id), await team("anon", S.id), await audit("anon", S.id)]) {
      expectDenied(r, /42501|permission denied/i);
    }
  });

  it("decisão registrada: a RLS direta de customers NÃO mudou — caixa/cozinha/garçom ainda leem PII por REST (e sem auditoria)", async () => {
    // As RPCs exigem reports.view, mas customers_select (orders.view OU reports.view) segue valendo. Não é regressão da 0127:
    // o contrato manteve a RLS operacional. Documentado como F-47 (Baixa): a trilha 'customer.viewed' só cobre get_customer.
    const direct = await as("cashierA").from("customers").select("id,name,phone,email").eq("restaurant_id", S.id).limit(5);
    expectOk(direct);
    expect(rows(direct).length).toBeGreaterThan(0);
    expect(rows(direct)[0]).toHaveProperty("phone");
  });
});

// =====================================================================================================================
describe("list_customers: busca, agregados, paginação keyset e cursor", () => {
  it("agregados: orders_count conta TODOS os pedidos; total_spent exclui cancelados/recusados; last_order_at", async () => {
    const r = await ok(listC("ownerA", S.id, "Fulano", null, 10));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: "Fulano Cancelado", orders_count: 4, total_spent_cents: 1500 });
    expect(Date.parse(r.rows[0].last_order_at)).toBe(Date.parse(at(1003)));
    const dani = (await ok(listC("ownerA", S.id, "Dani Formatada"))).rows[0];
    expect(dani).toMatchObject({ orders_count: 1, total_spent_cents: 0 }); // só cancelado
    const noOrders = (await ok(listC("ownerA", S.id, "zz-cli-110"))).rows[0];
    expect(noOrders).toMatchObject({ orders_count: 0, total_spent_cents: 0, last_order_at: null });
    expect(Object.keys(r.rows[0]).sort()).toEqual(["email", "id", "last_order_at", "name", "orders_count", "phone", "total_spent_cents"]);
    // todos os números conferem com o modelo
    const page = (await ok(listC("ownerA", S.id, null, null, 100))).rows as any[];
    for (const row of page) {
      const st = orderStats.get(row.id) ?? { cnt: 0, spent: 0 };
      expect({ c: row.orders_count, s: row.total_spent_cents }, row.name).toEqual({ c: st.cnt, s: st.spent });
    }
  });

  it("busca literal: %, _, \\ não são curingas; dígitos de telefone atravessam a formatação", async () => {
    for (const q of ["%", "_", "\\", "100%", "Bob_U", "Carlos\\B", "%%", "\\%", "_%_", "a%b", "[a-z]*", "' or 1=1 --", "'; drop table customers; --", "zz-cli-0"]) {
      const r = await ok(listC("ownerA", S.id, q, null, 100));
      const exp = expectedSearch(q).slice(0, 100);
      expect(r.rows.map((x: any) => x.id), JSON.stringify(q)).toEqual(exp.map((c) => c.id));
    }
    expect((await ok(listC("ownerA", S.id, "%", null, 100))).rows.map((x: any) => x.name)).toEqual(["Ana 100% Real"]);
    expect((await ok(listC("ownerA", S.id, "_", null, 100))).rows.map((x: any) => x.name)).toEqual(["Bob_Under"]);
    expect((await ok(listC("ownerA", S.id, "\\", null, 100))).rows.map((x: any) => x.name)).toEqual(["Carlos\\Back"]);
    for (const q of ["11977776666", "(11) 97777-6666", "97777", "+55 11 97777", "977776666"]) {
      expect((await ok(listC("ownerA", S.id, q))).rows.map((x: any) => x.name), q).toEqual(["Dani Formatada"]);
    }
    // case-insensitive e com espaços nas pontas; branco = sem filtro
    expect((await ok(listC("ownerA", S.id, "  BOB_under  "))).rows.map((x: any) => x.name)).toEqual(["Bob_Under"]);
    expect((await ok(listC("ownerA", S.id, "   "))).rows).toHaveLength(25);
    expect((await ok(listC("ownerA", S.id, "9".repeat(500), null, 100))).rows).toHaveLength(0);
  });

  it("paginação keyset completa (limite 7) cobre todos os clientes exatamente uma vez, na ordem (último pedido desc, id desc), inclusive com empates", async () => {
    const seen: string[] = [];
    let cursor: unknown = null;
    let pages = 0;
    for (;;) {
      const r = await ok(listC("ownerA", S.id, null, cursor, 7));
      expect(r.rows.length).toBeLessThanOrEqual(7);
      seen.push(...r.rows.map((x: any) => x.id));
      pages += 1;
      if (!r.next_cursor) break;
      expect(Object.keys(r.next_cursor).sort()).toEqual(["id", "t"]);
      expect(r.next_cursor.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      expect(r.rows).toHaveLength(7);
      cursor = r.next_cursor;
      expect(pages).toBeLessThan(40);
    }
    expect(new Set(seen).size).toBe(seen.length); // sem repetição
    expect(seen).toEqual(expectedOrder().map((c) => c.id));
    expect(pages).toBe(Math.ceil(custs.length / 7));
  });

  it("paginação com busca e com 20 clientes empatados no mesmo instante (limite 3)", async () => {
    const seen: string[] = [];
    let cursor: unknown = null;
    for (let i = 0; i < 60; i++) {
      const r = await ok(listC("managerA", S.id, "zz-cli-0", cursor, 3));
      seen.push(...r.rows.map((x: any) => x.id));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    expect(seen).toEqual(expectedSearch("zz-cli-0").map((c) => c.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("limite: padrão 25, 0/negativo => 1, acima de 100 => 100", async () => {
    expect((await ok(listC("ownerA", S.id, null, null, null))).rows).toHaveLength(25);
    expect((await ok(listC("ownerA", S.id, null, null, 0))).rows).toHaveLength(1);
    expect((await ok(listC("ownerA", S.id, null, null, -5))).rows).toHaveLength(1);
    expect((await ok(listC("ownerA", S.id, null, null, 1))).rows).toHaveLength(1);
    const big = await ok(listC("ownerA", S.id, null, null, 100));
    expect(big.rows).toHaveLength(100);
    expect(big.next_cursor).not.toBeNull();
    expect((await ok(listC("ownerA", S.id, null, null, 1000))).rows).toHaveLength(100);
    expect((await ok(listC("ownerA", S.id, null, null, 2147483647))).rows).toHaveLength(100);
    // última página: sem next_cursor
    const last = await ok(listC("ownerA", S.id, null, null, 100));
    expect(last.next_cursor).toEqual({ t: expect.any(String), id: last.rows[99].id });
    const tail = await ok(listC("ownerA", S.id, null, last.next_cursor, 100));
    expect(tail.rows).toHaveLength(custs.length - 100);
    expect(tail.next_cursor).toBeNull();
  });

  it("cursor adulterado => INVALID_CURSOR (22023): array, string, número, chave extra/faltando, tipos errados, uuid/timestamp inválidos", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const t = "2026-04-01T00:00:00.000000Z";
    const bad: unknown[] = [
      [],
      [t, id],
      "abc",
      "",
      5,
      true,
      {},
      { t },
      { id },
      { t, id, extra: 1 },
      { t, id: 5 },
      { t: 5, id },
      { t: null, id },
      { t, id: null },
      { t: [t], id },
      { t, id: { v: id } },
      { t: "ontem", id },
      { t: "2026-13-45T00:00:00Z", id },
      { t: "9".repeat(41), id },
      { t, id: "nao-e-uuid" },
      { t, id: id + "0" },
      { t, id: "' or 1=1 --" },
      { T: t, ID: id },
    ];
    for (const c of bad) {
      for (const r of [await listC("ownerA", S.id, null, c), await audit("ownerA", S.id, { p_before: c })]) {
        expect(r.error, JSON.stringify(c)).not.toBeNull();
        expect(r.error!.message, JSON.stringify(c)).toMatch(/^INVALID_CURSOR/);
        expect(r.error!.code).toBe("22023");
      }
    }
    // cursores "estranhos mas válidos" não geram erro nem 5xx
    for (const c of [{ t: "9999-12-31T00:00:00Z", id }, { t: "2026-04-01", id }, { t: "infinity", id }, { t: "-infinity", id }]) {
      const r = await listC("ownerA", S.id, null, c);
      expect(r.error, JSON.stringify(c)).toBeNull();
    }
    // JSON null e SQL NULL = sem cursor
    expect((await ok(listC("ownerA", S.id, null, null))).rows).toHaveLength(25);
  });
});

// =====================================================================================================================
describe("get_customer: conteúdo e auditoria LGPD", () => {
  const views = async (cid: string) => rows(await admin().from("audit_logs").select("id,actor_id,metadata,restaurant_id,resource_type").eq("action", "customer.viewed").eq("resource_id", cid));

  it("devolve cliente, endereços, pedidos (máx. 200, mais novos primeiro) e estatísticas completas", async () => {
    const eva = byName["Eva Normal"];
    const g = await ok(getC("ownerA", S.id, eva.id));
    expect(g.customer).toMatchObject({ id: eva.id, name: "Eva Normal", phone: "11955550005", email: "eva@exemplo.test", notes: "obs interna" });
    expect(g.orders).toHaveLength(200);
    expect(g.stats).toMatchObject({ orders_count: 205, total_spent_cents: 20500 }); // estatística sobre TODOS, lista limitada
    const times = g.orders.map((o: any) => Date.parse(o.created_at));
    expect([...times].sort((x: number, y: number) => y - x)).toEqual(times);
    expect(Object.keys(g.orders[0]).sort()).toEqual(["created_at", "fulfillment_type", "id", "order_number", "status", "total_cents"]);
    const ana = await ok(getC("managerA", S.id, byName["Ana 100% Real"].id));
    expect(ana.addresses).toHaveLength(1);
    expect(ana.addresses[0]).toMatchObject({ street: "Rua 0", city: "São Paulo", state: "SP", is_default: true });
    const ful = await ok(getC("ownerA", S.id, byName["Fulano Cancelado"].id));
    expect(ful.stats).toMatchObject({ orders_count: 4, total_spent_cents: 1500 });
    expect(ful.orders.map((o: any) => o.status)).toEqual(["REJECTED", "CANCELLED", "PREPARING", "COMPLETED"]);
    expect(Object.keys(g).sort()).toEqual(["addresses", "customer", "orders", "stats"]);
  });

  it("customer.viewed é gravado UMA vez por get_customer (ator, restaurante, recurso; metadata vazio) e NÃO por list_customers", async () => {
    const c = byName["Bob_Under"].id;
    expect(await views(c)).toHaveLength(0);
    await ok(getC("ownerA", S.id, c));
    let v = await views(c);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ actor_id: userId("ownerA"), restaurant_id: S.id, resource_type: "customer", metadata: {} });
    await ok(getC("managerA", S.id, c));
    v = await views(c);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.actor_id).sort()).toEqual([userId("ownerA"), userId("managerA")].sort());
    // listar (várias vezes, com busca) não audita
    const before = rows(await admin().from("audit_logs").select("id").eq("restaurant_id", S.id).eq("action", "customer.viewed")).length;
    await ok(listC("ownerA", S.id, "Bob"));
    await ok(listC("ownerA", S.id));
    expect(rows(await admin().from("audit_logs").select("id").eq("restaurant_id", S.id).eq("action", "customer.viewed")).length).toBe(before);
    // falhas não auditam: sem permissão, de fora, id inexistente
    await getC("cashierA", S.id, c);
    await getC("ownerB", S.id, c);
    await getC("ownerA", S.id, GHOST);
    expect(await views(c)).toHaveLength(2);
    expect(rows(await admin().from("audit_logs").select("id").eq("resource_id", GHOST).eq("action", "customer.viewed"))).toHaveLength(0);
    // sem PII no metadata de nenhuma linha de visualização
    expect(JSON.stringify(await views(c))).not.toMatch(/Bob_Under|11955550002/);
  });
});

// =====================================================================================================================
describe("list_team", () => {
  const OWNER_PERMS = ["menu.manage", "orders.view", "reports.view", "restaurant.settings.manage", "tables.manage", "tables.view", "tabs.view", "team.manage"];
  let rp: Record<string, string[]> = {};
  let revokedId = "";
  let invitedId = "";

  beforeAll(async () => {
    const a = admin();
    const perms = rows(await a.from("role_permissions").select("role,permission_key"));
    rp = {};
    for (const p of perms) (rp[p.role] ??= []).push(p.permission_key);
    const inv = await a.from("restaurant_memberships").insert({ restaurant_id: S.id, user_id: null, role: "waiter", status: "invited", invited_email: `zz-convite-${uniq()}@example.test` }).select("id").single();
    invitedId = inv.data!.id;
    const rev = await a.from("restaurant_memberships").insert({ restaurant_id: S.id, user_id: userId("plain"), role: "cashier", status: "revoked" }).select("id").single();
    revokedId = rev.data!.id;
    const ovr = (k: AccountKey, key: string, granted: boolean) => a.from("membership_permission_overrides").insert({ membership_id: S.members[k]!, restaurant_id: S.id, permission_key: key, granted });
    expectOk(await ovr("cashierA", "reports.view", true));
    expectOk(await ovr("waiterA", "tabs.manage", false));
    expectOk(await ovr("managerA", "menu.manage", false));
    // uma "concessão" a um revogado não pode gerar permissão efetiva
    expectOk(await a.from("membership_permission_overrides").insert({ membership_id: revokedId, restaurant_id: S.id, permission_key: "reports.view", granted: true }));
  });

  it("só o dono (team.manage) lista; gerente, caixa, cozinha e garçom => FORBIDDEN; de fora => RESTAURANT_NOT_FOUND; anon negado", async () => {
    expect((await ok(team("ownerA", S.id))).rows.length).toBe(7);
    for (const who of ["managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      const r = await team(who, S.id);
      expectRule(r, /^FORBIDDEN/);
      expect(r.error!.code).toBe("42501");
      expect(r.data).toBeNull();
    }
    const ms = new Set<string>();
    for (const who of ["ownerB", "plain", "superadmin", "support"] as AccountKey[]) {
      const r = await team(who, S.id);
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      ms.add(r.error!.message);
    }
    ms.add((await team("ownerA", GHOST)).error!.message);
    expect(ms.size).toBe(1);
    expectDenied(await team("anon", S.id), /42501|permission denied/i);
    // team.manage NÃO é delegável: gerente com override continua negado (e o override nem é gravável)
    const ov = await admin().from("membership_permission_overrides").insert({ membership_id: S.members.managerA!, restaurant_id: S.id, permission_key: "team.manage", granted: true });
    if (!ov.error) {
      try {
        expectRule(await team("managerA", S.id), /^FORBIDDEN/);
      } finally {
        await admin().from("membership_permission_overrides").delete().eq("membership_id", S.members.managerA!).eq("permission_key", "team.manage");
      }
    }
  });

  it("linhas: campos, e-mail real só aqui, ordem (dono, gerente, demais), permissões efetivas e overrides", async () => {
    const r = await ok(team("ownerA", S.id));
    const byId = new Map<string, any>(r.rows.map((x: any) => [x.membership_id, x]));
    expect(r.rows.map((x: any) => x.role).slice(0, 2)).toEqual(["owner", "manager"]);
    const own = byId.get(S.members.ownerA!);
    expect(Object.keys(own).sort()).toEqual(["created_at", "email", "full_name", "invited_email", "last_sign_in_at", "membership_id", "overrides", "permissions", "role", "status", "user_id"]);
    expect(own).toMatchObject({ user_id: userId("ownerA"), full_name: "DEMO Dono A", email: "owner.a@example.test", role: "owner", status: "active" });
    // dono: só permissões de gestão (nunca operacionais)
    expect(own.permissions).toEqual(OWNER_PERMS);
    expect(own.permissions).toEqual(rp.owner.slice().sort());
    for (const op of ["orders.create", "orders.accept", "payments.record", "tabs.manage", "tables.operate", "print.request"]) expect(own.permissions).not.toContain(op);
    // gerente: matriz padrão menos o override (menu.manage=false); sem team.manage
    const mgr = byId.get(S.members.managerA!);
    expect(mgr.permissions).toEqual(rp.manager.filter((p) => p !== "menu.manage").sort());
    expect(mgr.permissions).not.toContain("team.manage");
    expect(mgr.overrides).toEqual([{ permission: "menu.manage", granted: false }]);
    // caixa ganha reports.view; garçom perde tabs.manage; cozinha = padrão
    expect(byId.get(S.members.cashierA!).permissions).toEqual([...rp.cashier, "reports.view"].sort());
    expect(byId.get(S.members.waiterA!).permissions).toEqual(rp.waiter.filter((p) => p !== "tabs.manage").sort());
    expect(byId.get(S.members.waiterA!).overrides).toEqual([{ permission: "tabs.manage", granted: false }]);
    expect(byId.get(S.members.kitchenA!).permissions).toEqual(rp.kitchen.slice().sort());
    // efetivas == o que has_permission realmente decide (confere pelas RPCs de verdade)
    expectOk(await as("cashierA").rpc("dashboard_metrics", { p_restaurant: S.id, p_from: "2026-01-01T00:00:00Z", p_to: "2026-01-02T00:00:00Z" }));
    expectRule(await as("waiterA").rpc("dashboard_metrics", { p_restaurant: S.id, p_from: "2026-01-01T00:00:00Z", p_to: "2026-01-02T00:00:00Z" }), /^FORBIDDEN/);
    // convite pendente e revogado: sem permissões efetivas, mesmo com override
    const inv = byId.get(invitedId);
    expect(inv).toMatchObject({ status: "invited", user_id: null, full_name: null, permissions: [], overrides: [], last_sign_in_at: null });
    expect(inv.email).toBe(inv.invited_email);
    const rev = byId.get(revokedId);
    expect(rev).toMatchObject({ status: "revoked", role: "cashier", permissions: [], overrides: [{ permission: "reports.view", granted: true }] });
    expect(r.rows.length).toBe(7);
  });

  it("e-mail de usuário só sai por list_team: nenhuma outra RPC de leitura da Fase 5 o devolve", async () => {
    const dump = JSON.stringify([
      await ok(audit("ownerA", S.id, { p_limit: 200 })),
      await ok(as("ownerA").rpc("dashboard_metrics", { p_restaurant: S.id, p_from: "2026-01-01T00:00:00Z", p_to: "2026-12-01T00:00:00Z" })),
    ]);
    expect(dump).not.toMatch(/owner\.a@example\.test|manager\.a@example\.test|waiter\.a@example\.test/);
  });

  it("owner com override de permissão operacional continua sem permissão efetiva (se o banco aceitar gravar o override)", async () => {
    const a = admin();
    const ins = await a.from("membership_permission_overrides").insert({ membership_id: S.members.ownerA!, restaurant_id: S.id, permission_key: "payments.record", granted: true });
    if (ins.error) {
      expect(ins.error.message).toMatch(/owner|operational|operac|permission/i); // trigger recusa: ótimo
      return;
    }
    try {
      const own = (await ok(team("ownerA", S.id))).rows.find((x: any) => x.membership_id === S.members.ownerA);
      expect(own.permissions).not.toContain("payments.record");
      expectRule(await as("ownerA").rpc("record_payment", { p_tab: GHOST, p_method: "PIX", p_amount_cents: 100 }), /FORBIDDEN|TAB_NOT_FOUND/);
    } finally {
      await a.from("membership_permission_overrides").delete().eq("membership_id", S.members.ownerA!).eq("permission_key", "payments.record");
    }
  });
});

// =====================================================================================================================
describe("list_audit_logs", () => {
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const ids: Record<string, string> = {};
  const bulkIds: { id: string; created_at: string }[] = [];
  const base = Date.parse("2026-05-01T00:00:00Z");

  async function put(row: Record<string, unknown>) {
    const r = await admin().from("audit_logs").insert({ restaurant_id: S.id, resource_type: "zz", ...row }).select("id,created_at").single();
    if (r.error) throw new Error(`audit: ${r.error.message}`);
    return r.data as { id: string; created_at: string };
  }
  const deep = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : { nivel: n, filho: deep(n - 1, leaf) });

  beforeAll(async () => {
    const a = admin();
    ids.sanit = (
      await put({
        action: "zz.t24.sanit",
        actor_id: userId("ownerA"),
        created_at: new Date(base + 10_000_000).toISOString(),
        metadata: {
          keep: "ok",
          count: 5,
          flag: true,
          nulo: null,
          qr_token: "QRSECRET1",
          api_key: "APIKEY1",
          apiKey: "APIKEY2",
          "x-api-key": "APIKEY3",
          password: "SENHA1",
          Password: "SENHA2",
          passwd: "SENHA3",
          pwd: "SENHA4",
          secret: "S1",
          clientSecret: "S2",
          jwt: "J1",
          access_token: "T1",
          refresh_token: "T2",
          Authorization: "Bearer AUTH1",
          cookie: "C1",
          set_cookie: "C2",
          credentials: "CRED1",
          signature: "SIG1",
          private_key: "PK1",
          bearer: "B1",
          nested: { keep: "yes", Authorization: "Bearer X1", deeper: [{ access_token: "T3", keep: 1 }, "plain", [JWT, { secret: "S3", n: 2 }]] },
          note: JWT,
          list: [JWT, "texto normal", 7, null, { token: "T4" }],
          profundo: deep(12, { secret: "SEGREDOPROFUNDO", note: JWT }),
        },
      })
    ).id;
    ids.bearer = (await put({ action: "zz.t24.bearer", metadata: { header_value: `Bearer ${JWT}`, nota: ` ${JWT}` }, created_at: new Date(base + 9_000_000).toISOString() })).id;
    ids.senha = (await put({ action: "zz.t24.senha", metadata: { senha: "MINHASENHA", segredo: "MEUSEGREDO", chave_api: "CHAVE1", ok: 1 }, created_at: new Date(base + 8_000_000).toISOString() })).id;
    // atores
    ids.actOwner = (await put({ action: "zz.t24.actor.owner", actor_id: userId("ownerA"), created_at: new Date(base + 7_000_000).toISOString() })).id;
    ids.actSuper = (await put({ action: "zz.t24.actor.super", actor_id: userId("superadmin"), created_at: new Date(base + 6_900_000).toISOString() })).id;
    ids.actSupport = (await put({ action: "zz.t24.actor.support", actor_id: userId("support"), created_at: new Date(base + 6_800_000).toISOString() })).id;
    ids.actOtherTenant = (await put({ action: "zz.t24.actor.otherTenant", actor_id: userId("ownerB"), created_at: new Date(base + 6_700_000).toISOString() })).id;
    ids.actPlain = (await put({ action: "zz.t24.actor.plain", actor_id: userId("plain"), created_at: new Date(base + 6_600_000).toISOString() })).id;
    ids.actGhost = (await put({ action: "zz.t24.actor.ghost", actor_id: GHOST, created_at: new Date(base + 6_500_000).toISOString() })).id;
    ids.actNull = (await put({ action: "zz.t24.actor.null", actor_id: null, created_at: new Date(base + 6_400_000).toISOString() })).id;
    // prefixos com curingas literais
    ids.pct = (await put({ action: "zz.t24.pct%x", created_at: new Date(base + 6_300_000).toISOString() })).id;
    ids.und = (await put({ action: "zz.t24.u_x", created_at: new Date(base + 6_200_000).toISOString() })).id;
    ids.und2 = (await put({ action: "zz.t24.uzx", created_at: new Date(base + 6_100_000).toISOString() })).id;
    // outro tenant e linha sem restaurante: nunca aparecem em S
    await a.from("audit_logs").insert([
      { restaurant_id: S3.id, action: "zz.t24.sanit", metadata: { marcador: "SO-DO-TENANT-3" }, created_at: new Date(base + 5_000_000).toISOString() },
      { restaurant_id: null, action: "zz.t24.sanit", metadata: { marcador: "SEM-RESTAURANTE" }, created_at: new Date(base + 5_000_001).toISOString() },
    ]);
    // 215 linhas em massa: a cada 5 compartilham o mesmo created_at (desempate por id)
    const batch = Array.from({ length: 215 }, (_, i) => ({
      restaurant_id: S.id,
      action: `zz.t24.bulk.${i % 2 ? "a" : "b"}`,
      resource_type: "zz",
      metadata: { i },
      created_at: new Date(base + Math.floor(i / 5) * 1000).toISOString(),
    }));
    const ins = await a.from("audit_logs").insert(batch).select("id,created_at");
    if (ins.error) throw new Error(ins.error.message);
    bulkIds.push(...(ins.data as any[]));
  }, 120_000);

  const one = async (prefix: string, extra: Record<string, unknown> = {}) => (await ok(audit("ownerA", S.id, { p_action_prefix: prefix, ...extra }))).rows as any[];

  it("só team.manage (dono): gerente e demais papéis => FORBIDDEN; de fora => RESTAURANT_NOT_FOUND idêntico", async () => {
    expect((await one("zz.t24.sanit")).length).toBe(1);
    for (const who of ["managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      const r = await audit(who, S.id);
      expectRule(r, /^FORBIDDEN/);
      expect(r.data).toBeNull();
    }
    const ms = new Set<string>();
    for (const who of ["ownerB", "plain", "superadmin", "support"] as AccountKey[]) {
      const r = await audit(who, S.id);
      expectRule(r, /^RESTAURANT_NOT_FOUND/);
      ms.add(r.error!.message);
    }
    ms.add((await audit("ownerA", GHOST)).error!.message);
    expect(ms.size).toBe(1);
  });

  it("sanitização: remove chaves sensíveis (qualquer profundidade/caixa) e mascara strings em formato de JWT", async () => {
    const [row] = await one("zz.t24.sanit");
    const m = row.metadata;
    expect(m.keep).toBe("ok");
    expect(m.count).toBe(5);
    expect(m.flag).toBe(true);
    expect(m.nulo).toBeNull();
    for (const k of ["qr_token", "api_key", "apiKey", "x-api-key", "password", "Password", "passwd", "pwd", "secret", "clientSecret", "jwt", "access_token", "refresh_token", "Authorization", "cookie", "set_cookie", "credentials", "signature", "private_key", "bearer"]) {
      expect(m, k).not.toHaveProperty(k);
    }
    expect(m.nested.keep).toBe("yes");
    expect(m.nested).not.toHaveProperty("Authorization");
    expect(m.nested.deeper[0]).toEqual({ keep: 1 });
    expect(m.nested.deeper[1]).toBe("plain");
    expect(m.nested.deeper[2]).toEqual(["[removido]", { n: 2 }]);
    expect(m.note).toBe("[removido]");
    expect(m.list).toEqual(["[removido]", "texto normal", 7, null, {}]);
    const text = JSON.stringify(row);
    for (const secret of ["QRSECRET1", "APIKEY", "SENHA1", "SENHA2", "SENHA3", "SENHA4", "AUTH1", "X1", "PK1", "SEGREDOPROFUNDO", "eyJhbGci", "dozjgNry"]) expect(text, secret).not.toContain(secret);
    // aninhamento > 8 níveis é cortado (o segredo do fundo nunca sai)
    expect(JSON.stringify(m.profundo)).toContain("[truncado]");
    // o dado bruto no banco continua intacto (a sanitização é só na leitura)
    const raw = (await admin().from("audit_logs").select("metadata").eq("id", ids.sanit).single()).data!.metadata as any;
    expect(raw.qr_token).toBe("QRSECRET1");
  });

  it("limite documentado: 'Bearer <jwt>' e JWT com espaço antes passam (a regra é ^eyJ...); valores não são inspecionados fora desse padrão", async () => {
    const [row] = await one("zz.t24.bearer");
    // Documentado (F-45, Info): o valor com prefixo "Bearer " não casa com ^eyJ e sai como foi gravado.
    expect(row.metadata.header_value).toBe(`Bearer ${JWT}`);
    expect(row.metadata.nota).toBe(` ${JWT}`);
  });

  it.fails("F-44: chaves em português (senha, segredo, chave_api) deveriam ser removidas como password/secret/api_key (o cabeçalho da 0125 promete 'senha')", async () => {
    const [row] = await one("zz.t24.senha");
    const text = JSON.stringify(row.metadata);
    expect(text).not.toContain("MINHASENHA");
    expect(text).not.toContain("MEUSEGREDO");
    expect(text).not.toContain("CHAVE1");
    expect(row.metadata.ok).toBe(1);
  });

  it("actor_name: nome do membro do PRÓPRIO restaurante; admins de plataforma => 'Plataforma'; membro de outro tenant, sem vínculo, inexistente ou nulo => null", async () => {
    const rowsBy = async (a: string) => (await one(a))[0];
    expect(await rowsBy("zz.t24.actor.owner")).toMatchObject({ actor_id: userId("ownerA"), actor_name: "DEMO Dono A" });
    expect(await rowsBy("zz.t24.actor.super")).toMatchObject({ actor_id: userId("superadmin"), actor_name: "Plataforma" });
    expect(await rowsBy("zz.t24.actor.support")).toMatchObject({ actor_name: "Plataforma" });
    expect(await rowsBy("zz.t24.actor.otherTenant")).toMatchObject({ actor_id: userId("ownerB"), actor_name: null }); // nome de B não vaza para S
    // `plain` tem vínculo REVOGADO neste restaurante (fixture do list_team): o histórico preserva o nome de ex-membros
    expect(await rowsBy("zz.t24.actor.plain")).toMatchObject({ actor_name: "DEMO Usuario Sem Vinculo" });
    expect(await rowsBy("zz.t24.actor.ghost")).toMatchObject({ actor_name: null });
    expect(await rowsBy("zz.t24.actor.null")).toMatchObject({ actor_id: null, actor_name: null });
    const all = JSON.stringify(await one("zz.t24.actor"));
    expect(all).not.toMatch(/DEMO Dono B|owner\.b@|@example\.test/);
  });

  it("isolamento: linhas de outro tenant e sem restaurante nunca aparecem; formato das linhas", async () => {
    const r = await ok(audit("ownerA", S.id, { p_limit: 200 }));
    const text = JSON.stringify(r);
    expect(text).not.toContain("SO-DO-TENANT-3");
    expect(text).not.toContain("SEM-RESTAURANTE");
    expect(r.rows.every((x: any) => Object.keys(x).sort().join() === "action,actor_id,actor_name,created_at,id,metadata,resource_id,resource_type")).toBe(true);
    // S3 (sem equipe) só é legível por quem tem vínculo nele: ninguém aqui
    expectRule(await audit("ownerA", S3.id), /^RESTAURANT_NOT_FOUND/);
    // dono de A lendo auditoria do DEMO A não recebe linhas de S
    const a = await ok(audit("ownerA", world().restaurants.a.id, { p_action_prefix: "zz.t24" }));
    expect(a.rows).toHaveLength(0);
  });

  it("prefixo: filtra por início, é literal para % e _ , vazio = sem filtro, > 64 caracteres => INVALID_PREFIX", async () => {
    expect((await one("zz.t24.pct")).map((x) => x.action)).toEqual(["zz.t24.pct%x"]);
    expect((await one("zz.t24.pct%")).map((x) => x.action)).toEqual(["zz.t24.pct%x"]);
    expect((await one("zz.t24.u_")).map((x) => x.action)).toEqual(["zz.t24.u_x"]); // não casa 'uzx'
    expect((await one("zz.t24.u")).map((x) => x.action).sort()).toEqual(["zz.t24.u_x", "zz.t24.uzx"]);
    expect((await one("%")).length).toBe(0);
    expect((await one("_")).length).toBe(0);
    expect((await one("\\")).length).toBe(0);
    expect((await one("zz.t24.%", { p_limit: 200 })).length).toBe(0);
    expect((await one("  ")).length).toBe(50);
    expect((await one(null as any)).length).toBe(50);
    expect((await one("' or 1=1 --")).length).toBe(0);
    for (const bad of ["a".repeat(65), "zz.".repeat(30)]) {
      const r = await audit("ownerA", S.id, { p_action_prefix: bad });
      expectRule(r, /^INVALID_PREFIX/);
      expect(r.error!.code).toBe("22023");
    }
    expect((await audit("ownerA", S.id, { p_action_prefix: "a".repeat(64) })).error).toBeNull();
  });

  it("período: from>=to => INVALID_PERIOD; só from ou só to filtram; janela semiaberta [from, to)", async () => {
    const f = new Date(base).toISOString();
    expectRule(await audit("ownerA", S.id, { p_from: f, p_to: f }), /^INVALID_PERIOD/);
    expectRule(await audit("ownerA", S.id, { p_from: "2026-06-01T00:00:00Z", p_to: "2026-05-01T00:00:00Z" }), /^INVALID_PERIOD/);
    const w = await one("zz.t24.bulk", { p_limit: 200, p_from: new Date(base + 1000).toISOString(), p_to: new Date(base + 3000).toISOString() });
    // buckets de 5 linhas em base+1000 e base+2000 (to exclusivo)
    expect(w).toHaveLength(10);
    expect(w.every((x) => Date.parse(x.created_at) >= base + 1000 && Date.parse(x.created_at) < base + 3000)).toBe(true);
    expect((await one("zz.t24.bulk", { p_limit: 200, p_to: new Date(base + 1000).toISOString() })).length).toBe(5);
    expect((await one("zz.t24.bulk", { p_limit: 200, p_from: new Date(base + 42_000).toISOString() })).length).toBe(5); // último grupo (i=210..214)
  });

  it("limite: padrão 50, 0/negativo => 1, acima de 200 => 200; paginação keyset (limite 50) percorre as 215 linhas sem repetir, em ordem desc com desempate por id", async () => {
    expect((await one("zz.t24.bulk")).length).toBe(50);
    expect((await one("zz.t24.bulk", { p_limit: null })).length).toBe(50);
    expect((await one("zz.t24.bulk", { p_limit: 0 })).length).toBe(1);
    expect((await one("zz.t24.bulk", { p_limit: -3 })).length).toBe(1);
    expect((await one("zz.t24.bulk", { p_limit: 200 })).length).toBe(200);
    expect((await one("zz.t24.bulk", { p_limit: 100000 })).length).toBe(200);
    const seen: string[] = [];
    let cursor: unknown = null;
    let pages = 0;
    for (;;) {
      const r = await ok(audit("ownerA", S.id, { p_action_prefix: "zz.t24.bulk", p_limit: 50, p_before: cursor }));
      seen.push(...r.rows.map((x: any) => x.id));
      pages += 1;
      if (!r.next_cursor) break;
      expect(r.rows).toHaveLength(50);
      expect(Object.keys(r.next_cursor).sort()).toEqual(["id", "t"]);
      cursor = r.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(215);
    const expected = [...bulkIds].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at) || (x.id < y.id ? 1 : -1)).map((x) => x.id);
    expect(seen).toEqual(expected);
  });
});

// =====================================================================================================================
describe("EXECUTE e helpers internos (app_private)", () => {
  it("helpers app_private não são chamáveis por clientes (nem pelo schema exposto nem por app_private)", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["require_customer_access", { p_rid: S.id }],
      ["parse_cursor", { p_cursor: { t: "2026-01-01T00:00:00Z", id: GHOST } }],
      ["cursor_ts", { p: "2026-01-01T00:00:00Z" }],
      ["like_escape", { p: "%" }],
      ["sanitize_audit_metadata", { p: { secret: "x" }, p_depth: 0 }],
      ["check_period", { p_from: "2026-01-01T00:00:00Z", p_to: "2026-01-02T00:00:00Z", p_max_days: 366 }],
      ["report_tz", { p_rid: S.id }],
      ["require_perm", { p_rid: S.id, p_perm: "reports.view", p_nf: "X" }],
    ];
    for (const who of ["anon", "ownerA"] as Client[]) {
      for (const [fn, args] of calls) {
        const viaPublic = await cl(who).rpc(fn, args);
        expect(viaPublic.error, `${who} public.${fn}`).not.toBeNull();
        expect(viaPublic.data).toBeNull();
        const viaPrivate = await (cl(who) as any).schema("app_private").rpc(fn, args);
        expect(viaPrivate.error, `${who} app_private.${fn}`).not.toBeNull();
        expect(viaPrivate.data).toBeNull();
        expect(viaPrivate.status).toBeLessThan(500);
      }
    }
  });

  describe.skipIf(!dockerAvailable)("catálogo (docker exec psql)", () => {
    const sigs = [
      "public.dashboard_metrics(uuid,timestamptz,timestamptz)",
      "public.restaurant_report(uuid,text,timestamptz,timestamptz,text)",
      "public.list_customers(uuid,text,jsonb,integer)",
      "public.get_customer(uuid,uuid)",
      "public.list_team(uuid)",
      "public.list_audit_logs(uuid,text,timestamptz,timestamptz,integer,jsonb)",
    ];
    it("as 6 RPCs: EXECUTE só authenticated (não anon, não PUBLIC), SECURITY DEFINER com search_path vazio", () => {
      for (const sig of sigs) {
        const q = psql(
          `select has_function_privilege('anon','${sig}','execute')||'|'||has_function_privilege('authenticated','${sig}','execute')||'|'||has_function_privilege('public','${sig}','execute')`,
        );
        expect(q, sig).toEqual(["false|true|false"]);
        const d = psql(`select p.prosecdef::text||'|'||coalesce(array_to_string(p.proconfig,','),'') from pg_proc p where p.oid='${sig}'::regprocedure`);
        expect(d, sig).toEqual(["true|search_path=\"\""]);
      }
    });
    it("nenhuma função de app_private é executável por anon/authenticated/PUBLIC", () => {
      const leaks = psql(
        "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and (has_function_privilege('anon', p.oid,'execute') or has_function_privilege('authenticated', p.oid,'execute') or has_function_privilege('public', p.oid,'execute')) order by 1",
      );
      expect(leaks).toEqual([]);
    });
  });
});
