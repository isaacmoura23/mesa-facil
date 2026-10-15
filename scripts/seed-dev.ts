/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Seed de DESENVOLVIMENTO/TESTE (Supabase LOCAL somente).
 *
 *   npm run db:seed:dev
 *
 * - Usa a service role (nunca roda contra URL que não seja localhost/127.0.0.1).
 * - Idempotente: pode rodar N vezes; só cria o que falta e restaura o estado base.
 * - Cria dois restaurantes de demonstração (DEMO Restaurante A/B), contas @example.test
 *   (senha fixa em tests/fixtures/accounts.ts), superadmin/suporte (insert direto em
 *   platform_admins via service role) e dados de exemplo (cardápio, mesas, pedidos...).
 * - Tudo que é dado de demonstração tem "DEMO" no nome. Não imprime chaves.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import path from "node:path";
import {
  ACCOUNTS,
  ACCOUNT_KEYS,
  DEMO_RESTAURANTS,
  EPHEMERAL_EMAIL_DOMAIN,
  EPHEMERAL_PREFIX,
  TEST_PASSWORD,
  type AccountKey,
  type RestaurantKey,
} from "../tests/fixtures/accounts";
import type { RestaurantSamples, World } from "../tests/fixtures/world";
import { assertLocalUrl, loadEnv } from "./lib/env";

type Admin = SupabaseClient;
type Row = Record<string, any>;

// O cliente é não-tipado (sem Database types): linhas são `any`; quem espera "pode não existir" checa null.
function must(res: { data: any; error: { message: string; code?: string } | null }, what: string): any {
  if (res.error) throw new Error(`[seed] ${what}: ${res.error.message} (${res.error.code ?? "?"})`);
  return res.data;
}

export function createAdminClient(): Admin {
  const env = loadEnv();
  assertLocalUrl(env.url);
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------
async function listAllUsers(admin: Admin): Promise<{ id: string; email?: string }[]> {
  const all: { id: string; email?: string }[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`[seed] listUsers: ${error.message}`);
    all.push(...data.users.map((u) => ({ id: u.id, email: u.email })));
    if (data.users.length < 200) break;
  }
  return all;
}

async function ensureUsers(admin: Admin): Promise<Record<AccountKey, { id: string; email: string }>> {
  const existing = await listAllUsers(admin);
  const byEmail = new Map(existing.map((u) => [u.email?.toLowerCase(), u.id]));
  const out = {} as Record<AccountKey, { id: string; email: string }>;
  for (const key of ACCOUNT_KEYS) {
    const def = ACCOUNTS[key];
    let id = byEmail.get(def.email);
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({
        email: def.email,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: def.fullName },
      });
      if (error || !data.user) throw new Error(`[seed] createUser ${def.email}: ${error?.message}`);
      id = data.user.id;
    }
    out[key] = { id, email: def.email };
    // O profile nasce por trigger; garante o nome DEMO mesmo em contas antigas.
    must(await admin.from("profiles").update({ full_name: def.fullName }).eq("id", id), "profile name");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sobras de execuções anteriores (usuários/restaurantes/linhas efêmeras dos testes)
// ---------------------------------------------------------------------------
async function cleanupLeftovers(admin: Admin): Promise<void> {
  // Usuários efêmeros (cascade remove vínculos e profiles).
  for (const u of await listAllUsers(admin)) {
    if (u.email?.startsWith(EPHEMERAL_PREFIX) && u.email.endsWith(EPHEMERAL_EMAIL_DOMAIN)) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
  // Restaurantes efêmeros (cascade leva tudo; payments também têm restaurant_id cascade).
  must(await admin.from("restaurants").delete().like("slug", `${EPHEMERAL_PREFIX}%`), "cleanup restaurants");

  const demoIds = Object.values(DEMO_RESTAURANTS).map((r) => r.id);
  must(await admin.from("payments").delete().in("restaurant_id", demoIds).like("idempotency_key", `${EPHEMERAL_PREFIX}%`), "cleanup payments");
  must(await admin.from("print_jobs").delete().in("restaurant_id", demoIds).like("printer_target", `${EPHEMERAL_PREFIX}%`), "cleanup print_jobs");
  must(await admin.from("orders").delete().in("restaurant_id", demoIds).like("idempotency_key", `${EPHEMERAL_PREFIX}%`), "cleanup orders");
  must(await admin.from("tabs").delete().in("restaurant_id", demoIds).like("label", `${EPHEMERAL_PREFIX}%`), "cleanup tabs");
  must(await admin.from("restaurant_tables").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup tables");
  must(await admin.from("products").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup products");
  must(await admin.from("menu_categories").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup categories");
  must(await admin.from("customers").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup customers");
  must(await admin.from("modifier_groups").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup modifier groups");
  must(await admin.from("delivery_zones").delete().in("restaurant_id", demoIds).like("name", `${EPHEMERAL_PREFIX}%`), "cleanup zones");
  must(await admin.from("business_hour_exceptions").delete().in("restaurant_id", demoIds).like("description", `${EPHEMERAL_PREFIX}%`), "cleanup hour exceptions");
  must(await admin.from("business_hours").delete().in("restaurant_id", demoIds).eq("opens_at", "03:33:00"), "cleanup hours");
  must(await admin.from("support_sessions").update({ ended_at: new Date().toISOString() }).in("restaurant_id", demoIds).is("ended_at", null), "close stale support sessions");
}

// ---------------------------------------------------------------------------
// Restaurantes + vínculos + plataforma
// ---------------------------------------------------------------------------
async function ensureRestaurants(admin: Admin, users: Record<AccountKey, { id: string }>): Promise<void> {
  for (const k of ["a", "b"] as RestaurantKey[]) {
    const def = DEMO_RESTAURANTS[k];
    const ownerKey = (k === "a" ? "ownerA" : "ownerB") as AccountKey;
    // Um teste interrompido pode ter deixado outro tenant "ocupando" o slug demo-*: remove o intruso.
    must(await admin.from("restaurants").delete().eq("slug", def.slug).neq("id", def.id), "drop slug squatter");
    const row = must(await admin.from("restaurants").select("id,name,slug,status").eq("id", def.id).maybeSingle(), "select restaurant");
    if (!row) {
      must(
        await admin.from("restaurants").insert({ id: def.id, name: def.name, slug: def.slug, status: "active", created_by: users[ownerKey].id }),
        "insert restaurant",
      );
    } else {
      const patch: Row = {};
      if (row.name !== def.name) patch.name = def.name;
      if (row.slug !== def.slug) patch.slug = def.slug; // restaura slug se um teste foi interrompido
      if (row.status !== "active") patch.status = "active";
      if (Object.keys(patch).length) must(await admin.from("restaurants").update(patch).eq("id", def.id), "restore restaurant");
    }
  }

  // Vínculos: estado base idêntico a cada execução (sem overrides, sem convites sobrando).
  const demoIds = Object.values(DEMO_RESTAURANTS).map((r) => r.id);
  must(await admin.from("membership_permission_overrides").delete().in("restaurant_id", demoIds), "reset overrides");
  must(await admin.from("restaurant_memberships").delete().in("restaurant_id", demoIds).is("user_id", null), "drop pending invites");

  for (const key of ACCOUNT_KEYS) {
    const def = ACCOUNTS[key];
    if (!def.restaurant || !def.role) continue;
    const rid = DEMO_RESTAURANTS[def.restaurant].id;
    const userId = users[key].id;
    const m = must(
      await admin.from("restaurant_memberships").select("id,role,status").eq("restaurant_id", rid).eq("user_id", userId).maybeSingle(),
      "select membership",
    );
    if (!m) {
      must(await admin.from("restaurant_memberships").insert({ restaurant_id: rid, user_id: userId, role: def.role, status: "active", invited_by: users[def.restaurant === "a" ? "ownerA" : "ownerB"].id }), "insert membership");
    } else if (m.role !== def.role || m.status !== "active") {
      must(await admin.from("restaurant_memberships").update({ role: def.role, status: "active" }).eq("id", m.id), "restore membership");
    }
  }

  // Marca de auditoria inicial por restaurante (audit_logs é append-only: cria uma única vez).
  for (const k of ["a", "b"] as RestaurantKey[]) {
    const rid = DEMO_RESTAURANTS[k].id;
    const seen = must(await admin.from("audit_logs").select("id").eq("restaurant_id", rid).eq("action", "demo.seeded").limit(1), "audit seen");
    if (!seen.length) {
      must(await admin.rpc("log_audit", { p_restaurant: rid, p_action: "demo.seeded", p_resource_type: "restaurant", p_resource_id: rid, p_metadata: { note: "DEMO seed" } }), "log_audit");
    }
  }

  // Plataforma: insert direto via service role (nunca por API de cliente).
  for (const key of ACCOUNT_KEYS) {
    const def = ACCOUNTS[key];
    if (!def.platformRole) continue;
    must(await admin.from("platform_admins").upsert({ user_id: users[key].id, role: def.platformRole }, { onConflict: "user_id" }), "platform_admins");
  }
  // Ninguém além de superadmin/support deve ser admin (higiene entre execuções).
  const admins = must(await admin.from("platform_admins").select("user_id"), "list admins");
  const allowed = new Set([users.superadmin.id, users.support.id]);
  for (const a of admins as Row[]) {
    if (!allowed.has(a.user_id)) must(await admin.from("platform_admins").delete().eq("user_id", a.user_id), "drop stray admin");
  }
}

// ---------------------------------------------------------------------------
// Dados de demonstração
// ---------------------------------------------------------------------------
async function ensureOne(admin: Admin, table: string, match: Row, values: Row = {}, opts: { enforce?: boolean } = {}): Promise<Row> {
  let q = admin.from(table).select("*");
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v as any);
  const found = must(await q.limit(1).maybeSingle(), `select ${table}`);
  if (found) {
    if (!opts.enforce) return found;
    // Estado base determinístico: devolve aos valores do seed qualquer campo que uma execução anterior (testes, UI) alterou.
    const patch: Row = {};
    for (const [k, v] of Object.entries(values)) {
      if (JSON.stringify(found[k] ?? null) !== JSON.stringify(v ?? null)) patch[k] = v;
    }
    if (!Object.keys(patch).length) return found;
    return must(await admin.from(table).update(patch).eq("id", found.id).select("*").single(), `restore ${table}`);
  }
  return must(await admin.from(table).insert({ ...match, ...values }).select("*").single(), `insert ${table}`);
}

/** Remove de uma tabela do restaurante tudo que não está na lista do seed (sobras de testes/UI). */
async function pruneExcept(admin: Admin, table: string, rid: string, keepIds: string[]): Promise<void> {
  const rows = must(await admin.from(table).select("id").eq("restaurant_id", rid), `list ${table}`) as Row[];
  const drop = rows.map((r) => r.id as string).filter((id) => !keepIds.includes(id));
  if (drop.length) must(await admin.from(table).delete().in("id", drop), `prune ${table}`);
}

async function seedRestaurantData(admin: Admin, k: RestaurantKey, users: Record<AccountKey, { id: string }>): Promise<RestaurantSamples> {
  const def = DEMO_RESTAURANTS[k];
  const rid = def.id;
  const cashier = users[k === "a" ? "cashierA" : "cashierB"].id;
  const suffix = k.toUpperCase();

  // Cardápio: o nome é a chave natural; todo o resto (ordem, preço, ativo, categoria, imagem) é forçado ao estado
  // base a cada execução, e o que não pertence ao seed é removido (UI/testes podem ter mexido).
  const E = { enforce: true };
  const catLanches = await ensureOne(admin, "menu_categories", { restaurant_id: rid, name: "DEMO Lanches" }, { description: null, sort_order: 1, is_active: true }, E);
  const catBebidas = await ensureOne(admin, "menu_categories", { restaurant_id: rid, name: "DEMO Bebidas" }, { description: null, sort_order: 2, is_active: true }, E);
  const catOculta = await ensureOne(admin, "menu_categories", { restaurant_id: rid, name: "DEMO Categoria Oculta" }, { description: null, sort_order: 9, is_active: false }, E);

  // Etapa 2.5: o estado base do cardápio DEMO não tem variantes nem selos (a UI/os testes podem ter criado).
  must(await admin.from("product_variants").delete().eq("restaurant_id", rid), "reset variants");
  const base = { image_path: null, is_available: true, badges: [] as string[] };
  const burger = await ensureOne(admin, "products", { restaurant_id: rid, name: `DEMO X-Burger ${suffix}` }, { ...base, category_id: catLanches.id, price_cents: 2500, description: "Produto de demonstração", is_active: true, sort_order: 1 }, E);
  const refri = await ensureOne(admin, "products", { restaurant_id: rid, name: `DEMO Refrigerante ${suffix}` }, { ...base, category_id: null, price_cents: 600, description: null, is_active: true, sort_order: 2 }, E);
  const hidden = await ensureOne(admin, "products", { restaurant_id: rid, name: `DEMO Produto Oculto ${suffix}` }, { ...base, category_id: null, price_cents: 100, description: null, is_active: false, sort_order: 3 }, E);

  const group = await ensureOne(admin, "modifier_groups", { restaurant_id: rid, name: "DEMO Adicionais" }, { min_selections: 0, max_selections: 3, is_active: true, sort_order: 1 }, E);
  const bacon = await ensureOne(admin, "modifiers", { restaurant_id: rid, group_id: group.id, name: "DEMO Bacon" }, { price_delta_cents: 500, is_available: true, is_active: true, sort_order: 1 }, E);
  const queijo = await ensureOne(admin, "modifiers", { restaurant_id: rid, group_id: group.id, name: "DEMO Queijo extra" }, { price_delta_cents: 400, is_available: true, is_active: true, sort_order: 2 }, E);

  await pruneExcept(admin, "modifiers", rid, [bacon.id, queijo.id]);
  await pruneExcept(admin, "modifier_groups", rid, [group.id]);
  await pruneExcept(admin, "products", rid, [burger.id, refri.id, hidden.id]);
  await pruneExcept(admin, "menu_categories", rid, [catLanches.id, catBebidas.id, catOculta.id]);
  must(await admin.from("product_modifier_groups").delete().eq("restaurant_id", rid).neq("product_id", burger.id), "prune links");
  must(await admin.from("product_modifier_groups").delete().eq("restaurant_id", rid).eq("product_id", burger.id).neq("group_id", group.id), "prune links 2");
  must(
    await admin.from("product_modifier_groups").upsert({ restaurant_id: rid, product_id: burger.id, group_id: group.id, sort_order: 0 }, { onConflict: "product_id,group_id" }),
    "pmg",
  );

  // Configurações (linha criada por trigger) + horários + exceção + zonas
  must(
    await admin.from("restaurant_settings").upsert(
      { restaurant_id: rid, accepts_orders: true, enabled_fulfillment_types: ["DELIVERY", "PICKUP", "DINE_IN"], single_tab_per_table: true, prep_time_minutes: 30, min_order_cents: 0, pickup_instructions: null, whatsapp: null, phone: null, address_text: null, storefront_origins: [] as string[], storefront_url: null },
      { onConflict: "restaurant_id" },
    ),
    "settings",
  );
  must(await admin.from("restaurants").update({ logo_path: null, timezone: "America/Sao_Paulo" }).eq("id", rid), "restaurant branding");
  const hoursNow = must(await admin.from("business_hours").select("id,weekday,opens_at,closes_at").eq("restaurant_id", rid), "hours") as Row[];
  const hoursOk =
    hoursNow.length === 7 &&
    [0, 1, 2, 3, 4, 5, 6].every((d) => hoursNow.some((h) => h.weekday === d && String(h.opens_at).startsWith("11:00") && String(h.closes_at).startsWith("23:00")));
  if (!hoursOk) {
    must(await admin.from("business_hours").delete().eq("restaurant_id", rid), "hours reset");
    must(await admin.from("business_hours").insert([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ restaurant_id: rid, weekday, opens_at: "11:00", closes_at: "23:00" }))), "hours insert");
  }
  const hour = must(await admin.from("business_hours").select("id").eq("restaurant_id", rid).limit(1).single(), "hour");
  must(await admin.from("business_hour_exceptions").delete().eq("restaurant_id", rid).neq("on_date", "2030-12-25"), "exceptions reset");
  must(await admin.from("business_hour_exceptions").upsert({ restaurant_id: rid, on_date: "2030-12-25", is_closed: true, opens_at: null, closes_at: null, description: "DEMO Natal" }, { onConflict: "restaurant_id,on_date" }), "exception");
  const zone = await ensureOne(admin, "delivery_zones", { restaurant_id: rid, name: "DEMO Centro" }, { fee_cents: 500, min_order_cents: 1500, estimated_minutes: 40, neighborhoods: ["Centro"], postal_code_prefixes: [], is_active: true }, E);
  const zoneOff = await ensureOne(admin, "delivery_zones", { restaurant_id: rid, name: "DEMO Zona Inativa" }, { fee_cents: 900, min_order_cents: 0, estimated_minutes: null, neighborhoods: [], postal_code_prefixes: [], is_active: false }, E);
  await pruneExcept(admin, "delivery_zones", rid, [zone.id, zoneOff.id]);

  // Mesas
  const tableIds: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const t = await ensureOne(admin, "restaurant_tables", { restaurant_id: rid, name: `DEMO Mesa ${i}` }, { capacity: 4, area: "Salão", sort_order: i });
    tableIds.push(t.id);
  }

  // Cliente + endereço
  const phone = k === "a" ? "11999990001" : "11999990002";
  const customer = await ensureOne(admin, "customers", { restaurant_id: rid, phone }, { name: `DEMO Cliente ${suffix}`, email: `cliente.${k}@example.test` });
  await ensureOne(admin, "customer_addresses", { restaurant_id: rid, customer_id: customer.id, street: "Rua DEMO" }, { number: "100", neighborhood: "Centro", city: "São Paulo", state: "SP", is_default: true });

  // Comanda aberta na Mesa 1 (a mesa passa a OCCUPIED via trigger)
  const tabTableId = tableIds[0];
  const tab = await ensureOne(admin, "tabs", { restaurant_id: rid, label: `DEMO Comanda ${suffix}` }, { table_id: tabTableId, guests: 2, opened_by: cashier, status: "OPEN" });

  // Pedidos (chave de idempotência estável => não duplica)
  const orderSpecs = [
    { n: 1, type: "PICKUP", status: "RECEIVED" },
    { n: 2, type: "DELIVERY", status: "CONFIRMED" },
    { n: 3, type: "DINE_IN", status: "PREPARING" },
    { n: 4, type: "PICKUP", status: "COMPLETED" },
  ] as const;
  const orderIds: string[] = [];
  let completedTotal = 0;
  for (const spec of orderSpecs) {
    const key = `demo-seed-order-${k}-${spec.n}`;
    let order = must(await admin.from("orders").select("id,total_cents").eq("restaurant_id", rid).eq("idempotency_key", key).maybeSingle(), "select order");
    if (!order) {
      const qty = spec.n;
      const unit = 2500;
      const mods = 500;
      const line = (unit + mods) * qty;
      const fee = spec.type === "DELIVERY" ? 500 : 0;
      const body: Row = {
        restaurant_id: rid,
        fulfillment_type: spec.type,
        status: spec.status,
        source: "STAFF",
        customer_id: customer.id,
        customer_name: `DEMO Cliente ${suffix}`,
        customer_phone: phone,
        subtotal_cents: line,
        delivery_fee_cents: fee,
        total_cents: line + fee,
        idempotency_key: key,
        created_by: cashier,
        notes: "Pedido de demonstração",
      };
      if (spec.type === "DELIVERY") body.delivery_address = { street: "Rua DEMO", number: "100", neighborhood: "Centro" };
      if (spec.type === "DINE_IN") Object.assign(body, { table_id: tabTableId, tab_id: tab.id });
      if (spec.status === "COMPLETED") body.completed_at = new Date().toISOString();
      if (spec.status !== "RECEIVED") body.confirmed_at = new Date().toISOString();
      order = must(await admin.from("orders").insert(body).select("id,total_cents").single(), "insert order");
      const item = must(
        await admin
          .from("order_items")
          .insert({ restaurant_id: rid, order_id: order.id, product_id: burger.id, product_name: burger.name, unit_price_cents: unit, modifiers_cents: mods, quantity: qty, line_total_cents: line })
          .select("id")
          .single(),
        "insert order item",
      );
      must(await admin.from("order_item_modifiers").insert({ restaurant_id: rid, order_item_id: item.id, modifier_id: bacon.id, group_name: "DEMO Adicionais", modifier_name: "DEMO Bacon", price_delta_cents: mods }), "item modifier");
    }
    orderIds.push(order.id);
    if (spec.n === 4) completedTotal = order.total_cents;
  }

  // Pagamento do pedido concluído
  const payKey = `demo-seed-pay-${k}-1`;
  let payment = must(await admin.from("payments").select("id").eq("restaurant_id", rid).eq("idempotency_key", payKey).maybeSingle(), "select payment");
  if (!payment) {
    payment = must(
      await admin
        .from("payments")
        .insert({ restaurant_id: rid, order_id: orderIds[3], method: "PIX", amount_cents: completedTotal, status: "PAID", provider: "demo", provider_reference: `demo-seed-ref-${k}-1`, idempotency_key: payKey, recorded_by: cashier, paid_at: new Date().toISOString(), notes: "DEMO pagamento" })
        .select("id")
        .single(),
      "insert payment",
    );
  }

  // Assinatura de teste (trial) se houver plano
  const live = must(await admin.from("subscriptions").select("id").eq("restaurant_id", rid).in("status", ["trialing", "active", "past_due"]).limit(1), "subs");
  if (!live.length) {
    const plan = must(await admin.from("plans").select("id").eq("code", "basico").maybeSingle(), "plan");
    if (plan) {
      must(await admin.from("subscriptions").insert({ restaurant_id: rid, plan_id: plan.id, status: "trialing", trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString() }), "subscription");
    }
  }

  return {
    id: rid,
    slug: def.slug,
    name: def.name,
    categoryId: catLanches.id,
    productId: burger.id,
    hiddenProductId: hidden.id,
    modifierGroupId: group.id,
    modifierId: bacon.id,
    tableIds,
    tabTableId,
    tabId: tab.id,
    customerId: customer.id,
    orderIds,
    paymentId: payment.id,
    businessHourId: hour.id,
    deliveryZoneId: zone.id,
  };
}

export async function seedDev(opts: { quiet?: boolean } = {}): Promise<World> {
  const env = loadEnv();
  assertLocalUrl(env.url);
  const admin = createAdminClient();
  const log = (...a: unknown[]) => {
    if (!opts.quiet) console.log(...a);
  };

  log(`[seed] alvo: ${env.url} (local)`);
  const users = await ensureUsers(admin);
  await cleanupLeftovers(admin);
  await ensureRestaurants(admin, users);

  const restaurants = {
    a: await seedRestaurantData(admin, "a", users),
    b: await seedRestaurantData(admin, "b", users),
  };

  const memberships: World["memberships"] = {};
  for (const key of ACCOUNT_KEYS) {
    const def = ACCOUNTS[key];
    if (!def.restaurant) continue;
    const m = must(
      await admin.from("restaurant_memberships").select("id").eq("restaurant_id", DEMO_RESTAURANTS[def.restaurant].id).eq("user_id", users[key].id).single(),
      "membership id",
    );
    memberships[key] = m.id;
  }

  const world: World = { url: env.url, users, memberships, restaurants };

  if (!opts.quiet) {
    console.log("[seed] pronto. Resumo:");
    console.log(`  restaurantes : ${DEMO_RESTAURANTS.a.name} (/${DEMO_RESTAURANTS.a.slug}), ${DEMO_RESTAURANTS.b.name} (/${DEMO_RESTAURANTS.b.slug})`);
    console.log(`  contas       : ${ACCOUNT_KEYS.length} (e-mails *@example.test; senha fixa em tests/fixtures/accounts.ts)`);
    for (const key of ACCOUNT_KEYS) {
      const d = ACCOUNTS[key];
      const where = d.restaurant ? `${d.role}@${d.restaurant.toUpperCase()}` : d.platformRole ? `plataforma:${d.platformRole}` : "sem vínculo";
      console.log(`    - ${d.email.padEnd(28)} ${where}`);
    }
    console.log("  por restaurante: 3 categorias, 3 produtos (1 oculto), 1 grupo de adicionais (2), 6 mesas, 1 comanda aberta, 4 pedidos, 1 pagamento, horários, zonas, assinatura trial");
  }
  return world;
}

// Execução direta: `tsx scripts/seed-dev.ts`
const invoked = process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "";
if (invoked === "seed-dev") {
  seedDev().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
