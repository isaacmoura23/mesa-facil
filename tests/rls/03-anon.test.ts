/**
 * Visitante anônimo (chave anon, sem login): só o que é público por desenho — cardápio, horários,
 * zonas, configurações de restaurantes ATIVOS e resolve_restaurant_by_slug. Nada de pedidos,
 * clientes, pagamentos, comandas, mesas, auditoria, vínculos, perfis; nenhuma escrita.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectOk, rows } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;

describe("anon lê somente dados públicos de restaurantes ativos", () => {
  const publicTables = [
    "menu_categories",
    "products",
    "modifier_groups",
    "modifiers",
    "product_modifier_groups",
    "restaurant_settings",
    "business_hours",
    "business_hour_exceptions",
    "delivery_zones",
  ];

  for (const table of publicTables) {
    it(`${table}: legível para A e B (ambos ativos)`, async () => {
      const res = await anon().from(table).select("restaurant_id").in("restaurant_id", [A().id, B().id]);
      expectOk(res);
      const seen = new Set(rows(res).map((r) => r.restaurant_id));
      expect(seen.has(A().id)).toBe(true);
      expect(seen.has(B().id)).toBe(true);
    });
  }

  it("itens inativos (produto, categoria, zona) ficam ocultos; ativos aparecem", async () => {
    const prods = rows(await anon().from("products").select("id,is_active").eq("restaurant_id", A().id));
    expect(prods.length).toBeGreaterThan(0);
    expect(prods.every((p) => p.is_active)).toBe(true);
    expect(prods.map((p) => p.id)).not.toContain(A().hiddenProductId);
    expect(rows(await anon().from("products").select("id").eq("id", A().hiddenProductId))).toHaveLength(0);

    const cats = rows(await anon().from("menu_categories").select("name").eq("restaurant_id", A().id));
    expect(cats.map((c) => c.name)).not.toContain("DEMO Categoria Oculta");
    expect(cats.map((c) => c.name)).toContain("DEMO Lanches");

    const zones = rows(await anon().from("delivery_zones").select("name").eq("restaurant_id", A().id));
    expect(zones.map((z) => z.name)).toEqual(["DEMO Centro"]);
  });

  it("restaurante pendente/suspenso desaparece do público (cardápio, horários, zonas, settings, slug)", async () => {
    const cleanup = new Cleanup();
    try {
      const slug = `zz-anon-${uniq()}`.slice(0, 40);
      const ins = await admin().from("restaurants").insert({ name: "zz DEMO Pendente", slug, status: "pending" }).select("id").single();
      expectOk(ins);
      const rid = ins.data!.id as string;
      cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rid)));
      expectOk(await admin().from("products").insert({ restaurant_id: rid, name: "zz-publico", price_cents: 100 }));
      expectOk(await admin().from("menu_categories").insert({ restaurant_id: rid, name: "zz-cat" }));
      expectOk(await admin().from("business_hours").insert({ restaurant_id: rid, weekday: 1, opens_at: "10:00", closes_at: "22:00" }));
      expectOk(await admin().from("delivery_zones").insert({ restaurant_id: rid, name: "zz-zona" }));

      const probe = async () => ({
        products: rows(await anon().from("products").select("id").eq("restaurant_id", rid)).length,
        categories: rows(await anon().from("menu_categories").select("id").eq("restaurant_id", rid)).length,
        hours: rows(await anon().from("business_hours").select("id").eq("restaurant_id", rid)).length,
        zones: rows(await anon().from("delivery_zones").select("id").eq("restaurant_id", rid)).length,
        settings: rows(await anon().from("restaurant_settings").select("restaurant_id").eq("restaurant_id", rid)).length,
        slug: rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: slug })).length,
      });

      expect(await probe()).toEqual({ products: 0, categories: 0, hours: 0, zones: 0, settings: 0, slug: 0 });
      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", rid));
      expect(await probe()).toEqual({ products: 0, categories: 0, hours: 0, zones: 0, settings: 0, slug: 0 });
      expectOk(await admin().from("restaurants").update({ status: "active" }).eq("id", rid));
      expect(await probe()).toEqual({ products: 1, categories: 1, hours: 1, zones: 1, settings: 1, slug: 1 });
    } finally {
      await cleanup.run();
    }
  });
});

describe("resolve_restaurant_by_slug (único endpoint público de tenant)", () => {
  it("resolve restaurante ativo devolvendo somente id/slug/name/status/logo_path", async () => {
    const res = await anon().rpc("resolve_restaurant_by_slug", { p_slug: "demo-a" });
    expectOk(res);
    expect(rows(res)).toHaveLength(1);
    expect(Object.keys(rows(res)[0]).sort()).toEqual(["id", "logo_path", "name", "slug", "status"]);
    expect(rows(res)[0]).toMatchObject({ id: A().id, slug: "demo-a", status: "active" });
  });

  it("normaliza caixa/espacos; slug inexistente, vazio, nulo e injeção devolvem vazio", async () => {
    expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: "  DEMO-B  " }))[0]?.id).toBe(B().id);
    for (const slug of ["nao-existe-xyz", "", "' or 1=1 --", "demo-a%", "demo-a;drop table orders", "%"]) {
      const r = await anon().rpc("resolve_restaurant_by_slug", { p_slug: slug });
      expectOk(r);
      expect(rows(r), `slug ${slug}`).toHaveLength(0);
    }
    const nul = await anon().rpc("resolve_restaurant_by_slug", { p_slug: null });
    expect(rows(nul)).toHaveLength(0);
  });

  it("um slug de restaurante suspenso não resolve (nem para usuário logado do próprio restaurante)", async () => {
    const cleanup = new Cleanup();
    try {
      const slug = `zz-susp-${uniq()}`.slice(0, 40);
      const ins = await admin().from("restaurants").insert({ name: "zz DEMO Suspenso", slug, status: "suspended" }).select("id").single();
      expectOk(ins);
      cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", ins.data!.id)));
      expect(rows(await anon().rpc("resolve_restaurant_by_slug", { p_slug: slug }))).toHaveLength(0);
      expect(rows(await as("ownerA").rpc("resolve_restaurant_by_slug", { p_slug: slug }))).toHaveLength(0);
    } finally {
      await cleanup.run();
    }
  });

  it("restaurant_is_public é só um booleano sobre dado já público", async () => {
    expect((await anon().rpc("restaurant_is_public", { rid: A().id })).data).toBe(true);
    expect((await anon().rpc("restaurant_is_public", { rid: "00000000-0000-4000-8000-00000000dead" })).data).toBe(false);
  });
});

describe("anon NÃO lê dados privados (e a ausência de dados não é vacuosa)", () => {
  const populated = [
    "orders",
    "order_items",
    "order_item_modifiers",
    "order_status_history",
    "customers",
    "customer_addresses",
    "payments",
    "tabs",
    "tab_status_history",
    "restaurant_tables",
    "restaurant_memberships",
    "audit_logs",
    "profiles",
    "platform_admins",
    "subscriptions",
    "restaurants",
    "permissions",
    "role_permissions",
    "order_status_transitions",
  ];
  const maybeEmpty = ["print_jobs", "support_sessions", "support_tickets", "membership_permission_overrides", "order_counters"];

  for (const table of [...populated, ...maybeEmpty]) {
    it(`${table}: anon não recebe linhas`, async () => {
      if (populated.includes(table)) {
        const { count } = await admin().from(table).select("*", { count: "exact", head: true });
        expect(count, `${table} deveria ter dados no seed`).toBeGreaterThan(0);
      }
      expectNoRows(await anon().from(table).select("*").limit(50));
    });
  }

  it("por id conhecido (pedido, cliente, pagamento, comanda, mesa, vínculo) continua negado", async () => {
    expectNoRows(await anon().from("orders").select("id").eq("id", A().orderIds[0]));
    expectNoRows(await anon().from("orders").select("id").eq("public_code", "ANYTHING"));
    expectNoRows(await anon().from("customers").select("id").eq("id", A().customerId));
    expectNoRows(await anon().from("payments").select("id").eq("id", A().paymentId));
    expectNoRows(await anon().from("tabs").select("id").eq("id", A().tabId));
    expectNoRows(await anon().from("restaurant_tables").select("id,qr_token").eq("id", A().tableIds[0]));
    expectNoRows(await anon().from("restaurant_memberships").select("id").eq("id", world().memberships.ownerA!));
  });

  it("embed a partir de dado público não puxa tabelas privadas (restaurants, orders)", async () => {
    const r1 = await anon().from("products").select("id,restaurants(name,status)").eq("restaurant_id", A().id);
    // sem GRANT em restaurants para anon => erro de privilégio (ou null), nunca dados
    if (!r1.error) for (const p of rows(r1)) expect(p.restaurants ?? null).toBeNull();
    else expect(r1.error.message).toMatch(/permission denied|42501/i);
    const r2 = await anon().from("products").select("id,order_items(id)").eq("restaurant_id", A().id);
    if (!r2.error) for (const p of rows(r2)) expect(p.order_items ?? []).toHaveLength(0);
  });

  it("e-mail/telefone de clientes e dados de membros não aparecem em nenhum endpoint anônimo (REST cru)", async () => {
    const { rawRest } = await import("../helpers/clients");
    for (const path of ["/rest/v1/customers?select=*", "/rest/v1/profiles?select=*", "/rest/v1/restaurant_memberships?select=*", "/rest/v1/audit_logs?select=*", "/rest/v1/orders?select=*"]) {
      const r = await rawRest(path, { token: null });
      if (r.status === 200) expect(r.body).toEqual([]);
      else expect([401, 403]).toContain(r.status);
    }
  });
});

describe("anon não escreve em nada", () => {
  it("INSERT de pedido, itens, pagamento, comanda, mesa, cliente, impressão, ticket é negado", async () => {
    const c = anon();
    const attempts = [
      c.from("orders").insert({ restaurant_id: A().id, fulfillment_type: "PICKUP", subtotal_cents: 1, total_cents: 1 }).select("id"),
      c.from("order_items").insert({ restaurant_id: A().id, order_id: A().orderIds[0], product_name: "x", unit_price_cents: 1, quantity: 1, line_total_cents: 1 }).select("id"),
      c.from("payments").insert({ restaurant_id: A().id, order_id: A().orderIds[0], method: "CASH", amount_cents: 1, status: "PAID", paid_at: new Date().toISOString() }).select("id"),
      c.from("tabs").insert({ restaurant_id: A().id, status: "OPEN", total_cents: 0 }).select("id"),
      c.from("restaurant_tables").insert({ restaurant_id: A().id, name: "zz-anon" }).select("id"),
      c.from("customers").insert({ restaurant_id: A().id, name: "zz-anon" }).select("id"),
      c.from("print_jobs").insert({ restaurant_id: A().id, document_type: "KITCHEN_TICKET", order_id: A().orderIds[0] }).select("id"),
      c.from("support_tickets").insert({ restaurant_id: A().id, subject: "zz anon" }).select("id"),
      c.from("audit_logs").insert({ action: "anon.forged" }).select("id"),
      c.from("platform_admins").insert({ user_id: world().users.plain.id, role: "superadmin" }).select("user_id"),
      c.from("restaurant_memberships").insert({ restaurant_id: A().id, user_id: world().users.plain.id, role: "owner", status: "active" }).select("id"),
      c.from("restaurants").insert({ name: "zz anon", slug: `zz-${uniq()}` }).select("id"),
    ];
    for (const res of await Promise.all(attempts)) expectDenied(res, /42501|permission denied|row-level security/i);
    expect(rows(await admin().from("orders").select("id").eq("restaurant_id", A().id).like("idempotency_key", "zz-%"))).toHaveLength(0);
    expect(rows(await admin().from("audit_logs").select("id").eq("action", "anon.forged"))).toHaveLength(0);
  });

  it("UPDATE/DELETE em tabelas públicas (cardápio, horários) é negado: anon só tem SELECT", async () => {
    const before = await admin().from("products").select("*").eq("id", A().productId).single();
    expectDenied(await anon().from("products").update({ price_cents: 1 }).eq("id", A().productId).select("id"));
    expectDenied(await anon().from("products").delete().eq("id", A().productId).select("id"));
    expectDenied(await anon().from("business_hours").delete().eq("restaurant_id", A().id).select("id"));
    expectDenied(await anon().from("restaurant_settings").update({ accepts_orders: false }).eq("restaurant_id", A().id).select("restaurant_id"));
    expectDenied(await anon().from("orders").update({ status: "CANCELLED", status_reason: "x" }).eq("id", A().orderIds[0]).select("id"));
    expect((await admin().from("products").select("*").eq("id", A().productId).single()).data).toEqual(before.data);
    expect((await admin().from("orders").select("status").eq("id", A().orderIds[0]).single()).data?.status).toBe("RECEIVED");
  });
});

describe("funções internas não são chamáveis por clientes", () => {
  const rid = "00000000-0000-4000-8000-0000000000a1";
  const calls: Array<[string, Record<string, unknown>]> = [
    ["is_platform_admin", {}],
    ["is_platform_superadmin", {}],
    ["is_member", { rid }],
    ["has_permission", { rid, perm: "orders.view" }],
    ["has_support_access", { rid }],
    ["my_permissions", { rid }],
    ["my_restaurants", {}],
    ["my_pending_invitations", {}],
    ["shares_restaurant_with", { p_user: rid }],
    ["invite_member", { p_restaurant: rid, p_email: "zz@example.test", p_role: "waiter" }],
    ["accept_invitation", { p_membership: rid }],
    ["change_member_role", { p_membership: rid, p_role: "manager" }],
    ["revoke_member", { p_membership: rid }],
    ["set_member_permission", { p_membership: rid, p_permission: "orders.view", p_granted: true }],
    ["open_support_session", { p_restaurant: rid, p_reason: "tentativa de acesso anonimo" }],
    ["close_support_session", { p_session: rid }],
    ["create_restaurant", { p_name: "zz", p_slug: "zz-x", p_owner_id: rid }],
    ["register_restaurant", { p_name: "zz", p_slug: "zz-x" }],
    ["product_has_orders", { pid: rid }],
    ["storage_path_restaurant_id", { p_name: `restaurants/${rid}/products/x.png` }],
    ["can_manage_restaurant_asset", { p_name: `restaurants/${rid}/products/x.png` }],
  ];
  // Nunca expostas a NENHUM cliente (nem logado): auditoria, contador, utilitários internos.
  const internal: Array<[string, Record<string, unknown>]> = [
    ["log_audit", { p_restaurant: rid, p_action: "forged.action" }],
    ["next_order_number", { rid }],
    ["tab_orders_total", { p_restaurant: rid, p_tab: rid }],
    ["create_restaurant_domain_defaults", {}],
    ["handle_new_user", {}],
    ["set_updated_at", {}],
    ["payments_sync_order", {}],
    ["orders_after_write_history", {}],
    ["orders_before_insert", {}],
    ["tabs_before_insert", {}],
    ["tables_before_update", {}],
  ];

  for (const [fn, args] of calls) {
    it(`anon não executa ${fn}`, async () => {
      const res = await anon().rpc(fn, args);
      expect(res.error, `${fn} executou para anon!`).not.toBeNull();
      expect(res.data ?? null).toBeNull();
      expect(`${res.error!.code} ${res.error!.message}`).toMatch(/42501|permission denied|PGRST202|not find/i);
    });
  }

  for (const [fn, args] of internal) {
    for (const who of ["anon", "waiterA", "ownerA", "superadmin"] as const) {
      it(`${who} não executa a função interna ${fn}`, async () => {
        const client = who === "anon" ? anon() : as(who);
        const res = await client.rpc(fn, args);
        expect(res.error, `${fn} executou para ${who}!`).not.toBeNull();
        expect(`${res.error!.code} ${res.error!.message}`).toMatch(/42501|permission denied|PGRST202|not find/i);
      });
    }
  }

  it("nenhuma tentativa de log_audit/next_order_number deixou rastro", async () => {
    expect(rows(await admin().from("audit_logs").select("id").eq("action", "forged.action"))).toHaveLength(0);
    const c = await admin().from("order_counters").select("last_number").eq("restaurant_id", A().id).single();
    const max = await admin().from("orders").select("order_number").eq("restaurant_id", A().id).order("order_number", { ascending: false }).limit(1).single();
    expect(c.data!.last_number).toBeGreaterThanOrEqual(max.data!.order_number);
  });
});

describe("planos: catálogo público só com planos ativos", () => {
  const cleanup = new Cleanup();
  afterAll(() => cleanup.run());

  it("anon lê planos ativos, não lê inativos e não escreve", async () => {
    const code = `zz-inativo-${uniq()}`;
    const ins = await admin().from("plans").insert({ code, name: "zz DEMO inativo", price_cents: 1, is_active: false }).select("id").single();
    expectOk(ins);
    cleanup.add(async () => void (await admin().from("plans").delete().eq("code", code)));
    const list = rows(await anon().from("plans").select("code,is_active"));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.is_active)).toBe(true);
    expect(list.map((p) => p.code)).not.toContain(code);
    expectDenied(await anon().from("plans").insert({ code: `zz-${uniq()}`, name: "x", price_cents: 1 }).select("id"));
    expectDenied(await anon().from("plans").update({ price_cents: 0 }).eq("code", "basico").select("id"));
  });
});
