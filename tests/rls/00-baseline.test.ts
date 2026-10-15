/**
 * Baseline: prova que o ambiente de teste é real e que os testes seguintes não são vacuosos.
 *  - login real (signInWithPassword) funciona e emite JWT "authenticated";
 *  - o seed deixou dados em A e B em TODAS as tabelas de domínio (senão "0 linhas" não provaria nada);
 *  - tokens forjados/adulterados e chaves erradas são rejeitados pelo gateway.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { ACCOUNTS, TEST_PASSWORD } from "../fixtures/accounts";
import { admin, anon, as, rawRest, signInAs, tokenOf, world } from "../helpers/clients";
import { rows } from "../helpers/expect";

function decodeJwt(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("autenticação real", () => {
  it("signInWithPassword emite JWT de usuário (role authenticated, sub = id da conta)", async () => {
    const { token, userId } = await signInAs(ACCOUNTS.ownerA.email, TEST_PASSWORD);
    const claims = decodeJwt(token);
    expect(claims.role).toBe("authenticated");
    expect(claims.sub).toBe(userId);
    expect(userId).toBe(world().users.ownerA.id);
  });

  it("senha errada é rejeitada", async () => {
    const env = loadEnv();
    const c = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
    const { data, error } = await c.auth.signInWithPassword({ email: ACCOUNTS.ownerA.email, password: "senha-errada-123" });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("os tokens de cada conta carregam o sub correto", () => {
    for (const key of ["ownerA", "waiterB", "superadmin"] as const) {
      expect(decodeJwt(tokenOf(key)).sub).toBe(world().users[key].id);
    }
  });
});

describe("gateway rejeita credenciais inválidas", () => {
  it("JWT com assinatura adulterada (claim role=service_role) => 401", async () => {
    const [h, , s] = tokenOf("waiterA").split(".");
    const claims = decodeJwt(tokenOf("waiterA"));
    claims.role = "service_role";
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const res = await rawRest("/rest/v1/orders?select=id", { token: `${h}.${forgedPayload}.${s}` });
    expect(res.status).toBe(401);
  });

  it("JWT forjado com sub de outro usuário e segredo errado => 401", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ role: "authenticated", sub: world().users.ownerB.id, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const res = await rawRest("/rest/v1/orders?select=id", { token: `${header}.${payload}.AAAA` });
    expect(res.status).toBe(401);
  });

  it("sem apikey o gateway local trata como anônimo: só dado público, nunca tabelas privadas", async () => {
    const env = loadEnv();
    const orders = await fetch(`${env.url}/rest/v1/orders?select=id`);
    expect([200, 401, 403]).toContain(orders.status);
    if (orders.status === 200) expect(await orders.json()).toEqual([]);
    const profiles = await fetch(`${env.url}/rest/v1/profiles?select=id`);
    if (profiles.status === 200) expect(await profiles.json()).toEqual([]);
  });

  it("a chave anon não é aceita como se fosse service role (RLS continua valendo)", async () => {
    const res = await rawRest("/rest/v1/orders?select=id", { token: null });
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) expect(res.body).toEqual([]);
  });
});

describe("seed realmente populou os dois tenants (testes de 0 linhas não são vacuosos)", () => {
  const tenantTables = [
    "menu_categories",
    "products",
    "modifier_groups",
    "modifiers",
    "business_hours",
    "business_hour_exceptions",
    "delivery_zones",
    "restaurant_settings",
    "customers",
    "customer_addresses",
    "restaurant_tables",
    "tabs",
    "orders",
    "order_items",
    "payments",
    "restaurant_memberships",
    "subscriptions",
  ];
  for (const table of tenantTables) {
    it(`${table}: A e B têm linhas`, async () => {
      for (const key of ["a", "b"] as const) {
        const { count, error } = await admin()
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("restaurant_id", world().restaurants[key].id);
        expect(error).toBeNull();
        expect(count, `${table} em ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it("owner A enxerga o próprio restaurante e só ele", async () => {
    const res = await as("ownerA").from("restaurants").select("id,slug");
    expect(res.error).toBeNull();
    expect(rows(res).map((r) => r.id)).toEqual([world().restaurants.a.id]);
  });

  it("anon enxerga o cardápio público dos dois restaurantes ativos", async () => {
    const res = await anon().from("products").select("id,restaurant_id").in("restaurant_id", [world().restaurants.a.id, world().restaurants.b.id]);
    expect(res.error).toBeNull();
    const ids = new Set(rows(res).map((r) => r.restaurant_id));
    expect(ids.has(world().restaurants.a.id) && ids.has(world().restaurants.b.id)).toBe(true);
  });
});
