/**
 * Equipe: fluxo completo invite_member -> accept_invitation -> change_member_role -> revoke_member,
 * overrides de permissão (set_member_permission) refletidos em has_permission e no acesso real aos dados.
 */
import { afterAll, describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../fixtures/accounts";
import { admin, as, signInAs, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, orderRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();

async function memberRow(id: string) {
  const r = await admin().from("restaurant_memberships").select("*").eq("id", id).single();
  expect(r.error).toBeNull();
  return r.data!;
}

async function auditActions(resourceId: string) {
  const r = await admin().from("audit_logs").select("action,actor_id,metadata").eq("resource_id", resourceId).order("created_at");
  return rows(r);
}

async function restoreWaiter2() {
  const id = world().memberships.waiter2A!;
  await admin().from("membership_permission_overrides").delete().eq("membership_id", id);
  await admin().from("restaurant_memberships").update({ role: "waiter", status: "active" }).eq("id", id);
}

afterAll(async () => {
  await restoreWaiter2();
  await admin().from("restaurant_memberships").delete().in("restaurant_id", [A().id, B().id]).like("invited_email", "zz-%");
  await admin().from("restaurant_memberships").delete().in("restaurant_id", [A().id, B().id]).eq("user_id", world().users.plain.id);
  await cleanup.run();
});

describe("convite -> aceite -> mudança de papel -> revogação (usuário sem conta no momento do convite)", () => {
  it("fluxo completo com efeito imediato sobre o acesso a dados", async () => {
    const email = `zz-invitee-${uniq()}@example.test`;

    // 1) dono convida (a pessoa ainda não tem conta)
    const inv = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: `  ${email.toUpperCase()}  `, p_role: "waiter" });
    expectOk(inv);
    const mid = inv.data as string;
    cleanup.add(async () => void (await admin().from("restaurant_memberships").delete().eq("id", mid)));
    expect(await memberRow(mid)).toMatchObject({ restaurant_id: A().id, user_id: null, role: "waiter", status: "invited", invited_email: email, invited_by: world().users.ownerA.id });
    expect((await auditActions(mid)).map((a) => a.action)).toEqual(["member.invited"]);

    // reconvite com outro papel atualiza o MESMO vínculo (sem duplicar)
    const again = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: email, p_role: "cashier" });
    expect(again.data).toBe(mid);
    expect(await memberRow(mid)).toMatchObject({ role: "cashier", status: "invited" });
    expect(rows(await admin().from("restaurant_memberships").select("id").eq("restaurant_id", A().id).eq("invited_email", email))).toHaveLength(1);

    // 2) a pessoa cria a conta depois (e-mail confirmado) e entra de verdade
    const created = await admin().auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: "zz DEMO Convidado" } });
    expect(created.error).toBeNull();
    const uid = created.data.user!.id;
    cleanup.add(async () => void (await admin().auth.admin.deleteUser(uid)));
    const me = await signInAs(email, TEST_PASSWORD);

    // convite visível só para ela, e sem acesso antes do aceite
    const pending = await me.client.rpc("my_pending_invitations");
    expectOk(pending);
    expect(rows(pending)).toEqual([expect.objectContaining({ membership_id: mid, restaurant_id: A().id, restaurant_name: "DEMO Restaurante A", role: "cashier" })]);
    expectNoRows(await me.client.from("orders").select("id").eq("restaurant_id", A().id));
    expect((await me.client.rpc("my_permissions", { rid: A().id })).data).toEqual([]);
    expect(rows(await me.client.rpc("my_restaurants"))).toHaveLength(0);
    // terceiros não aceitam o convite dela
    for (const who of ["plain", "ownerB", "waiterA", "superadmin"] as const) {
      expectRule(await as(who).rpc("accept_invitation", { p_membership: mid }), /invitation_not_found/);
    }
    expect((await memberRow(mid)).status).toBe("invited");
    // o convidado não consegue se auto-aprovar por escrita direta
    expectDenied(await me.client.from("restaurant_memberships").update({ status: "active", user_id: uid }).eq("id", mid).select("id"));

    // 3) aceite
    expectOk(await me.client.rpc("accept_invitation", { p_membership: mid }));
    expect(await memberRow(mid)).toMatchObject({ user_id: uid, status: "active", role: "cashier" });
    expect((await auditActions(mid)).map((a) => a.action)).toEqual(["member.invited", "member.invited", "member.invitation_accepted"]);
    expect(rows(await me.client.rpc("my_restaurants"))).toEqual([expect.objectContaining({ restaurant_id: A().id, role: "cashier", status: "active" })]);
    expect(rows(await me.client.from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    expect(rows(await me.client.from("payments").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0); // caixa vê pagamentos
    expectNoRows(await me.client.from("orders").select("id").eq("restaurant_id", B().id)); // e nada de B
    // aceitar de novo falha (já não está 'invited')
    expectRule(await me.client.rpc("accept_invitation", { p_membership: mid }), /invitation_not_found/);

    // 4) mudança de papel: efeito imediato no mesmo JWT
    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectOk(await me.client.from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id")); // cashier aceita
    expectOk(await as("ownerA").rpc("change_member_role", { p_membership: mid, p_role: "kitchen" }));
    expect(await memberRow(mid)).toMatchObject({ role: "kitchen" });
    expectNoRows(await me.client.from("payments").select("id").eq("restaurant_id", A().id)); // cozinha não vê pagamentos
    const order2 = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectRule(await me.client.from("orders").update({ status: "CONFIRMED" }).eq("id", order2.id).select("id"), /FORBIDDEN/);
    expect((await orderRow(order2.id)).status).toBe("RECEIVED");

    // 5) revogação corta o acesso imediatamente
    expectOk(await as("ownerA").rpc("revoke_member", { p_membership: mid }));
    expect(await memberRow(mid)).toMatchObject({ status: "revoked", role: "kitchen" });
    expectNoRows(await me.client.from("orders").select("id").eq("restaurant_id", A().id));
    expectNoRows(await me.client.from("products").select("id").eq("restaurant_id", A().id).eq("id", A().hiddenProductId));
    expectNotApplied(await me.client.from("orders").update({ status: "CONFIRMED" }).eq("id", order2.id).select("id"));
    expect((await me.client.rpc("is_member", { rid: A().id })).data).toBe(false);
    expect((await me.client.rpc("my_permissions", { rid: A().id })).data).toEqual([]);
    expect(rows(await me.client.rpc("my_restaurants"))).toHaveLength(0);
    expectRule(await me.client.rpc("accept_invitation", { p_membership: mid }), /invitation_not_found/);
    // não vê mais os colegas
    expectNoRows(await me.client.from("profiles").select("id").eq("id", world().users.ownerA.id));
    expect((await auditActions(mid)).map((a) => a.action)).toContain("member.revoked");
    // revogar de novo é inofensivo (sem nova auditoria)
    const count = (await auditActions(mid)).length;
    expectOk(await as("ownerA").rpc("revoke_member", { p_membership: mid }));
    expect((await auditActions(mid)).length).toBe(count);

    // 6) reconvite de membro revogado (já tem user_id) volta 'invited' e exige novo aceite
    expectOk(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: email, p_role: "waiter" }));
    expect(await memberRow(mid)).toMatchObject({ status: "invited", role: "waiter", user_id: uid });
    expectNoRows(await me.client.from("orders").select("id").eq("restaurant_id", A().id));
    expectOk(await me.client.rpc("accept_invitation", { p_membership: mid }));
    expect(rows(await me.client.from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    expect(rows(await me.client.from("payments").select("id").eq("restaurant_id", A().id))).toHaveLength(0); // garçom
  });

  it("validações do convite: papel owner, e-mail inválido, já membro", async () => {
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "nao-e-email", p_role: "waiter" }), /invalid_email/);
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "a@b", p_role: "waiter" }), /invalid_email/);
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "a@b.test", p_role: "owner" }), /invalid_role/);
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "waiter.a@example.test", p_role: "manager" }), /already_member/);
    expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "owner.a@example.test", p_role: "manager" }), /already_member/);
    expect(rows(await admin().from("restaurant_memberships").select("id").eq("restaurant_id", A().id).in("invited_email", ["nao-e-email", "a@b", "a@b.test"]))).toHaveLength(0);
  });

  it("convite para conta já existente (plain) e aceite pelo e-mail confirmado; convite de B não vale para A", async () => {
    const inv = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "plain@example.test", p_role: "waiter" });
    expectOk(inv);
    const mid = inv.data as string;
    cleanup.add(async () => void (await admin().from("restaurant_memberships").delete().eq("id", mid)));

    // o convite é para o e-mail do plain: o dono de B e o garçom de A não conseguem aceitar
    expectRule(await as("ownerB").rpc("accept_invitation", { p_membership: mid }), /invitation_not_found/);
    expect(rows(await as("ownerB").rpc("my_pending_invitations"))).toHaveLength(0);

    expect(rows(await as("plain").rpc("my_pending_invitations"))).toEqual([expect.objectContaining({ membership_id: mid })]);
    expectOk(await as("plain").rpc("accept_invitation", { p_membership: mid }));
    expect(rows(await as("plain").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    expectNoRows(await as("plain").from("orders").select("id").eq("restaurant_id", B().id));
    expectOk(await as("ownerA").rpc("revoke_member", { p_membership: mid }));
    expectNoRows(await as("plain").from("orders").select("id").eq("restaurant_id", A().id));
  });

  it("convite aceito depois que o restaurante foi suspenso é recusado", async () => {
    const inv = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "plain@example.test", p_role: "cashier" });
    expectOk(inv);
    const mid = inv.data as string;
    cleanup.add(async () => void (await admin().from("restaurant_memberships").delete().eq("id", mid)));
    try {
      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", A().id));
      expect(rows(await as("plain").rpc("my_pending_invitations"))).toHaveLength(0);
      expectRule(await as("plain").rpc("accept_invitation", { p_membership: mid }), /restaurant_suspended/);
      expect((await memberRow(mid)).status).toBe("invited");
    } finally {
      await admin().from("restaurants").update({ status: "active" }).eq("id", A().id);
      await admin().from("restaurant_memberships").delete().eq("id", mid);
    }
  });

  it("visibilidade da equipe: dono vê todos os vínculos de A; demais só o próprio", async () => {
    const owner = await as("ownerA").from("restaurant_memberships").select("id,restaurant_id").eq("restaurant_id", A().id);
    expect(rows(owner).length).toBeGreaterThanOrEqual(6);
    for (const who of ["managerA", "cashierA", "kitchenA", "waiterA"] as const) {
      const mine = await as(who).from("restaurant_memberships").select("id,user_id");
      expectOk(mine);
      expect(rows(mine)).toEqual([expect.objectContaining({ id: world().memberships[who], user_id: world().users[who].id })]);
    }
    expect(rows(await as("managerA").from("membership_permission_overrides").select("*"))).toHaveLength(0);
  });
});

describe("overrides de permissão: has_permission e acesso real respeitam o que o dono concede/remove", () => {
  const waiter2 = () => world().memberships.waiter2A!;

  it("conceder orders.accept ao garçom 2 (só a ele): aceita pedido; o garçom 1 continua sem; remover devolve ao padrão", async () => {
    try {
      const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
      expectNotApplied(await as("waiter2A").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));

      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.accept", p_granted: true }));
      const ov = await admin().from("membership_permission_overrides").select("*").eq("membership_id", waiter2());
      expect(ov.data).toEqual([expect.objectContaining({ restaurant_id: A().id, permission_key: "orders.accept", granted: true, created_by: world().users.ownerA.id })]);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "orders.accept" })).data).toBe(true);
      expect((await as("waiter2A").rpc("my_permissions", { rid: A().id })).data).toContain("orders.accept");
      expect((await as("waiterA").rpc("has_permission", { rid: A().id, perm: "orders.accept" })).data).toBe(false);
      expectNotApplied(await as("waiterA").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));

      expectOk(await as("waiter2A").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));
      expect((await orderRow(order.id)).status).toBe("CONFIRMED");
      // mas só o que foi concedido: cancelar continua proibido
      expectNotApplied(await as("waiter2A").from("orders").update({ status: "CANCELLED", status_reason: "x" }).eq("id", order.id).select("id"));

      // devolver ao padrão remove a linha de override (estado limpo)
      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.accept", p_granted: false }));
      expect(rows(await admin().from("membership_permission_overrides").select("*").eq("membership_id", waiter2()))).toHaveLength(0);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "orders.accept" })).data).toBe(false);
      const acts = (await admin().from("audit_logs").select("action,metadata").eq("resource_id", waiter2()).eq("action", "member.permission_changed")).data!;
      expect(acts.length).toBeGreaterThanOrEqual(2);
    } finally {
      await restoreWaiter2();
    }
  });

  it("remover uma permissão padrão do papel (orders.create) tira o acesso real; remover orders.view esconde os pedidos", async () => {
    try {
      const okIns = await as("waiter2A").from("customers").insert({ restaurant_id: A().id, name: `zz-ok-${uniq()}` }).select("id").single();
      expectOk(okIns);
      await admin().from("customers").delete().eq("id", okIns.data!.id);
      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.create", p_granted: false }));
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "orders.create" })).data).toBe(false);
      expectDenied(await as("waiter2A").from("customers").insert({ restaurant_id: A().id, name: `zz-no-${uniq()}` }).select("id"));
      expect(rows(await admin().from("customers").select("id").like("name", "zz-no-%"))).toHaveLength(0);

      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.view", p_granted: false }));
      expectNoRows(await as("waiter2A").from("orders").select("id").eq("restaurant_id", A().id));
      expectNoRows(await as("waiter2A").from("customers").select("id").eq("restaurant_id", A().id));
      // o garçom 1 não foi afetado
      expect(rows(await as("waiterA").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    } finally {
      await restoreWaiter2();
    }
    expect(rows(await as("waiter2A").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
  });

  it("mudar o papel zera os overrides (recomeça da matriz do novo papel) e ajusta o acesso na hora", async () => {
    try {
      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "payments.record", p_granted: true }));
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "payments.record" })).data).toBe(true);
      expect(rows(await as("waiter2A").from("payments").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);

      expectOk(await as("ownerA").rpc("change_member_role", { p_membership: waiter2(), p_role: "kitchen" }));
      expect(rows(await admin().from("membership_permission_overrides").select("*").eq("membership_id", waiter2()))).toHaveLength(0);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "payments.record" })).data).toBe(false);
      expectNoRows(await as("waiter2A").from("payments").select("id").eq("restaurant_id", A().id));
      expect((await as("waiter2A").rpc("my_permissions", { rid: A().id })).data).toEqual(["orders.update_status", "orders.view", "print.request"]);

      // promover a gerente dá o conjunto de gerente, nunca owner
      expectOk(await as("ownerA").rpc("change_member_role", { p_membership: waiter2(), p_role: "manager" }));
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "orders.cancel" })).data).toBe(true);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "team.manage" })).data).toBe(false);
      expectRule(await as("waiter2A").rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "waiter" }), /forbidden/);
    } finally {
      await restoreWaiter2();
    }
    expect(await memberRow(waiter2())).toMatchObject({ role: "waiter", status: "active" });
  });

  it("team.manage é indelegável e nenhum override transforma alguém em owner/dono de equipe", async () => {
    try {
      expectRule(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "team.manage", p_granted: true }), /team_manage_not_delegable/);
      expectRule(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "team.manage", p_granted: false }), /team_manage_not_delegable/);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "team.manage" })).data).toBe(false);
      // mesmo que um override 'team.manage' existisse no banco (inserido por fora do trigger), has_permission o ignora
      // (a trigger impede a inserção; aqui garantimos que a tentativa direta falha)
      expectRule(await admin().from("membership_permission_overrides").insert({ membership_id: waiter2(), restaurant_id: A().id, permission_key: "team.manage", granted: true }), /team_manage_not_delegable/);
    } finally {
      await restoreWaiter2();
    }
  });

  it("override não vaza entre restaurantes: FK composta (membership, restaurant) impede restaurant_id trocado", async () => {
    const r = await admin().from("membership_permission_overrides").insert({ membership_id: waiter2(), restaurant_id: B().id, permission_key: "orders.accept", granted: true });
    expect(r.error?.code).toBe("23503");
  });

  it("vínculo revogado perde também as permissões concedidas (overrides apagados na revogação)", async () => {
    try {
      expectOk(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.cancel", p_granted: true }));
      expectOk(await as("ownerA").rpc("revoke_member", { p_membership: waiter2() }));
      expect(rows(await admin().from("membership_permission_overrides").select("*").eq("membership_id", waiter2()))).toHaveLength(0);
      expect((await as("waiter2A").rpc("has_permission", { rid: A().id, perm: "orders.view" })).data).toBe(false);
      expectRule(await as("ownerA").rpc("set_member_permission", { p_membership: waiter2(), p_permission: "orders.cancel", p_granted: true }), /membership_revoked/);
      expectRule(await as("ownerA").rpc("change_member_role", { p_membership: waiter2(), p_role: "manager" }), /membership_revoked/);
    } finally {
      await restoreWaiter2();
    }
  });
});

describe("usuário com vínculos em dois restaurantes: permissões não vazam de um para o outro", () => {
  it("garçom em A + dono do próprio restaurante X: poderes de X (menu.manage) não valem em A, e vice-versa", async () => {
    const inv = await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: "plain@example.test", p_role: "waiter" });
    expectOk(inv);
    const mid = inv.data as string;
    cleanup.add(async () => void (await admin().from("restaurant_memberships").delete().eq("id", mid)));
    expectOk(await as("plain").rpc("accept_invitation", { p_membership: mid }));

    const reg = await as("plain").rpc("register_restaurant", { p_name: "zz DEMO Multi", p_slug: `zz-multi-${uniq()}`.slice(0, 40) });
    expectOk(reg);
    const xid = reg.data as string;
    cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", xid)));

    try {
      const me = as("plain");
      // minhas permissões por restaurante são independentes
      const inA = (await me.rpc("my_permissions", { rid: A().id })).data as string[];
      const inX = (await me.rpc("my_permissions", { rid: xid })).data as string[];
      expect(inA).toEqual(["orders.create", "orders.view", "print.request", "tables.operate", "tables.view", "tabs.manage", "tabs.view"]);
      expect(inX).toContain("menu.manage");
      expect(inX).not.toContain("orders.create"); // dono nunca opera
      expect(inA).not.toContain("menu.manage");

      // dono de X gerencia o cardápio de X...
      const mine = await me.from("products").insert({ restaurant_id: xid, name: "zz-x-prod", price_cents: 1 }).select("id").single();
      expectOk(mine);
      // ...mas isso não lhe dá menu.manage em A
      expectDenied(await me.from("products").insert({ restaurant_id: A().id, name: "zz-a-prod", price_cents: 1 }).select("id"));
      expectNotApplied(await me.from("products").update({ price_cents: 1 }).eq("id", A().productId).select("id"));
      // garçom em A opera em A (cria cliente) mas o dono em X não opera em X
      const cust = await me.from("customers").insert({ restaurant_id: A().id, name: `zz-multi-${uniq()}` }).select("id").single();
      expectOk(cust);
      await admin().from("customers").delete().eq("id", cust.data!.id);
      expectDenied(await me.from("customers").insert({ restaurant_id: xid, name: "zz-multi-x" }).select("id"));
      // team.manage em X não permite mexer na equipe de A
      expectRule(await me.rpc("change_member_role", { p_membership: world().memberships.waiterA, p_role: "manager" }), /forbidden/);
      expectRule(await me.rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "waiter" }), /forbidden/);
      // pedidos de A visíveis (orders.view como garçom); pedidos de B não
      expect(rows(await me.from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
      expectNoRows(await me.from("orders").select("id").eq("restaurant_id", B().id));
      // my_restaurants lista os dois, cada um com seu papel
      const list = rows(await me.rpc("my_restaurants")).map((r) => `${r.restaurant_id}:${r.role}`).sort();
      expect(list).toEqual([`${A().id}:waiter`, `${xid}:owner`].sort());
    } finally {
      await admin().from("restaurant_memberships").delete().eq("id", mid);
    }
  });
});
