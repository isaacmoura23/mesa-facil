/**
 * Cadastro público (signUp) e tickets de suporte.
 *  - metadados enviados no signUp (role/is_admin/platform_role) NÃO viram poder algum;
 *  - convite por e-mail só vale para e-mail confirmado (risco de pré-cadastro quando a confirmação está desligada);
 *  - support_tickets: membro abre para o próprio restaurante, não para outro; só a plataforma muda o status.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv, projectRoot } from "../../scripts/lib/env";
import { TEST_PASSWORD } from "../fixtures/accounts";
import { admin, as, withToken, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

function emailConfirmationsEnabled(): boolean {
  const cfg = path.join(projectRoot(), "supabase", "config.toml");
  if (!existsSync(cfg)) return true;
  const toml = readFileSync(cfg, "utf8");
  const section = /\[auth\.email\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
  return !/^\s*enable_confirmations\s*=\s*false/m.test(section);
}

describe("signUp público não concede poder", () => {
  it("user_metadata hostil (role/is_admin/platform_role) não altera o JWT nem a autorização", async () => {
    const env = loadEnv();
    const c = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `zz-signup-${uniq()}@example.test`;
    const su = await c.auth.signUp({
      email,
      password: TEST_PASSWORD,
      options: { data: { role: "service_role", is_admin: true, platform_role: "superadmin", is_platform_admin: true, full_name: "zz DEMO Hostil" } },
    });
    expect(su.error).toBeNull();
    if (su.data.user) cleanup.add(async () => void (await admin().auth.admin.deleteUser(su.data.user!.id)));
    if (!su.data.session) return; // confirmação de e-mail ligada: sem sessão, nada a testar além disso

    const claims = JSON.parse(Buffer.from(su.data.session.access_token.split(".")[1], "base64url").toString());
    expect(claims.role).toBe("authenticated");
    expect(claims.app_metadata?.platform_role).toBeUndefined();

    const me = withToken(su.data.session.access_token);
    expect((await me.rpc("is_platform_admin")).data).toBe(false);
    expect((await me.rpc("is_platform_superadmin")).data).toBe(false);
    expectRule(await me.rpc("create_restaurant", { p_name: "zz hostil", p_slug: `zz-${uniq()}`, p_owner_id: su.data.user!.id }), /forbidden/);
    expectRule(await me.rpc("open_support_session", { p_restaurant: A().id, p_reason: "tentativa com metadata hostil" }), /forbidden/);
    expectNoRows(await me.from("orders").select("id"));
    expectNoRows(await me.from("restaurant_memberships").select("id"));
    expect(rows(await admin().from("platform_admins").select("user_id").eq("user_id", su.data.user!.id))).toHaveLength(0);
    // o profile nasce só com o nome (campo de exibição), sem outros campos
    const prof = await admin().from("profiles").select("full_name,phone,avatar_url").eq("id", su.data.user!.id).single();
    expect(prof.data).toEqual({ full_name: "zz DEMO Hostil", phone: null, avatar_url: null });
  });

  it("convite por e-mail: depende de e-mail CONFIRMADO (config.toml: enable_confirmations)", async () => {
    const env = loadEnv();
    const victim = `zz-victim-${uniq()}@example.test`;
    const inv = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: victim, p_role: "waiter" });
    expectOk(inv);
    const mid = inv.data as string;
    cleanup.add(async () => void (await admin().from("restaurant_memberships").delete().eq("id", mid)));

    // um terceiro (atacante) se cadastra com o e-mail da vítima ANTES dela
    const c = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const su = await c.auth.signUp({ email: victim, password: TEST_PASSWORD });
    expect(su.error).toBeNull();
    if (su.data.user) cleanup.add(async () => void (await admin().auth.admin.deleteUser(su.data.user!.id)));

    if (emailConfirmationsEnabled()) {
      // produção/CI com confirmação: sem confirmar o e-mail não há sessão => não há como aceitar
      expect(su.data.session).toBeNull();
      expect((await admin().from("restaurant_memberships").select("status,user_id").eq("id", mid).single()).data).toMatchObject({ status: "invited", user_id: null });
    } else {
      // RISCO DOCUMENTADO (FINDINGS F-04): com enable_confirmations=false o cadastro já nasce confirmado e a
      // pessoa que se cadastra primeiro com o e-mail convidado consegue aceitar o convite. A defesa do banco
      // (exigir email_confirmed_at) só é efetiva com a confirmação de e-mail LIGADA em produção.
      console.warn("[F-04] enable_confirmations=false neste ambiente: convites podem ser reivindicados por pré-cadastro. NÃO usar em produção.");
      expect(su.data.session).not.toBeNull();
      const attacker = withToken(su.data.session!.access_token);
      expect(rows(await attacker.rpc("my_pending_invitations"))).toHaveLength(1);
      expectOk(await attacker.rpc("accept_invitation", { p_membership: mid }));
      expect((await admin().from("restaurant_memberships").select("status").eq("id", mid).single()).data?.status).toBe("active");
    }
  });
});

describe("support_tickets", () => {
  const subject = () => `zz-ticket-${uniq()}`;

  it("membro abre ticket do próprio restaurante (status open, autor = ele); não para outro restaurante", async () => {
    const s = subject();
    const ok = await as("waiterA").from("support_tickets").insert({ restaurant_id: A().id, subject: s, body: "teste" }).select("id,status,opened_by,restaurant_id").single();
    expectOk(ok);
    cleanup.add(async () => void (await admin().from("support_tickets").delete().eq("id", ok.data!.id)));
    expect(ok.data).toMatchObject({ status: "open", opened_by: world().users.waiterA.id, restaurant_id: A().id });

    expectDenied(await as("waiterA").from("support_tickets").insert({ restaurant_id: B().id, subject: subject() }).select("id"));
    expectDenied(await as("plain").from("support_tickets").insert({ restaurant_id: A().id, subject: subject() }).select("id"));
    expect(rows(await admin().from("support_tickets").select("id").like("subject", "zz-ticket-%").eq("restaurant_id", B().id))).toHaveLength(0);
  });

  it("não forja autor nem status no insert (GRANT por coluna)", async () => {
    expectDenied(await as("waiterA").from("support_tickets").insert({ restaurant_id: A().id, subject: subject(), opened_by: world().users.ownerA.id }).select("id"), /42501|permission denied/);
    expectDenied(await as("waiterA").from("support_tickets").insert({ restaurant_id: A().id, subject: subject(), status: "resolved" }).select("id"), /42501|permission denied/);
  });

  it("visibilidade: o autor e o dono do restaurante (team.manage) e a plataforma veem; colegas e outro tenant não", async () => {
    const t = await admin().from("support_tickets").insert({ restaurant_id: A().id, opened_by: world().users.waiterA.id, subject: subject() }).select("id").single();
    expectOk(t);
    cleanup.add(async () => void (await admin().from("support_tickets").delete().eq("id", t.data!.id)));
    for (const who of ["waiterA", "ownerA", "superadmin", "support"] as const) {
      expect(rows(await as(who).from("support_tickets").select("id").eq("id", t.data!.id)), who).toHaveLength(1);
    }
    for (const who of ["cashierA", "managerA", "ownerB", "plain"] as const) {
      expectNoRows(await as(who).from("support_tickets").select("id").eq("id", t.data!.id));
    }
  });

  it("só a plataforma muda o status; o dono e o autor não; ninguém apaga", async () => {
    const t = await admin().from("support_tickets").insert({ restaurant_id: A().id, opened_by: world().users.waiterA.id, subject: subject() }).select("id").single();
    expectOk(t);
    cleanup.add(async () => void (await admin().from("support_tickets").delete().eq("id", t.data!.id)));
    for (const who of ["waiterA", "ownerA", "managerA"] as const) {
      expectNotApplied(await as(who).from("support_tickets").update({ status: "closed" }).eq("id", t.data!.id).select("id"));
    }
    expect((await admin().from("support_tickets").select("status").eq("id", t.data!.id).single()).data?.status).toBe("open");
    expectOk(await as("support").from("support_tickets").update({ status: "in_progress" }).eq("id", t.data!.id).select("id"));
    expect((await admin().from("support_tickets").select("status").eq("id", t.data!.id).single()).data?.status).toBe("in_progress");
    expectDenied(await as("superadmin").from("support_tickets").delete().eq("id", t.data!.id).select("id"));
  });
});
