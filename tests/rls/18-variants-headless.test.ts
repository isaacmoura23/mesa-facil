/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Etapa 2.5 (SaaS headless) — migração 0113, exercitada como o navegador faz (cliente anon / usuário logado):
 *
 *   product_variants              RLS (leitura pública só de ativas em restaurante ativo; escrita só menu.manage), FK composta,
 *                                 DELETE de variante vendida bloqueado, unicidades (nome entre ativas, 1 padrão ativa)
 *   products.badges               CHECK
 *   validate_cart                 variant_id (obrigatória/inexistente/indisponível/preço forjado/adicionais)
 *   public_menu                   variants, price_cents = menor preço disponível, badges, contact, storefront_url
 *   storefront_origins(slug)      leitura PÚBLICA (CORS da API); '{}' para suspenso/pendente/inexistente
 *   get_storefront_origins(uuid)  leitura da EQUIPE; storefront_origins fora do SELECT de anon e authenticated
 *   restaurant_settings           escrita (settings.manage) + CHECKs de contato/URL/origens
 *   order_items                   variant_id exige snapshot; apagar a variante mantém o snapshot
 *
 * Restaurante efêmero "zz-hl-*" (service role) para tudo que não precisa de papéis reais; o DEMO A só é tocado onde
 * a equipe de A é necessária (e restaurado em finally). Dados efêmeros usam o prefixo "zz-".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, rows } from "../helpers/expect";
import { Cleanup, makeOrder, uniq } from "../helpers/factory";
import { clearTodayException, insertRow, setOpenToday, walkKeys } from "../helpers/menu";
import type { AccountKey } from "../fixtures/accounts";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();
afterAll(() => cleanup.run());

// ---------------------------------------------------------------------------------------------------------------------
// utilitários
// ---------------------------------------------------------------------------------------------------------------------
/** Erro do Postgres com SQLSTATE exato (e, opcionalmente, o nome da constraint na mensagem). */
function expectPg(res: { error: { code?: string; message: string } | null }, code: string, text?: RegExp | string) {
  expect(res.error, `esperava o erro ${code}, mas a operação passou`).not.toBeNull();
  expect(res.error!.code, res.error!.message).toBe(code);
  if (text) expect(res.error!.message).toMatch(text instanceof RegExp ? text : new RegExp(text));
}

async function makeRestaurant(status: "active" | "pending" | "suspended" = "active") {
  const slug = `zz-hl-${uniq()}`.slice(0, 40);
  const r = await admin().from("restaurants").insert({ name: `zz DEMO Headless ${slug}`, slug, status }).select("id,slug").single();
  expectOk(r);
  const rest = r.data as { id: string; slug: string };
  cleanup.add(async () => void (await admin().from("restaurants").delete().eq("id", rest.id)));
  // a linha de configurações nasce por trigger; garante mesmo assim
  await admin().from("restaurant_settings").upsert({ restaurant_id: rest.id }, { onConflict: "restaurant_id" });
  return rest;
}

const addVariant = (rid: string, productId: string, v: Record<string, unknown> = {}) =>
  insertRow("product_variants", { restaurant_id: rid, product_id: productId, name: `zz-v-${uniq()}`, price_cents: 1000, ...v });

const setStatusOf = async (rid: string, status: string) => expectOk(await admin().from("restaurants").update({ status }).eq("id", rid));

const cart = async (slug: string, items: unknown[], opts: { fulfillment?: string; client?: ReturnType<typeof anon> } = {}) => {
  const res = await (opts.client ?? anon()).rpc("validate_cart", { p_slug: slug, p_fulfillment: opts.fulfillment ?? "PICKUP", p_items: items });
  expect(res.error, res.error ? `${res.error.code}: ${res.error.message}` : "").toBeNull();
  return res.data as any;
};
const codes = (c: any) => (c.errors as any[]).map((e) => e.code);
const line = (productId: string, quantity: number, extra: Record<string, unknown> = {}) => ({ product_id: productId, quantity, modifier_ids: [], ...extra });

async function menuOf(slug: string, client = anon()) {
  const res = await client.rpc("public_menu", { p_slug: slug });
  expect(res.error, res.error ? `${res.error.code}: ${res.error.message}` : "").toBeNull();
  return res.data as any;
}
const productIn = (menu: any, id: string) => menu.categories.flatMap((c: any) => c.products).find((p: any) => p.id === id);

const COUNT_TABLES = ["orders", "order_items", "order_item_modifiers", "order_counters", "customers", "payments", "tabs", "print_jobs", "product_variants", "audit_logs"];
/** Contagens por restaurante (escopo X: isolado de qualquer outro agente/teste que mexa nos DEMO em paralelo). */
const snapCounts = async (rid: string) => {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) out[t] = (await admin().from(t).select("*", { count: "exact", head: true }).eq("restaurant_id", rid)).count ?? -1;
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// fixtures compartilhadas: restaurante efêmero X (ativo) com cardápio de variantes
// ---------------------------------------------------------------------------------------------------------------------
let X: { id: string; slug: string };
let pV: any; // produto com variantes (preço base 900, que NÃO deve valer)
let pPlain: any; // sem variantes, R$ 10,00
let pOnlyUnavail: any; // única variante indisponível (preço base 777)
let pOther: any; // outro produto de X (com 1 variante)
let vP: any, vM: any, vG: any, vXG: any, vOld: any, vOther: any;
let modA: any, modB: any; // adicionais de pV
let pB: any, vB: any; // produto e variante do DEMO B

beforeAll(async () => {
  X = await makeRestaurant("active");
  await setOpenToday(X.id, true);
  pV = await insertRow("products", { restaurant_id: X.id, name: "zz-pizza", price_cents: 900, sort_order: 1 });
  pPlain = await insertRow("products", { restaurant_id: X.id, name: "zz-agua", price_cents: 1000, sort_order: 2 });
  pOnlyUnavail = await insertRow("products", { restaurant_id: X.id, name: "zz-suco", price_cents: 777, sort_order: 3 });
  pOther = await insertRow("products", { restaurant_id: X.id, name: "zz-pastel", price_cents: 500, sort_order: 4 });
  vP = await addVariant(X.id, pV.id, { name: "P", price_cents: 1000, is_default: true, sort_order: 1 });
  vM = await addVariant(X.id, pV.id, { name: "M", price_cents: 1500, sort_order: 2 });
  vG = await addVariant(X.id, pV.id, { name: "G", price_cents: 2000, sort_order: 3 });
  vXG = await addVariant(X.id, pV.id, { name: "XG", price_cents: 800, is_available: false, sort_order: 4 });
  vOld = await addVariant(X.id, pV.id, { name: "Antiga", price_cents: 500, is_active: false, sort_order: 5 });
  await addVariant(X.id, pOnlyUnavail.id, { name: "Unica", price_cents: 500, is_available: false });
  vOther = await addVariant(X.id, pOther.id, { name: "Grande", price_cents: 1200 });

  const grp = await insertRow("modifier_groups", { restaurant_id: X.id, name: "zz-adicionais", min_selections: 0, max_selections: 2 });
  modA = await insertRow("modifiers", { restaurant_id: X.id, group_id: grp.id, name: "zz-borda", price_delta_cents: 100, sort_order: 1 });
  modB = await insertRow("modifiers", { restaurant_id: X.id, group_id: grp.id, name: "zz-catupiry", price_delta_cents: 250, sort_order: 2 });
  expectOk(await admin().from("product_modifier_groups").insert({ restaurant_id: X.id, product_id: pV.id, group_id: grp.id }));

  pB = await insertRow("products", { restaurant_id: B().id, name: "zz-prod-b", price_cents: 1100, is_active: false });
  vB = await addVariant(B().id, pB.id, { name: "B-unica", price_cents: 1300 });
  cleanup.add(async () => void (await admin().from("products").delete().eq("id", pB.id)));
});
afterAll(async () => {
  await clearTodayException(X.id);
});

// =====================================================================================================================
// 1. product_variants — leitura
// =====================================================================================================================
describe("product_variants — leitura (RLS)", () => {
  it("anon lê só variantes ATIVAS de restaurante ativo (inclui indisponível; oculta a inativa)", async () => {
    const res = await anon().from("product_variants").select("id,name,is_active,is_available").eq("product_id", pV.id).order("sort_order");
    expectOk(res);
    expect(rows(res).map((v) => v.name)).toEqual(["P", "M", "G", "XG"]);
    expect(rows(res).every((v) => v.is_active)).toBe(true);
    expect(rows(res).map((v) => v.id)).not.toContain(vOld.id);
  });

  it("anon e usuário logado SEM vínculo também não veem a inativa; membros de X não existem, mas a equipe de A vê as inativas de A", async () => {
    expect(rows(await as("plain").from("product_variants").select("id").eq("id", vOld.id))).toHaveLength(0);
    expect(rows(await anon().from("product_variants").select("id").eq("id", vOld.id))).toHaveLength(0);

    const inactiveA = await insertRow("products", { restaurant_id: A().id, name: `zz-vis-${uniq()}`, price_cents: 100, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", inactiveA.id)));
    const hidden = await addVariant(A().id, inactiveA.id, { name: "oculta", is_active: false });
    for (const who of ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
      expect(rows(await as(who).from("product_variants").select("id").eq("id", hidden.id)), `${who} (membro) vê a inativa do próprio restaurante`).toHaveLength(1);
    }
    for (const who of ["ownerB", "managerB", "plain"] as AccountKey[]) {
      expect(rows(await as(who).from("product_variants").select("id").eq("id", hidden.id)), `${who} vê variante inativa de A`).toHaveLength(0);
    }
    expect(rows(await anon().from("product_variants").select("id").eq("id", hidden.id))).toHaveLength(0);
  });

  it("restaurante SUSPENSO ou PENDENTE: anon não lê nenhuma variante; ao reativar, volta", async () => {
    const S = await makeRestaurant("active");
    const p = await insertRow("products", { restaurant_id: S.id, name: "zz-prod-s", price_cents: 500 });
    const v = await addVariant(S.id, p.id, { name: "S" });
    expect(rows(await anon().from("product_variants").select("id").eq("id", v.id))).toHaveLength(1);
    await setStatusOf(S.id, "suspended");
    expect(rows(await anon().from("product_variants").select("id").eq("restaurant_id", S.id))).toHaveLength(0);
    expect(rows(await as("plain").from("product_variants").select("id").eq("restaurant_id", S.id))).toHaveLength(0);
    await setStatusOf(S.id, "pending");
    expect(rows(await anon().from("product_variants").select("id").eq("restaurant_id", S.id))).toHaveLength(0);
    await setStatusOf(S.id, "active");
    expect(rows(await anon().from("product_variants").select("id").eq("restaurant_id", S.id))).toHaveLength(1);
  });

  it("isolamento: variante de B não aparece quando se consulta A (nem por filtro de product_id de B) e vice-versa", async () => {
    const bInactive = await addVariant(B().id, pB.id, { name: "B-inativa", is_active: false });
    expect(rows(await as("managerA").from("product_variants").select("id").eq("id", bInactive.id))).toHaveLength(0);
    expect(rows(await as("managerA").from("product_variants").select("id").eq("product_id", pB.id).eq("is_active", false))).toHaveLength(0);
  });
});

// =====================================================================================================================
// 2. product_variants — escrita
// =====================================================================================================================
describe("product_variants — escrita só com menu.manage", () => {
  let pA: any; // produto (inativo, não aparece no cardápio) do DEMO A para os testes de escrita
  beforeAll(async () => {
    pA = await insertRow("products", { restaurant_id: A().id, name: `zz-pw-${uniq()}`, price_cents: 800, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", pA.id)));
  });

  const newRow = (extra: Record<string, unknown> = {}) => ({ restaurant_id: A().id, product_id: pA.id, name: `zz-w-${uniq()}`, price_cents: 1500, ...extra });

  for (const who of ["ownerA", "managerA"] as AccountKey[]) {
    it(`${who} (menu.manage): cria, edita e apaga (não vendida) uma variante`, async () => {
      const c = as(who);
      const ins = await c.from("product_variants").insert(newRow()).select("id,name,price_cents,restaurant_id,is_active").single();
      expectOk(ins);
      const id = (ins.data as any).id;
      const upd = await c.from("product_variants").update({ price_cents: 1777, is_available: false }).eq("id", id).select("price_cents,is_available");
      expectOk(upd);
      expect(rows(upd)).toEqual([{ price_cents: 1777, is_available: false }]);
      const del = await c.from("product_variants").delete().eq("id", id).select("id");
      expectOk(del);
      expect(rows(del)).toHaveLength(1);
      expect((await admin().from("product_variants").select("id").eq("id", id)).data).toEqual([]);
    });
  }

  for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "managerB", "plain"] as AccountKey[]) {
    it(`${who}: não cria, não edita, não apaga variantes de A`, async () => {
      const c = as(who);
      const target = await addVariant(A().id, pA.id, { name: `zz-alvo-${uniq()}`, price_cents: 1234 });
      expectDenied(await c.from("product_variants").insert(newRow()).select("id"));
      expectNotApplied(await c.from("product_variants").update({ price_cents: 1 }).eq("id", target.id).select("id"));
      expectNotApplied(await c.from("product_variants").delete().eq("id", target.id).select("id"));
      const after = (await admin().from("product_variants").select("price_cents").eq("id", target.id).single()).data as any;
      expect(after.price_cents).toBe(1234);
      expect((await admin().from("product_variants").select("id", { count: "exact", head: true }).eq("product_id", pA.id).like("name", "zz-w-%")).count).toBe(0);
    });
  }

  it("anon: sem privilégio de escrita (42501)", async () => {
    const target = await addVariant(A().id, pA.id, { name: `zz-alvo-${uniq()}`, price_cents: 4321 });
    const c = anon();
    expectDenied(await c.from("product_variants").insert(newRow()).select("id"));
    expectDenied(await c.from("product_variants").update({ price_cents: 1 }).eq("id", target.id).select("id"));
    expectDenied(await c.from("product_variants").delete().eq("id", target.id).select("id"));
    expect(((await admin().from("product_variants").select("price_cents").eq("id", target.id).single()).data as any).price_cents).toBe(4321);
  });

  it("gerente de A não move a variante para B (update de restaurant_id) nem insere com restaurant_id de B", async () => {
    const target = await addVariant(A().id, pA.id, { name: `zz-mv-${uniq()}` });
    expectDenied(await as("managerA").from("product_variants").update({ restaurant_id: B().id }).eq("id", target.id).select("id"));
    expectDenied(await as("managerA").from("product_variants").insert({ restaurant_id: B().id, product_id: pB.id, name: "zz-x", price_cents: 1 }).select("id"));
    expect(((await admin().from("product_variants").select("restaurant_id").eq("id", target.id).single()).data as any).restaurant_id).toBe(A().id);
  });

  it("FK composta: variante com restaurant_id de A e product_id de um produto de B é rejeitada (23503), no insert e no update", async () => {
    const ins = await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: pB.id, name: "zz-cross", price_cents: 100 }).select("id");
    expectPg(ins, "23503");
    const own = await addVariant(A().id, pA.id, { name: `zz-fk-${uniq()}` });
    expectPg(await as("managerA").from("product_variants").update({ product_id: pB.id }).eq("id", own.id).select("id"), "23503");
    expect(((await admin().from("product_variants").select("product_id").eq("id", own.id).single()).data as any).product_id).toBe(pA.id);
    // produto inexistente
    expectPg(await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: crypto.randomUUID(), name: "zz-fantasma", price_cents: 1 }).select("id"), "23503");
  });

  it("variante vendida não pode ser APAGADA pela equipe (DELETE filtrado, nada muda); soft-delete (is_active=false) é permitido", async () => {
    const sold = await addVariant(A().id, pA.id, { name: `zz-vendida-${uniq()}`, price_cents: 2200 });
    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectOk(
      await admin().from("order_items").insert({
        restaurant_id: A().id, order_id: order.id, product_id: pA.id, product_name: "zz-pw", variant_id: sold.id, variant_name_snapshot: sold.name,
        unit_price_cents: 2200, quantity: 1, line_total_cents: 2200,
      }),
    );

    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      const del = await as(who).from("product_variants").delete().eq("id", sold.id).select("id");
      expectNotApplied(del);
    }
    expect((await admin().from("product_variants").select("id").eq("id", sold.id)).data).toHaveLength(1);

    // soft-delete permitido
    const soft = await as("managerA").from("product_variants").update({ is_active: false }).eq("id", sold.id).select("is_active");
    expectOk(soft);
    expect(rows(soft)).toEqual([{ is_active: false }]);
    // ainda não pode apagar depois de inativa
    expectNotApplied(await as("managerA").from("product_variants").delete().eq("id", sold.id).select("id"));
    expect((await admin().from("product_variants").select("id").eq("id", sold.id)).data).toHaveLength(1);

    // controle positivo: variante NUNCA vendida é apagável
    const fresh = await addVariant(A().id, pA.id, { name: `zz-livre-${uniq()}` });
    expect(rows(await as("managerA").from("product_variants").delete().eq("id", fresh.id).select("id"))).toHaveLength(1);
  });

  it("variant_has_orders(): só authenticated executa; anon recebe 42501; estranho a A recebe false mesmo para variante vendida", async () => {
    const sold = await addVariant(A().id, pA.id, { name: `zz-vho-${uniq()}` });
    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    expectOk(
      await admin().from("order_items").insert({
        restaurant_id: A().id, order_id: order.id, product_id: pA.id, product_name: "zz", variant_id: sold.id, variant_name_snapshot: sold.name,
        unit_price_cents: 100, quantity: 1, line_total_cents: 100,
      }),
    );
    expectDenied(await anon().rpc("variant_has_orders", { vid: sold.id }));
    expect((await as("managerA").rpc("variant_has_orders", { vid: sold.id })).data).toBe(true);
    expect((await as("ownerB").rpc("variant_has_orders", { vid: sold.id })).data).toBe(false); // sem vínculo: não vira oráculo de vendas
    expect((await as("managerA").rpc("variant_has_orders", { vid: crypto.randomUUID() })).data).toBe(false);
  });

  it("nome único entre variantes ATIVAS do produto (sem diferenciar caixa nem espaços nas pontas); inativas não contam", async () => {
    const base = `zz-nome-${uniq()}`;
    await addVariant(A().id, pA.id, { name: base });
    for (const dup of [base, base.toUpperCase(), `  ${base}  `, base[0].toUpperCase() + base.slice(1)]) {
      expectPg(await as("managerA").from("product_variants").insert(newRow({ name: dup })).select("id"), "23505", /product_variants_name_uq/);
    }
    // outro produto aceita o mesmo nome
    const pDup = await insertRow("products", { restaurant_id: A().id, name: `zz-dup-${uniq()}`, price_cents: 100, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", pDup.id)));
    expectOk(await admin().from("product_variants").insert({ restaurant_id: A().id, product_id: pDup.id, name: base, price_cents: 1 }));
    // inativas duplicadas são permitidas (soft-delete repetido)
    expectOk(await as("managerA").from("product_variants").insert(newRow({ name: base, is_active: false })).select("id"));
    expectOk(await as("managerA").from("product_variants").insert(newRow({ name: base, is_active: false })).select("id"));
    // reativar uma duplicada de ativa viola o índice
    const dormant = (await admin().from("product_variants").select("id").eq("product_id", pA.id).eq("name", base).eq("is_active", false).limit(1).single()).data as any;
    expectPg(await as("managerA").from("product_variants").update({ is_active: true }).eq("id", dormant.id).select("id"), "23505");
  });

  it("no máximo 1 variante PADRÃO ativa por produto (a inativa pode ser padrão)", async () => {
    const p = await insertRow("products", { restaurant_id: A().id, name: `zz-pd-${uniq()}`, price_cents: 100, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", p.id)));
    const first = await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: p.id, name: "um", price_cents: 100, is_default: true }).select("id").single();
    expectOk(first);
    expectPg(await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: p.id, name: "dois", price_cents: 100, is_default: true }).select("id"), "23505", /product_variants_one_default_uq/);
    // não padrão: ok; promover a segunda a padrão: viola; inativa padrão: ok
    const second = await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: p.id, name: "dois", price_cents: 100 }).select("id").single();
    expectOk(second);
    expectPg(await as("managerA").from("product_variants").update({ is_default: true }).eq("id", (second.data as any).id).select("id"), "23505");
    expectOk(await as("managerA").from("product_variants").insert({ restaurant_id: A().id, product_id: p.id, name: "tres", price_cents: 100, is_default: true, is_active: false }).select("id"));
    // trocar o padrão: tira de um e põe no outro em sequência
    expectOk(await as("managerA").from("product_variants").update({ is_default: false }).eq("id", (first.data as any).id).select("id"));
    expectOk(await as("managerA").from("product_variants").update({ is_default: true }).eq("id", (second.data as any).id).select("id"));
  });

  it("CHECKs de variante: nome vazio/branco/longo (>40) e preço negativo", async () => {
    for (const name of ["", "   ", "x".repeat(41)]) {
      expectPg(await as("managerA").from("product_variants").insert(newRow({ name })).select("id"), "23514");
    }
    expectOk(await as("managerA").from("product_variants").insert(newRow({ name: "x".repeat(40) })).select("id"));
    expectPg(await as("managerA").from("product_variants").insert(newRow({ price_cents: -1 })).select("id"), "23514");
    expectOk(await as("managerA").from("product_variants").insert(newRow({ price_cents: 0 })).select("id")); // grátis é válido
  });

  it("apagar o PRODUTO leva as variantes (cascade); apagar o restaurante também", async () => {
    const S = await makeRestaurant("active");
    const p = await insertRow("products", { restaurant_id: S.id, name: "zz-casc", price_cents: 100 });
    const v = await addVariant(S.id, p.id, { name: "c" });
    expectOk(await admin().from("products").delete().eq("id", p.id));
    expect((await admin().from("product_variants").select("id").eq("id", v.id)).data).toEqual([]);
  });
});

// =====================================================================================================================
// 3. products.badges
// =====================================================================================================================
describe("products.badges — CHECK", () => {
  let p: any;
  beforeAll(async () => {
    p = await insertRow("products", { restaurant_id: A().id, name: `zz-badge-${uniq()}`, price_cents: 100, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", p.id)));
  });
  const set = (badges: unknown, who: AccountKey = "managerA") => as(who).from("products").update({ badges }).eq("id", p.id).select("badges");

  it("valores permitidos (NEW, POPULAR, REGIONAL, SWEET, SPICY, VEGETARIAN), na ordem enviada, até 4", async () => {
    const ok = await set(["NEW", "SPICY"]);
    expectOk(ok);
    expect(rows(ok)[0].badges).toEqual(["NEW", "SPICY"]);
    for (const list of [[], ["POPULAR"], ["REGIONAL", "SWEET", "VEGETARIAN", "NEW"]]) {
      const r = await set(list);
      expectOk(r);
      expect(rows(r)[0].badges).toEqual(list);
    }
  });

  it("rejeita selo desconhecido, minúsculo, vazio, duplicado, mais de 4 e NULL", async () => {
    expectPg(await set(["FOO"]), "23514", /products_badges_valid/);
    expectPg(await set(["new"]), "23514");
    expectPg(await set([""]), "23514");
    expectPg(await set(["NEW", "NEW"]), "23514");
    expectPg(await set(["NEW", "SPICY", "NEW"]), "23514");
    expectPg(await set(["NEW", "POPULAR", "SWEET", "SPICY", "NEW"]), "23514");
    expectPg(await set(["NEW", "POPULAR", "SWEET", "SPICY", "VEGETARIAN"]), "23514"); // 5 distintos > 4
    expectPg(await set(["NEW'; drop table products;--"]), "23514");
    expectPg(await set(null), "23502"); // not null
    // nada disso alterou o produto
    expect(((await admin().from("products").select("badges").eq("id", p.id).single()).data as any).badges).toEqual(["REGIONAL", "SWEET", "VEGETARIAN", "NEW"]);
  });

  it("só menu.manage altera selos (caixa/garçom/cozinha/dono de B: nenhuma linha afetada); anon: 42501", async () => {
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB"] as AccountKey[]) {
      expectNotApplied(await set(["POPULAR"], who));
    }
    expectDenied(await anon().from("products").update({ badges: ["POPULAR"] }).eq("id", p.id).select("id"));
    expect(((await admin().from("products").select("badges").eq("id", p.id).single()).data as any).badges).toEqual(["REGIONAL", "SWEET", "VEGETARIAN", "NEW"]);
  });
});

// =====================================================================================================================
// 4. validate_cart com variantes
// =====================================================================================================================
describe("validate_cart — variantes", () => {
  it("produto COM variantes exige variant_id (ausente ou null => VARIANT_REQUIRED no índice do item)", async () => {
    for (const items of [[line(pV.id, 1)], [line(pV.id, 1, { variant_id: null })]]) {
      const c = await cart(X.slug, items);
      expect(c.ok).toBe(false);
      expect(c.errors).toEqual([expect.objectContaining({ code: "VARIANT_REQUIRED", item_index: 0 })]);
      expect(c.items).toEqual([]);
      expect(c.total_cents).toBe(0);
    }
    const second = await cart(X.slug, [line(pPlain.id, 1), line(pV.id, 1)]);
    expect(second.errors.map((e: any) => [e.code, e.item_index])).toEqual([["VARIANT_REQUIRED", 1]]);
  });

  it("com variant_id válido: preço unitário = preço da VARIANTE (o preço base 900 do produto é ignorado); devolve variant{id,name,price_cents}", async () => {
    const c = await cart(X.slug, [line(pV.id, 3, { variant_id: vG.id })]);
    expect(c.ok, JSON.stringify(c.errors)).toBe(true);
    expect(c.items[0]).toMatchObject({ product_id: pV.id, quantity: 3, unit_price_cents: 2000, line_total_cents: 6000, variant: { id: vG.id, name: "G", price_cents: 2000 } });
    expect(c).toMatchObject({ subtotal_cents: 6000, total_cents: 6000 });
    const small = await cart(X.slug, [line(pV.id, 1, { variant_id: vP.id })]);
    expect(small.items[0]).toMatchObject({ unit_price_cents: 1000, variant: { name: "P" } });
  });

  it("variante inexistente / de outro PRODUTO / de outro RESTAURANTE / malformada => VARIANT_NOT_ALLOWED, indistinguíveis entre si", async () => {
    const attempts: unknown[] = [crypto.randomUUID(), vOther.id, vB.id, "nao-e-uuid", 123, { id: vP.id }, [vP.id], true, "", "' or 1=1 --"];
    const seen = new Set<string>();
    for (const variant_id of attempts) {
      const c = await cart(X.slug, [line(pV.id, 1, { variant_id })]);
      expect(c.ok, JSON.stringify(variant_id)).toBe(false);
      expect(codes(c), JSON.stringify(variant_id)).toEqual(["VARIANT_NOT_ALLOWED"]);
      expect(c.items).toEqual([]);
      seen.add(JSON.stringify(c.errors));
    }
    expect(seen.size, "mensagens/índices diferentes revelariam se a variante existe em outro produto/restaurante").toBe(1);
  });

  it("variante informada para produto SEM variantes => VARIANT_NOT_ALLOWED", async () => {
    const c = await cart(X.slug, [line(pPlain.id, 1, { variant_id: vP.id })]);
    expect(codes(c)).toEqual(["VARIANT_NOT_ALLOWED"]);
    const own = await cart(X.slug, [line(pPlain.id, 1, { variant_id: crypto.randomUUID() })]);
    expect(codes(own)).toEqual(["VARIANT_NOT_ALLOWED"]);
  });

  it("variante indisponível (is_available=false) ou inativa => VARIANT_UNAVAILABLE; nada é cobrado", async () => {
    for (const v of [vXG, vOld]) {
      const c = await cart(X.slug, [line(pV.id, 1, { variant_id: v.id })]);
      expect(codes(c)).toEqual(["VARIANT_UNAVAILABLE"]);
      expect(c.errors[0].item_index).toBe(0);
      expect(c.subtotal_cents).toBe(0);
    }
    // produto cuja ÚNICA variante ativa está indisponível: ainda exige variante (e ela está indisponível)
    const only = (await admin().from("product_variants").select("id").eq("product_id", pOnlyUnavail.id).single()).data as any;
    expect(codes(await cart(X.slug, [line(pOnlyUnavail.id, 1)]))).toEqual(["VARIANT_REQUIRED"]);
    expect(codes(await cart(X.slug, [line(pOnlyUnavail.id, 1, { variant_id: only.id })]))).toEqual(["VARIANT_UNAVAILABLE"]);
  });

  it("preço forjado é ignorado: price_cents, unit_price_cents, variant{price_cents}, total_cents... nada muda o total", async () => {
    const honest = await cart(X.slug, [line(pV.id, 2, { variant_id: vM.id })]);
    const forged = await cart(X.slug, [
      line(pV.id, 2, {
        variant_id: vM.id, price_cents: 1, unit_price_cents: 1, variant_price_cents: 1, line_total_cents: 1, total_cents: 1,
        variant: { id: vM.id, price_cents: 1, name: "G" }, discount_cents: 99999,
      }),
    ]);
    expect(forged.total_cents).toBe(honest.total_cents);
    expect(forged.total_cents).toBe(3000);
    expect(forged.items[0]).toMatchObject({ unit_price_cents: 1500, variant: { id: vM.id, name: "M", price_cents: 1500 } });
    expect(forged.discount_cents).toBe(0);
  });

  it("preço = variante + adicionais, por unidade (× quantidade)", async () => {
    const c = await cart(X.slug, [line(pV.id, 2, { variant_id: vM.id, modifier_ids: [modA.id, modB.id] })]);
    expect(c.ok, JSON.stringify(c.errors)).toBe(true);
    // (1500 + 100 + 250) * 2
    expect(c.items[0]).toMatchObject({ unit_price_cents: 1500, modifiers_cents: 350, line_total_cents: 3700, variant: { name: "M" } });
    expect(c.items[0].modifiers.map((m: any) => m.price_delta_cents).sort()).toEqual([100, 250]);
    expect(c.total_cents).toBe(3700);
  });

  it("produto SEM variantes segue inalterado: preço do produto, variant = null", async () => {
    const c = await cart(X.slug, [line(pPlain.id, 3)]);
    expect(c.ok).toBe(true);
    expect(c.items[0]).toMatchObject({ unit_price_cents: 1000, quantity: 3, line_total_cents: 3000, variant: null });
    const mixed = await cart(X.slug, [line(pPlain.id, 1), line(pV.id, 1, { variant_id: vP.id }), line(pOther.id, 2, { variant_id: vOther.id })]);
    expect(mixed.ok, JSON.stringify(mixed.errors)).toBe(true);
    expect(mixed.total_cents).toBe(1000 + 1000 + 2 * 1200);
  });

  it("produto de X com a variante de B em outro slug: produto de outro restaurante => PRODUTO indisponível (a variante nem é avaliada)", async () => {
    const c = await cart("demo-b", [line(pV.id, 1, { variant_id: vB.id })]);
    expect(codes(c)).toContain("PRODUCT_UNAVAILABLE");
    expect(codes(c)).not.toContain("VARIANT_NOT_ALLOWED");
  });

  it("mudar o preço/disponibilidade da variante (service role) muda o total do próximo orçamento", async () => {
    const pMut = await insertRow("products", { restaurant_id: X.id, name: "zz-mut", price_cents: 1000, sort_order: 9 });
    const v = await addVariant(X.id, pMut.id, { name: "mutavel", price_cents: 1100 });
    // pMut agora tem variante => exige variant_id
    expect(codes(await cart(X.slug, [line(pMut.id, 1)]))).toEqual(["VARIANT_REQUIRED"]);
    expect((await cart(X.slug, [line(pMut.id, 2, { variant_id: v.id })])).total_cents).toBe(2200);
    expectOk(await admin().from("product_variants").update({ price_cents: 1300 }).eq("id", v.id));
    expect((await cart(X.slug, [line(pMut.id, 2, { variant_id: v.id })])).total_cents).toBe(2600);
    expectOk(await admin().from("product_variants").update({ is_available: false }).eq("id", v.id));
    expect(codes(await cart(X.slug, [line(pMut.id, 2, { variant_id: v.id })]))).toEqual(["VARIANT_UNAVAILABLE"]);
    // soft-delete da única variante: o produto volta a ser "sem variantes" e usa o preço base
    expectOk(await admin().from("product_variants").update({ is_active: false, is_available: true }).eq("id", v.id));
    const back = await cart(X.slug, [line(pMut.id, 2)]);
    expect(back.ok, JSON.stringify(back.errors)).toBe(true);
    expect(back.total_cents).toBe(2000);
    expect(back.items[0].variant).toBeNull();
    await admin().from("products").update({ is_active: false }).eq("id", pMut.id);
  });

  it("variante vale também para DELIVERY/mínimo: pedido mínimo considera o preço da variante", async () => {
    expectOk(await admin().from("restaurant_settings").update({ min_order_cents: 1800 }).eq("restaurant_id", X.id));
    try {
      const below = await cart(X.slug, [line(pV.id, 1, { variant_id: vP.id })]); // 1000 < 1800
      expect(codes(below)).toEqual(["BELOW_MINIMUM"]);
      const ok = await cart(X.slug, [line(pV.id, 1, { variant_id: vG.id })]); // 2000 >= 1800
      expect(ok.ok, JSON.stringify(ok.errors)).toBe(true);
    } finally {
      await admin().from("restaurant_settings").update({ min_order_cents: 0 }).eq("restaurant_id", X.id);
    }
  });

  it("restaurante suspenso: RESTAURANT_UNAVAILABLE, sem revelar variantes; nada é gravado em nenhuma tabela", async () => {
    const before = await snapCounts(X.id);
    const calls: Promise<any>[] = [];
    for (let i = 0; i < 6; i++) {
      calls.push(cart(X.slug, [line(pV.id, 1 + i, { variant_id: vM.id })]));
      calls.push(cart(X.slug, [line(pV.id, 1)]));
      calls.push(cart(X.slug, [line(pV.id, 1, { variant_id: vXG.id })], { client: as("waiterA") }));
    }
    await Promise.all(calls);
    const S = await makeRestaurant("suspended");
    const susp = await cart(S.slug, [line(pV.id, 1, { variant_id: vM.id })]);
    expect(codes(susp)).toEqual(["RESTAURANT_UNAVAILABLE"]);
    expect(await snapCounts(X.id)).toEqual(before);
  });
});

// =====================================================================================================================
// 5. public_menu
// =====================================================================================================================
describe("public_menu — variantes, selos, contato e URL da vitrine", () => {
  it("produto com variantes: lista ordenada, só ativas, campos públicos; price_cents = MENOR preço disponível (a indisponível mais barata não conta)", async () => {
    expectOk(await admin().from("products").update({ badges: ["NEW", "SPICY"] }).eq("id", pV.id));
    const m = await menuOf(X.slug);
    const p = productIn(m, pV.id);
    expect(p).toBeTruthy();
    expect(p.price_cents).toBe(1000); // P=1000 (XG=800 está indisponível e Antiga=500 está inativa)
    expect(p.badges).toEqual(["NEW", "SPICY"]);
    expect(p.variants.map((v: any) => v.name)).toEqual(["P", "M", "G", "XG"]);
    expect(p.variants.map((v: any) => v.price_cents)).toEqual([1000, 1500, 2000, 800]);
    expect(p.variants.map((v: any) => v.is_default)).toEqual([true, false, false, false]);
    expect(p.variants.map((v: any) => v.is_available)).toEqual([true, true, true, false]);
    for (const v of p.variants) expect(Object.keys(v).sort()).toEqual(["id", "is_available", "is_default", "name", "price_cents"]);
    expect(JSON.stringify(m)).not.toContain(vOld.id); // variante inativa não vaza
    expect(JSON.stringify(m)).not.toContain("Antiga");
  });

  it("todas as variantes indisponíveis => price_cents cai para o preço base do produto; produto sem variantes => variants [] e badges []", async () => {
    const m = await menuOf(X.slug);
    expect(productIn(m, pOnlyUnavail.id)).toMatchObject({ price_cents: 777, variants: [expect.objectContaining({ name: "Unica", is_available: false })] });
    expect(productIn(m, pPlain.id)).toMatchObject({ price_cents: 1000, badges: [], variants: [] });
  });

  it("nenhuma chave interna nem storefront_origins no JSON; 'phone' só dentro de restaurant.contact", async () => {
    const S = await makeRestaurant("active");
    expectOk(await admin().from("restaurant_settings").update({ storefront_origins: ["https://zz-segredo.example.com"], phone: "(11) 4000-1234", whatsapp: "5511999990000" }).eq("restaurant_id", S.id));
    const m = await menuOf(S.slug);
    const text = JSON.stringify(m);
    expect(text).not.toContain("storefront_origins");
    expect(text).not.toContain("zz-segredo");
    const { restaurant, ...rest } = m;
    expect(walkKeys(rest).has("phone")).toBe(false);
    expect(Object.keys(restaurant).sort()).toEqual(["contact", "id", "logo_path", "name", "slug", "storefront_url", "timezone"]);
    expect(Object.keys(restaurant.contact).sort()).toEqual(["address_text", "phone", "whatsapp"]);
  });

  it("contato e storefront_url vêm das configurações; vazio => null", async () => {
    const S = await makeRestaurant("active");
    let m = await menuOf(S.slug);
    expect(m.restaurant.contact).toEqual({ whatsapp: null, phone: null, address_text: null });
    expect(m.restaurant.storefront_url).toBeNull();
    expectOk(
      await admin().from("restaurant_settings").update({ whatsapp: "+5511999990000", phone: "(11) 4000-1234", address_text: "Rua Zz, 10 - Centro", storefront_url: "https://la-zz.vercel.app/cardapio" }).eq("restaurant_id", S.id),
    );
    m = await menuOf(S.slug);
    expect(m.restaurant.contact).toEqual({ whatsapp: "+5511999990000", phone: "(11) 4000-1234", address_text: "Rua Zz, 10 - Centro" });
    expect(m.restaurant.storefront_url).toBe("https://la-zz.vercel.app/cardapio");
    // authenticated vê o mesmo (a RPC é a mesma)
    expect((await menuOf(S.slug, as("plain"))).restaurant.contact).toEqual(m.restaurant.contact);
  });

  it("suspenso/pendente/inexistente => null (nenhum dado de variante)", async () => {
    const S = await makeRestaurant("active");
    const p = await insertRow("products", { restaurant_id: S.id, name: "zz-p", price_cents: 100 });
    await addVariant(S.id, p.id, { name: "v" });
    expect((await menuOf(S.slug))?.categories).toBeTruthy();
    await setStatusOf(S.id, "suspended");
    expect(await menuOf(S.slug)).toBeNull();
    await setStatusOf(S.id, "pending");
    expect(await menuOf(S.slug)).toBeNull();
    expect(await menuOf(`zz-nao-existe-${uniq()}`)).toBeNull();
  });

  it("selo/variante de B não aparece no menu de A e vice-versa", async () => {
    const mA = JSON.stringify(await menuOf("demo-a"));
    expect(mA).not.toContain(vB.id);
    expect(mA).not.toContain(vP.id);
    expect(JSON.stringify(await menuOf("demo-b"))).not.toContain(vP.id);
  });
});

// =====================================================================================================================
// 6. storefront_origins(slug) — pública
// =====================================================================================================================
describe("storefront_origins(p_slug) — leitura pública para o CORS", () => {
  const ORIGINS = ["https://zz-loja.vercel.app", "https://zz-loja.example.com:8443"];
  let S: { id: string; slug: string };
  beforeAll(async () => {
    S = await makeRestaurant("active");
    expectOk(await admin().from("restaurant_settings").update({ storefront_origins: ORIGINS }).eq("restaurant_id", S.id));
  });
  const call = (slug: string | null, client = anon()) => client.rpc("storefront_origins", { p_slug: slug });

  it("anon e authenticated recebem a lista de restaurante ATIVO", async () => {
    for (const client of [anon(), as("plain"), as("ownerB")]) {
      const r = await call(S.slug, client);
      expectOk(r);
      expect(r.data).toEqual(ORIGINS);
    }
  });

  it("slug é normalizado (minúsculas e espaços nas pontas)", async () => {
    expect((await call(`  ${S.slug.toUpperCase()}  `)).data).toEqual(ORIGINS);
    // btrim só remove ESPAÇOS (tab/quebra de linha não são removidos => não casa)
    expect((await call(`\t${S.slug}\n`)).data).toEqual([]);
  });

  it("restaurante sem origens => []; NULL, vazio, inexistente e slugs hostis => [] (nunca erro nem dado alheio)", async () => {
    const empty = await makeRestaurant("active");
    expect((await call(empty.slug)).data).toEqual([]);
    for (const slug of [null, "", "   ", `zz-nao-existe-${uniq()}`, "' or 1=1 --", "%", "demo-a%", "x".repeat(5000), "../demo-a"]) {
      const r = await call(slug as string | null);
      expect(r.error, JSON.stringify(slug)).toBeNull();
      expect(r.data, JSON.stringify(slug)).toEqual([]);
    }
  });

  it("SUSPENSO e PENDENTE => []; ao reativar, volta", async () => {
    await setStatusOf(S.id, "suspended");
    expect((await call(S.slug)).data).toEqual([]);
    await setStatusOf(S.id, "pending");
    expect((await call(S.slug)).data).toEqual([]);
    await setStatusOf(S.id, "active");
    expect((await call(S.slug)).data).toEqual(ORIGINS);
  });

  it("não vaza as origens de OUTRO restaurante: o slug de B devolve só o que B tem", async () => {
    const r = await call("demo-b");
    expectOk(r);
    for (const o of ORIGINS) expect(r.data as string[]).not.toContain(o);
  });
});

// =====================================================================================================================
// 7. get_storefront_origins(uuid) — equipe
// =====================================================================================================================
describe("get_storefront_origins(p_restaurant) — leitura da equipe", () => {
  const ORIGINS = [`https://zz-a-${uniq()}.example.com`];
  let prev: string[] = [];
  beforeAll(async () => {
    prev = ((await admin().from("restaurant_settings").select("storefront_origins").eq("restaurant_id", A().id).single()).data as any).storefront_origins;
    expectOk(await admin().from("restaurant_settings").update({ storefront_origins: ORIGINS }).eq("restaurant_id", A().id));
  });
  afterAll(async () => {
    await admin().from("restaurant_settings").update({ storefront_origins: prev }).eq("restaurant_id", A().id);
    await admin().from("support_sessions").update({ ended_at: new Date().toISOString() }).eq("restaurant_id", A().id).is("ended_at", null);
  });
  const get = (who: AccountKey | "anon", rid: string | null = A().id) => (who === "anon" ? anon() : as(who)).rpc("get_storefront_origins", { p_restaurant: rid });

  for (const who of ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA"] as AccountKey[]) {
    it(`${who} (membro de A) lê as origens de A`, async () => {
      const r = await get(who);
      expectOk(r);
      expect(r.data).toEqual(ORIGINS);
    });
  }

  it("anon não executa (42501); sem vínculo, dono/gerente de B, superadmin e suporte SEM sessão => forbidden", async () => {
    expectDenied(await get("anon"));
    for (const who of ["plain", "ownerB", "managerB", "cashierB", "superadmin", "support"] as AccountKey[]) {
      const r = await get(who);
      expectDenied(r, /forbidden|42501/);
      expect(JSON.stringify(r.data ?? null)).not.toContain("zz-a-");
    }
  });

  it("id nulo, inexistente ou de B => forbidden para a equipe de A", async () => {
    expectDenied(await get("ownerA", null), /forbidden|42501/);
    expectDenied(await get("ownerA", crypto.randomUUID()), /forbidden|42501/);
    expectDenied(await get("ownerA", B().id), /forbidden|42501/);
  });

  it("suporte COM sessão ativa lê; ao encerrar a sessão, perde o acesso", async () => {
    const open = await as("support").rpc("open_support_session", { p_restaurant: A().id, p_reason: "zz teste: ler origens da vitrine", p_minutes: 15 });
    expectOk(open);
    const r = await get("support");
    expectOk(r);
    expect(r.data).toEqual(ORIGINS);
    await admin().from("support_sessions").update({ ended_at: new Date().toISOString() }).eq("restaurant_id", A().id).is("ended_at", null);
    expectDenied(await get("support"), /forbidden|42501/);
  });

  it("membro de restaurante SUSPENSO perde o acesso (is_member exige restaurante não suspenso); restaurante efêmero com vínculo temporário", async () => {
    const S = await makeRestaurant("active");
    expectOk(await admin().from("restaurant_settings").update({ storefront_origins: ["https://zz-susp.example.com"] }).eq("restaurant_id", S.id));
    const mem = await admin().from("restaurant_memberships").insert({ restaurant_id: S.id, user_id: world().users.plain.id, role: "manager", status: "active" }).select("id").single();
    expectOk(mem);
    try {
      expect((await get("plain", S.id)).data).toEqual(["https://zz-susp.example.com"]);
      await setStatusOf(S.id, "suspended");
      expectDenied(await get("plain", S.id), /forbidden|42501/);
      await setStatusOf(S.id, "active");
      expect((await get("plain", S.id)).data).toEqual(["https://zz-susp.example.com"]);
    } finally {
      await admin().from("restaurant_memberships").delete().eq("id", (mem.data as any).id);
    }
    expectDenied(await get("plain", S.id), /forbidden|42501/); // vínculo removido
  });
});

// =====================================================================================================================
// 8. restaurant_settings — storefront_origins fora do SELECT; escrita; CHECKs
// =====================================================================================================================
describe("restaurant_settings — storefront_origins é ilegível por anon/authenticated", () => {
  const SECRET = [`https://zz-secreto-${uniq()}.example.com`];
  let prev: any;
  beforeAll(async () => {
    prev = (await admin().from("restaurant_settings").select("storefront_origins,whatsapp,phone,address_text,storefront_url").eq("restaurant_id", A().id).single()).data;
    expectOk(await admin().from("restaurant_settings").update({ storefront_origins: SECRET }).eq("restaurant_id", A().id));
  });
  afterAll(async () => {
    await admin().from("restaurant_settings").update(prev).eq("restaurant_id", A().id);
  });

  const clients: Array<[string, () => ReturnType<typeof anon>]> = [
    ["anon", () => anon()],
    ["plain (logado sem vínculo)", () => as("plain")],
    ["ownerB (outro restaurante)", () => as("ownerB")],
    ["cashierA (equipe de A)", () => as("cashierA")],
    ["ownerA (dono de A)", () => as("ownerA")],
    ["managerA", () => as("managerA")],
  ];

  for (const [label, mk] of clients) {
    it(`${label}: SELECT da coluna, select=*, filtro e ordenação por storefront_origins => permission denied; nenhuma origem vaza`, async () => {
      const c = mk();
      const direct = await c.from("restaurant_settings").select("storefront_origins").eq("restaurant_id", A().id);
      expectDenied(direct, /permission denied|42501/);
      expect(JSON.stringify(direct.data ?? null)).not.toContain("zz-secreto");

      const star = await c.from("restaurant_settings").select("*").eq("restaurant_id", A().id);
      expectDenied(star, /permission denied|42501/);
      expect(JSON.stringify(star.data ?? null)).not.toContain("zz-secreto");

      // oráculo por filtro (contains / is not null / eq) e por ordenação
      expectDenied(await c.from("restaurant_settings").select("restaurant_id").contains("storefront_origins", SECRET), /permission denied|42501/);
      expectDenied(await c.from("restaurant_settings").select("restaurant_id").not("storefront_origins", "is", null), /permission denied|42501/);
      expectDenied(await c.from("restaurant_settings").select("restaurant_id").order("storefront_origins"), /permission denied|42501/);
      // embed pelo restaurante também não dá acesso
      const embed = await c.from("restaurants").select("id,restaurant_settings(storefront_origins)").eq("id", A().id);
      expect(JSON.stringify(embed.data ?? null)).not.toContain("zz-secreto");
    });
  }

  it("as demais colunas (contato, URL, horários...) seguem legíveis: anon e logado leem as de restaurante ativo", async () => {
    const cols = "restaurant_id,accepts_orders,prep_time_minutes,min_order_cents,enabled_fulfillment_types,whatsapp,phone,address_text,storefront_url";
    for (const c of [anon(), as("plain"), as("ownerB"), as("ownerA")]) {
      const r = await c.from("restaurant_settings").select(cols).eq("restaurant_id", A().id);
      expectOk(r);
      expect(rows(r)).toHaveLength(1);
    }
  });

  it("restaurante suspenso: anon não lê nem as colunas públicas", async () => {
    const S = await makeRestaurant("suspended");
    expect(rows(await anon().from("restaurant_settings").select("restaurant_id,phone").eq("restaurant_id", S.id))).toHaveLength(0);
    expect(rows(await as("plain").from("restaurant_settings").select("restaurant_id,phone").eq("restaurant_id", S.id))).toHaveLength(0);
  });

  it("UPDATE ... RETURNING storefront_origins é negado e NÃO altera nada (anon, estranho, dono de B, caixa, dono de A e gerente)", async () => {
    const attempt = [`https://zz-ataque-${uniq()}.example.com`];
    for (const [label, mk] of clients) {
      const r = await mk().from("restaurant_settings").update({ storefront_origins: attempt }).eq("restaurant_id", A().id).select("storefront_origins");
      expectDenied(r, /permission denied|42501/);
      expect(JSON.stringify(r.data ?? null), label).not.toContain("zz-secreto");
    }
    expect(((await admin().from("restaurant_settings").select("storefront_origins").eq("restaurant_id", A().id).single()).data as any).storefront_origins).toEqual(SECRET);
  });

  it("anon não escreve nada em restaurant_settings", async () => {
    expectDenied(await anon().from("restaurant_settings").update({ phone: "(11) 4000-0000" }).eq("restaurant_id", A().id).select("restaurant_id"));
    expectDenied(await anon().from("restaurant_settings").insert({ restaurant_id: B().id }).select("restaurant_id"));
  });
});

describe("restaurant_settings — quem pode editar contato, URL e origens", () => {
  let prev: any;
  beforeAll(async () => {
    prev = (await admin().from("restaurant_settings").select("storefront_origins,whatsapp,phone,address_text,storefront_url").eq("restaurant_id", A().id).single()).data;
  });
  afterAll(async () => {
    await admin().from("restaurant_settings").update(prev).eq("restaurant_id", A().id);
  });
  const read = async (rid = A().id) =>
    (await admin().from("restaurant_settings").select("storefront_origins,whatsapp,phone,address_text,storefront_url").eq("restaurant_id", rid).single()).data as any;

  for (const who of ["ownerA", "managerA"] as AccountKey[]) {
    it(`${who} (restaurant.settings.manage) atualiza contato, URL e origens (e a leitura da equipe devolve o novo valor)`, async () => {
      const tag = uniq();
      const patch = {
        whatsapp: "+5511988887777", phone: "(11) 3000-1111", address_text: `Rua ${tag}, 1`, storefront_url: `https://zz-${tag}.vercel.app`,
        storefront_origins: [`https://zz-${tag}.vercel.app`, "https://www.zz-loja.com.br"],
      };
      const upd = await as(who).from("restaurant_settings").update(patch).eq("restaurant_id", A().id).select("restaurant_id,whatsapp,phone,address_text,storefront_url");
      expectOk(upd);
      expect(rows(upd)).toHaveLength(1);
      expect(await read()).toEqual(patch);
      expect((await as(who).rpc("get_storefront_origins", { p_restaurant: A().id })).data).toEqual(patch.storefront_origins);
      expect((await anon().rpc("storefront_origins", { p_slug: "demo-a" })).data).toEqual(patch.storefront_origins);
      // volta a nulo/vazio
      expectOk(await as(who).from("restaurant_settings").update({ whatsapp: null, phone: null, address_text: null, storefront_url: null, storefront_origins: [] }).eq("restaurant_id", A().id));
      expect(await read()).toEqual({ whatsapp: null, phone: null, address_text: null, storefront_url: null, storefront_origins: [] });
    });
  }

  for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "managerB", "plain"] as AccountKey[]) {
    it(`${who}: nenhuma linha afetada ao tentar alterar contato, URL ou origens de A`, async () => {
      const before = await read();
      const r = await as(who)
        .from("restaurant_settings")
        .update({ whatsapp: "+5511900000000", phone: "000000", address_text: "hack", storefront_url: "https://zz-hack.example.com", storefront_origins: ["https://zz-hack.example.com"] })
        .eq("restaurant_id", A().id)
        .select("restaurant_id");
      expectNotApplied(r);
      expect(await read()).toEqual(before);
      // sem .select(): também não aplica (0 linhas) ou nega
      await as(who).from("restaurant_settings").update({ storefront_origins: ["https://zz-hack2.example.com"] }).eq("restaurant_id", A().id);
      expect(await read()).toEqual(before);
    });
  }

  it("gerente de A não altera as origens de B (nem dono de B as de A): o isolamento vale para as colunas novas", async () => {
    const beforeB = await read(B().id);
    const r = await as("managerA").from("restaurant_settings").update({ storefront_origins: ["https://zz-cross.example.com"], phone: "999999" }).eq("restaurant_id", B().id).select("restaurant_id");
    expectNotApplied(r);
    expect(await read(B().id)).toEqual(beforeB);
  });
});

describe("restaurant_settings — CHECKs (whatsapp, phone, endereço, URL e origens)", () => {
  let S: { id: string; slug: string };
  beforeAll(async () => {
    S = await makeRestaurant("active");
  });
  const upd = (patch: Record<string, unknown>) => admin().from("restaurant_settings").update(patch).eq("restaurant_id", S.id);
  const stored = async () => (await admin().from("restaurant_settings").select("whatsapp,phone,address_text,storefront_url,storefront_origins").eq("restaurant_id", S.id).single()).data as any;

  it("whatsapp: 10–15 dígitos com '+' opcional; NULL ok", async () => {
    for (const ok of ["+5511999990000", "11999990000", "5511999990000", "1234567890", "123456789012345", null]) expectOk(await upd({ whatsapp: ok }));
    for (const bad of ["123", "123456789", "1234567890123456", "+55 11 99999-0000", "(11) 99999-0000", "abc1234567890", "+", "++5511999990000", "5511999990000 ", "55119999900aa", ""]) {
      expectPg(await upd({ whatsapp: bad }), "23514", /restaurant_settings_whatsapp_fmt/);
    }
  });

  it("phone: 6–30 caracteres de [0-9+()./ -]; NULL ok", async () => {
    for (const ok of ["(11) 4000-1234", "+55 11 4000.1234", "11999990000", "123456", "4000/1234", null]) expectOk(await upd({ phone: ok }));
    for (const bad of ["12345", "abc123456", "<script>", "1".repeat(31), "11 4000-1234 ramal A", "", "(11) 4000-1234;"]) {
      expectPg(await upd({ phone: bad }), "23514", /restaurant_settings_phone_fmt/);
    }
  });

  it("address_text: até 200 caracteres", async () => {
    expectOk(await upd({ address_text: "x".repeat(200) }));
    expectPg(await upd({ address_text: "x".repeat(201) }), "23514", /restaurant_settings_address_len/);
    expectOk(await upd({ address_text: null }));
  });

  it("storefront_url: somente https://host[:porta][/caminho]; sem http, esquema estranho, espaço, <>, credenciais; ≤ 200", async () => {
    for (const ok of ["https://la-pastelaria.vercel.app", "https://a.com/menu?x=1#y", "https://localhost:3000", "https://onailton.com.br/", "https://Meu-Site.com", null]) {
      expectOk(await upd({ storefront_url: ok }));
    }
    for (const bad of [
      "http://a.com", "ftp://a.com", "javascript:alert(1)", "data:text/html,<script>", "https://", "//a.com", "a.com", "https://a.com/ b",
      "https://a.com/<x>", 'https://a.com/"x', "https://user@a.com", "https://user:pw@a.com", "https:// a.com",
      `https://a.com/${"x".repeat(200)}`, "", " https://a.com", "https://a.com\n",
    ]) {
      expectPg(await upd({ storefront_url: bad }), "23514", /restaurant_settings_storefront_url_fmt/);
    }
    expect((await stored()).storefront_url).toBeNull(); // o último valor aceito foi null
  });

  it("storefront_origins: https canônico, minúsculo, sem caminho/barra final/curinga/duplicadas, até 5; NULL e array vazio", async () => {
    const ok = [[], ["https://a.com"], ["https://a.com:8443"], ["https://sub.a-b.com", "https://x.io"], ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com"]];
    for (const list of ok) {
      expectOk(await upd({ storefront_origins: list }));
      expect((await stored()).storefront_origins).toEqual(list);
    }
    const bad: Array<[string, unknown]> = [
      ["barra final", ["https://a.com/"]],
      ["curinga", ["https://*.a.com"]],
      ["curinga puro", ["*"]],
      ["http", ["http://a.com"]],
      ["maiúsculas", ["https://A.com"]],
      ["caminho", ["https://a.com/path"]],
      ["query", ["https://a.com?x=1"]],
      ["fragmento", ["https://a.com#x"]],
      ["sem esquema", ["a.com"]],
      ["só esquema", ["https://"]],
      ["vazio", [""]],
      ["espaço", ["https://a.com "]],
      ["credenciais", ["https://u@a.com"]],
      ["porta não numérica", ["https://a.com:abc"]],
      ["porta com 6 dígitos", ["https://a.com:123456"]],
      ["mais de 5", ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"]],
      ["duplicadas", ["https://a.com", "https://a.com"]],
      ["duplicadas não adjacentes", ["https://a.com", "https://b.com", "https://a.com"]],
      ["javascript:", ["javascript:alert(1)"]],
      ["host com 254+ caracteres", [`https://${"a".repeat(254)}.com`]],
      ["segunda inválida", ["https://a.com", "http://b.com"]],
      ["quinta inválida", ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://E.com"]],
    ];
    for (const [label, list] of bad) {
      expectPg(await upd({ storefront_origins: list }), "23514", /restaurant_settings_storefront_origins_valid/);
      void label;
    }
    expectPg(await upd({ storefront_origins: null }), "23502"); // not null default '{}'
    // nada inválido foi gravado: continua a última lista válida
    expect((await stored()).storefront_origins).toEqual(["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com"]);
  });

  it("os mesmos CHECKs valem para o dono de A pela API (RLS + constraint), sem alterar o valor anterior", async () => {
    const prev = (await admin().from("restaurant_settings").select("storefront_origins,storefront_url").eq("restaurant_id", A().id).single()).data as any;
    try {
      expectPg(await as("ownerA").from("restaurant_settings").update({ storefront_origins: ["https://x.com/"] }).eq("restaurant_id", A().id), "23514");
      expectPg(await as("ownerA").from("restaurant_settings").update({ storefront_url: "http://x.com" }).eq("restaurant_id", A().id), "23514");
      expectPg(await as("managerA").from("restaurant_settings").update({ whatsapp: "12" }).eq("restaurant_id", A().id), "23514");
      expect((await admin().from("restaurant_settings").select("storefront_origins,storefront_url").eq("restaurant_id", A().id).single()).data).toEqual(prev);
    } finally {
      await admin().from("restaurant_settings").update(prev).eq("restaurant_id", A().id);
    }
  });
});

// =====================================================================================================================
// 9. order_items — snapshot da variante
// =====================================================================================================================
describe("order_items — variant_id exige snapshot; apagar a variante preserva o histórico", () => {
  let order: { id: string };
  let v: any;
  let p: any;
  beforeAll(async () => {
    p = await insertRow("products", { restaurant_id: A().id, name: `zz-oi-${uniq()}`, price_cents: 100, is_active: false });
    cleanup.add(async () => void (await admin().from("products").delete().eq("id", p.id)));
    order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
  });
  const item = (extra: Record<string, unknown>) => ({
    restaurant_id: A().id, order_id: order.id, product_id: p.id, product_name: "zz", unit_price_cents: 1800, quantity: 1, line_total_cents: 1800, ...extra,
  });

  it("variant_id sem variant_name_snapshot é rejeitado (CHECK); com snapshot é aceito; sem variante (NULL/NULL) segue valendo", async () => {
    v = await addVariant(A().id, p.id, { name: "Grande", price_cents: 1800 });
    expectPg(await admin().from("order_items").insert(item({ variant_id: v.id })), "23514", /order_items_variant_has_snapshot/);
    expectOk(await admin().from("order_items").insert(item({ variant_id: null })));
    expectOk(await admin().from("order_items").insert(item({ variant_id: null, variant_name_snapshot: "histórico" })));
    expectOk(await admin().from("order_items").insert(item({ variant_id: v.id, variant_name_snapshot: "Grande" })));
  });

  it("snapshot vazio, em branco ou com mais de 40 caracteres é rejeitado", async () => {
    for (const snap of ["", "   ", "x".repeat(41)]) {
      expectPg(await admin().from("order_items").insert(item({ variant_name_snapshot: snap })), "23514");
    }
  });

  it("FK composta: variante de outro restaurante não pode ser usada em item de A", async () => {
    expectPg(await admin().from("order_items").insert(item({ variant_id: vB.id, variant_name_snapshot: "B-unica" })), "23503");
  });

  it("equipe autenticada não insere nem altera variant_id/snapshot de itens (sem grant de escrita em order_items)", async () => {
    for (const who of ["ownerA", "managerA", "cashierA"] as AccountKey[]) {
      expectDenied(await as(who).from("order_items").insert(item({ variant_id: v.id, variant_name_snapshot: "Grande" })).select("id"));
      expectDenied(await as(who).from("order_items").update({ variant_name_snapshot: "hack", variant_id: null }).eq("order_id", order.id).select("id"));
    }
    expectDenied(await anon().from("order_items").update({ variant_name_snapshot: "hack" }).eq("order_id", order.id).select("id"));
  });

  it("apagar a variante (service role) mantém o item: variant_id vira NULL e o snapshot do nome permanece", async () => {
    const before = (await admin().from("order_items").select("id,variant_id,variant_name_snapshot").eq("order_id", order.id).eq("variant_id", v.id)).data as any[];
    expect(before).toHaveLength(1);
    expectOk(await admin().from("product_variants").delete().eq("id", v.id));
    const after = (await admin().from("order_items").select("id,variant_id,variant_name_snapshot,product_name,unit_price_cents,line_total_cents").eq("id", before[0].id).single()).data as any;
    expect(after).toMatchObject({ variant_id: null, variant_name_snapshot: "Grande", unit_price_cents: 1800, line_total_cents: 1800 });
  });

  it("a equipe lê o snapshot dos itens do próprio restaurante, mas não os de outro", async () => {
    const own = await as("managerA").from("order_items").select("variant_name_snapshot").eq("order_id", order.id);
    expectOk(own);
    expect(rows(own).map((r) => r.variant_name_snapshot)).toContain("Grande");
    expect(rows(await as("ownerB").from("order_items").select("variant_name_snapshot").eq("order_id", order.id))).toHaveLength(0);
    expect(rows(await anon().from("order_items").select("variant_name_snapshot").eq("order_id", order.id))).toHaveLength(0);
  });
});
