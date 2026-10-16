/**
 * Deriva de configuração: a matriz do contrato (docs/CONTRACT.md) == banco == constantes do app;
 * e o catálogo do Postgres continua "default-deny" (RLS ligado em tudo, sem views, SECURITY DEFINER com
 * search_path fixo, anon só com SELECT nas tabelas públicas).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "../../scripts/lib/env";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectOk, rows } from "../helpers/expect";
import { dockerAvailable, psql } from "../helpers/psql";

const A = () => world().restaurants.a;
const ROLES = ["owner", "manager", "cashier", "kitchen", "waiter"] as const;
const OPERATIONAL = ["orders.create", "orders.accept", "orders.reject", "orders.update_status", "orders.cancel", "tables.operate", "tabs.manage", "payments.record", "print.request"];

function parseContractMatrix(): Record<string, Record<(typeof ROLES)[number], boolean>> {
  const md = readFileSync(path.join(projectRoot(), "docs", "CONTRACT.md"), "utf8");
  const out: Record<string, Record<(typeof ROLES)[number], boolean>> = {};
  for (const line of md.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 8) continue;
    // Linhas combinadas do contrato: "orders.accept / reject" => orders.accept e orders.reject
    const parts = cells[1].split("/").map((x) => x.trim());
    const first = parts[0];
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(first)) continue;
    const prefix = first.slice(0, first.indexOf(".") + 1);
    for (const part of parts) {
      const perm = part.includes(".") ? part : prefix + part;
      out[perm] = {} as Record<(typeof ROLES)[number], boolean>;
      ROLES.forEach((r, i) => {
        out[perm][r] = cells[2 + i].startsWith("✔");
      });
    }
  }
  return out;
}

describe("contrato x banco x app", () => {
  it("role_permissions no banco == matriz de docs/CONTRACT.md (linha a linha)", async () => {
    const matrix = parseContractMatrix();
    expect(Object.keys(matrix)).toHaveLength(17);
    const db = await admin().from("role_permissions").select("role,permission_key");
    expectOk(db);
    const have = new Set(rows(db).map((r) => `${r.role}:${r.permission_key}`));
    const want = new Set<string>();
    for (const [perm, byRole] of Object.entries(matrix)) for (const role of ROLES) if (byRole[role]) want.add(`${role}:${perm}`);
    expect([...have].sort()).toEqual([...want].sort());
  });

  it("catálogo permissions: 17 chaves; is_operational == as 9 permissões operacionais do contrato", async () => {
    const res = await as("ownerA").from("permissions").select("key,is_operational");
    expectOk(res);
    expect(rows(res)).toHaveLength(17);
    expect(rows(res).filter((p) => p.is_operational).map((p) => p.key).sort()).toEqual([...OPERATIONAL].sort());
  });

  it("owner no contrato nunca tem permissão operacional", () => {
    const matrix = parseContractMatrix();
    for (const perm of OPERATIONAL) expect(matrix[perm].owner, perm).toBe(false);
  });

  it("constantes do app (quando existirem) refletem o catálogo do banco", async () => {
    const perms = await import("../../src/lib/auth/permissions").catch(() => null);
    if (!perms) return;
    const res = await admin().from("permissions").select("key,is_operational");
    const dbOperational = rows(res).filter((p) => p.is_operational).map((p) => p.key).sort();
    expect([...perms.OPERATIONAL_PERMISSIONS].sort()).toEqual(dbOperational);
    expect(Object.keys(perms.PERMISSION_LABELS).sort()).toEqual(rows(res).map((p) => p.key).sort());
  });
});

describe.skipIf(!dockerAvailable)("catálogo do Postgres (default-deny)", () => {
  it("toda tabela de public tem RLS habilitado; nenhuma view/materialized view exposta", () => {
    expect(psql("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity")).toEqual([]);
    expect(psql("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m','f')")).toEqual([]);
  });

  it("toda função SECURITY DEFINER (public/app_private) fixa search_path", () => {
    expect(
      psql(
        "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')",
      ),
    ).toEqual([]);
  });

  it("anon só executa a whitelist pública (cardápio/carrinho/slug); funções de trigger não contam: não são chamáveis", () => {
    const anonExec = psql(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_depend d on d.objid=p.oid and d.deptype='e' where n.nspname='public' and d.objid is null and p.prorettype <> 'trigger'::regtype and has_function_privilege('anon', p.oid,'execute') order by 1",
    );
    // Fase 2: public_menu e validate_cart são públicas POR DESIGN (leitura/precificação sem gravar nada).
    // Etapa 2.5 (mig. 0113): storefront_origins(slug) alimenta o CORS da API pública (devolve só as origens de restaurante ativo).
    // Fase 3 (mig. 0115): track_order (acompanhamento por código público de 80 bits, sem PII) também é pública por desenho.
    expect(anonExec).toEqual(["public_menu", "resolve_restaurant_by_slug", "restaurant_is_public", "storefront_origins", "track_order", "validate_cart"]);
  });

  it("Fase 3 (migs. 0114-0116): EXECUTE por papel — create_public_order só service_role; transition_order_status/request_print/mark_print_job só authenticated; track_order anon+authenticated", () => {
    const priv = (sig: string) =>
      psql(
        `select has_function_privilege('anon','${sig}','execute')||'|'||has_function_privilege('authenticated','${sig}','execute')||'|'||has_function_privilege('public','${sig}','execute')||'|'||has_function_privilege('service_role','${sig}','execute')`,
      )?.map((l) => l.replace(/true/g, "t").replace(/false/g, "f"));
    // anon | authenticated | PUBLIC | service_role
    expect(priv("public.create_public_order(text,text,jsonb,jsonb,jsonb,uuid,text,text,jsonb)")).toEqual(["f|f|f|t"]);
    expect(priv("public.transition_order_status(uuid,text,text)")).toEqual(["f|t|f|t"]);
    expect(priv("public.request_print(uuid,text)")).toEqual(["f|t|f|t"]);
    expect(priv("public.mark_print_job(uuid,text)")).toEqual(["f|t|f|t"]);
    expect(priv("public.track_order(text,text)")).toEqual(["t|t|f|t"]);
  });

  it("Fase 3: print_jobs não tem mais INSERT/UPDATE/DELETE para authenticated (F-08) nem policy de INSERT; SELECT permanece", () => {
    expect(
      psql("select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='print_jobs'"),
    ).toEqual(["SELECT"]);
    expect(psql("select count(*) from pg_policies where schemaname='public' and tablename='print_jobs' and cmd in ('INSERT','UPDATE','DELETE')")).toEqual(["0"]);
  });

  it("reorder_menu: authenticated executa, anon e PUBLIC não", () => {
    expect(
      psql(
        "select has_function_privilege('anon','public.reorder_menu(uuid,text,uuid[])','execute'), has_function_privilege('authenticated','public.reorder_menu(uuid,text,uuid[])','execute'), has_function_privilege('public','public.reorder_menu(uuid,text,uuid[])','execute')",
      ),
    ).toEqual(["f|t|f"]);
  });

  it("schema app_private é inacessível a anon/authenticated", () => {
    expect(psql("select has_schema_privilege('anon','app_private','usage'), has_schema_privilege('authenticated','app_private','usage')")).toEqual(["f|f"]);
  });

  it("nenhuma função de app_private (day_intervals, is_open_now, menu_products_json, price_cart, ...) é executável por anon/authenticated/PUBLIC", () => {
    expect(
      psql(
        "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and (has_function_privilege('anon', p.oid,'execute') or has_function_privilege('authenticated', p.oid,'execute') or has_function_privilege('public', p.oid,'execute')) order by 1",
      ),
    ).toEqual([]);
    // as quatro funções internas da Fase 2 existem (o teste acima não é vacuoso)
    const names = psql("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' order by 1")!;
    for (const fn of ["day_intervals", "is_open_now", "menu_products_json", "price_cart"]) expect(names).toContain(fn);
  });

  it("app_private não é exposto pelo PostgREST: price_cart/is_open_now não são chamáveis por RPC (anon e authenticated)", async () => {
    for (const client of [anon(), as("ownerA")]) {
      const r1 = await client.schema("app_private" as never).rpc("price_cart", { p_restaurant_id: A().id, p_fulfillment: "PICKUP", p_items: [] });
      expect(r1.error, "app_private.price_cart chamável por RPC").not.toBeNull();
      const r2 = await client.schema("app_private" as never).rpc("is_open_now", { p_restaurant_id: A().id });
      expect(r2.error, "app_private.is_open_now chamável por RPC").not.toBeNull();
      // mesmo qualificando no nome, via schema público não existe
      const r3 = await client.rpc("price_cart", { p_restaurant_id: A().id, p_fulfillment: "PICKUP", p_items: [] });
      expect(r3.error).not.toBeNull();
    }
  });

  it("anon: somente SELECT, e apenas nas tabelas públicas de cardápio/horário/plano", () => {
    const rowsOut = psql("select table_name||'|'||string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='anon' and table_schema='public' group by table_name order by table_name")!;
    expect(rowsOut.every((r) => r.endsWith("|SELECT"))).toBe(true);
    expect(rowsOut.map((r) => r.split("|")[0])).toEqual([
      "business_hour_exceptions",
      "business_hours",
      "delivery_zones",
      "menu_categories",
      "modifier_groups",
      "modifiers",
      "plans",
      "product_modifier_groups",
      "product_variants",
      "products",
    ]);
  });

  // Etapa 2.5: restaurant_settings saiu do grant de TABELA (SELECT agora é por coluna, sem storefront_origins).
  it("restaurant_settings: SELECT por coluna para anon/authenticated, sem storefront_origins (e sem escrita para anon)", () => {
    // sem privilégio de tabela (a leitura é por coluna)
    expect(
      psql("select grantee||'|'||privilege_type from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public' and table_name='restaurant_settings' and privilege_type='SELECT'"),
    ).toEqual([]);
    for (const role of ["anon", "authenticated"]) {
      expect(psql(`select has_column_privilege('${role}','public.restaurant_settings','storefront_origins','select')`), `${role} lê storefront_origins`).toEqual(["f"]);
      // UPDATE: authenticated mantém o grant de tabela da 0108 (a policy settings.manage restringe a dono/gerente); anon nunca escreve.
      expect(psql(`select has_column_privilege('${role}','public.restaurant_settings','storefront_origins','update')`), `${role} UPDATE em storefront_origins`).toEqual([role === "anon" ? "f" : "t"]);
      expect(psql(`select has_table_privilege('${role}','public.restaurant_settings','select')`), `${role} tem SELECT de tabela`).toEqual(["f"]);
    }
    // todas as demais colunas são legíveis por anon e por authenticated
    const publicCols = psql(
      "select attname from pg_attribute where attrelid='public.restaurant_settings'::regclass and attnum>0 and not attisdropped and attname<>'storefront_origins' order by attnum",
    )!;
    expect(publicCols).toEqual(expect.arrayContaining(["restaurant_id", "accepts_orders", "whatsapp", "phone", "address_text", "storefront_url"]));
    for (const role of ["anon", "authenticated"]) {
      const lacking = publicCols.filter((c) => psql(`select has_column_privilege('${role}','public.restaurant_settings','${c}','select')`)![0] !== "t");
      expect(lacking, `${role} sem SELECT nas colunas`).toEqual([]);
    }
    // anon nunca escreve em restaurant_settings
    expect(psql("select has_table_privilege('anon','public.restaurant_settings','insert,update,delete')")).toEqual(["f"]);
  });

  it("product_variants: anon só SELECT; authenticated SELECT/INSERT/UPDATE/DELETE; sem TRUNCATE/REFERENCES/TRIGGER; RLS + FORCE ligados", () => {
    expect(psql("select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name='product_variants'")).toEqual(["SELECT"]);
    expect(psql("select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='product_variants'")).toEqual(["DELETE,INSERT,SELECT,UPDATE"]);
    expect(psql("select relrowsecurity, relforcerowsecurity from pg_class where oid='public.product_variants'::regclass")).toEqual(["t|t"]);
  });

  it("funções novas da 0113: get_storefront_origins só authenticated; variant_has_orders só authenticated; cap_errors em app_private inacessível", () => {
    expect(psql("select has_function_privilege('anon','public.get_storefront_origins(uuid)','execute'), has_function_privilege('authenticated','public.get_storefront_origins(uuid)','execute'), has_function_privilege('public','public.get_storefront_origins(uuid)','execute')")).toEqual(["f|t|f"]);
    expect(psql("select has_function_privilege('anon','public.variant_has_orders(uuid)','execute'), has_function_privilege('authenticated','public.variant_has_orders(uuid)','execute'), has_function_privilege('public','public.variant_has_orders(uuid)','execute')")).toEqual(["f|t|f"]);
    expect(psql("select has_function_privilege('anon','public.storefront_origins(text)','execute'), has_function_privilege('authenticated','public.storefront_origins(text)','execute'), has_function_privilege('public','public.storefront_origins(text)','execute')")).toEqual(["t|t|f"]);
  });

  it("authenticated nunca recebe INSERT/UPDATE/DELETE em tabelas de identidade, pedidos, pagamentos e auditoria", () => {
    const sensitive = [
      "audit_logs",
      "restaurant_memberships",
      "membership_permission_overrides",
      "platform_admins",
      "permissions",
      "role_permissions",
      "support_sessions",
      "orders",
      "order_items",
      "order_item_modifiers",
      "order_status_history",
      "order_counters",
      "payments",
      "tab_status_history",
    ];
    const list = sensitive.map((t) => `'${t}'`).join(",");
    const granted = psql(
      `select table_name||'|'||privilege_type from information_schema.role_table_grants where grantee in ('authenticated','anon','PUBLIC') and table_schema='public' and table_name in (${list}) and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
    );
    expect(granted).toEqual([]);
    // colunas atualizáveis de orders: apenas as de fluxo
    const cols = psql("select column_name from information_schema.column_privileges where grantee='authenticated' and table_schema='public' and table_name='orders' and privilege_type='UPDATE' order by 1");
    expect(cols).toEqual(["estimated_ready_at", "status", "status_reason"]);
  });
});

describe("endurecimento (achados em tests/FINDINGS.md)", () => {
  // F-02 (corrigido na mig. 111): antes, image_path / logo_path aceitavam qualquer texto, inclusive path de outro tenant ou "../".
  it("[F-02] products.image_path e restaurants.logo_path só aceitam o prefixo do próprio restaurante", async () => {
    try {
      const bad = `restaurants/${world().restaurants.b.id}/products/x.png`;
      const r1 = await as("managerA").from("products").update({ image_path: bad }).eq("id", A().productId).select("image_path");
      expect(r1.error, "image_path de outro tenant aceito").not.toBeNull();
      const r2 = await as("ownerA").from("restaurants").update({ logo_path: "../../auth/v1/admin/users" }).eq("id", A().id).select("logo_path");
      expect(r2.error, "logo_path com traversal aceito").not.toBeNull();
    } finally {
      await admin().from("products").update({ image_path: null }).eq("id", A().productId);
      await admin().from("restaurants").update({ logo_path: null }).eq("id", A().id);
    }
  });

  // F-03 (corrigido na mig. 0117/0121): o cliente nunca define nem troca o qr_token.
  it("[F-03] restaurant_tables.qr_token só é gerado pelo servidor: INSERT/UPDATE com token => 42501; rotate_table_qr é o único caminho", async () => {
    const mine: string[] = [];
    try {
      for (const who of ["ownerA", "managerA"] as const) {
        const forgedToken = `ZZFORJADO${who}`.slice(0, 16);
        expectDenied(await as(who).from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-qr-${who}`, qr_token: forgedToken }).select("id"), /42501|permission denied/i);
        expect(rows(await admin().from("restaurant_tables").select("id").eq("qr_token", forgedToken))).toHaveLength(0);
      }
      // cadastro legítimo: o token nasce no servidor, é único e o cliente consegue lê-lo (tables.view)
      const created = await as("ownerA").from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-qr-ok-${Date.now()}` }).select("id,qr_token").single();
      expectOk(created);
      mine.push(created.data!.id);
      expect(created.data!.qr_token).toMatch(/^[A-Za-z0-9_-]{8,}$/);
      const token = created.data!.qr_token as string;
      // UPDATE do token negado; UPDATE de cadastro mantém o token
      expectDenied(await as("ownerA").from("restaurant_tables").update({ qr_token: "ZZFORJADOUPDATE" }).eq("id", created.data!.id).select("id"), /42501|permission denied/i);
      expectDenied(await as("managerA").from("restaurant_tables").update({ qr_token: token }).eq("id", A().tableIds[0]).select("id"), /42501|permission denied/i);
      expectOk(await as("ownerA").from("restaurant_tables").update({ name: `zz-qr-ren-${Date.now()}`, capacity: 6 }).eq("id", created.data!.id).select("id"));
      expect((await admin().from("restaurant_tables").select("qr_token").eq("id", created.data!.id).single()).data?.qr_token).toBe(token);
      // não é oráculo entre tenants: B nunca consegue sondar um token de A por colisão
      expectDenied(await as("managerB").from("restaurant_tables").insert({ restaurant_id: world().restaurants.b.id, name: "zz-qr-b", qr_token: token }).select("id"), /42501|permission denied/i);
      // o caminho legítimo
      const rotated = await as("ownerA").rpc("rotate_table_qr", { p_table: created.data!.id });
      expectOk(rotated);
      expect((rotated.data as any).qr_token).not.toBe(token);
      expect((await admin().from("restaurant_tables").select("qr_token").eq("id", created.data!.id).single()).data?.qr_token).toBe((rotated.data as any).qr_token);
    } finally {
      if (mine.length) await admin().from("restaurant_tables").delete().in("id", mine);
      await admin().from("restaurant_tables").delete().like("name", "zz-qr-%");
    }
  });
});

describe.skipIf(!dockerAvailable)("Fase 4: grants por coluna e EXECUTE das RPCs de comanda/pagamento/mesa (mig. 0117-0123)", () => {
  const cols = (table: string, priv: "INSERT" | "UPDATE") =>
    psql(`select column_name from information_schema.column_privileges where grantee='authenticated' and table_schema='public' and table_name='${table}' and privilege_type='${priv}' order by 1`);
  const tablePriv = (table: string) =>
    psql(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and table_name='${table}'`);

  it("tabs: authenticated só atualiza label/guests e não insere nada; restaurant_tables: sem qr_token/status/created_at/updated_at", () => {
    expect(cols("tabs", "UPDATE")).toEqual(["guests", "label"]);
    expect(cols("tabs", "INSERT")).toEqual([]);
    expect(psql("select count(*) from pg_policies where schemaname='public' and tablename='tabs' and cmd='INSERT'")).toEqual(["0"]);
    expect(cols("restaurant_tables", "INSERT")).toEqual(["area", "capacity", "id", "name", "restaurant_id", "sort_order"]);
    expect(cols("restaurant_tables", "UPDATE")).toEqual(["area", "capacity", "name", "sort_order"]);
    // ninguém (nem anon) escreve nessas tabelas por privilégio de tabela inteira
    expect(psql("select has_table_privilege('anon','public.tabs','insert,update,delete'), has_table_privilege('anon','public.restaurant_tables','insert,update,delete')")).toEqual(["f|f"]);
    expect((tablePriv("tabs") ?? []).join(",")).not.toMatch(/INSERT/);
  });

  const RPCS = [
    "open_tab(uuid,uuid,text,integer)",
    "create_staff_order(uuid,jsonb,text,text)",
    "get_tab_balance(uuid)",
    "record_payment(uuid,uuid,text,integer,integer,text)",
    "close_tab(uuid,text)",
    "cancel_tab(uuid,text)",
    "set_table_status(uuid,text)",
    "request_tab_print(uuid,text)",
    "rotate_table_qr(uuid)",
  ];
  it("EXECUTE só para authenticated (nunca anon nem PUBLIC) nas 9 RPCs da Fase 4; create_staff_order tem uma única assinatura (a de 4 args)", () => {
    for (const fn of RPCS) {
      expect(
        psql(`select has_function_privilege('anon','public.${fn}','execute'), has_function_privilege('authenticated','public.${fn}','execute'), has_function_privilege('public','public.${fn}','execute')`),
        fn,
      ).toEqual(["f|t|f"]);
    }
    expect(psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_staff_order'")).toEqual(["1"]);
    // todas SECURITY DEFINER com search_path vazio
    expect(
      psql(
        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('open_tab','create_staff_order','get_tab_balance','record_payment','close_tab','cancel_tab','set_table_status','request_tab_print','rotate_table_qr') and (not p.prosecdef or p.proconfig is null or not ('search_path=\"\"' = any(p.proconfig)))",
      ),
    ).toEqual(["0"]);
  });

  it("app_private (price_cart_core, price_cart, helpers de comanda) não é executável nem enxergável por anon/authenticated/PUBLIC", async () => {
    expect(psql("select has_schema_privilege('anon','app_private','usage'), has_schema_privilege('authenticated','app_private','usage')")).toEqual(["f|f"]);
    const lines = psql(
      "select p.proname||'|'||has_function_privilege('anon',p.oid,'execute')||'|'||has_function_privilege('authenticated',p.oid,'execute')||'|'||has_function_privilege('public',p.oid,'execute') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname in ('price_cart_core','price_cart','tab_totals','tab_balance_json','payment_json','require_perm') order by 1",
    )!;
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const l of lines) expect(l, l).toMatch(/\|false\|false\|false$|\|f\|f\|f$/);
    const args = { p_restaurant_id: A().id, p_fulfillment: "DINE_IN", p_items: [], p_delivery_zone_id: null, p_staff: true };
    expect((await as("managerA").rpc("price_cart_core", args)).error, "price_cart_core acessível pelo cliente").not.toBeNull();
    expect((await anon().rpc("price_cart_core", args)).error).not.toBeNull();
  });
});
