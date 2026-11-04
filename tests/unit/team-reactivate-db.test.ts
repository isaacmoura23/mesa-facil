import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Equipe (migração 0139) contra um Postgres REAL com as migrações aplicadas: reativar acesso revogado,
 * lista de restaurantes com acesso encerrado e lista da equipe somente leitura. Só roda com TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

async function as(userId: string | null, sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
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
const U = { owner: id(), manager: id(), cashier: id(), waiter: id(), stranger: id() };
const A = id();
const B = id();
let admin: Client;
let waiterMembership = "";
let neverAccepted = "";

suite("equipe: reativar acesso, acesso encerrado e lista somente leitura", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    for (const [name, uid] of Object.entries(U)) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${name}-${uid}@equipe.test`]);
      await admin.query("insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do update set full_name = excluded.full_name", [uid, `Pessoa ${name}`]);
    }
    for (const [rid, slug] of [[A, `equipe-a-${A.slice(0, 6)}`], [B, `equipe-b-${B.slice(0, 6)}`]]) {
      await admin.query("insert into public.restaurants (id, name, slug, status, timezone) values ($1,$2,$3,'active','America/Fortaleza')", [rid, `Rest ${slug}`, slug]);
    }
    for (const [uid, role] of [[U.owner, "owner"], [U.manager, "manager"], [U.cashier, "cashier"]]) {
      await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,$3,'active')", [A, uid, role]);
    }
    waiterMembership = (await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status) values ($1,$2,'waiter','revoked') returning id", [A, U.waiter])).rows[0].id;
    neverAccepted = (await admin.query("insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_email) values ($1,null,'kitchen','revoked','nunca@equipe.test') returning id", [A])).rows[0].id;
    // ajuste de permissão antigo do garçom: não pode voltar na reativação
    await admin.query("insert into public.membership_permission_overrides (restaurant_id, membership_id, permission_key, granted) values ($1,$2,'orders.accept',true)", [A, waiterMembership]);
  });
  afterAll(async () => {
    await admin?.end();
  });

  it("revogado enxerga o restaurante em 'acesso encerrado'; quem nunca teve vínculo não vê nada", async () => {
    const r = await as(U.waiter, "select slug, name from public.my_revoked_restaurants()");
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toMatch(/^Rest equipe-a/);
    expect((await as(U.stranger, "select * from public.my_revoked_restaurants()")).rows).toHaveLength(0);
    expect((await as(U.manager, "select * from public.my_revoked_restaurants()")).rows).toHaveLength(0);
  });

  it("só o dono reativa; gerente, caixa e o próprio revogado não conseguem", async () => {
    for (const uid of [U.manager, U.cashier, U.waiter, U.stranger]) {
      const r = await as(uid, "select public.reactivate_member($1)", [waiterMembership]);
      expect(r.error).toMatch(/forbidden/);
    }
    const still = (await admin.query("select status from public.restaurant_memberships where id = $1", [waiterMembership])).rows[0];
    expect(still.status).toBe("revoked");
  });

  it("convite nunca aceito não tem conta para reativar", async () => {
    expect((await as(U.owner, "select public.reactivate_member($1)", [neverAccepted])).error).toMatch(/no_account/);
  });

  it("dono reativa: volta ativo, mesmo papel, sem os ajustes antigos, com auditoria", async () => {
    const r = await as(U.owner, "select public.reactivate_member($1)", [waiterMembership]);
    expect(r.error).toBeUndefined();
    const m = (await admin.query("select status, role from public.restaurant_memberships where id = $1", [waiterMembership])).rows[0];
    expect(m).toMatchObject({ status: "active", role: "waiter" });
    expect((await admin.query("select count(*)::int n from public.membership_permission_overrides where membership_id = $1", [waiterMembership])).rows[0].n).toBe(0);
    const audit = await admin.query("select 1 from public.audit_logs where restaurant_id = $1 and action = 'member.reactivated' and resource_id = $2", [A, waiterMembership]);
    expect(audit.rowCount).toBe(1);
    // acesso de volta: garçom enxerga o restaurante e já não aparece como encerrado
    expect((await as(U.waiter, "select * from public.my_restaurants()")).rows).toHaveLength(1);
    expect((await as(U.waiter, "select * from public.my_revoked_restaurants()")).rows).toHaveLength(0);
  });

  it("reativar de novo (já ativo) e reativar o dono são recusados", async () => {
    expect((await as(U.owner, "select public.reactivate_member($1)", [waiterMembership])).error).toMatch(/not_revoked/);
    const ownerM = (await admin.query("select id from public.restaurant_memberships where restaurant_id = $1 and role = 'owner'", [A])).rows[0].id;
    expect((await as(U.manager, "select public.reactivate_member($1)", [ownerM])).error).toMatch(/forbidden/);
  });

  it("lista da equipe somente leitura: dono e gerente veem nome e papel (sem e-mail); outros papéis e estranhos não", async () => {
    for (const uid of [U.owner, U.manager]) {
      const r = await as(uid, "select public.list_team_basic($1) as r", [A]);
      expect(r.error).toBeUndefined();
      const rows = r.rows[0].r.rows as Record<string, unknown>[];
      expect(rows.map((x) => x.role)).toEqual(["owner", "manager", "cashier", "waiter"]);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["full_name", "membership_id", "role", "status"]);
        expect(row.status).toBe("active");
      }
    }
    for (const uid of [U.cashier, U.waiter, U.stranger]) {
      expect((await as(uid, "select public.list_team_basic($1)", [A])).error).toMatch(/RESTAURANT_NOT_FOUND/);
    }
    // outro restaurante: o gerente de A não enxerga a equipe de B
    expect((await as(U.manager, "select public.list_team_basic($1)", [B])).error).toMatch(/RESTAURANT_NOT_FOUND/);
  });

  it("o gerente continua sem poder editar a equipe (list_team completo e convites seguem só com o dono)", async () => {
    expect((await as(U.manager, "select public.list_team($1)", [A])).error).toBeTruthy();
    expect((await as(U.manager, "select public.invite_member($1, 'x@equipe.test', 'waiter')", [A])).error).toMatch(/forbidden/);
  });
});
