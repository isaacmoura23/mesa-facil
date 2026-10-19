/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fase 5 (mig. 0126): endurecimento das tabelas de configuração (restaurants.timezone, restaurant_settings, business_hours,
 * business_hour_exceptions, delivery_zones), tudo por clientes AUTENTICADOS reais (dono/gerente/caixa/cozinha/garçom de A
 * vinculados a um restaurante efêmero `zz-t5-*`; dono de B como "estranho"). Service role só monta fixtures e confere o
 * estado real depois de cada ataque. O DEMO A só é usado como "outro restaurante" para tentativas de MOVER linhas (negadas).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, anon, as, world } from "../helpers/clients";
import { expectDenied, expectNotApplied, expectOk, expectRule, rows } from "../helpers/expect";
import { Cleanup } from "../helpers/factory";
import { makeTenant, type Tenant } from "../helpers/phase5";

const cleanup = new Cleanup();
let S: Tenant;
const A = () => world().restaurants.a;
const COLUMN_DENIED = /42501|permission denied/i;

const hours = (who: AccountKey, rid = S.id, weekday?: number) => {
  let q = as(who).from("business_hours").select("id,restaurant_id,weekday,opens_at,closes_at").eq("restaurant_id", rid);
  if (weekday !== undefined) q = q.eq("weekday", weekday);
  return q;
};
const addHour = (who: AccountKey, weekday: number, opens: string, closes: string, rid = S.id) =>
  as(who).from("business_hours").insert({ restaurant_id: rid, weekday, opens_at: opens, closes_at: closes }).select("id");
const addZone = (who: AccountKey, patch: Record<string, unknown> = {}, rid = S.id) =>
  as(who).from("delivery_zones").insert({ restaurant_id: rid, name: "zz-zona", fee_cents: 500, min_order_cents: 1000, ...patch }).select("id");
const addExc = (who: AccountKey, patch: Record<string, unknown>, rid = S.id) =>
  as(who).from("business_hour_exceptions").insert({ restaurant_id: rid, ...patch }).select("id");
const count = async (table: string, rid = S.id) => (await admin().from(table).select("*", { count: "exact", head: true }).eq("restaurant_id", rid)).count ?? 0;
const clear = async (table: string, rid = S.id) => void (await admin().from(table).delete().eq("restaurant_id", rid));

beforeAll(async () => {
  S = await makeTenant(cleanup);
});
afterAll(async () => {
  await cleanup.run();
});

// =====================================================================================================================
describe("restaurants: timezone, slug e status", () => {
  const upd = (who: AccountKey, patch: Record<string, unknown>, rid = S.id) => as(who).from("restaurants").update(patch).eq("id", rid).select("id,timezone,slug,status,name");
  const row = async () => (await admin().from("restaurants").select("name,slug,status,timezone,logo_path").eq("id", S.id).single()).data as any;

  it("timezone inválido é rejeitado (INVALID_TIMEZONE, 23514); válido (inclusive UTC) passa", async () => {
    for (const bad of ["Mars/Olympus", "america/sao_paulo", "America/Sao Paulo", "UTC+3", "GMT+25", "'; drop table restaurants; --", " America/Sao_Paulo", "Foo"]) {
      const r = await upd("ownerA", { timezone: bad });
      expectRule(r, /INVALID_TIMEZONE/);
      expect(r.error!.code, bad).toBe("23514");
    }
    expect((await row()).timezone).toBe("America/Sao_Paulo");
    for (const ok of ["Asia/Tokyo", "UTC", "America/New_York", "America/Sao_Paulo"]) expect(rows(await upd("managerA", { timezone: ok }))).toHaveLength(1);
    // INSERT por service role também é validado (restaurante nascido com fuso inválido quebraria relatórios)
    const ins = await admin().from("restaurants").insert({ name: "zz-tz", slug: `zz-t5-tz-${Date.now().toString(36)}`, status: "active", timezone: "Nope/Nope" });
    expectRule(ins, /INVALID_TIMEZONE/);
    // gravar o MESMO valor antigo não revalida (não bloqueia atualizações sem mudança)
    expect(rows(await upd("ownerA", { name: "zz DEMO T5 renomeado" }))).toHaveLength(1);
  });

  it("owner e manager editam nome; caixa/cozinha/garçom não alteram nada; dono de B e anon também não", async () => {
    expect(rows(await upd("managerA", { name: "zz DEMO T5 gerente" }))[0].name).toBe("zz DEMO T5 gerente");
    const before = await row();
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "plain"] as AccountKey[]) {
      expectNotApplied(await upd(who, { name: `zz-hack-${who}`, timezone: "Asia/Tokyo" }));
    }
    expect(await row()).toEqual(before);
    const an = await anon().from("restaurants").update({ name: "zz-hack-anon" }).eq("id", S.id).select("id");
    expectNotApplied(an);
    expect(await row()).toEqual(before);
  });

  it("owner e manager NÃO alteram slug nem status (só a plataforma)", async () => {
    const before = await row();
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      for (const patch of [{ slug: "zz-slug-novo" }, { status: "suspended" }, { status: "pending" }, { slug: "demo-b" }, { slug: "zz-novo", status: "active", name: "zz DEMO T5 x" }]) {
        const r = await upd(who, patch);
        if (r.error) expectDenied(r);
        else expect(rows(r), JSON.stringify(patch)).toHaveLength(0);
      }
    }
    const after = await row();
    expect(after.slug).toBe(before.slug);
    expect(after.status).toBe("active");
    expect(after.name).toBe(before.name);
  });

  it("logo_path de outro tenant ou fora de restaurants/{id}/logo/ é rejeitado (F-02 segue valendo)", async () => {
    for (const bad of [`restaurants/${A().id}/logo/${crypto.randomUUID()}.png`, "../etc/passwd", `restaurants/${S.id}/logo/../../x.png`, `restaurants/${S.id}/products/x.png`, "https://evil.test/x.png"]) {
      const r = await upd("ownerA", { logo_path: bad });
      expect(r.error, bad).not.toBeNull();
    }
    expect((await row()).logo_path).toBeNull();
    expect(rows(await upd("ownerA", { logo_path: `restaurants/${S.id}/logo/${crypto.randomUUID()}.webp` }))).toHaveLength(1);
    expectOk(await upd("ownerA", { logo_path: null }));
  });
});

// =====================================================================================================================
describe("restaurant_settings", () => {
  const upd = (who: AccountKey, patch: Record<string, unknown>, rid = S.id) => as(who).from("restaurant_settings").update(patch).eq("restaurant_id", rid).select("restaurant_id,prep_time_minutes");
  const row = async () => (await admin().from("restaurant_settings").select("*").eq("restaurant_id", S.id).single()).data as any;

  it("owner e manager escrevem as colunas editáveis; caixa, cozinha, garçom, dono de B e anon não", async () => {
    expect(rows(await upd("ownerA", { prep_time_minutes: 41, accepts_orders: false, min_order_cents: 1234, pickup_instructions: "retirar no balcão" }))).toHaveLength(1);
    expect(rows(await upd("managerA", { prep_time_minutes: 42, whatsapp: "5511999990000", phone: "1133334444", address_text: "Rua X, 1", single_tab_per_table: false, storefront_url: "https://loja.example.test" }))).toHaveLength(1);
    const before = await row();
    expect(before).toMatchObject({ prep_time_minutes: 42, accepts_orders: false, min_order_cents: 1234, single_tab_per_table: false });
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "plain"] as AccountKey[]) {
      expectNotApplied(await upd(who, { prep_time_minutes: 1, accepts_orders: true, min_order_cents: 0 }));
    }
    expectNotApplied(await anon().from("restaurant_settings").update({ prep_time_minutes: 1 }).eq("restaurant_id", S.id).select("restaurant_id"));
    expect(await row()).toEqual(before);
  });

  it("restaurant_id, created_at e updated_at são imutáveis para clientes (permission denied na coluna); service role continua podendo", async () => {
    const before = await row();
    for (const patch of [{ restaurant_id: A().id }, { created_at: "2000-01-01T00:00:00Z" }, { updated_at: "2000-01-01T00:00:00Z" }, { prep_time_minutes: 50, restaurant_id: A().id }]) {
      for (const who of ["ownerA", "managerA"] as AccountKey[]) expectDenied(await upd(who, patch), COLUMN_DENIED);
    }
    const aSettings = (await admin().from("restaurant_settings").select("*").eq("restaurant_id", A().id).single()).data;
    expect(await row()).toEqual(before);
    expect((await admin().from("restaurant_settings").select("*").eq("restaurant_id", A().id).single()).data).toEqual(aSettings);
    // ownerB tentando "puxar" a linha de S para B
    expectDenied(await upd("ownerB", { restaurant_id: world().restaurants.b.id }), COLUMN_DENIED);
  });

  it("CHECKs: min_order_cents <= 10.000.000; no máx. 3 tipos de atendimento e sem NULL; >= 1 tipo", async () => {
    const rule = (r: any, re: RegExp) => {
      expectRule(r, re);
      expect(r.error.code).toBe("23514");
    };
    rule(await upd("ownerA", { min_order_cents: 10_000_001 }), /restaurant_settings_min_order_max/);
    expect(rows(await upd("ownerA", { min_order_cents: 10_000_000 }))).toHaveLength(1);
    rule(await upd("ownerA", { min_order_cents: -1 }), /min_order_cents|check/);
    rule(await upd("ownerA", { enabled_fulfillment_types: ["DELIVERY", "PICKUP", "DINE_IN", "DELIVERY"] }), /restaurant_settings_fulfillment_valid/);
    rule(await upd("ownerA", { enabled_fulfillment_types: [] }), /restaurant_settings_has_fulfillment/);
    const withNull = await upd("ownerA", { enabled_fulfillment_types: ["DELIVERY", null] });
    expect(withNull.error).not.toBeNull();
    const badEnum = await upd("ownerA", { enabled_fulfillment_types: ["DRONE"] });
    expect(badEnum.error).not.toBeNull();
    expect(rows(await upd("ownerA", { enabled_fulfillment_types: ["DELIVERY", "PICKUP", "DINE_IN"] }))).toHaveLength(1);
    expect((await upd("ownerA", { prep_time_minutes: 601 })).error!.code).toBe("23514");
    expect((await row()).enabled_fulfillment_types).toEqual(["DELIVERY", "PICKUP", "DINE_IN"]);
  });

  it("INSERT continua igual: dono recria a linha 1:1 se faltar; dono de B não cria a de S", async () => {
    await admin().from("restaurant_settings").delete().eq("restaurant_id", S.id);
    expectDenied(await as("ownerB").from("restaurant_settings").insert({ restaurant_id: S.id }).select("restaurant_id"), COLUMN_DENIED);
    expect(await count("restaurant_settings")).toBe(0);
    const r = await as("ownerA").from("restaurant_settings").insert({ restaurant_id: S.id, prep_time_minutes: 20 }).select("restaurant_id");
    if (!r.error) expect(rows(r)).toHaveLength(1);
    else await admin().from("restaurant_settings").upsert({ restaurant_id: S.id }, { onConflict: "restaurant_id" }); // restaura para os demais testes
    expect(await count("restaurant_settings")).toBe(1);
  });

  it("storefront_origins continua ilegível (select *, coluna explícita, filtro, RETURNING) mas gravável por owner/manager; leitura via RPC", async () => {
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      expectDenied(await as(who).from("restaurant_settings").select("*").eq("restaurant_id", S.id), COLUMN_DENIED);
      expectDenied(await as(who).from("restaurant_settings").select("storefront_origins").eq("restaurant_id", S.id), COLUMN_DENIED);
      expectDenied(await as(who).from("restaurant_settings").select("restaurant_id").eq("restaurant_id", S.id).contains("storefront_origins", ["https://x.test"]), COLUMN_DENIED);
      expect(rows(await as(who).from("restaurant_settings").select("restaurant_id,accepts_orders,prep_time_minutes").eq("restaurant_id", S.id))).toHaveLength(1);
    }
    expectDenied(await anon().from("restaurant_settings").select("storefront_origins").eq("restaurant_id", S.id), COLUMN_DENIED);
    const origin = "https://cardapio.example.test";
    const w = await as("managerA").from("restaurant_settings").update({ storefront_origins: [origin] }).eq("restaurant_id", S.id).select("restaurant_id");
    expectOk(w);
    expectDenied(await as("ownerA").from("restaurant_settings").update({ storefront_origins: [origin] }).eq("restaurant_id", S.id).select("storefront_origins"), COLUMN_DENIED);
    const via = await as("ownerA").rpc("get_storefront_origins", { p_restaurant: S.id });
    expectOk(via);
    expect(JSON.stringify(via.data)).toContain(origin);
    expectNotApplied(await as("cashierA").from("restaurant_settings").update({ storefront_origins: ["https://evil.test"] }).eq("restaurant_id", S.id).select("restaurant_id"));
    expect(((await admin().from("restaurant_settings").select("storefront_origins").eq("restaurant_id", S.id).single()).data as any).storefront_origins).toEqual([origin]);
  });
});

// =====================================================================================================================
describe("business_hours", () => {
  beforeAll(async () => void (await clear("business_hours")));

  it("papéis: owner e manager inserem/editam/apagam; caixa, cozinha, garçom, dono de B e anon não", async () => {
    const o = await addHour("ownerA", 1, "09:00", "12:00");
    expectOk(o);
    const m = await addHour("managerA", 1, "13:00", "18:00");
    expectOk(m);
    const id = rows(o)[0].id as string;
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "plain"] as AccountKey[]) {
      expectDenied(await addHour(who, 2, "10:00", "11:00"), COLUMN_DENIED);
      expectNotApplied(await as(who).from("business_hours").update({ opens_at: "01:00" }).eq("id", id).select("id"));
      expectNotApplied(await as(who).from("business_hours").delete().eq("id", id).select("id"));
    }
    expectDenied(await anon().from("business_hours").insert({ restaurant_id: S.id, weekday: 2, opens_at: "10:00", closes_at: "11:00" }), COLUMN_DENIED);
    expect(await count("business_hours")).toBe(2);
    expect(rows(await as("managerA").from("business_hours").update({ opens_at: "08:00" }).eq("id", id).select("opens_at"))[0].opens_at).toBe("08:00:00");
    const tmp = rows(await addHour("ownerA", 0, "10:00", "11:00"))[0].id;
    expect(rows(await as("managerA").from("business_hours").delete().eq("id", tmp).select("id"))).toHaveLength(1);
  });

  it("sem permissão a RLS responde (a regra de negócio não vaza): caixa tentando sobrepor recebe negação, não BUSINESS_HOURS_OVERLAP", async () => {
    const r = await addHour("cashierA", 1, "10:00", "11:00"); // sobrepõe 08–12
    expect(r.error).not.toBeNull();
    expect(r.error!.message).not.toMatch(/BUSINESS_HOURS/);
    expectDenied(r, COLUMN_DENIED);
  });

  it("sobreposição no mesmo dia => BUSINESS_HOURS_OVERLAP; faixas coladas, outro dia e virada de dia", async () => {
    const overlap = async (who: AccountKey, wd: number, a: string, b: string) => {
      const r = await addHour(who, wd, a, b);
      expectRule(r, /BUSINESS_HOURS_OVERLAP/);
      expect(r.error!.code).toBe("23514");
    };
    // existentes (weekday 1): 08:00–12:00 e 13:00–18:00
    await overlap("ownerA", 1, "11:00", "14:00");
    await overlap("ownerA", 1, "08:00", "12:00");
    await overlap("ownerA", 1, "07:00", "08:01");
    await overlap("managerA", 1, "17:59", "19:00");
    await overlap("managerA", 1, "10:00", "10:30"); // contida
    await overlap("managerA", 1, "07:00", "19:00"); // contém as duas
    expectOk(await addHour("ownerA", 1, "12:00", "13:00")); // colada nas duas pontas: sem sobreposição
    expectOk(await addHour("ownerA", 2, "09:00", "12:00")); // mesmo horário em outro dia
    // virada de dia: 22:00–02:00 conta como [22h, 26h)
    expectOk(await addHour("ownerA", 1, "22:00", "02:00"));
    await overlap("ownerA", 1, "20:00", "23:00");
    await overlap("ownerA", 1, "23:00", "23:30");
    await overlap("ownerA", 1, "21:00", "04:00"); // outra virada que cruza a primeira
    expectOk(await addHour("ownerA", 1, "18:00", "19:00")); // entre 13–18 e 22–02: cabe
    // limite documentado (0126): o transbordo da virada para o DIA SEGUINTE não é checado — F-46 (Info)
    expectOk(await addHour("ownerA", 2, "01:00", "03:00"));
    // UPDATE também valida (e ignora a própria linha)
    const id = rows(await addHour("ownerA", 3, "10:00", "11:00"))[0].id as string;
    expectOk(await addHour("ownerA", 3, "12:00", "13:00"));
    expect(rows(await as("ownerA").from("business_hours").update({ closes_at: "11:30" }).eq("id", id).select("id"))).toHaveLength(1);
    expectRule(await as("ownerA").from("business_hours").update({ closes_at: "12:30" }).eq("id", id).select("id"), /BUSINESS_HOURS_OVERLAP/);
    expectRule(await as("ownerA").from("business_hours").update({ weekday: 1, opens_at: "12:00", closes_at: "13:00" }).eq("id", id).select("id"), /BUSINESS_HOURS_OVERLAP/);
    const stored = (await admin().from("business_hours").select("opens_at,closes_at").eq("id", id).single()).data as any;
    expect(stored).toEqual({ opens_at: "10:00:00", closes_at: "11:30:00" });
  });

  it("CHECKs existentes: abre == fecha, dia fora de 0..6, horário malformado", async () => {
    expect((await addHour("ownerA", 4, "10:00", "10:00")).error!.code).toBe("23514");
    expect((await addHour("ownerA", 7, "10:00", "11:00")).error!.code).toBe("23514");
    expect((await addHour("ownerA", -1, "10:00", "11:00")).error!.code).toBe("23514");
    expect((await addHour("ownerA", 4, "25:00", "11:00")).error).not.toBeNull();
    expect((await addHour("ownerA", 4, "ab", "11:00")).error).not.toBeNull();
    expect(await count("business_hours")).toBe(rows(await hours("ownerA")).length);
  });

  it("no máximo 6 faixas por dia (BUSINESS_HOURS_LIMIT); a 7ª recusada por owner e manager; outro dia não é afetado", async () => {
    for (let i = 0; i < 6; i++) expectOk(await addHour(i % 2 ? "managerA" : "ownerA", 5, `${String(i * 3).padStart(2, "0")}:00`, `${String(i * 3 + 1).padStart(2, "0")}:00`));
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      const r = await addHour(who, 5, "20:00", "21:00");
      expectRule(r, /BUSINESS_HOURS_LIMIT/);
      expect(r.error!.code).toBe("23514");
    }
    expect(rows(await hours("ownerA", S.id, 5))).toHaveLength(6);
    expectOk(await addHour("ownerA", 6, "20:00", "21:00"));
    // mover uma faixa de outro dia para um dia cheio também é barrado
    const other = rows(await hours("ownerA", S.id, 6))[0].id;
    expectRule(await as("ownerA").from("business_hours").update({ weekday: 5 }).eq("id", other).select("id"), /BUSINESS_HOURS_LIMIT/);
  });

  it("concorrência: 10 inserções simultâneas no mesmo dia => exatamente 6 (lock); 6 sobrepostas iguais => 1", async () => {
    await clear("business_hours");
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => addHour(i % 2 ? "ownerA" : "managerA", 3, `${String(i * 2).padStart(2, "0")}:00`, `${String(i * 2 + 1).padStart(2, "0")}:00`)));
    expect(res.filter((r) => !r.error)).toHaveLength(6);
    for (const r of res.filter((x) => x.error)) expectRule(r, /BUSINESS_HOURS_LIMIT/);
    expect(await count("business_hours")).toBe(6);
    const same = await Promise.all(Array.from({ length: 6 }, () => addHour("ownerA", 4, "10:00", "14:00")));
    expect(same.filter((r) => !r.error)).toHaveLength(1);
    for (const r of same.filter((x) => x.error)) expectRule(r, /BUSINESS_HOURS_OVERLAP/);
    expect(rows(await hours("ownerA", S.id, 4))).toHaveLength(1);
  });

  it("isolamento: dono de B não escreve em S; ninguém move faixas entre restaurantes (restaurant_id e id imutáveis), nem quem é dono dos dois", async () => {
    const mine = rows(await hours("ownerA", S.id, 3))[0];
    const aHour = (await admin().from("business_hours").select("*").eq("restaurant_id", A().id).limit(1).single()).data as any;
    const snapA = (await admin().from("business_hours").select("*").eq("restaurant_id", A().id).order("id")).data;
    const snapS = (await admin().from("business_hours").select("*").eq("restaurant_id", S.id).order("id")).data;
    expectDenied(await addHour("ownerB", 0, "10:00", "11:00"), COLUMN_DENIED);
    expectDenied(await addHour("ownerA", 0, "10:00", "11:00", world().restaurants.b.id), COLUMN_DENIED); // dono de A (e de S), não de B
    expectNotApplied(await as("ownerB").from("business_hours").update({ opens_at: "01:00" }).eq("id", mine.id).select("id"));
    expectNotApplied(await as("ownerB").from("business_hours").delete().eq("id", mine.id).select("id"));
    // ownerA é dono de S e de A: mover S -> A e A -> S, com e sem colunas válidas junto
    expectDenied(await as("ownerA").from("business_hours").update({ restaurant_id: A().id }).eq("id", mine.id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hours").update({ restaurant_id: A().id, opens_at: "06:00" }).eq("id", mine.id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hours").update({ restaurant_id: S.id }).eq("id", aHour.id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hours").update({ id: crypto.randomUUID() }).eq("id", mine.id).select("id"), COLUMN_DENIED);
    expectDenied(await as("managerA").from("business_hours").update({ created_at: "2000-01-01T00:00:00Z" }).eq("id", mine.id).select("id"), COLUMN_DENIED);
    expect((await admin().from("business_hours").select("*").eq("restaurant_id", A().id).order("id")).data).toEqual(snapA);
    expect((await admin().from("business_hours").select("*").eq("restaurant_id", S.id).order("id")).data).toEqual(snapS);
  });
});

// =====================================================================================================================
describe("business_hour_exceptions", () => {
  beforeAll(async () => void (await clear("business_hour_exceptions")));
  const D = (n: number) => new Date(Date.UTC(2040, 0, 1) + n * 864e5).toISOString().slice(0, 10);

  it("papéis e formas: fechado sem horário, aberto com horário; fechado COM horário => CHECK; aberto sem horário/igual => CHECK", async () => {
    expectOk(await addExc("ownerA", { on_date: D(0), is_closed: true, description: "Natal" }));
    expectOk(await addExc("managerA", { on_date: D(1), is_closed: false, opens_at: "10:00", closes_at: "14:00", description: "Especial" }));
    for (const patch of [
      { on_date: D(2), is_closed: true, opens_at: "10:00", closes_at: "14:00" },
      { on_date: D(2), is_closed: true, opens_at: "10:00", closes_at: null },
      { on_date: D(2), is_closed: true, opens_at: null, closes_at: "14:00" },
    ]) {
      const r = await addExc("ownerA", patch);
      expectRule(r, /business_hour_exceptions_closed_no_times/);
      expect(r.error!.code).toBe("23514");
    }
    expect((await addExc("ownerA", { on_date: D(2), is_closed: false, opens_at: null, closes_at: null })).error!.code).toBe("23514");
    expect((await addExc("ownerA", { on_date: D(2), is_closed: false, opens_at: "10:00", closes_at: "10:00" })).error!.code).toBe("23514");
    expect((await addExc("ownerA", { on_date: D(0), is_closed: true })).error!.code).toBe("23505"); // data repetida
    expect((await addExc("ownerA", { on_date: "2040-02-30", is_closed: true })).error).not.toBeNull();
    expect((await addExc("ownerA", { on_date: D(2), is_closed: true, description: "x".repeat(201) })).error!.code).toBe("23514");
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "plain"] as AccountKey[]) expectDenied(await addExc(who, { on_date: D(3), is_closed: true }), COLUMN_DENIED);
    expectDenied(await anon().from("business_hour_exceptions").insert({ restaurant_id: S.id, on_date: D(3), is_closed: true }), COLUMN_DENIED);
    expect(await count("business_hour_exceptions")).toBe(2);
    // UPDATE: não dá para tornar 'fechado' com horário
    const id = rows(await as("ownerA").from("business_hour_exceptions").select("id").eq("restaurant_id", S.id).eq("on_date", D(1)))[0].id;
    expectRule(await as("ownerA").from("business_hour_exceptions").update({ is_closed: true }).eq("id", id).select("id"), /business_hour_exceptions_closed_no_times/);
    expect(rows(await as("managerA").from("business_hour_exceptions").update({ is_closed: true, opens_at: null, closes_at: null, description: "Fechado" }).eq("id", id).select("id"))).toHaveLength(1);
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB"] as AccountKey[]) expectNotApplied(await as(who).from("business_hour_exceptions").update({ description: "hack" }).eq("id", id).select("id"));
  });

  it("restaurant_id e id imutáveis: nenhuma exceção muda de restaurante (nem para quem é dono dos dois)", async () => {
    const id = rows(await as("ownerA").from("business_hour_exceptions").select("id").eq("restaurant_id", S.id).eq("on_date", D(0)))[0].id;
    const snap = (await admin().from("business_hour_exceptions").select("*").eq("restaurant_id", A().id).order("id")).data;
    expectDenied(await as("ownerA").from("business_hour_exceptions").update({ restaurant_id: A().id }).eq("id", id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hour_exceptions").update({ restaurant_id: A().id, description: "mover" }).eq("id", id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hour_exceptions").update({ id: crypto.randomUUID() }).eq("id", id).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("business_hour_exceptions").update({ restaurant_id: S.id }).eq("restaurant_id", A().id).select("id"), COLUMN_DENIED);
    expect((await admin().from("business_hour_exceptions").select("*").eq("restaurant_id", A().id).order("id")).data).toEqual(snap);
    expect(rows(await admin().from("business_hour_exceptions").select("id").eq("id", id).eq("restaurant_id", S.id))).toHaveLength(1);
  });

  it("limite de 400 exceções (EXCEPTIONS_LIMIT): a 401ª é recusada para owner e manager; apagar uma libera", async () => {
    await clear("business_hour_exceptions");
    const bulk = Array.from({ length: 400 }, (_, i) => ({ restaurant_id: S.id, on_date: D(i), is_closed: true, description: `zz-${i}` }));
    for (let i = 0; i < 400; i += 100) expectOk(await admin().from("business_hour_exceptions").insert(bulk.slice(i, i + 100)));
    expect(await count("business_hour_exceptions")).toBe(400);
    for (const who of ["ownerA", "managerA"] as AccountKey[]) {
      const r = await addExc(who, { on_date: D(500), is_closed: true });
      expectRule(r, /EXCEPTIONS_LIMIT/);
      expect(r.error!.code).toBe("23514");
    }
    expect(await count("business_hour_exceptions")).toBe(400);
    expect(rows(await as("ownerA").from("business_hour_exceptions").delete().eq("restaurant_id", S.id).eq("on_date", D(7)).select("id"))).toHaveLength(1);
    expectOk(await addExc("ownerA", { on_date: D(500), is_closed: true }));
    expectRule(await addExc("managerA", { on_date: D(501), is_closed: true }), /EXCEPTIONS_LIMIT/);
    await clear("business_hour_exceptions");
  }, 120_000);
});

// =====================================================================================================================
describe("delivery_zones", () => {
  beforeAll(async () => void (await clear("delivery_zones")));
  const rule = (r: any, re: RegExp) => {
    expectRule(r, re);
    expect(r.error.code).toBe("23514");
  };

  it("papéis: owner e manager criam/editam/apagam; caixa, cozinha, garçom, dono de B e anon não", async () => {
    expectOk(await addZone("ownerA", { name: "zz-zona-dono", neighborhoods: ["Centro"], postal_code_prefixes: ["01310"], estimated_minutes: 40 }));
    expectOk(await addZone("managerA", { name: "zz-zona-gerente" }));
    const id = rows(await as("ownerA").from("delivery_zones").select("id").eq("restaurant_id", S.id).eq("name", "zz-zona-dono"))[0].id;
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "plain"] as AccountKey[]) {
      expectDenied(await addZone(who, { name: "zz-hack" }), COLUMN_DENIED);
      expectNotApplied(await as(who).from("delivery_zones").update({ fee_cents: 0 }).eq("id", id).select("id"));
      expectNotApplied(await as(who).from("delivery_zones").delete().eq("id", id).select("id"));
    }
    expectDenied(await anon().from("delivery_zones").insert({ restaurant_id: S.id, name: "zz-hack" }), COLUMN_DENIED);
    expect(await count("delivery_zones")).toBe(2);
    expect(rows(await as("managerA").from("delivery_zones").update({ fee_cents: 700, is_active: false }).eq("id", id).select("fee_cents,is_active"))[0]).toEqual({ fee_cents: 700, is_active: false });
  });

  it("CHECKs: taxa <= R$ 1.000, pedido mínimo <= R$ 100.000, ETA <= 1440, nome 1..120, valores negativos", async () => {
    rule(await addZone("ownerA", { fee_cents: 100_001 }), /delivery_zones_fee_max/);
    expectOk(await addZone("ownerA", { name: "zz-taxa-max", fee_cents: 100_000 }));
    rule(await addZone("ownerA", { min_order_cents: 10_000_001 }), /delivery_zones_min_order_max/);
    expectOk(await addZone("ownerA", { name: "zz-min-max", min_order_cents: 10_000_000 }));
    rule(await addZone("ownerA", { estimated_minutes: 1441 }), /delivery_zones_eta_max/);
    expectOk(await addZone("ownerA", { name: "zz-eta-max", estimated_minutes: 1440 }));
    expectOk(await addZone("ownerA", { name: "zz-eta-nulo", estimated_minutes: null }));
    rule(await addZone("ownerA", { estimated_minutes: 0 }), /estimated_minutes|check/);
    rule(await addZone("ownerA", { fee_cents: -1 }), /fee_cents|check/);
    rule(await addZone("ownerA", { min_order_cents: -1 }), /min_order_cents|check/);
    rule(await addZone("ownerA", { name: "" }), /name|check/);
    rule(await addZone("ownerA", { name: "   " }), /name|check/);
    rule(await addZone("ownerA", { name: "x".repeat(121) }), /name|check/);
    expect((await addZone("ownerA", { fee_cents: 1.5 })).error).not.toBeNull();
    expect((await addZone("ownerA", { fee_cents: "abc" })).error).not.toBeNull();
    // UPDATE respeita os mesmos CHECKs
    const id = rows(await as("ownerA").from("delivery_zones").select("id").eq("restaurant_id", S.id).eq("name", "zz-taxa-max"))[0].id;
    rule(await as("ownerA").from("delivery_zones").update({ fee_cents: 100_001 }).eq("id", id).select("id"), /delivery_zones_fee_max/);
    rule(await as("managerA").from("delivery_zones").update({ estimated_minutes: 5000 }).eq("id", id).select("id"), /delivery_zones_eta_max/);
  });

  it("bairros: até 100 itens, sem NULL, até ~6000 bytes; prefixos de CEP: até 50, só dígitos (1..8), sem NULL", async () => {
    expectOk(await addZone("ownerA", { name: "zz-100-bairros", neighborhoods: Array.from({ length: 100 }, (_, i) => `B${i}`) }));
    rule(await addZone("ownerA", { neighborhoods: Array.from({ length: 101 }, (_, i) => `B${i}`) }), /delivery_zones_neighborhoods_valid/);
    rule(await addZone("ownerA", { neighborhoods: ["Centro", null] }), /delivery_zones_neighborhoods_valid/);
    rule(await addZone("ownerA", { neighborhoods: Array.from({ length: 100 }, (_, i) => `${"b".repeat(60)}${i}`) }), /delivery_zones_neighborhoods_valid/); // > 6000 bytes
    expectOk(await addZone("ownerA", { name: "zz-50-ceps", postal_code_prefixes: Array.from({ length: 50 }, (_, i) => String(10000 + i)) }));
    rule(await addZone("ownerA", { postal_code_prefixes: Array.from({ length: 51 }, (_, i) => String(10000 + i)) }), /delivery_zones_prefixes_valid/);
    for (const bad of [["abc"], ["01310-100"], ["013 10"], ["123456789"], ["01310", "x"], ["0131a"], ["٠١٢"], ["01310", null], ["-1"], ["01310,"], [" 01310"]]) {
      rule(await addZone("ownerA", { postal_code_prefixes: bad }), /delivery_zones_prefixes_valid/);
    }
    expectOk(await addZone("ownerA", { name: "zz-cep-8", postal_code_prefixes: ["01310100", "0", "99"] }));
    expectOk(await addZone("managerA", { name: "zz-cep-vazio", postal_code_prefixes: [] }));
    // UPDATE
    const id = rows(await as("ownerA").from("delivery_zones").select("id").eq("restaurant_id", S.id).eq("name", "zz-cep-8"))[0].id;
    rule(await as("ownerA").from("delivery_zones").update({ postal_code_prefixes: ["12-34"] }).eq("id", id).select("id"), /delivery_zones_prefixes_valid/);
    rule(await as("ownerA").from("delivery_zones").update({ neighborhoods: [null] }).eq("id", id).select("id"), /delivery_zones_neighborhoods_valid/);
  });

  it.fails("F-43: prefixo de CEP vazio (['']) ou com vírgula (['1,2']) deveria ser recusado — o CHECK valida o array_to_string, não cada elemento", async () => {
    // array_to_string(['']) = '' casa a alternativa vazia da regex '^(...)?$' (prefixo vazio casaria TODOS os CEPs) e
    // array_to_string(['1,2']) = '1,2' vira "dois prefixos". Correção: exigir CADA elemento ~ '^[0-9]{1,8}$'
    // (ex.: CHECK (not exists (select 1 from unnest(postal_code_prefixes) p where p !~ '^[0-9]{1,8}$'))).
    const empty = await addZone("ownerA", { name: "zz-prefixo-vazio", postal_code_prefixes: [""] });
    const comma = await addZone("ownerA", { name: "zz-prefixo-virgula", postal_code_prefixes: ["1,2"] });
    expect(empty.error).not.toBeNull();
    expect(comma.error).not.toBeNull();
  });

  it("no máximo 50 zonas (ZONES_LIMIT) e sob concorrência; apagar libera", async () => {
    await clear("delivery_zones");
    const bulk = Array.from({ length: 44 }, (_, i) => ({ restaurant_id: S.id, name: `zz-z${i}`, fee_cents: 0, min_order_cents: 0 }));
    expectOk(await admin().from("delivery_zones").insert(bulk));
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => addZone(i % 2 ? "ownerA" : "managerA", { name: `zz-par-${i}` })));
    expect(res.filter((r) => !r.error)).toHaveLength(6); // 44 + 6 = 50
    for (const r of res.filter((x) => x.error)) rule(r, /ZONES_LIMIT/);
    expect(await count("delivery_zones")).toBe(50);
    rule(await addZone("ownerA", { name: "zz-51" }), /ZONES_LIMIT/);
    const one = rows(await as("ownerA").from("delivery_zones").select("id").eq("restaurant_id", S.id).limit(1))[0].id;
    expect(rows(await as("managerA").from("delivery_zones").delete().eq("id", one).select("id"))).toHaveLength(1);
    expectOk(await addZone("managerA", { name: "zz-de-novo" }));
    rule(await addZone("managerA", { name: "zz-52" }), /ZONES_LIMIT/);
  }, 120_000);

  it("isolamento: ninguém move zonas entre restaurantes (restaurant_id/id/created_at imutáveis); dono de B não escreve em S", async () => {
    const mine = rows(await as("ownerA").from("delivery_zones").select("id").eq("restaurant_id", S.id).limit(1))[0].id;
    const aZone = (await admin().from("delivery_zones").select("id").eq("restaurant_id", A().id).limit(1).single()).data as any;
    const snapA = (await admin().from("delivery_zones").select("*").eq("restaurant_id", A().id).order("id")).data;
    const snapS = (await admin().from("delivery_zones").select("*").eq("restaurant_id", S.id).order("id")).data;
    expectDenied(await as("ownerA").from("delivery_zones").update({ restaurant_id: A().id }).eq("id", mine).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("delivery_zones").update({ restaurant_id: A().id, name: "zz-mover" }).eq("id", mine).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("delivery_zones").update({ restaurant_id: S.id }).eq("id", aZone.id).select("id"), COLUMN_DENIED);
    expectDenied(await as("managerA").from("delivery_zones").update({ id: crypto.randomUUID() }).eq("id", mine).select("id"), COLUMN_DENIED);
    expectDenied(await as("managerA").from("delivery_zones").update({ created_at: "2000-01-01T00:00:00Z" }).eq("id", mine).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerB").from("delivery_zones").insert({ restaurant_id: S.id, name: "zz-b-invade" }).select("id"), COLUMN_DENIED);
    expectDenied(await as("ownerA").from("delivery_zones").insert({ restaurant_id: world().restaurants.b.id, name: "zz-a-invade-b" }).select("id"), COLUMN_DENIED);
    expectNotApplied(await as("ownerB").from("delivery_zones").update({ name: "zz-b-edita" }).eq("id", mine).select("id"));
    expectNotApplied(await as("ownerB").from("delivery_zones").delete().eq("id", mine).select("id"));
    expect((await admin().from("delivery_zones").select("*").eq("restaurant_id", A().id).order("id")).data).toEqual(snapA);
    expect((await admin().from("delivery_zones").select("*").eq("restaurant_id", S.id).order("id")).data).toEqual(snapS);
    expect(rows(await admin().from("delivery_zones").select("id").like("name", "zz-b-%"))).toHaveLength(0);
  });
});
