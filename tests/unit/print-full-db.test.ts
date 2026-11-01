import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Comanda completa (migração 0138) contra um Postgres REAL com as migrações aplicadas.
 * Só roda com TEST_DATABASE_URL. Cria dados NOVOS a cada execução.
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
let orderId = "";
let publicCode = "";

const print = async (uid: string, type: string) => {
  const r = await as(uid, "select public.request_print($1, $2) as r", [orderId, type]);
  return { error: r.error, payload: (r.rows[0]?.r?.payload ?? null) as Json | null };
};

suite("comanda completa: dados do cupom de entrega e pagamento real", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    for (const [name, uid] of Object.entries(U)) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${name}-${uid}@comanda.test`]);
      await admin.query("insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name", [uid, `Pessoa ${name}`]);
    }
    await admin.query("insert into public.restaurants (id, name, slug, status, timezone) values ($1,'Comanda Teste',$2,'active','America/Fortaleza')", [A, `comanda-${A.slice(0, 8)}`]);
    await admin.query("insert into public.restaurant_settings (restaurant_id) values ($1) on conflict do nothing", [A]);
    for (const [uid, role] of [[U.owner, "owner"], [U.manager, "manager"], [U.cashier, "cashier"], [U.kitchen, "kitchen"], [U.waiter, "waiter"]]) {
      await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,$3,'active')", [A, uid, role]);
    }
    await admin.query("insert into public.products (id, restaurant_id, name, price_cents) values ($1,$2,'Bolo Trufado',3500)", [P, A]);
    const sale = await as(U.cashier, "select public.create_counter_sale($1, $2::jsonb, $3, null, $4) as r", [
      A, JSON.stringify([{ product_id: P, variant_id: null, quantity: 1, modifier_ids: [] }]), 5000, `comanda-${id()}`,
    ]);
    expect(sale.error).toBeUndefined();
    orderId = sale.rows[0].r.order.id;
    // Cliente identificado (como num pedido do cardápio): nome e telefone ficam no pedido.
    await admin.query("update public.orders set customer_name = 'Maria da Silva', customer_phone = '85994084103' where id = $1", [orderId]);
    publicCode = (await admin.query("select public_code from public.orders where id = $1", [orderId])).rows[0].public_code;
  });
  afterAll(async () => {
    await admin?.end();
  });

  it("caixa imprime a comanda completa com cliente, telefone, código, prazo, aceite e pagamento real", async () => {
    const r = await print(U.cashier, "ORDER_FULL");
    expect(r.error).toBeUndefined();
    const p = r.payload!;
    expect(p).toMatchObject({
      document_type: "ORDER_FULL",
      customer_name: "Maria da Silva",
      customer_phone: "85994084103",
      public_code: publicCode,
      subtotal_cents: 3500,
      total_cents: 3500,
      payment_status: "PAID",
    });
    expect(p.estimated_ready_at_local).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(p.confirmed_at_local).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(p.payments).toEqual([
      expect.objectContaining({ method: "CASH", amount_cents: 3500, tendered_cents: 5000, change_cents: 1500 }),
    ]);
    expect(p.items[0]).toMatchObject({ name: "Bolo Trufado", quantity: 1, line_total_cents: 3500 });
  });

  it("gerente também; cozinha, garçom e dono não (precisa de payments.record)", async () => {
    expect((await print(U.manager, "ORDER_FULL")).error).toBeUndefined();
    for (const uid of [U.kitchen, U.waiter]) {
      expect((await print(uid, "ORDER_FULL")).error).toMatch(/FORBIDDEN/);
    }
    expect((await print(U.owner, "ORDER_FULL")).error).toBeTruthy();
  });

  it("a comanda de preparo continua sem preço, sem telefone e sem pagamento (e só com o primeiro nome)", async () => {
    for (const uid of [U.cashier, U.kitchen]) {
      const r = await print(uid, "KITCHEN_TICKET");
      expect(r.error).toBeUndefined();
      const keys = Object.keys(r.payload!);
      for (const k of ["customer_phone", "public_code", "payments", "total_cents", "subtotal_cents", "customer_name", "delivery_address"]) {
        expect(keys, `${uid} ${k}`).not.toContain(k);
      }
    }
    expect((await print(U.kitchen, "KITCHEN_TICKET")).payload).toMatchObject({ customer_first_name: "Maria" });
  });

  it("o recibo antigo não ganhou os dados novos; tipo inválido é recusado", async () => {
    const rec = await print(U.cashier, "ORDER_RECEIPT");
    expect(rec.error).toBeUndefined();
    expect(Object.keys(rec.payload!)).not.toContain("customer_phone");
    expect(Object.keys(rec.payload!)).not.toContain("payments");
    expect((await print(U.cashier, "PARTIAL_BILL")).error).toMatch(/INVALID_DOCUMENT_TYPE/);
  });

  it("pagamento recusado ou pendente não aparece como pago", async () => {
    await admin.query(
      "insert into public.payments (restaurant_id, order_id, method, amount_cents, status, provider, recorded_by) values ($1,$2,'PIX',100,'PENDING','MANUAL',$3)",
      [A, orderId, U.cashier],
    );
    const p = (await print(U.cashier, "ORDER_FULL")).payload!;
    expect(p.payments).toHaveLength(1);
    expect(p.payments[0].method).toBe("CASH");
  });
});
