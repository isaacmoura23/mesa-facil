/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Apoio dos testes da Fase 2 (cardápio): fábrica de entidades efêmeras ("zz-") via service role,
 * controle do horário de funcionamento de hoje (para o teste não depender da hora em que roda) e
 * atalhos para as RPCs públicas.
 */
import { admin } from "./clients";
import { Cleanup } from "./factory";

export const TZ = "America/Sao_Paulo";

/** Data (YYYY-MM-DD) de hoje no fuso do restaurante, com deslocamento em dias. */
export function localDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 864e5));
}

function must(res: { data: any; error: { message: string } | null }, what: string): any {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/**
 * Força "aberto agora" (ou "fechado agora") no restaurante via EXCEÇÃO de horário do dia:
 * a exceção substitui a grade semanal (comportamento do contrato), então o teste independe do relógio.
 * A linha é marcada com descrição "zz-..." (o seed a remove se o teste for interrompido).
 */
export async function setOpenToday(rid: string, open: boolean) {
  const row: Record<string, unknown> = open
    ? { restaurant_id: rid, on_date: localDate(), is_closed: false, opens_at: "00:00:00", closes_at: "23:59:59", description: "zz-aberto-hoje" }
    : { restaurant_id: rid, on_date: localDate(), is_closed: true, opens_at: null, closes_at: null, description: "zz-fechado-hoje" };
  must(await admin().from("business_hour_exceptions").upsert(row, { onConflict: "restaurant_id,on_date" }), "setOpenToday");
}

export async function clearTodayException(rid: string) {
  await admin().from("business_hour_exceptions").delete().eq("restaurant_id", rid).eq("on_date", localDate()).like("description", "zz-%");
}

export async function setSettings(rid: string, patch: Record<string, unknown>) {
  must(await admin().from("restaurant_settings").update(patch).eq("restaurant_id", rid), "setSettings");
}

export const BASE_FULFILLMENT = ["DELIVERY", "PICKUP", "DINE_IN"];

export async function setStatus(rid: string, status: string) {
  must(await admin().from("restaurants").update({ status }).eq("id", rid), "setStatus");
}

export async function insertRow(table: string, row: Record<string, unknown>): Promise<any> {
  return must(await admin().from(table).insert(row).select("*").single(), `insert ${table}`);
}

export interface MenuFixture {
  rid: string;
  category: any;
  pPlain: any; // sem adicionais, R$ 10,00
  pGrp: any; // grupo g1 (min 1, max 2)
  pGinact: any; // vinculado a um grupo INATIVO
  pUnavail: any; // is_available = false
  pInactive: any; // is_active = false
  pOffCat: any; // em categoria inativa
  g1: any;
  m1: any; // +100
  m2: any; // +200
  m6: any; // +50
  m3: any; // is_available = false
  m4: any; // is_active = false
  g2: any; // grupo inativo
  m5: any; // adicional ativo dentro do grupo inativo
  gOther: any; // grupo ativo NÃO vinculado a nenhum produto
  m7: any;
}

/** Cardápio efêmero no restaurante `rid` para exercitar todos os códigos de erro de validate_cart. */
export async function makeMenuFixture(cleanup: Cleanup, rid: string): Promise<MenuFixture> {
  const a = admin();
  const tag = Math.random().toString(36).slice(2, 7);
  const n = (s: string) => `zz-${s}-${tag}`;
  const category = await insertRow("menu_categories", { restaurant_id: rid, name: n("cat"), sort_order: 50 });
  const catOff = await insertRow("menu_categories", { restaurant_id: rid, name: n("cat-off"), sort_order: 51, is_active: false });
  cleanup.add(async () => void (await a.from("menu_categories").delete().in("id", [category.id, catOff.id])));

  const prod = (name: string, extra: Record<string, unknown> = {}) =>
    insertRow("products", { restaurant_id: rid, category_id: category.id, name: n(name), price_cents: 1000, ...extra });
  const pPlain = await prod("p-plain", { sort_order: 1 });
  const pGrp = await prod("p-grp", { sort_order: 2 });
  const pGinact = await prod("p-ginact", { sort_order: 3 });
  const pUnavail = await prod("p-unavail", { is_available: false, sort_order: 4 });
  const pInactive = await prod("p-inactive", { is_active: false, sort_order: 5 });
  const pOffCat = await insertRow("products", { restaurant_id: rid, category_id: catOff.id, name: n("p-offcat"), price_cents: 1000 });
  cleanup.add(async () => void (await a.from("products").delete().eq("restaurant_id", rid).like("name", "zz-%")));

  const grp = (name: string, extra: Record<string, unknown>) => insertRow("modifier_groups", { restaurant_id: rid, name: n(name), ...extra });
  const g1 = await grp("g1", { min_selections: 1, max_selections: 2, sort_order: 1 });
  const g2 = await grp("g2-off", { min_selections: 0, max_selections: 2, is_active: false, sort_order: 2 });
  const gOther = await grp("g-other", { min_selections: 0, max_selections: 2, sort_order: 3 });
  cleanup.add(async () => void (await a.from("modifier_groups").delete().eq("restaurant_id", rid).like("name", "zz-%")));

  const mod = (g: any, name: string, delta: number, extra: Record<string, unknown> = {}) =>
    insertRow("modifiers", { restaurant_id: rid, group_id: g.id, name: n(name), price_delta_cents: delta, ...extra });
  const m1 = await mod(g1, "m1", 100, { sort_order: 1 });
  const m2 = await mod(g1, "m2", 200, { sort_order: 2 });
  const m6 = await mod(g1, "m6", 50, { sort_order: 3 });
  const m3 = await mod(g1, "m3-unavail", 300, { is_available: false, sort_order: 4 });
  const m4 = await mod(g1, "m4-inactive", 400, { is_active: false, sort_order: 5 });
  const m5 = await mod(g2, "m5", 500);
  const m7 = await mod(gOther, "m7", 700);

  must(
    await a.from("product_modifier_groups").insert([
      { restaurant_id: rid, product_id: pGrp.id, group_id: g1.id },
      { restaurant_id: rid, product_id: pGinact.id, group_id: g2.id },
    ]),
    "link groups",
  );

  return { rid, category, pPlain, pGrp, pGinact, pUnavail, pInactive, pOffCat, g1, m1, m2, m6, m3, m4, g2, m5, gOther, m7 };
}

export function walkKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) walkKeys(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      walkKeys(v, into);
    }
  }
  return into;
}
