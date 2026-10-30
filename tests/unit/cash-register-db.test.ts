import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Caixa (migração 0135) contra um Postgres REAL com as migrações aplicadas.
 * Só roda com TEST_DATABASE_URL (superusuário do banco local), por exemplo o do `supabase start`:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run --project unit tests/unit/cash-register-db.test.ts
 * Cria restaurantes/usuários NOVOS a cada execução (os movimentos são imutáveis e não podem ser apagados).
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Result = { rows: Record<string, unknown>[]; error?: string };
// Resposta JSON das RPCs do caixa (campos variam por função; os testes conferem os que importam).
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function run(role: "authenticated" | "anon", userId: string | null, sql: string, params: unknown[] = []): Promise<Result> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    if (userId) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return { rows: r.rows };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return { rows: [], error: (e as Error).message };
  } finally {
    await c.end();
  }
}
const as = (userId: string, sql: string, params: unknown[] = []) => run("authenticated", userId, sql, params);

const id = () => randomUUID();
const U = { owner: id(), manager: id(), manager2: id(), cashier: id(), cashier2: id(), kitchen: id(), waiter: id(), otherOwner: id(), otherManager: id() };
const A = id(); // restaurante principal
const B = id(); // outro restaurante

let admin: Client;
let orderNo = 0;
const key = () => randomUUID();

async function makeOrder(total: number): Promise<string> {
  const oid = id();
  orderNo += 1;
  await admin.query(
    "insert into public.orders (id, restaurant_id, order_number, source, fulfillment_type, subtotal_cents, total_cents) values ($1,$2,$3,'STAFF','PICKUP',$4,$4)",
    [oid, A, orderNo, total],
  );
  return oid;
}
async function pay(userId: string, orderId: string, method: string, amount: number, tendered: number | null) {
  return as(userId, "select public.record_payment(p_order => $1, p_method => $2, p_amount_cents => $3, p_tendered_cents => $4) as r", [orderId, method, amount, tendered]);
}
const rpc = async (userId: string, call: string, params: unknown[]) => {
  const r = await as(userId, `select ${call} as r`, params);
  return { ...r, r: (r.rows[0]?.r ?? null) as Json | null };
};

suite("caixa: turnos, movimentos, retiradas e permissões", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    const emails = Object.entries(U);
    for (const [name, uid] of emails) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${name}-${uid}@caixa.test`]);
      await admin.query("insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name", [uid, `Pessoa ${name}`]);
    }
    for (const [rid, slug] of [[A, `caixa-a-${A.slice(0, 8)}`], [B, `caixa-b-${B.slice(0, 8)}`]]) {
      await admin.query("insert into public.restaurants (id, name, slug, status, timezone) values ($1,$2,$3,'active','America/Fortaleza')", [rid, `Caixa ${slug}`, slug]);
      // restaurant_settings é criada por gatilho junto com o restaurante; garante o estado sem duplicar
      await admin.query("insert into public.restaurant_settings (restaurant_id) values ($1) on conflict do nothing", [rid]);
    }
    const members: [string, string, string][] = [
      [A, U.owner, "owner"], [A, U.manager, "manager"], [A, U.manager2, "manager"], [A, U.cashier, "cashier"],
      [A, U.cashier2, "cashier"], [A, U.kitchen, "kitchen"], [A, U.waiter, "waiter"],
      [B, U.otherOwner, "owner"], [B, U.otherManager, "manager"],
    ];
    for (const [rid, uid, role] of members) {
      await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,$3,'active')", [rid, uid, role]);
    }
  });
  afterAll(async () => {
    await admin?.end();
  });

  const has = async (uid: string, perm: string) =>
    (await as(uid, "select public.has_permission($1, $2) as ok", [A, perm])).rows[0]?.ok === true;

  it("permissões por papel: caixa opera, gerente aprova, dono só vê, cozinha e garçom nada", async () => {
    expect([await has(U.cashier, "cash.view"), await has(U.cashier, "cash.operate"), await has(U.cashier, "cash.approve")]).toEqual([true, true, false]);
    expect([await has(U.manager, "cash.view"), await has(U.manager, "cash.operate"), await has(U.manager, "cash.approve")]).toEqual([true, true, true]);
    expect([await has(U.owner, "cash.view"), await has(U.owner, "cash.operate"), await has(U.owner, "cash.approve")]).toEqual([true, false, false]);
    for (const uid of [U.kitchen, U.waiter]) {
      expect([await has(uid, "cash.view"), await has(uid, "cash.operate"), await has(uid, "cash.approve")]).toEqual([false, false, false]);
    }
  });

  it("quem não tem acesso não lê nada: cozinha, garçom, dono de outro restaurante e anônimo", async () => {
    for (const uid of [U.kitchen, U.waiter, U.otherOwner]) {
      expect((await as(uid, "select count(*)::int as n from public.cash_movements")).rows[0]?.n).toBe(0);
      expect((await rpc(uid, "public.cash_summary($1, now() - interval '1 day', now() + interval '1 day')", [A])).error).toBeTruthy();
    }
    const anon = await run("anon", null, "select count(*)::int as n from public.cash_movements");
    expect(anon.error).toMatch(/permission denied/i);
    const anonRpc = await run("anon", null, "select public.cash_summary($1, now() - interval '1 day', now())", [A]);
    expect(anonRpc.error).toBeTruthy();
  });

  it("clientes não escrevem direto nas tabelas do caixa", async () => {
    for (const sql of [
      "insert into public.cash_movements (restaurant_id, kind, direction, amount_cents, reason) values ($1,'EXPENSE','OUT',100,'x')",
      "update public.cash_movements set amount_cents = 1",
      "delete from public.cash_movements",
      "insert into public.cash_sessions (restaurant_id, opening_cents) values ($1, 0)",
      "insert into public.cash_withdrawal_requests (restaurant_id, amount_cents, reason) values ($1, 100, 'abc')",
    ]) {
      const r = await as(U.manager, sql, sql.includes("$1") ? [A] : []);
      expect(r.error, sql).toMatch(/permission denied/i);
    }
  });

  let sessionId = "";
  it("abre o turno (só quem opera) e não deixa abrir dois", async () => {
    expect((await rpc(U.kitchen, "public.cash_open_session($1, 5000)", [A])).error).toMatch(/not found|encontrado|FORBIDDEN/i);
    expect((await rpc(U.owner, "public.cash_open_session($1, 5000)", [A])).error).toMatch(/FORBIDDEN/);
    expect((await rpc(U.otherManager, "public.cash_open_session($1, 5000)", [A])).error).toMatch(/not found|encontrado|FORBIDDEN/i);
    expect((await rpc(U.cashier, "public.cash_open_session($1, -1)", [A])).error).toMatch(/INVALID_AMOUNT/);
    const ok = await rpc(U.cashier, "public.cash_open_session($1, 5000)", [A]);
    expect(ok.error).toBeUndefined();
    sessionId = String(ok.r?.session_id);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rpc(U.manager, "public.cash_open_session($1, 0)", [A])).error).toMatch(/SESSION_ALREADY_OPEN/);
  });

  it("entrada e saída: valida valor, motivo, tipo e é idempotente", async () => {
    const k1 = key();
    const sup = await rpc(U.cashier, "public.cash_record_movement($1, 'SUPPLY', 2000, 'troco inicial', $2)", [A, k1]);
    expect(sup.r?.movement.kind).toBe("SUPPLY");
    expect(sup.r?.movement.direction).toBe("IN");
    expect(sup.r?.movement.session_id).toBe(sessionId);
    const again = await rpc(U.cashier, "public.cash_record_movement($1, 'SUPPLY', 2000, 'troco inicial', $2)", [A, k1]);
    expect(again.r?.idempotent_replay).toBe(true);
    expect(again.r?.movement.id).toBe(sup.r?.movement.id);
    expect((await rpc(U.cashier, "public.cash_record_movement($1, 'SUPPLY', 2100, 'troco inicial', $2)", [A, k1])).error).toMatch(/IDEMPOTENCY_CONFLICT/);

    expect((await rpc(U.cashier, "public.cash_record_movement($1, 'EXPENSE', 1500, null, null)", [A])).error).toMatch(/REASON_REQUIRED/);
    expect((await rpc(U.cashier, "public.cash_record_movement($1, 'EXPENSE', 0, 'gelo', null)", [A])).error).toMatch(/INVALID_AMOUNT/);
    expect((await rpc(U.cashier, "public.cash_record_movement($1, 'WITHDRAWAL', 100, 'x', null)", [A])).error).toMatch(/INVALID_KIND/);
    expect((await rpc(U.cashier, "public.cash_record_movement($1, 'EXPENSE', 100, 'abc', 'curta')", [A])).error).toMatch(/INVALID_IDEMPOTENCY_KEY/);
    expect((await rpc(U.kitchen, "public.cash_record_movement($1, 'EXPENSE', 100, 'gelo', null)", [A])).error).toBeTruthy();
    const exp = await rpc(U.cashier, "public.cash_record_movement($1, 'EXPENSE', 1500, 'compra de gelo', null)", [A]);
    expect(exp.r?.movement.direction).toBe("OUT");
  });

  it("pagamento em dinheiro vira venda no caixa com valor recebido e troco; Pix não", async () => {
    const o1 = await makeOrder(3790);
    const p1 = await pay(U.cashier, o1, "CASH", 3790, 5000);
    expect(p1.error).toBeUndefined();
    const o2 = await makeOrder(1000);
    expect((await pay(U.cashier, o2, "CASH", 1000, null)).error).toBeUndefined();
    const o3 = await makeOrder(2000);
    expect((await pay(U.cashier, o3, "PIX", 2000, null)).error).toBeUndefined();
    const sales = await admin.query("select * from public.cash_movements where restaurant_id = $1 and kind = 'SALE' order by created_at", [A]);
    expect(sales.rows).toHaveLength(2);
    expect(sales.rows[0]).toMatchObject({ amount_cents: 3790, tendered_cents: 5000, change_cents: 1210, direction: "IN", session_id: sessionId });
    expect(sales.rows[1]).toMatchObject({ amount_cents: 1000, tendered_cents: null, change_cents: null });
    // troco menor que o valor é recusado pelo próprio pagamento (já existia) e nada vira venda
    const o4 = await makeOrder(900);
    expect((await pay(U.cashier, o4, "CASH", 900, 500)).error).toMatch(/INVALID_TENDERED/);
    expect((await admin.query("select count(*)::int n from public.cash_movements where restaurant_id = $1 and kind = 'SALE'", [A])).rows[0]?.n).toBe(2);
  });

  let pendingId = "";
  it("retirada: o caixa pede, só o gerente decide, nunca quem pediu", async () => {
    const req = await rpc(U.cashier, "public.cash_request_withdrawal($1, 3000, 'guardar no cofre', $2)", [A, key()]);
    pendingId = String(req.r?.request_id);
    expect(req.r?.status).toBe("PENDING");
    expect((await rpc(U.cashier, "public.cash_request_withdrawal($1, 100, 'ab', null)", [A])).error).toMatch(/REASON_REQUIRED/);
    expect((await rpc(U.kitchen, "public.cash_request_withdrawal($1, 100, 'abc', null)", [A])).error).toBeTruthy();

    expect((await rpc(U.cashier, "public.cash_decide_withdrawal($1, 'APPROVE', null)", [pendingId])).error).toMatch(/FORBIDDEN/);
    expect((await rpc(U.cashier2, "public.cash_decide_withdrawal($1, 'CANCEL', null)", [pendingId])).error).toMatch(/FORBIDDEN/);
    expect((await rpc(U.otherManager, "public.cash_decide_withdrawal($1, 'APPROVE', null)", [pendingId])).error).toMatch(/not found|encontrado|FORBIDDEN/i);
    expect((await rpc(U.manager, "public.cash_decide_withdrawal($1, 'TALVEZ', null)", [pendingId])).error).toMatch(/INVALID_ACTION/);

    const ok = await rpc(U.manager, "public.cash_decide_withdrawal($1, 'APPROVE', 'ok, pode')", [pendingId]);
    expect(ok.r?.status).toBe("APPROVED");
    const mv = await admin.query("select * from public.cash_movements where id = $1", [ok.r?.movement_id]);
    expect(mv.rows[0]).toMatchObject({ kind: "WITHDRAWAL", direction: "OUT", amount_cents: 3000, session_id: sessionId });
    expect((await rpc(U.manager2, "public.cash_decide_withdrawal($1, 'REJECT', null)", [pendingId])).error).toMatch(/REQUEST_NOT_PENDING/);
  });

  it("gerente não aprova o próprio pedido; outro gerente aprova; recusa e cancelamento funcionam", async () => {
    const own = await rpc(U.manager, "public.cash_request_withdrawal($1, 800, 'compra urgente', null)", [A]);
    expect((await rpc(U.manager, "public.cash_decide_withdrawal($1, 'APPROVE', null)", [own.r?.request_id])).error).toMatch(/SELF_APPROVAL/);
    expect((await rpc(U.manager2, "public.cash_decide_withdrawal($1, 'APPROVE', null)", [own.r?.request_id])).r?.status).toBe("APPROVED");

    const rej = await rpc(U.cashier, "public.cash_request_withdrawal($1, 700, 'outra retirada', null)", [A]);
    expect((await rpc(U.manager, "public.cash_decide_withdrawal($1, 'REJECT', 'sem necessidade')", [rej.r?.request_id])).r?.status).toBe("REJECTED");
    const canc = await rpc(U.cashier, "public.cash_request_withdrawal($1, 600, 'mais uma retirada', null)", [A]);
    expect((await rpc(U.cashier, "public.cash_decide_withdrawal($1, 'CANCEL', null)", [canc.r?.request_id])).r?.status).toBe("CANCELLED");
    const rows = await admin.query("select status, movement_id from public.cash_withdrawal_requests where id = any($1::uuid[]) order by status", [[rej.r?.request_id, canc.r?.request_id]]);
    expect(rows.rows.every((r) => r.movement_id === null)).toBe(true);
  });

  it("retirada direta só para quem aprova; estorno é lançamento contrário e só uma vez", async () => {
    expect((await rpc(U.cashier, "public.cash_withdraw_direct($1, 500, 'sangria', null)", [A])).error).toMatch(/FORBIDDEN/);
    expect((await rpc(U.manager, "public.cash_withdraw_direct($1, 500, 'sangria do dia', $2)", [A, key()])).r?.movement.kind).toBe("WITHDRAWAL");

    const exp = await admin.query("select id from public.cash_movements where restaurant_id = $1 and kind = 'EXPENSE' limit 1", [A]);
    const expId = exp.rows[0]?.id;
    expect((await rpc(U.cashier, "public.cash_reverse_movement($1, 'lançado errado')", [expId])).error).toMatch(/FORBIDDEN/);
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, 'x')", [expId])).error).toMatch(/REASON_REQUIRED/);
    const rev = await rpc(U.manager, "public.cash_reverse_movement($1, 'lançado errado')", [expId]);
    expect(rev.r?.movement).toMatchObject({ kind: "REVERSAL", direction: "IN", amount_cents: 1500, reverses: expId });
    expect((await rpc(U.manager2, "public.cash_reverse_movement($1, 'de novo')", [expId])).error).toMatch(/ALREADY_REVERSED/);
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, 'estornar o estorno')", [rev.r?.movement.id])).error).toMatch(/NOT_REVERSIBLE/);
    const sale = await admin.query("select id from public.cash_movements where restaurant_id = $1 and kind = 'SALE' limit 1", [A]);
    expect((await rpc(U.manager, "public.cash_reverse_movement($1, 'estornar venda')", [sale.rows[0]?.id])).error).toMatch(/NOT_REVERSIBLE/);
  });

  it("movimentos são imutáveis (até para o dono do banco)", async () => {
    await expect(admin.query("update public.cash_movements set amount_cents = amount_cents + 1 where restaurant_id = $1", [A])).rejects.toThrow(/append_only/);
    await expect(admin.query("delete from public.cash_movements where restaurant_id = $1", [A])).rejects.toThrow(/append_only/);
    // truncate já é barrado pela chave estrangeira (estorno aponta para movimento); em qualquer caso falha
    await expect(admin.query("truncate public.cash_movements")).rejects.toThrow();
  });

  it("resumo e histórico batem com os lançamentos, e mostram quem fez", async () => {
    const sum = await rpc(U.owner, "public.cash_summary($1, now() - interval '1 day', now() + interval '1 day')", [A]);
    // entradas: suprimento 2000 + vendas 3790 + 1000 + estorno 1500; saídas: despesa 1500 + retiradas 3000 + 800 + 500
    expect(sum.r?.in_cents).toBe(2000 + 3790 + 1000 + 1500);
    expect(sum.r?.out_cents).toBe(1500 + 3000 + 800 + 500);
    expect(sum.r?.sales_count).toBe(2);
    expect(sum.r?.tendered_cents).toBe(5000);
    expect(sum.r?.change_given_cents).toBe(1210);
    expect(sum.r?.pending_withdrawals).toBe(0);
    const expected = 5000 + (2000 + 3790 + 1000 + 1500) - (1500 + 3000 + 800 + 500);
    expect(sum.r?.open_session?.expected_cents).toBe(expected);

    const list = await rpc(U.manager, "public.cash_list($1, now() - interval '1 day', now() + interval '1 day', null, null, 100, null)", [A]);
    const rows = list.r as unknown as Json[];
    expect(rows.length).toBe(8); // suprimento, despesa, 2 vendas, 3 retiradas, 1 estorno
    expect(rows.find((x) => x.kind === "SALE" && x.change_cents === 1210)?.actor_name).toBe("Pessoa cashier");
    expect(rows.filter((x) => x.reversed).length).toBe(1);
    const onlySales = await rpc(U.manager, "public.cash_list($1, now() - interval '1 day', now() + interval '1 day', 'sale', null, 100, null)", [A]);
    expect((onlySales.r as unknown as unknown[]).length).toBe(2);
    expect((await rpc(U.manager, "public.cash_list($1, now(), now() - interval '1 day', null, null, 100, null)", [A])).error).toMatch(/INVALID_RANGE/);
    expect((await rpc(U.kitchen, "public.cash_list($1, now() - interval '1 day', now() + interval '1 day', null, null, 100, null)", [A])).error).toBeTruthy();
    expect((await rpc(U.otherManager, "public.cash_summary($1, now() - interval '1 day', now() + interval '1 day')", [A])).error).toBeTruthy();
  });

  it("fecha o turno com a contagem; mostra a diferença; não fecha duas vezes; depois do fechamento nada entra nele", async () => {
    const expected = 5000 + (2000 + 3790 + 1000 + 1500) - (1500 + 3000 + 800 + 500);
    expect((await rpc(U.kitchen, "public.cash_close_session($1, 100, null)", [sessionId])).error).toBeTruthy();
    expect((await rpc(U.cashier, "public.cash_close_session($1, -5, null)", [sessionId])).error).toMatch(/INVALID_AMOUNT/);
    const close = await rpc(U.cashier, "public.cash_close_session($1, $2, 'faltou troco miúdo')", [sessionId, expected - 90]);
    expect(close.r).toMatchObject({ expected_cents: expected, counted_cents: expected - 90, difference_cents: -90 });
    expect((await rpc(U.cashier, "public.cash_close_session($1, 100, null)", [sessionId])).error).toMatch(/SESSION_NOT_OPEN/);
    await expect(admin.query("update public.cash_sessions set notes = 'mexido' where id = $1", [sessionId])).rejects.toThrow(/immutable/);
    // sem turno aberto o dinheiro continua entrando (turno é opcional)
    const o = await makeOrder(500);
    expect((await pay(U.cashier, o, "CASH", 500, 1000)).error).toBeUndefined();
    const last = await admin.query("select session_id from public.cash_movements where restaurant_id = $1 and kind = 'SALE' order by created_at desc limit 1", [A]);
    expect(last.rows[0]?.session_id).toBeNull();
    const supply = await rpc(U.cashier, "public.cash_record_movement($1, 'SUPPLY', 100, null, null)", [A]);
    expect(supply.r?.movement.session_id).toBeNull();
    const sessions = await rpc(U.manager, "public.cash_list_sessions($1, 10)", [A]);
    expect((sessions.r as unknown as Json[])[0]).toMatchObject({ status: "CLOSED", difference_cents: -90, opened_by_name: "Pessoa cashier" });
  });

  it("pedidos de retirada pendentes aparecem para quem vê, com nomes; outro restaurante não vê", async () => {
    const r = await rpc(U.cashier, "public.cash_request_withdrawal($1, 1200, 'depósito no banco', null)", [A]);
    const pend = await rpc(U.owner, "public.cash_list_requests($1, 'PENDING', 50)", [A]);
    const list = pend.r as unknown as Json[];
    expect(list.map((x) => x.id)).toContain(r.r?.request_id);
    expect(list[0]?.requested_by_name).toBe("Pessoa cashier");
    expect((await rpc(U.otherOwner, "public.cash_list_requests($1, 'PENDING', 50)", [A])).error).toBeTruthy();
    expect((await rpc(U.kitchen, "public.cash_list_requests($1, 'PENDING', 50)", [A])).error).toBeTruthy();
    expect((await rpc(U.manager, "public.cash_list_requests($1, 'xx', 50)", [A])).error).toMatch(/INVALID_STATUS/);
  });

  it("restaurantes isolados: o outro restaurante tem caixa próprio e vazio", async () => {
    const open = await rpc(U.otherManager, "public.cash_open_session($1, 100)", [B]);
    expect(open.error).toBeUndefined();
    const sum = await rpc(U.otherOwner, "public.cash_summary($1, now() - interval '1 day', now() + interval '1 day')", [B]);
    expect(sum.r?.in_cents).toBe(0);
    expect(sum.r?.open_session?.opening_cents).toBe(100);
  });
});
