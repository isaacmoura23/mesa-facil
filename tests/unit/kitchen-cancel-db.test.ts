import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Cozinha cancela o preparo + estorno da venda de pedido cancelado (migração 0137) contra um Postgres REAL
 * com as migrações aplicadas. Só roda com TEST_DATABASE_URL. Cria dados NOVOS a cada execução.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Resposta JSON das RPCs (campos conferidos caso a caso).
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function as(userId: string, sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return { rows: r.rows, error: undefined as string | undefined };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return { rows: [], error: (e as Error).message };
  } finally {
    await c.end();
  }
}

const id = () => randomUUID();
const U = { owner: id(), manager: id(), cashier: id(), kitchen: id(), waiter: id() };
const A = id();
const P = id();
let admin: Client;

const rpc = async (uid: string, call: string, params: unknown[]) => {
  const r = await as(uid, `select ${call} as r`, params);
  return { error: r.error, r: (r.rows[0]?.r ?? null) as Json | null };
};
const sell = async (qty: number, tendered: number) => {
  const r = await rpc(U.cashier, "public.create_counter_sale($1, $2::jsonb, $3, null, $4)", [
    A,
    JSON.stringify([{ product_id: P, variant_id: null, quantity: qty, modifier_ids: [] }]),
    tendered,
    `cancel-${id()}`,
  ]);
  expect(r.error).toBeUndefined();
  return { orderId: r.r!.order.id as string, paymentId: r.r!.payment.id as string, total: r.r!.order.total_cents as number };
};
const range = ["now() - interval '1 day'", "now() + interval '1 day'"];
const summary = async (uid: string) => (await rpc(uid, `public.cash_summary($1, ${range[0]}, ${range[1]})`, [A])).r!;
const movement = async (uid: string, paymentId: string) => {
  const list = (await rpc(uid, `public.cash_list($1, ${range[0]}, ${range[1]})`, [A])).r as unknown as Json[];
  return list.find((m) => m.payment_id === paymentId)!;
};

suite("cozinha cancela o preparo; venda de pedido cancelado é estornada pelo gerente", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    for (const [name, uid] of Object.entries(U)) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${name}-${uid}@cozinha.test`]);
      await admin.query("insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name", [uid, `Pessoa ${name}`]);
    }
    await admin.query("insert into public.restaurants (id, name, slug, status, timezone) values ($1,'Cozinha Cancela',$2,'active','America/Fortaleza')", [A, `cozinha-${A.slice(0, 8)}`]);
    await admin.query("insert into public.restaurant_settings (restaurant_id) values ($1) on conflict do nothing", [A]);
    for (const [uid, role] of [[U.owner, "owner"], [U.manager, "manager"], [U.cashier, "cashier"], [U.kitchen, "kitchen"], [U.waiter, "waiter"]]) {
      await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,$3,'active')", [A, uid, role]);
    }
    await admin.query("insert into public.products (id, restaurant_id, name, price_cents) values ($1,$2,'Bolo',3500)", [P, A]);
  });
  afterAll(async () => {
    await admin?.end();
  });

  const has = async (uid: string, perm: string) => (await as(uid, "select public.has_permission($1, $2) as ok", [A, perm])).rows[0]?.ok === true;
  const cancel = (uid: string, orderId: string, reason: string | null) => rpc(uid, "public.transition_order_status($1, 'CANCELLED', $2)", [orderId, reason]);

  it("só a cozinha ganhou a permissão nova: caixa e garçom continuam sem cancelar; dono nunca", async () => {
    expect(await has(U.kitchen, "orders.cancel")).toBe(true);
    expect(await has(U.manager, "orders.cancel")).toBe(true);
    for (const uid of [U.cashier, U.waiter, U.owner]) expect(await has(uid, "orders.cancel")).toBe(false);
  });

  let venda: { orderId: string; paymentId: string; total: number };
  it("cozinha cancela o pedido pago com motivo (obrigatório); quem não pode, não consegue", async () => {
    const open = await rpc(U.cashier, "public.cash_open_session($1, 5000)", [A]);
    expect(open.error).toBeUndefined();
    venda = await sell(2, 10000);
    expect(venda.total).toBe(7000);

    expect((await cancel(U.kitchen, venda.orderId, null)).error).toMatch(/REASON_REQUIRED/);
    expect((await cancel(U.kitchen, venda.orderId, "   ")).error).toMatch(/REASON_REQUIRED/);
    expect((await cancel(U.cashier, venda.orderId, "caixa tentou")).error).toMatch(/FORBIDDEN/);
    expect((await cancel(U.waiter, venda.orderId, "garçom tentou")).error).toMatch(/FORBIDDEN/);

    const ok = await cancel(U.kitchen, venda.orderId, "Falta de ingrediente");
    expect(ok.error).toBeUndefined();
    const row = (await admin.query("select status, status_reason, payment_status from public.orders where id = $1", [venda.orderId])).rows[0];
    expect(row).toMatchObject({ status: "CANCELLED", status_reason: "Falta de ingrediente", payment_status: "PAID" });
  });

  it("o dinheiro NÃO sai sozinho: a venda continua na gaveta e aparece como 'estornar'", async () => {
    const s = await summary(U.manager);
    expect(s.open_session.expected_cents).toBe(5000 + 7000);
    expect(s.pending_refunds).toEqual({ count: 1, amount_cents: 7000 });
    const m = await movement(U.cashier, venda.paymentId);
    expect(m).toMatchObject({ kind: "SALE", reversed: false, pending_refund: true });
  });

  it("só o gerente estorna; caixa e cozinha não; venda de pedido ativo não é estornável", async () => {
    for (const uid of [U.cashier, U.kitchen]) {
      expect((await rpc(uid, "public.cash_reverse_movement($1, 'devolução')", [(await movement(U.manager, venda.paymentId)).id])).error).toBeTruthy();
    }
    const ativa = await sell(1, 5000);
    const mAtiva = await movement(U.manager, ativa.paymentId);
    expect(mAtiva.pending_refund).toBe(false);
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, 'não deveria')", [mAtiva.id])).error).toMatch(/NOT_REVERSIBLE/);
  });

  it("gerente estorna a venda do pedido cancelado: sai da gaveta, some da pendência, e não estorna duas vezes", async () => {
    const m = await movement(U.manager, venda.paymentId);
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, '')", [m.id])).error).toMatch(/REASON_REQUIRED/);
    const ok = await rpc(U.manager, "public.cash_reverse_movement($1, 'Pedido cancelado pela cozinha')", [m.id]);
    expect(ok.error).toBeUndefined();
    expect(ok.r!.movement).toMatchObject({ kind: "REVERSAL", direction: "OUT", amount_cents: 7000 });

    const s = await summary(U.manager);
    expect(s.pending_refunds).toEqual({ count: 0, amount_cents: 0 });
    // abertura 5000 + venda cancelada (7000 entra e 7000 sai) + venda ativa (3500)
    expect(s.open_session.expected_cents).toBe(5000 + 3500);
    expect(await movement(U.manager, venda.paymentId)).toMatchObject({ reversed: true, pending_refund: false });
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, 'de novo')", [m.id])).error).toMatch(/ALREADY_REVERSED/);
  });

  it("os dados do estorno ficam na auditoria e quem cancelou é o usuário da cozinha", async () => {
    const aud = await admin.query("select action from public.audit_logs where restaurant_id = $1 and action = 'cash.reversed'", [A]);
    expect(aud.rowCount).toBe(1);
    const hist = await admin.query("select changed_by from public.order_status_history where order_id = $1 and to_status = 'CANCELLED'", [venda.orderId]);
    expect(hist.rows[0]?.changed_by).toBe(U.kitchen);
  });
});
