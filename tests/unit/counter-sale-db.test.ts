import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Venda de balcão (migração 0136) contra um Postgres REAL com as migrações aplicadas.
 * Só roda com TEST_DATABASE_URL (superusuário do banco local). Cria dados NOVOS a cada execução.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Resposta JSON da RPC (campos conferidos caso a caso).
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function as(userId: string | null, sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${userId ? "authenticated" : "anon"}`);
    if (userId) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
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
const U = { owner: id(), manager: id(), cashier: id(), kitchen: id(), waiter: id(), other: id() };
const A = id();
const B = id();
const P = { coxinha: id(), suco: id(), inativo: id(), outro: id() };

let admin: Client;

const sale = async (uid: string | null, items: unknown, tendered: number | null, key: string | null = null, rid = A) => {
  const r = await as(uid, "select public.create_counter_sale($1, $2::jsonb, $3, null, $4) as r", [rid, JSON.stringify(items), tendered, key]);
  return { ...r, r: (r.rows[0]?.r ?? null) as Json | null };
};
const line = (productId: string, quantity: number) => ({ product_id: productId, variant_id: null, quantity, modifier_ids: [] });

suite("venda de balcão: pedido + pagamento em dinheiro numa transação", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    for (const [name, uid] of Object.entries(U)) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${name}-${uid}@balcao.test`]);
      await admin.query("insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name", [uid, `Pessoa ${name}`]);
    }
    for (const [rid, slug] of [[A, `balcao-a-${A.slice(0, 8)}`], [B, `balcao-b-${B.slice(0, 8)}`]]) {
      await admin.query("insert into public.restaurants (id, name, slug, status, timezone) values ($1,$2,$3,'active','America/Fortaleza')", [rid, `Balcão ${slug}`, slug]);
      await admin.query("insert into public.restaurant_settings (restaurant_id) values ($1) on conflict do nothing", [rid]);
    }
    const members: [string, string, string][] = [
      [A, U.owner, "owner"], [A, U.manager, "manager"], [A, U.cashier, "cashier"], [A, U.kitchen, "kitchen"], [A, U.waiter, "waiter"],
      [B, U.other, "owner"],
    ];
    for (const [rid, uid, role] of members) {
      await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,$3,'active')", [rid, uid, role]);
    }
    await admin.query("insert into public.products (id, restaurant_id, name, price_cents) values ($1,$2,'Coxinha',700), ($3,$2,'Suco',500)", [P.coxinha, A, P.suco]);
    await admin.query("insert into public.products (id, restaurant_id, name, price_cents, is_active) values ($1,$2,'Antigo',900,false)", [P.inativo, A]);
    await admin.query("insert into public.products (id, restaurant_id, name, price_cents) values ($1,$2,'Do outro',100)", [P.outro, B]);
  });
  afterAll(async () => {
    await admin?.end();
  });

  it("cria pedido CONFIRMED pago, com preço do servidor e troco", async () => {
    const r = await sale(U.cashier, [line(P.coxinha, 2), line(P.suco, 1)], 2000);
    expect(r.error).toBeUndefined();
    expect(r.r?.ok).toBe(true);
    expect(r.r?.order.total_cents).toBe(1900);
    expect(r.r?.order.status).toBe("CONFIRMED");
    expect(r.r?.order.payment_status).toBe("PAID");
    expect(r.r?.change_cents).toBe(100);
    const mv = await admin.query("select kind, direction, amount_cents, tendered_cents, change_cents from public.cash_movements where payment_id = $1", [r.r?.payment.id]);
    expect(mv.rows).toEqual([{ kind: "SALE", direction: "IN", amount_cents: 1900, tendered_cents: 2000, change_cents: 100 }]);
  });

  it("valor recebido vazio = valor exato (sem troco)", async () => {
    const r = await sale(U.manager, [line(P.suco, 3)], null);
    expect(r.r?.order.total_cents).toBe(1500);
    expect(r.r?.change_cents).toBe(0);
  });

  it("recusa valor recebido menor que o total e não grava nada", async () => {
    const before = (await admin.query("select count(*)::int n from public.orders where restaurant_id = $1", [A])).rows[0].n;
    const r = await sale(U.cashier, [line(P.coxinha, 1)], 600);
    expect(r.error).toMatch(/INVALID_TENDERED/);
    expect((await admin.query("select count(*)::int n from public.orders where restaurant_id = $1", [A])).rows[0].n).toBe(before);
  });

  it("itens inválidos (inativo, de outro restaurante, vazio) voltam ok:false e não gravam", async () => {
    for (const items of [[line(P.inativo, 1)], [line(P.outro, 1)], []]) {
      const r = await sale(U.cashier, items, 5000);
      expect(r.error ?? r.r?.ok === false).toBeTruthy();
      if (!r.error) expect(r.r?.ok).toBe(false);
    }
  });

  it("só gerente e caixa vendem; dono, cozinha, garçom, outro restaurante e anônimo não", async () => {
    for (const uid of [U.owner, U.kitchen, U.waiter, U.other]) {
      const r = await sale(uid, [line(P.coxinha, 1)], 1000);
      expect(r.error, uid).toMatch(/FORBIDDEN|encontrado|NOT_FOUND/i);
    }
    const anon = await sale(null, [line(P.coxinha, 1)], 1000);
    expect(anon.error).toMatch(/permission denied/i);
  });

  it("idempotente: repetir a chave devolve o mesmo pedido e um único pagamento", async () => {
    const key = `balcao-${id()}`;
    const a = await sale(U.cashier, [line(P.coxinha, 1)], 1000, key);
    const b = await sale(U.cashier, [line(P.coxinha, 1)], 1000, key);
    expect(a.r?.idempotent_replay).toBe(false);
    expect(b.r?.idempotent_replay).toBe(true);
    expect(b.r?.order.id).toBe(a.r?.order.id);
    expect(b.r?.change_cents).toBe(300);
    const n = (await admin.query("select count(*)::int n from public.payments where order_id = $1", [a.r?.order.id])).rows[0].n;
    expect(n).toBe(1);
    expect((await sale(U.cashier, [line(P.coxinha, 1)], 1000, "curta")).error).toMatch(/INVALID_IDEMPOTENCY_KEY/);
  });

  it("a venda aparece na cozinha (CONFIRMED) e usa o turno aberto", async () => {
    const open = await as(U.cashier, "select public.cash_open_session($1, 1000) as r", [A]);
    expect(open.error).toBeUndefined();
    const r = await sale(U.cashier, [line(P.coxinha, 1)], 1000);
    const m = await admin.query("select session_id from public.cash_movements where payment_id = $1", [r.r?.payment.id]);
    expect(m.rows[0].session_id).toBe(open.rows[0].r.session_id);
    const seen = await as(U.kitchen, "select status from public.orders where id = $1", [r.r?.order.id]);
    expect(seen.rows[0]?.status).toBe("CONFIRMED");
  });
});
