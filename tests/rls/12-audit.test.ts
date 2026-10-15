/**
 * audit_logs: append-only (nem update/delete, nem pelo service role) e não escrevível por clientes;
 * leitura restrita a team.manage do restaurante e à plataforma.
 */
import { describe, expect, it } from "vitest";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectOk, expectRule, rows } from "../helpers/expect";
import { uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;

const ALL_USERS = ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA", "ownerB", "plain", "support", "superadmin"] as const;

async function anyAuditRow(rid: string) {
  const r = await admin().from("audit_logs").select("*").eq("restaurant_id", rid).limit(1).single();
  expect(r.error, "o seed/testes anteriores deveriam ter gerado auditoria").toBeNull();
  return r.data!;
}

describe("escrita em audit_logs", () => {
  it("nenhum cliente (nenhum papel, nem plataforma, nem anon) insere, altera ou apaga", async () => {
    const row = await anyAuditRow(A().id);
    for (const who of ALL_USERS) {
      expectDenied(await as(who).from("audit_logs").insert({ restaurant_id: A().id, actor_id: world().users[who].id, action: "forged.by.client" }).select("id"));
      expectDenied(await as(who).from("audit_logs").update({ action: "tampered" }).eq("id", row.id).select("id"));
      expectDenied(await as(who).from("audit_logs").delete().eq("id", row.id).select("id"));
      expectDenied(await as(who).from("audit_logs").delete().eq("restaurant_id", A().id).select("id"));
    }
    expectDenied(await anon().from("audit_logs").insert({ action: "forged.by.anon" }).select("id"));
    expectDenied(await anon().from("audit_logs").delete().eq("id", row.id).select("id"));
    expect((await admin().from("audit_logs").select("*").eq("id", row.id).single()).data).toEqual(row);
    expect(rows(await admin().from("audit_logs").select("id").in("action", ["forged.by.client", "forged.by.anon", "tampered"]))).toHaveLength(0);
  });

  it("append-only no próprio banco: update/delete falham até para o service role", async () => {
    const row = await anyAuditRow(A().id);
    expectRule(await admin().from("audit_logs").update({ action: "tampered" }).eq("id", row.id), /audit_logs_are_append_only/);
    expectRule(await admin().from("audit_logs").update({ metadata: { x: 1 } }).eq("restaurant_id", A().id), /audit_logs_are_append_only/);
    expectRule(await admin().from("audit_logs").delete().eq("id", row.id), /audit_logs_are_append_only/);
    expectRule(await admin().from("audit_logs").delete().eq("restaurant_id", A().id), /audit_logs_are_append_only/);
    expect((await admin().from("audit_logs").select("*").eq("id", row.id).single()).data).toEqual(row);
  });

  it("log_audit (único ponto de escrita) não é executável por nenhum cliente", async () => {
    for (const who of ALL_USERS) {
      const r = await as(who).rpc("log_audit", { p_restaurant: A().id, p_action: "forged.via.rpc" });
      expect(r.error, `${who} chamou log_audit`).not.toBeNull();
      expect(`${r.error!.code} ${r.error!.message}`).toMatch(/42501|permission denied|PGRST202/i);
    }
    expect(rows(await admin().from("audit_logs").select("id").eq("action", "forged.via.rpc"))).toHaveLength(0);
  });

  it("a auditoria sobrevive à remoção do restaurante (sem FK/cascade)", async () => {
    const slug = `zz-audit-${uniq()}`.slice(0, 40);
    const ins = await admin().from("restaurants").insert({ name: "zz DEMO Auditoria", slug, status: "pending" }).select("id").single();
    expectOk(ins);
    const rid = ins.data!.id as string;
    expectOk(await admin().from("restaurants").update({ status: "active" }).eq("id", rid));
    expect(rows(await admin().from("audit_logs").select("id").eq("restaurant_id", rid).eq("action", "restaurant.updated_by_platform"))).toHaveLength(1);
    expectOk(await admin().from("restaurants").delete().eq("id", rid));
    expect(rows(await admin().from("audit_logs").select("id").eq("restaurant_id", rid))).toHaveLength(1);
  });
});

describe("leitura de audit_logs", () => {
  it("dono vê só a auditoria do próprio restaurante; demais papéis e usuários comuns não veem nada", async () => {
    const mineA = await as("ownerA").from("audit_logs").select("restaurant_id");
    expectOk(mineA);
    expect(rows(mineA).length).toBeGreaterThan(0);
    expect(rows(mineA).every((r) => r.restaurant_id === A().id)).toBe(true);
    const mineB = await as("ownerB").from("audit_logs").select("restaurant_id");
    expect(rows(mineB).length).toBeGreaterThan(0);
    expect(rows(mineB).every((r) => r.restaurant_id === B().id)).toBe(true);

    for (const who of ["managerA", "cashierA", "kitchenA", "waiterA", "plain", "managerB"] as const) {
      expectNoRows(await as(who).from("audit_logs").select("id"));
    }
    expectNoRows(await anon().from("audit_logs").select("id"));
  });

  // F-10 (corrigido na mig. 111): 'support' não lê auditoria sem sessão de suporte ativa; superadmin lê tudo.
  it("superadmin lê a auditoria de todos os restaurantes; 'support' não lê nada sem sessão de suporte", async () => {
    // audit_logs só cresce (append-only) e o PostgREST limita a 1000 linhas por resposta: consulta cada restaurante com limit(1)
    // em vez de um IN() sem ordem, que podia devolver só linhas de um deles quando a tabela passa de 1000.
    for (const rid of [A().id, B().id]) {
      const r = await as("superadmin").from("audit_logs").select("restaurant_id").eq("restaurant_id", rid).limit(1);
      expectOk(r);
      expect(rows(r), `superadmin não lê a auditoria de ${rid}`).toHaveLength(1);
    }
    expectNoRows(await as("support").from("audit_logs").select("id").in("restaurant_id", [A().id, B().id]));
  });
});
