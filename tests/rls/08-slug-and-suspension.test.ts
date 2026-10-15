/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * - A autorização NÃO depende do slug: renomear o slug (plataforma) não muda quem acessa o quê;
 *   usar restaurant_id de B com sessão de A continua negado; chamadas REST/GraphQL/Auth diretas
 *   (sem passar pelo app) continuam bloqueadas.
 * - Restaurante suspenso corta o acesso a dados imediatamente (mesmo JWT), pendente não é público.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, anon, as, rawRest, tokenOf, world } from "../helpers/clients";
import { loadEnv } from "../../scripts/lib/env";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup, makeOrder, makeTable, orderRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

async function restoreA() {
  await admin().from("restaurants").update({ slug: "demo-a", status: "active", name: "DEMO Restaurante A" }).eq("id", A().id);
}

describe("autorização independe do slug", () => {
  it("renomear o slug pela plataforma não muda nenhum acesso (mesmo JWT, mesmas permissões)", async () => {
    const newSlug = `demo-a-renomeado-${uniq()}`.slice(0, 50);
    try {
      const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
      const rename = await admin().from("restaurants").update({ slug: newSlug }).eq("id", A().id);
      expectOk(rename);

      // a equipe segue com exatamente as mesmas permissões
      expect(rows(await as("ownerA").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
      expect(((await as("ownerA").rpc("my_permissions", { rid: A().id })).data as string[]).includes("team.manage")).toBe(true);
      expect((await as("ownerA").rpc("has_permission", { rid: A().id, perm: "orders.accept" })).data).toBe(false);
      expectOk(await as("cashierA").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));
      expect((await orderRow(order.id)).status).toBe("CONFIRMED");
      expect(rows(await as("kitchenA").from("tabs").select("id"))).toHaveLength(0); // continua sem tabs.view

      const mine = await as("managerA").rpc("my_restaurants");
      expect(rows(mine)).toEqual([expect.objectContaining({ restaurant_id: A().id, slug: newSlug, role: "manager" })]);

      // B continua isolado, e agora também sob o slug novo de A
      expectNoRows(await as("ownerB").from("orders").select("id").eq("restaurant_id", A().id));
      expectNoRows(await as("ownerA").from("orders").select("id").eq("restaurant_id", B().id));

      // público: slug antigo some, novo resolve para o MESMO id
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: "demo-a" }))).toHaveLength(0);
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: newSlug }))[0]?.id).toBe(A().id);

      // auditoria da troca
      const audit = await admin().from("audit_logs").select("action,metadata").eq("restaurant_id", A().id).eq("action", "restaurant.updated_by_platform").order("created_at", { ascending: false }).limit(1);
      expect(rows(audit)[0].metadata).toMatchObject({ slug_from: "demo-a", slug_to: newSlug });
    } finally {
      await restoreA();
    }
    expect((await admin().from("restaurants").select("slug").eq("id", A().id).single()).data?.slug).toBe("demo-a");
  });

  it("tomar o slug antigo não dá acesso a nada: o novo dono do slug 'demo-a' não enxerga o tenant A", async () => {
    const holder = `demo-a-parked-${uniq()}`.slice(0, 50);
    let squatterId: string | undefined;
    try {
      expectOk(await admin().from("restaurants").update({ slug: holder }).eq("id", A().id));
      const sq = await admin().from("restaurants").insert({ name: "zz DEMO Squatter", slug: "demo-a", status: "active" }).select("id").single();
      expectOk(sq);
      squatterId = sq.data!.id as string;
      // o slug 'demo-a' agora resolve para OUTRO restaurante...
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: "demo-a" }))[0]?.id).toBe(squatterId);
      // ...mas a equipe de A continua autorizada só por vínculo, e ninguém ganha acesso por slug
      expect(rows(await as("ownerA").from("orders").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
      expect(rows(await as("ownerA").from("orders").select("id").eq("restaurant_id", squatterId))).toHaveLength(0);
      expect((await as("ownerA").rpc("is_member", { rid: squatterId })).data).toBe(false);
    } finally {
      if (squatterId) await admin().from("restaurants").delete().eq("id", squatterId);
      await restoreA();
    }
  });

  it("slug e status só a plataforma altera: superadmin altera pela API (auditado); suporte não", async () => {
    const newSlug = `demo-a-sa-${uniq()}`.slice(0, 50);
    try {
      expectNotApplied(await as("support").from("restaurants").update({ slug: newSlug }).eq("id", A().id).select("id"));
      expect((await admin().from("restaurants").select("slug").eq("id", A().id).single()).data?.slug).toBe("demo-a");

      const ok = await as("superadmin").from("restaurants").update({ slug: newSlug }).eq("id", A().id).select("id,slug");
      expectOk(ok);
      expect(rows(ok)).toHaveLength(1);
      const audit = await admin().from("audit_logs").select("actor_id,metadata").eq("restaurant_id", A().id).eq("action", "restaurant.updated_by_platform").order("created_at", { ascending: false }).limit(1);
      expect(rows(audit)[0]).toMatchObject({ actor_id: world().users.superadmin.id, metadata: expect.objectContaining({ slug_to: newSlug }) });
    } finally {
      await restoreA();
    }
  });

  it("slug inválido/reservado/duplicado é barrado pelo banco", async () => {
    for (const slug of ["admin", "api", "Demo-A", "demo a", "ab", "demo-b", "-demo", "demo--x_y"]) {
      const r = await admin().from("restaurants").update({ slug }).eq("id", A().id);
      expect(r.error, `slug ${slug} deveria falhar`).not.toBeNull();
      expect(r.error!.code).toMatch(/23514|23505/);
    }
    expect((await admin().from("restaurants").select("slug").eq("id", A().id).single()).data?.slug).toBe("demo-a");
  });
});

describe("restaurant_id/slug vindos do cliente nunca concedem acesso (API direta, sem o app)", () => {
  it("REST cru com o JWT de A: filtros por restaurant_id de B devolvem [] e escritas não afetam B", async () => {
    const tokenA = tokenOf("managerA");
    const order = await makeOrder(cleanup, B().id, { status: "RECEIVED" });

    const read = await rawRest(`/rest/v1/orders?select=id,restaurant_id&restaurant_id=eq.${B().id}`, { token: tokenA });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([]);
    const readById = await rawRest(`/rest/v1/orders?select=id&id=eq.${order.id}`, { token: tokenA });
    expect(readById.body).toEqual([]);
    const readOr = await rawRest(`/rest/v1/orders?select=id,restaurant_id&or=(restaurant_id.eq.${B().id},restaurant_id.eq.${A().id})`, { token: tokenA });
    expect((readOr.body as any[]).length).toBeGreaterThan(0);
    expect((readOr.body as any[]).every((o) => o.restaurant_id === A().id)).toBe(true);
    const all = await rawRest(`/rest/v1/orders?select=restaurant_id&limit=1000`, { token: tokenA });
    expect((all.body as any[]).some((o) => o.restaurant_id === B().id)).toBe(false);

    const patch = await rawRest(`/rest/v1/orders?id=eq.${order.id}`, { method: "PATCH", token: tokenA, body: { status: "CANCELLED", status_reason: "x" }, headers: { Prefer: "return=representation" } });
    expect([200, 204]).toContain(patch.status);
    if (patch.status === 200) expect(patch.body).toEqual([]);
    expect((await orderRow(order.id)).status).toBe("RECEIVED");

    const post = await rawRest(`/rest/v1/products`, { method: "POST", token: tokenA, body: { restaurant_id: B().id, name: "zz-evil", price_cents: 1 }, headers: { Prefer: "return=representation" } });
    expect(post.status).toBe(403);
    expect(JSON.stringify(post.body)).toMatch(/row-level security|42501/);
    const del = await rawRest(`/rest/v1/products?id=eq.${B().productId}`, { method: "DELETE", token: tokenA, headers: { Prefer: "return=representation" } });
    expect(del.status === 200 ? del.body : []).toEqual([]);
    expect(rows(await admin().from("products").select("id").eq("id", B().productId))).toHaveLength(1);

    const rpc = await rawRest(`/rest/v1/rpc/change_member_role`, { method: "POST", token: tokenA, body: { p_membership: world().memberships.waiterB, p_role: "manager" } });
    expect(rpc.status).toBe(403);
    expect(JSON.stringify(rpc.body)).toMatch(/forbidden/);
  });

  it("cabeçalhos/parâmetros que 'declaram' o tenant são ignorados (x-restaurant-id, slug, role)", async () => {
    const tokenA = tokenOf("waiterA");
    const hdr = { "x-restaurant-id": B().id, "x-restaurant-slug": "demo-b", "x-forwarded-host": "demo-b.example.test", "x-user-role": "owner" };
    const r = await rawRest(`/rest/v1/orders?select=restaurant_id&restaurant_slug=eq.demo-b&slug=eq.demo-b`, { token: tokenA, headers: hdr });
    // coluna inexistente => erro de PostgREST (nunca dados de B)
    if (r.status === 200) expect((r.body as any[]).some((o) => o.restaurant_id === B().id)).toBe(false);
    else expect([400, 404]).toContain(r.status);
    const r2 = await rawRest(`/rest/v1/orders?select=restaurant_id`, { token: tokenA, headers: hdr });
    expect(r2.status).toBe(200);
    expect((r2.body as any[]).some((o) => o.restaurant_id === B().id)).toBe(false);
    expect((r2.body as any[]).length).toBeGreaterThan(0);
  });

  it("schemas não expostos (auth, storage, app_private) não são alcançáveis via Accept-Profile", async () => {
    const tokenA = tokenOf("ownerA");
    for (const [schema, table] of [
      ["auth", "users"],
      ["app_private", "anything"],
      ["storage", "objects"],
      ["extensions", "pg_stat_statements"],
    ]) {
      const r = await rawRest(`/rest/v1/${table}?select=*`, { token: tokenA, headers: { "Accept-Profile": schema } });
      expect([400, 401, 403, 404, 406], `${schema}.${table} => ${r.status}`).toContain(r.status);
      expect(Array.isArray(r.body) && r.body.length > 0).toBe(false);
    }
  });

  it("API admin do Auth não é acessível com JWT de usuário (listar/apagar usuários)", async () => {
    const env = loadEnv();
    for (const who of ["ownerA", "superadmin"] as const) {
      const list = await fetch(`${env.url}/auth/v1/admin/users`, { headers: { apikey: env.anonKey, Authorization: `Bearer ${tokenOf(who)}` } });
      expect([401, 403]).toContain(list.status);
      const del = await fetch(`${env.url}/auth/v1/admin/users/${world().users.ownerB.id}`, { method: "DELETE", headers: { apikey: env.anonKey, Authorization: `Bearer ${tokenOf(who)}` } });
      expect([401, 403]).toContain(del.status);
    }
    expect((await admin().auth.admin.getUserById(world().users.ownerB.id)).data.user?.id).toBe(world().users.ownerB.id);
  });

  it("GraphQL (quando pg_graphql estiver habilitado) respeita o mesmo RLS; hoje a extensão está desligada no Supabase local", async () => {
    const env = loadEnv();
    const gql = async (token: string, query: string) => {
      const res = await fetch(`${env.url}/graphql/v1`, { method: "POST", headers: { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    const q = `{ ordersCollection(first: 200) { edges { node { id restaurant_id customer_phone } } } }`;
    const anonRes = await gql(env.anonKey, q);
    const anonEdges = anonRes.body?.data?.ordersCollection?.edges ?? [];
    expect(anonEdges).toHaveLength(0);
    const waiter = await gql(tokenOf("waiterA"), q);
    if (waiter.status === 200 && waiter.body?.data?.ordersCollection) {
      const edges = waiter.body.data.ordersCollection.edges as any[];
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every((e) => e.node.restaurant_id === A().id)).toBe(true);
    }
    const profiles = await gql(env.anonKey, `{ profilesCollection(first: 50) { edges { node { id full_name } } } }`);
    expect(profiles.body?.data?.profilesCollection?.edges ?? []).toHaveLength(0);
  });
});

describe("restaurante suspenso/pendente", () => {
  it("suspenso: toda a equipe perde acesso a dados na hora (mesmo JWT) e o público some; reativar devolve", async () => {
    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    try {
      // antes: acesso normal
      expect(rows(await as("ownerA").from("orders").select("id").eq("id", order.id))).toHaveLength(1);
      expect(rows(await anon().from("products").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);

      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", A().id));

      for (const who of ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA"] as const) {
        expectNoRows(await as(who).from("orders").select("id").eq("id", order.id));
        expectNoRows(await as(who).from("products").select("id").eq("restaurant_id", A().id));
        expectNoRows(await as(who).from("restaurant_tables").select("id").eq("restaurant_id", A().id));
        expect((await as(who).rpc("is_member", { rid: A().id })).data).toBe(false);
        expect((await as(who).rpc("my_permissions", { rid: A().id })).data).toEqual([]);
      }
      expectNoRows(await as("ownerA").from("restaurants").select("id").eq("id", A().id));
      expectNotApplied(await as("ownerA").from("restaurants").update({ name: "HACKED" }).eq("id", A().id).select("id"));
      expectNotApplied(await as("cashierA").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id"));
      expectDenied(await as("managerA").from("products").insert({ restaurant_id: A().id, name: "zz-susp", price_cents: 1 }).select("id"));
      expectRule(await as("ownerA").rpc("invite_member", { p_restaurant: A().id, p_email: `zz-${uniq()}@example.test`, p_role: "waiter" }), /forbidden/);
      expect((await orderRow(order.id)).status).toBe("RECEIVED");

      // público: nada
      expect(rows(await anon().from("products").select("id").eq("restaurant_id", A().id))).toHaveLength(0);
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: "demo-a" }))).toHaveLength(0);

      // my_restaurants ainda informa o status (a UI mostra o aviso)
      const mine = await as("ownerA").rpc("my_restaurants");
      expect(rows(mine)).toEqual([expect.objectContaining({ restaurant_id: A().id, status: "suspended" })]);

      // B não é afetado
      expect(rows(await as("ownerB").from("orders").select("id").eq("restaurant_id", B().id)).length).toBeGreaterThan(0);

      // plataforma ainda vê a linha do restaurante, mas não os pedidos
      expect(rows(await as("superadmin").from("restaurants").select("id,status").eq("id", A().id))).toEqual([{ id: A().id, status: "suspended" }]);
      expectNoRows(await as("superadmin").from("orders").select("id").eq("id", order.id));

      // reativação restaura o acesso imediatamente
      expectOk(await admin().from("restaurants").update({ status: "active" }).eq("id", A().id));
      expect(rows(await as("ownerA").from("orders").select("id").eq("id", order.id))).toHaveLength(1);
      expect((await as("cashierA").rpc("has_permission", { rid: A().id, perm: "orders.accept" })).data).toBe(true);
    } finally {
      await restoreA();
    }
  });

  it("pendente: a equipe opera (configuração antes da ativação), mas o público não vê nada", async () => {
    try {
      expectOk(await admin().from("restaurants").update({ status: "pending" }).eq("id", A().id));
      expect(rows(await as("managerA").from("products").select("id").eq("restaurant_id", A().id)).length).toBeGreaterThan(0);
      expect(rows(await anon().from("products").select("id").eq("restaurant_id", A().id))).toHaveLength(0);
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: "demo-a" }))).toHaveLength(0);
      expect(rows(await anon().from("restaurant_settings").select("restaurant_id").eq("restaurant_id", A().id))).toHaveLength(0);
    } finally {
      await restoreA();
    }
  });

  it("restaurante suspenso: membros não leem profiles dos colegas via shares_restaurant_with", async () => {
    try {
      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", A().id));
      expectNoRows(await as("waiterA").from("profiles").select("id").eq("id", world().users.ownerA.id));
      expect(rows(await as("waiterA").from("profiles").select("id").eq("id", world().users.waiterA.id))).toHaveLength(1); // o próprio perfil segue legível
    } finally {
      await restoreA();
    }
  });

  it("nova mesa/pedido criados enquanto suspenso não ficam acessíveis por sessões antigas", async () => {
    const table = await makeTable(cleanup, A().id);
    try {
      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", A().id));
      expectNoRows(await as("waiterA").from("restaurant_tables").select("id").eq("id", table.id));
      expectNotApplied(await as("waiterA").from("restaurant_tables").update({ status: "OCCUPIED" }).eq("id", table.id).select("id"));
    } finally {
      await restoreA();
    }
  });
});
