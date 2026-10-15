/**
 * Anti-escalonamento de privilégios:
 *  - ninguém escreve em restaurant_memberships / overrides / platform_admins pela API;
 *  - garçom não se promove; gerente não vira owner; ninguém atribui 'owner';
 *  - dono não vira superadmin nem cria restaurante; status/slug só a plataforma altera;
 *  - a matriz de permissões do contrato é exatamente a efetiva (has_permission / my_permissions).
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { ACCOUNTS } from "../fixtures/accounts";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;

async function membership(key: AccountKey) {
  const r = await admin().from("restaurant_memberships").select("role,status,user_id").eq("id", world().memberships[key]!).single();
  expect(r.error).toBeNull();
  return r.data!;
}

describe("restaurant_memberships: nenhuma escrita direta pela API (anti auto-promoção)", () => {
  const actors: AccountKey[] = ["waiterA", "cashierA", "kitchenA", "managerA", "ownerA", "plain"];

  for (const who of actors) {
    it(`${who}: INSERT/UPDATE/DELETE direto em restaurant_memberships são negados e nada muda`, async () => {
      const snapshot = await admin().from("restaurant_memberships").select("*").eq("restaurant_id", A().id).order("id");

      // tenta se promover / criar vínculo
      for (const role of ["owner", "manager"] as const) {
        const ins = await as(who).from("restaurant_memberships").insert({ restaurant_id: A().id, user_id: world().users[who].id, role, status: "active" }).select("id");
        expectDenied(ins);
      }
      const own = world().memberships[who];
      if (own) {
        for (const patch of [{ role: "owner" }, { role: "manager" }, { status: "active" }, { user_id: world().users.plain.id }]) {
          const upd = await as(who).from("restaurant_memberships").update(patch).eq("id", own).select("id");
          expectDenied(upd);
        }
        expectDenied(await as(who).from("restaurant_memberships").delete().eq("id", own).select("id"));
      }
      // update em massa
      expectDenied(await as(who).from("restaurant_memberships").update({ role: "owner" }).eq("restaurant_id", A().id).select("id"));
      expectDenied(await as(who).from("restaurant_memberships").delete().eq("restaurant_id", A().id).select("id"));
      // upsert (PostgREST faz INSERT .. ON CONFLICT DO UPDATE)
      const ups = await as(who).from("restaurant_memberships").upsert({ restaurant_id: A().id, user_id: world().users[who].id, role: "owner", status: "active" }, { onConflict: "restaurant_id,user_id" }).select("id");
      expectDenied(ups);

      const after = await admin().from("restaurant_memberships").select("*").eq("restaurant_id", A().id).order("id");
      expect(after.data).toEqual(snapshot.data);
    });
  }

  it("membership_permission_overrides: sem escrita pela API (nem dono nem gerente)", async () => {
    const target = world().memberships.waiter2A!;
    for (const who of ["ownerA", "managerA", "waiter2A"] as const) {
      const ins = await as(who)
        .from("membership_permission_overrides")
        .insert({ membership_id: target, restaurant_id: A().id, permission_key: "orders.accept", granted: true });
      expectDenied(ins);
      expectDenied(await as(who).from("membership_permission_overrides").update({ granted: true }).eq("membership_id", target).select("membership_id"));
      expectDenied(await as(who).from("membership_permission_overrides").delete().eq("membership_id", target).select("membership_id"));
    }
    expect(rows(await admin().from("membership_permission_overrides").select("*").eq("membership_id", target))).toHaveLength(0);
  });

  it("catálogo (permissions / role_permissions): leitura sim, escrita nunca pela API", async () => {
    const rp = await as("ownerA").from("role_permissions").select("*").eq("role", "owner");
    expectOk(rp);
    expect(rows(rp).length).toBeGreaterThan(0);

    for (const who of ["ownerA", "managerA", "superadmin"] as const) {
      expectDenied(await as(who).from("role_permissions").insert({ role: "owner", permission_key: "payments.record" }).select("*"));
      expectDenied(await as(who).from("role_permissions").insert({ role: "waiter", permission_key: "payments.record" }).select("*"));
      expectDenied(await as(who).from("role_permissions").delete().eq("role", "manager").select("*"));
      expectDenied(await as(who).from("permissions").update({ is_operational: false }).eq("key", "payments.record").select("*"));
      expectDenied(await as(who).from("permissions").insert({ key: "evil.permission", description: "x" }).select("*"));
    }
    const opCheck = await admin().from("role_permissions").select("*").eq("role", "owner").eq("permission_key", "payments.record");
    expect(rows(opCheck)).toHaveLength(0);
  });
});

describe("RPCs de equipe: ninguém se promove nem atribui 'owner'", () => {
  it("garçom não altera o próprio papel nem o de colegas", async () => {
    const before = await membership("waiter2A");
    expectDenied(await as("waiterA").rpc("change_member_role", { p_membership: world().memberships.waiterA!, p_role: "manager" }), /forbidden/);
    expectDenied(await as("waiterA").rpc("change_member_role", { p_membership: world().memberships.waiterA!, p_role: "owner" }), /forbidden/);
    expectDenied(await as("waiterA").rpc("change_member_role", { p_membership: world().memberships.waiter2A!, p_role: "manager" }), /forbidden/);
    expectDenied(await as("waiterA").rpc("set_member_permission", { p_membership: world().memberships.waiterA!, p_permission: "payments.record", p_granted: true }), /forbidden/);
    expectDenied(await as("waiterA").rpc("set_member_permission", { p_membership: world().memberships.waiter2A!, p_permission: "orders.cancel", p_granted: true }), /forbidden/);
    expectDenied(await as("waiterA").rpc("revoke_member", { p_membership: world().memberships.managerA! }), /forbidden/);
    expectDenied(await as("waiterA").rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "manager" }), /forbidden/);

    expect(await membership("waiterA")).toMatchObject({ role: "waiter", status: "active" });
    expect(await membership("waiter2A")).toEqual(before);
    expect(rows(await admin().from("membership_permission_overrides").select("*").eq("restaurant_id", A().id))).toHaveLength(0);
  });

  it("gerente (sem team.manage) não vira owner, não promove ninguém e não convida", async () => {
    for (const [target, role] of [
      ["managerA", "owner"],
      ["cashierA", "manager"],
      ["waiter2A", "owner"],
    ] as const) {
      const r = await as("managerA").rpc("change_member_role", { p_membership: world().memberships[target]!, p_role: role });
      expectDenied(r, /forbidden/);
    }
    expectDenied(await as("managerA").rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "cashier" }), /forbidden/);
    expectDenied(await as("managerA").rpc("revoke_member", { p_membership: world().memberships.waiter2A! }), /forbidden/);
    expect(await membership("managerA")).toMatchObject({ role: "manager" });
    expect(await membership("cashierA")).toMatchObject({ role: "cashier" });
    expect(await membership("waiter2A")).toMatchObject({ role: "waiter", status: "active" });
  });

  it("nem o dono atribui, rebaixa ou revoga 'owner' (inclui o próprio); nem convida como owner", async () => {
    const waiter2 = world().memberships.waiter2A!;
    expectRule(await as("ownerA").rpc("change_member_role", { p_membership: waiter2, p_role: "owner" }), /owner_protected/);
    expectRule(await as("ownerA").rpc("change_member_role", { p_membership: world().memberships.ownerA!, p_role: "manager" }), /cannot_modify_self/);
    expectRule(await as("ownerA").rpc("revoke_member", { p_membership: world().memberships.ownerA! }), /cannot_modify_self/);
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "owner" }), /invalid_role/);
    expect(await membership("waiter2A")).toMatchObject({ role: "waiter" });
    expect(await membership("ownerA")).toMatchObject({ role: "owner", status: "active" });
  });

  it("team.manage não é delegável; permissões do dono não mudam por override", async () => {
    expectRule(await as("ownerA").rpc("set_member_permission", { p_membership: world().memberships.managerA!, p_permission: "team.manage", p_granted: true }), /team_manage_not_delegable/);
    expectRule(await as("ownerA").rpc("set_member_permission", { p_membership: world().memberships.managerA!, p_permission: "permissao.inexistente", p_granted: true }), /unknown_permission/);
    // owner como alvo (via sessão de outro usuário não é possível: não há 2º owner) => testado no nível de trigger
    const ownerM = world().memberships.ownerA!;
    expectRule(
      await admin().from("membership_permission_overrides").insert({ membership_id: ownerM, restaurant_id: A().id, permission_key: "payments.record", granted: true }),
      /owner_permissions_are_fixed/,
    );
    expectRule(
      await admin().from("membership_permission_overrides").insert({ membership_id: world().memberships.managerA!, restaurant_id: A().id, permission_key: "team.manage", granted: true }),
      /team_manage_not_delegable/,
    );
    expect(rows(await admin().from("membership_permission_overrides").select("*").eq("restaurant_id", A().id))).toHaveLength(0);
  });

  it("triggers de proteção valem até para o service role (defesa em profundidade)", async () => {
    const waiter2 = world().memberships.waiter2A!;
    expectRule(await admin().from("restaurant_memberships").update({ role: "owner" }).eq("id", waiter2), /owner_cannot_be_assigned/);
    expectRule(await admin().from("restaurant_memberships").update({ status: "revoked" }).eq("id", world().memberships.ownerA!), /owner_is_protected/);
    expectRule(await admin().from("restaurant_memberships").update({ role: "manager" }).eq("id", world().memberships.ownerA!), /owner_is_protected/);
    expectRule(await admin().from("restaurant_memberships").update({ user_id: world().users.plain.id }).eq("id", waiter2), /membership_user_immutable/);
    expectRule(await admin().from("restaurant_memberships").update({ restaurant_id: B().id }).eq("id", waiter2), /membership_immutable_column/);
    // segundo owner vigente no mesmo restaurante é impossível (índice único parcial)
    const dup = await admin().from("restaurant_memberships").insert({ restaurant_id: A().id, user_id: world().users.plain.id, role: "owner", status: "active" });
    expect(dup.error?.code).toBe("23505");
    // owner nunca recebe permissão operacional na matriz
    expectRule(await admin().from("role_permissions").insert({ role: "owner", permission_key: "orders.accept" }), /owner_cannot_have_operational_permission/);
    expect(await membership("waiter2A")).toMatchObject({ role: "waiter", status: "active" });
  });
});

describe("plataforma: ninguém vira admin/superadmin pela API", () => {
  const actors: AccountKey[] = ["ownerA", "managerA", "waiterA", "plain", "support"];

  for (const who of actors) {
    it(`${who}: não grava em platform_admins (insert/update/delete/upsert) e continua sem poderes`, async () => {
      const uid = world().users[who].id;
      const snapshot = await admin().from("platform_admins").select("*").order("user_id");

      expectDenied(await as(who).from("platform_admins").insert({ user_id: uid, role: "superadmin" }).select("*"));
      expectDenied(await as(who).from("platform_admins").upsert({ user_id: uid, role: "superadmin" }, { onConflict: "user_id" }).select("*"));
      expectDenied(await as(who).from("platform_admins").update({ role: "superadmin" }).eq("user_id", uid).select("*"));
      expectDenied(await as(who).from("platform_admins").update({ role: "superadmin" }).neq("user_id", uid).select("*"));
      expectDenied(await as(who).from("platform_admins").delete().neq("user_id", uid).select("*"));
      expectDenied(await as(who).from("platform_admins").delete().eq("user_id", world().users.superadmin.id).select("*"));

      expect((await admin().from("platform_admins").select("*").order("user_id")).data).toEqual(snapshot.data);
      const isSuper = await as(who).rpc("is_platform_superadmin");
      expect(isSuper.data).toBe(who === "support" ? false : false);
    });
  }

  it("platform_admins: cada admin só enxerga o próprio registro; não-admins não veem nada", async () => {
    const sup = await as("superadmin").from("platform_admins").select("user_id,role");
    expectOk(sup);
    expect(rows(sup)).toEqual([{ user_id: world().users.superadmin.id, role: "superadmin" }]);
    const own = await as("ownerA").from("platform_admins").select("user_id");
    expectOk(own);
    expect(rows(own)).toHaveLength(0);
  });

  it("create_restaurant (RPC) só para superadmin: dono, gerente, suporte e usuário comum são negados", async () => {
    const slug = `zz-test-${uniq()}`.slice(0, 40);
    for (const who of ["ownerA", "managerA", "plain", "support", "waiterB"] as const) {
      expectRule(await as(who).rpc("create_restaurant", { p_name: "zz Evil", p_slug: slug, p_owner_id: world().users[who].id }), /forbidden/);
    }
    expect(rows(await admin().from("restaurants").select("id").eq("slug", slug))).toHaveLength(0);
  });

  it("superadmin cria restaurante pela RPC (controle positivo); slug reservado/duplicado/ inválido são rejeitados", async () => {
    const cleanup = new Cleanup();
    const slug = `zz-test-${uniq()}`.slice(0, 40);
    try {
      const ok = await as("superadmin").rpc("create_restaurant", { p_name: "zz DEMO Criado pela Plataforma", p_slug: slug, p_owner_id: world().users.plain.id });
      expectOk(ok);
      const rid = ok.data as string;
      cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rid)));

      const r = await admin().from("restaurants").select("status,slug,created_by").eq("id", rid).single();
      expect(r.data).toMatchObject({ status: "active", slug, created_by: world().users.superadmin.id });
      const m = await admin().from("restaurant_memberships").select("role,status,user_id").eq("restaurant_id", rid);
      expect(m.data).toEqual([{ role: "owner", status: "active", user_id: world().users.plain.id }]);
      const audit = await admin().from("audit_logs").select("action,actor_id").eq("restaurant_id", rid).eq("action", "restaurant.created");
      expect(audit.data).toEqual([{ action: "restaurant.created", actor_id: world().users.superadmin.id }]);

      expectRule(await as("superadmin").rpc("create_restaurant", { p_name: "zz dup", p_slug: slug, p_owner_id: world().users.plain.id }), /slug_unavailable/);
      expectRule(await as("superadmin").rpc("create_restaurant", { p_name: "zz dup", p_slug: "admin", p_owner_id: world().users.plain.id }), /invalid_slug/);
      expectRule(await as("superadmin").rpc("create_restaurant", { p_name: "zz dup", p_slug: "Slug Invalido!", p_owner_id: world().users.plain.id }), /invalid_slug/);
      expectRule(await as("superadmin").rpc("create_restaurant", { p_name: "x", p_slug: `zz-${uniq()}`, p_owner_id: world().users.plain.id }), /invalid_name/);
      expectRule(await as("superadmin").rpc("create_restaurant", { p_name: "zz sem dono", p_slug: `zz-${uniq()}`, p_owner_id: "00000000-0000-4000-8000-00000000dead" }), /owner_not_found/);
    } finally {
      await cleanup.run();
    }
  });

  it("register_restaurant: usuário comum cria restaurante PENDENTE e não consegue se auto-ativar; limite de 5", async () => {
    const cleanup = new Cleanup();
    const created: string[] = [];
    try {
      const slug = `zz-reg-${uniq()}`.slice(0, 40);
      const reg = await as("plain").rpc("register_restaurant", { p_name: "zz DEMO Auto Cadastro", p_slug: slug });
      expectOk(reg);
      const rid = reg.data as string;
      created.push(rid);
      cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rid)));

      expect((await admin().from("restaurants").select("status").eq("id", rid).single()).data?.status).toBe("pending");
      // vira owner do próprio restaurante, mas não pode mudar status/slug
      expectRule(await as("plain").from("restaurants").update({ status: "active" }).eq("id", rid).select("id"), /restaurant_status_slug_platform_only/);
      expectRule(await as("plain").from("restaurants").update({ slug: `zz-${uniq()}` }).eq("id", rid).select("id"), /restaurant_status_slug_platform_only/);
      expect((await admin().from("restaurants").select("status,slug").eq("id", rid).single()).data).toEqual({ status: "pending", slug });

      // pendente não aparece publicamente
      const pub = await as("plain").rpc("resolve_restaurant_by_slug", { p_slug: slug });
      expect(rows(pub)).toHaveLength(0);

      expectRule(await as("plain").rpc("register_restaurant", { p_name: "zz dup", p_slug: "demo-a" }), /slug_unavailable/);
      expectRule(await as("plain").rpc("register_restaurant", { p_name: "zz dup", p_slug: "login" }), /invalid_slug/);

      // limite anti-abuso: 5 restaurantes por usuário
      for (let i = 0; i < 4; i++) {
        const r = await as("plain").rpc("register_restaurant", { p_name: `zz DEMO limite ${i}`, p_slug: `zz-reg-${uniq()}`.slice(0, 40) });
        expectOk(r);
        created.push(r.data as string);
        cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", r.data as string)));
      }
      expectRule(await as("plain").rpc("register_restaurant", { p_name: "zz sexto", p_slug: `zz-reg-${uniq()}`.slice(0, 40) }), /restaurant_limit_reached/);
    } finally {
      await cleanup.run();
    }
    for (const id of created) expect(rows(await admin().from("restaurants").select("id").eq("id", id))).toHaveLength(0);
  });

  it("anônimo não executa create_restaurant/register_restaurant", async () => {
    const { anon } = await import("../helpers/clients");
    expectDenied(await anon().rpc("create_restaurant", { p_name: "zz x", p_slug: "zz-anon", p_owner_id: world().users.plain.id }), /42501|permission denied/);
    expectDenied(await anon().rpc("register_restaurant", { p_name: "zz x", p_slug: "zz-anon" }), /42501|permission denied/);
  });
});

describe("restaurants / profiles / planos: colunas e escrita restritas", () => {
  const cleanup = new Cleanup();
  afterAll(() => cleanup.run());

  it("dono e gerente não alteram status nem slug; created_by/id não têm GRANT", async () => {
    for (const who of ["ownerA", "managerA"] as const) {
      expectRule(await as(who).from("restaurants").update({ status: "suspended" }).eq("id", A().id).select("id"), /restaurant_status_slug_platform_only/);
      expectRule(await as(who).from("restaurants").update({ slug: "novo-slug" }).eq("id", A().id).select("id"), /restaurant_status_slug_platform_only/);
      expectDenied(await as(who).from("restaurants").update({ created_by: world().users[who].id }).eq("id", A().id).select("id"));
      expectDenied(await as(who).from("restaurants").update({ id: B().id }).eq("id", A().id).select("id"));
    }
    const r = await admin().from("restaurants").select("status,slug").eq("id", A().id).single();
    expect(r.data).toEqual({ status: "active", slug: "demo-a" });
  });

  it("dono não cria nem apaga restaurantes; funcionários sem settings.manage não renomeiam", async () => {
    expectDenied(await as("ownerA").from("restaurants").insert({ name: "zz DEMO x", slug: `zz-${uniq()}` }).select("id"));
    expectDenied(await as("ownerA").from("restaurants").delete().eq("id", A().id).select("id"));
    for (const who of ["cashierA", "kitchenA", "waiterA"] as const) {
      expectNotApplied(await as(who).from("restaurants").update({ name: "HACKED" }).eq("id", A().id).select("id"));
    }
    expect((await admin().from("restaurants").select("name").eq("id", A().id).single()).data?.name).toBe("DEMO Restaurante A");
  });

  it("dono renomeia o próprio restaurante (controle positivo) e não o de B", async () => {
    try {
      const r = await as("ownerA").from("restaurants").update({ name: "DEMO Restaurante A (editado)" }).eq("id", A().id).select("id");
      expectOk(r);
      expect(rows(r)).toHaveLength(1);
      expectNotApplied(await as("ownerA").from("restaurants").update({ name: "HACKED" }).eq("id", B().id).select("id"));
    } finally {
      await admin().from("restaurants").update({ name: "DEMO Restaurante A" }).eq("id", A().id);
    }
    expect((await admin().from("restaurants").select("name").eq("id", B().id).single()).data?.name).toBe("DEMO Restaurante B");
  });

  it("profiles: edita o próprio nome; não o alheio; não troca id", async () => {
    const original = ACCOUNTS.waiterA.fullName;
    try {
      expectOk(await as("waiterA").from("profiles").update({ full_name: "DEMO Garcom A editado" }).eq("id", world().users.waiterA.id).select("id"));
      expect((await admin().from("profiles").select("full_name").eq("id", world().users.waiterA.id).single()).data?.full_name).toBe("DEMO Garcom A editado");
    } finally {
      await admin().from("profiles").update({ full_name: original }).eq("id", world().users.waiterA.id);
    }
    expectNotApplied(await as("waiterA").from("profiles").update({ full_name: "HACKED" }).eq("id", world().users.ownerA.id).select("id"));
    expectDenied(await as("waiterA").from("profiles").update({ id: world().users.plain.id }).eq("id", world().users.waiterA.id).select("id"));
    expect((await admin().from("profiles").select("full_name").eq("id", world().users.ownerA.id).single()).data?.full_name).toBe(ACCOUNTS.ownerA.fullName);
  });

  it("planos: leitura pública do catálogo; escrita só superadmin (dono/gerente/suporte negados)", async () => {
    const code = `zz-plan-${uniq()}`;
    const plans = await as("ownerA").from("plans").select("id,code");
    expectOk(plans);
    expect(rows(plans).length).toBeGreaterThan(0);
    const anyPlan = rows(plans)[0];

    for (const who of ["ownerA", "managerA", "support"] as const) {
      expectDenied(await as(who).from("plans").insert({ code, name: "zz", price_cents: 1 }).select("id"));
      expectNotApplied(await as(who).from("plans").update({ price_cents: 0 }).eq("id", anyPlan.id).select("id"));
      expectNotApplied(await as(who).from("plans").delete().eq("id", anyPlan.id).select("id"));
    }
    expect(rows(await admin().from("plans").select("id").eq("id", anyPlan.id))).toHaveLength(1);

    // controle positivo: superadmin
    const ins = await as("superadmin").from("plans").insert({ code, name: "zz DEMO plano", price_cents: 1 }).select("id").single();
    expectOk(ins);
    cleanup.add(async () => void (await admin().from("plans").delete().eq("code", code)));
    const del = await as("superadmin").from("plans").delete().eq("id", ins.data!.id).select("id");
    expectOk(del);
    expect(rows(del)).toHaveLength(1);
  });

  it("assinaturas: dono lê a do próprio restaurante, não escreve; garçom não lê; B invisível", async () => {
    const own = await as("ownerA").from("subscriptions").select("id,restaurant_id");
    expectOk(own);
    expect(rows(own).every((s) => s.restaurant_id === A().id)).toBe(true);
    expect(rows(own).length).toBeGreaterThan(0);
    expect(rows(await as("waiterA").from("subscriptions").select("id"))).toHaveLength(0);
    expectDenied(await as("ownerA").from("subscriptions").insert({ restaurant_id: A().id, plan_id: (await admin().from("plans").select("id").limit(1).single()).data!.id, status: "active" }).select("id"));
    expectNotApplied(await as("ownerA").from("subscriptions").update({ status: "canceled" }).eq("restaurant_id", A().id).select("id"));
    expectNotApplied(await as("ownerA").from("subscriptions").delete().eq("restaurant_id", A().id).select("id"));
    const live = await admin().from("subscriptions").select("status").eq("restaurant_id", A().id);
    expect(rows(live).map((s) => s.status)).toContain("trialing");
  });
});

describe("matriz de permissões efetiva = contrato (docs/CONTRACT.md)", () => {
  const ALL = [
    "orders.view", "orders.create", "orders.accept", "orders.reject", "orders.update_status", "orders.cancel",
    "menu.manage", "tables.view", "tables.manage", "tables.operate", "tabs.view", "tabs.manage",
    "payments.record", "print.request", "reports.view", "team.manage", "restaurant.settings.manage",
  ];
  const MATRIX: Record<string, string[]> = {
    ownerA: ["orders.view", "menu.manage", "tables.view", "tables.manage", "tabs.view", "reports.view", "team.manage", "restaurant.settings.manage"],
    managerA: ALL.filter((p) => p !== "team.manage"),
    cashierA: ["orders.view", "orders.create", "orders.accept", "orders.reject", "orders.update_status", "tables.view", "tables.operate", "tabs.view", "tabs.manage", "payments.record", "print.request"],
    kitchenA: ["orders.view", "orders.update_status", "print.request"],
    waiterA: ["orders.view", "orders.create", "tables.view", "tables.operate", "tabs.view", "tabs.manage", "print.request"],
  };
  const OPERATIONAL = ["orders.create", "orders.accept", "orders.reject", "orders.update_status", "orders.cancel", "tables.operate", "tabs.manage", "payments.record", "print.request"];

  for (const [who, expected] of Object.entries(MATRIX)) {
    it(`${who}: my_permissions e has_permission batem com a matriz`, async () => {
      const mine = await as(who as AccountKey).rpc("my_permissions", { rid: A().id });
      expectOk(mine);
      expect([...(mine.data as string[])].sort()).toEqual([...expected].sort());
      for (const perm of ALL) {
        const r = await as(who as AccountKey).rpc("has_permission", { rid: A().id, perm });
        expect(r.data, `${who} ${perm}`).toBe(expected.includes(perm));
      }
    });
  }

  it("owner NUNCA tem permissão operacional (nenhuma das 9)", async () => {
    for (const perm of OPERATIONAL) {
      expect((await as("ownerA").rpc("has_permission", { rid: A().id, perm })).data, perm).toBe(false);
      expect((await as("ownerB").rpc("has_permission", { rid: B().id, perm })).data, perm).toBe(false);
    }
    // e a matriz no banco confirma
    const ops = await admin().from("role_permissions").select("permission_key").eq("role", "owner").in("permission_key", OPERATIONAL);
    expect(rows(ops)).toHaveLength(0);
  });

  it("superadmin e usuário sem vínculo não têm nenhuma permissão em restaurante algum", async () => {
    for (const who of ["superadmin", "plain", "support"] as const) {
      expect((await as(who).rpc("my_permissions", { rid: A().id })).data).toEqual([]);
      expect((await as(who).rpc("is_member", { rid: A().id })).data).toBe(false);
    }
  });
});
