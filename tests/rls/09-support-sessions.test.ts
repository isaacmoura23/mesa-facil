/**
 * Sessão de suporte: acesso temporário, SOMENTE LEITURA, com motivo, expiração e auditoria.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, orderRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();

const REASON = "Chamado #123: investigar divergência de pedido";

async function closeAllSessions() {
  await admin().from("support_sessions").update({ ended_at: new Date().toISOString() }).in("restaurant_id", [A().id, B().id]).is("ended_at", null);
}
afterEach(closeAllSessions);
afterAll(async () => {
  await closeAllSessions();
  await cleanup.run();
});

async function open(who: AccountKey, rid = A().id, reason = REASON, minutes = 30) {
  const r = await as(who).rpc("open_support_session", { p_restaurant: rid, p_reason: reason, p_minutes: minutes });
  return r;
}

/** Tabelas privadas de A que a sessão de suporte deve passar a ENXERGAR (somente leitura). */
const READABLE_WITH_SESSION: Array<[string, number]> = [
  ["orders", 4],
  ["order_items", 4],
  ["order_item_modifiers", 4],
  ["order_status_history", 4],
  ["customers", 1],
  ["customer_addresses", 1],
  ["payments", 1],
  ["tabs", 1],
  ["tab_status_history", 1],
  ["restaurant_tables", 6],
  ["restaurant_memberships", 6],
  ["subscriptions", 1],
];

describe("sem sessão: superadmin e suporte NÃO leem dados operacionais dos restaurantes", () => {
  for (const who of ["superadmin", "support"] as const) {
    it(`${who}: pedidos, clientes, pagamentos, comandas, mesas, vínculos de A devolvem 0 linhas (e B também)`, async () => {
      for (const [table] of READABLE_WITH_SESSION) {
        if (table === "subscriptions") continue; // assinaturas são legíveis pela plataforma por desenho (cobrança)
        for (const rid of [A().id, B().id]) {
          expectNoRows(await as(who).from(table).select("id").eq("restaurant_id", rid));
        }
      }
      expectNoRows(await as(who).from("print_jobs").select("id"));
      // itens ocultos do cardápio (não públicos) também ficam fechados
      expectNoRows(await as(who).from("products").select("id").eq("id", A().hiddenProductId));
      expectNoRows(await as(who).from("profiles").select("id").eq("id", world().users.ownerA.id));
      expect((await as(who).rpc("has_permission", { rid: A().id, perm: "orders.view" })).data).toBe(false);
      expect((await as(who).rpc("has_support_access", { rid: A().id })).data).toBe(false);
    });
  }

  it("a plataforma enxerga a existência dos restaurantes (restaurants) mas não o conteúdo", async () => {
    const r = await as("superadmin").from("restaurants").select("id,slug");
    expectOk(r);
    const ids = rows(r).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([A().id, B().id]));
  });
});

describe("abrir sessão: quem pode, validações e auditoria", () => {
  it("usuário comum, dono, gerente e garçom NÃO abrem sessão de suporte", async () => {
    for (const who of ["plain", "ownerA", "managerA", "waiterA", "ownerB"] as const) {
      expectRule(await open(who), /forbidden/);
    }
    expect(rows(await admin().from("support_sessions").select("id").eq("restaurant_id", A().id).is("ended_at", null))).toHaveLength(0);
  });

  it("validações: motivo >= 10 caracteres úteis, <= 500; duração 1..60; restaurante existente", async () => {
    const countBefore = rows(await admin().from("support_sessions").select("id").eq("restaurant_id", A().id)).length;
    expectRule(await open("superadmin", A().id, "curto"), /invalid_reason/);
    expectRule(await open("superadmin", A().id, "         x          "), /invalid_reason/);
    expectRule(await open("superadmin", A().id, "x".repeat(501)), /invalid_reason/);
    expectRule(await open("superadmin", A().id, REASON, 0), /invalid_duration/);
    expectRule(await open("superadmin", A().id, REASON, 61), /invalid_duration/);
    const nul = await as("superadmin").rpc("open_support_session", { p_restaurant: A().id, p_reason: REASON, p_minutes: null });
    expectRule(nul, /invalid_duration/);
    expectRule(await open("superadmin", "00000000-0000-4000-8000-00000000dead"), /restaurant_not_found/);
    expect(rows(await admin().from("support_sessions").select("id").eq("restaurant_id", A().id))).toHaveLength(countBefore);
  });

  it("sessão aberta grava motivo/expiração e vai para audit_logs; o dono do restaurante enxerga o acesso, o gerente não", async () => {
    const res = await open("superadmin", A().id, REASON, 15);
    expectOk(res);
    const sid = res.data as string;

    const s = await admin().from("support_sessions").select("*").eq("id", sid).single();
    expect(s.data).toMatchObject({ restaurant_id: A().id, admin_id: world().users.superadmin.id, reason: REASON, ended_at: null });
    const mins = (new Date(s.data!.expires_at).getTime() - new Date(s.data!.started_at).getTime()) / 60_000;
    expect(Math.round(mins)).toBe(15);

    const audit = await admin().from("audit_logs").select("actor_id,metadata,resource_id").eq("restaurant_id", A().id).eq("action", "support.session_opened").eq("resource_id", sid);
    expect(audit.data).toEqual([{ actor_id: world().users.superadmin.id, metadata: { reason: REASON, minutes: 15 }, resource_id: sid }]);

    // transparência: dono (team.manage) vê quem acessou e por quê
    const ownerView = await as("ownerA").from("audit_logs").select("action,metadata").eq("resource_id", sid);
    expect(rows(ownerView)).toHaveLength(1);
    expect(rows(ownerView)[0].metadata.reason).toBe(REASON);
    const ownerSessions = await as("ownerA").from("support_sessions").select("id,reason,admin_id").eq("id", sid);
    expect(rows(ownerSessions)).toHaveLength(1);
    // gerente não tem team.manage; dono de B não vê
    expectNoRows(await as("managerA").from("audit_logs").select("id").eq("resource_id", sid));
    expectNoRows(await as("managerA").from("support_sessions").select("id").eq("id", sid));
    expectNoRows(await as("ownerB").from("audit_logs").select("id").eq("resource_id", sid));
    expectNoRows(await as("ownerB").from("support_sessions").select("id").eq("id", sid));
  });

  it("abrir de novo encerra a sessão anterior do mesmo admin no mesmo restaurante (sem acumular)", async () => {
    const first = (await open("superadmin")).data as string;
    const second = (await open("superadmin")).data as string;
    expect(second).not.toBe(first);
    const active = await admin().from("support_sessions").select("id").eq("admin_id", world().users.superadmin.id).eq("restaurant_id", A().id).is("ended_at", null);
    expect(rows(active).map((x) => x.id)).toEqual([second]);
  });

  it("ninguém escreve em support_sessions pela API (nem o próprio admin)", async () => {
    const sid = (await open("superadmin")).data as string;
    expectDenied(
      await as("superadmin")
        .from("support_sessions")
        .insert({ restaurant_id: B().id, admin_id: world().users.superadmin.id, reason: "sessao forjada direto", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
        .select("id"),
    );
    expectDenied(await as("superadmin").from("support_sessions").update({ expires_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", sid).select("id"));
    expectDenied(await as("superadmin").from("support_sessions").delete().eq("id", sid).select("id"));
    expect(rows(await admin().from("support_sessions").select("id").eq("restaurant_id", B().id))).toHaveLength(0);
  });
});

describe("com sessão aberta: leitura sim, escrita não", () => {
  for (const who of ["superadmin", "support"] as const) {
    it(`${who}: lê pedidos/clientes/pagamentos/comandas/mesas/vínculos de A, mas nada de B`, async () => {
      expectOk(await open(who));
      for (const [table, min] of READABLE_WITH_SESSION) {
        const r = await as(who).from(table).select("restaurant_id").eq("restaurant_id", A().id);
        expectOk(r);
        expect(rows(r).length, table).toBeGreaterThanOrEqual(min);
        // assinaturas são legíveis por qualquer admin da plataforma (cobrança), com ou sem sessão
        if (table !== "subscriptions") expectNoRows(await as(who).from(table).select("restaurant_id").eq("restaurant_id", B().id));
      }
      expect(rows(await as(who).from("products").select("id").eq("id", A().hiddenProductId))).toHaveLength(1);
      expect(rows(await as(who).from("orders").select("id,customer_phone").eq("id", A().orderIds[0]))).toHaveLength(1);
      expect((await as(who).rpc("has_support_access", { rid: A().id })).data).toBe(true);
      expect((await as(who).rpc("has_support_access", { rid: B().id })).data).toBe(false);
      // sessão não é vínculo: nenhuma permissão operacional/administrativa
      expect((await as(who).rpc("is_member", { rid: A().id })).data).toBe(false);
      expect((await as(who).rpc("my_permissions", { rid: A().id })).data).toEqual([]);
    });
  }

  it("não escreve: pedidos, comandas, mesas, cardápio, clientes, pagamentos, equipe e configurações ficam intactos", async () => {
    expectOk(await open("superadmin"));
    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    const sa = as("superadmin");
    const snapshot = async () => ({
      order: await orderRow(order.id),
      tab: (await admin().from("tabs").select("*").eq("id", A().tabId).single()).data,
      table: (await admin().from("restaurant_tables").select("*").eq("id", A().tableIds[3]).single()).data,
      product: (await admin().from("products").select("*").eq("id", A().productId).single()).data,
      customer: (await admin().from("customers").select("*").eq("id", A().customerId).single()).data,
      settings: (await admin().from("restaurant_settings").select("*").eq("restaurant_id", A().id).single()).data,
      members: (await admin().from("restaurant_memberships").select("*").eq("restaurant_id", A().id).order("id")).data,
      payment: (await admin().from("payments").select("*").eq("id", A().paymentId).single()).data,
    });
    const before = await snapshot();

    expectNotApplied(await sa.from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));
    expectNotApplied(await sa.from("orders").update({ status: "CANCELLED", status_reason: "suporte" }).eq("id", order.id).select("id"));
    expectNotApplied(await sa.from("tabs").update({ status: "CLOSED" }).eq("id", A().tabId).select("id"));
    expectDenied(await sa.from("tabs").insert({ restaurant_id: A().id, status: "OPEN", total_cents: 0, opened_by: world().users.superadmin.id }).select("id"));
    expectNotApplied(await sa.from("restaurant_tables").update({ status: "OCCUPIED" }).eq("id", A().tableIds[3]).select("id"));
    expectDenied(await sa.from("restaurant_tables").insert({ restaurant_id: A().id, name: "zz-support" }).select("id"));
    expectNotApplied(await sa.from("products").update({ price_cents: 1 }).eq("id", A().productId).select("id"));
    expectDenied(await sa.from("products").insert({ restaurant_id: A().id, name: "zz-support", price_cents: 1 }).select("id"));
    expectNotApplied(await sa.from("products").delete().eq("id", A().productId).select("id"));
    expectNotApplied(await sa.from("customers").update({ name: "HACKED" }).eq("id", A().customerId).select("id"));
    expectDenied(await sa.from("customers").insert({ restaurant_id: A().id, name: "zz-support" }).select("id"));
    expectNotApplied(await sa.from("restaurant_settings").update({ accepts_orders: false }).eq("restaurant_id", A().id).select("restaurant_id"));
    expectDenied(await sa.from("payments").insert({ restaurant_id: A().id, order_id: order.id, method: "CASH", amount_cents: 100, status: "PAID", paid_at: new Date().toISOString() }).select("id"));
    expectDenied(await sa.from("restaurant_memberships").update({ role: "owner" }).eq("restaurant_id", A().id).select("id"));
    expectDenied(await sa.from("print_jobs").insert({ restaurant_id: A().id, document_type: "KITCHEN_TICKET", order_id: order.id, requested_by: world().users.superadmin.id }).select("id"));
    expectRule(await sa.rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "manager" }), /forbidden/);
    expectRule(await sa.rpc("change_member_role", { p_membership: world().memberships.waiterA, p_role: "manager" }), /forbidden/);
    expectRule(await sa.rpc("revoke_member", { p_membership: world().memberships.waiterA }), /forbidden/);
    expectRule(await sa.rpc("set_member_permission", { p_membership: world().memberships.waiterA, p_permission: "orders.accept", p_granted: true }), /forbidden/);

    expect(await snapshot()).toEqual(before);
  });

  it("sessão de A não vaza para B nem para quem não abriu (outro admin segue sem acesso)", async () => {
    expectOk(await open("superadmin"));
    expectNoRows(await as("support").from("orders").select("id").eq("restaurant_id", A().id));
    expectNoRows(await as("superadmin").from("orders").select("id").eq("restaurant_id", B().id));
    expectNoRows(await as("plain").from("orders").select("id").eq("restaurant_id", A().id));
  });

  it("storage: com sessão de suporte, upload no bucket do restaurante continua negado", async () => {
    expectOk(await open("superadmin"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const up = await as("superadmin").storage.from("restaurant-public").upload(`restaurants/${A().id}/products/zz-support-${uniq()}.png`, png, { contentType: "image/png" });
    expect(up.error).not.toBeNull();
  });
});

describe("encerramento, expiração e perda de privilégio", () => {
  it("close_support_session: o acesso some na hora (mesmo JWT) e fica auditado; só o próprio admin encerra", async () => {
    const sid = (await open("superadmin")).data as string;
    expect(rows(await as("superadmin").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);

    // outro admin, dono e usuário comum não encerram a sessão alheia
    for (const who of ["support", "ownerA", "plain"] as const) {
      expectRule(await as(who).rpc("close_support_session", { p_session: sid }), /forbidden/);
    }
    expect((await admin().from("support_sessions").select("ended_at").eq("id", sid).single()).data?.ended_at).toBeNull();

    expectOk(await as("superadmin").rpc("close_support_session", { p_session: sid }));
    expectNoRows(await as("superadmin").from("orders").select("id").eq("restaurant_id", A().id));
    expectNoRows(await as("superadmin").from("customers").select("id").eq("restaurant_id", A().id));
    expect((await as("superadmin").rpc("has_support_access", { rid: A().id })).data).toBe(false);

    const audit = await admin().from("audit_logs").select("actor_id,metadata").eq("resource_id", sid).eq("action", "support.session_closed");
    expect(audit.data).toEqual([{ actor_id: world().users.superadmin.id, metadata: { expired: false } }]);

    // idempotente: fechar de novo não duplica auditoria
    expectOk(await as("superadmin").rpc("close_support_session", { p_session: sid }));
    expect(rows(await admin().from("audit_logs").select("id").eq("resource_id", sid).eq("action", "support.session_closed"))).toHaveLength(1);
  });

  it("sessão expirada nega acesso mesmo sem encerramento explícito", async () => {
    const sid = (await open("superadmin", A().id, REASON, 5)).data as string;
    expect(rows(await as("superadmin").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    const past = Date.now() - 2 * 3_600_000;
    expectOk(await admin().from("support_sessions").update({ started_at: new Date(past).toISOString(), expires_at: new Date(past + 30 * 60_000).toISOString() }).eq("id", sid));
    expectNoRows(await as("superadmin").from("orders").select("id").eq("restaurant_id", A().id));
    expect((await as("superadmin").rpc("has_support_access", { rid: A().id })).data).toBe(false);
  });

  it("a duração máxima é imposta pelo banco (60 min), inclusive para o service role", async () => {
    const r = await admin().from("support_sessions").insert({ restaurant_id: A().id, admin_id: world().users.superadmin.id, reason: "duração acima do limite permitido", expires_at: new Date(Date.now() + 61 * 60_000).toISOString() });
    expect(r.error?.code).toBe("23514");
    const r2 = await admin().from("support_sessions").insert({ restaurant_id: A().id, admin_id: world().users.superadmin.id, reason: "curto", expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect(r2.error?.code).toBe("23514");
  });

  it("perder o papel de admin da plataforma invalida a sessão (has_support_access exige is_platform_admin)", async () => {
    expectOk(await open("support"));
    expect(rows(await as("support").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
    try {
      expectOk(await admin().from("platform_admins").delete().eq("user_id", world().users.support.id));
      expectNoRows(await as("support").from("orders").select("id").eq("restaurant_id", A().id));
      expectNoRows(await as("support").from("audit_logs").select("id").eq("restaurant_id", A().id));
    } finally {
      await admin().from("platform_admins").upsert({ user_id: world().users.support.id, role: "support" }, { onConflict: "user_id" });
    }
    // sessão ainda aberta no banco: ao restaurar o papel, volta a valer (documenta o comportamento)
    expect(rows(await as("support").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
  });
});
