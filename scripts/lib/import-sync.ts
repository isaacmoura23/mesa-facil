/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Motor de sincronização idempotente da importação (service role).
 *
 * Chaves naturais por restaurante:
 *   restaurante           slug
 *   categoria             lower(nome)
 *   produto               (categoria, lower(nome))
 *   variante              (produto, lower(nome))
 *   grupo de adicionais   lower(nome)
 *   adicional             (grupo, lower(nome))
 *   vínculo               (produto, grupo)        [PK]
 *   zona de entrega       lower(nome)
 *   horário               (dia, abre, fecha)
 *
 * Semântica de reexecução (padrão = "sincronizar com a fonte"):
 *   - cria o que falta; atualiza só os campos de CATÁLOGO (nome/preço/descrição/ordem/selos/imagem/ativo);
 *   - NÃO mexe em estado operacional (is_available, accepts_orders, prep_time, pickup_instructions...);
 *   - não apaga nada. `prune` desativa (is_active=false) o que não está nos dados; `createOnly` só cria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSkipped, prepareAsset, uploadAsset, type SkippedAsset } from "./import-assets";
import type { ImportData } from "./import-types";

type Row = Record<string, any>;
export type Admin = SupabaseClient;

export interface SyncMode {
  createOnly: boolean;
  prune: boolean;
  srcRoot: string;
}

export interface EntityStats {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
}

export interface RestaurantReport {
  slug: string;
  id: string;
  restaurantCreated: boolean;
  stats: Record<string, EntityStats>;
  images: { uploaded: number; skipped: SkippedAsset[] };
  warnings: string[];
}

export function must(res: { data: any; error: { message: string; code?: string } | null }, what: string): any {
  if (res.error) throw new Error(`[import] ${what}: ${res.error.message} (${res.error.code ?? "?"})`);
  return res.data;
}

const norm = (s: string) => s.trim().toLowerCase();
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function fetchAll(admin: Admin, table: string, rid: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await admin.from(table).select("*").eq("restaurant_id", rid).order("created_at", { ascending: true }).order("id").range(from, from + 999), `list ${table}`) as Row[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const newStats = (): EntityStats => ({ created: 0, updated: 0, unchanged: 0, deactivated: 0 });

interface Desired {
  key: string;
  insert: Row;
  /** Campos de catálogo reforçados em reexecuções. */
  update: Row;
}

/** Sincroniza uma tabela com id próprio. Devolve key -> linha final. */
async function syncTable(
  admin: Admin,
  table: string,
  existing: Row[],
  keyOf: (r: Row) => string,
  desired: Desired[],
  mode: SyncMode,
  stats: EntityStats,
  opts: { demoteFirst?: (rows: Row[]) => Promise<void> } = {},
): Promise<Map<string, Row>> {
  // Em chave duplicada (sobras manuais) vale a linha ativa mais antiga.
  const byKey = new Map<string, Row>();
  for (const r of existing) {
    const k = keyOf(r);
    const cur = byKey.get(k);
    if (!cur || (!cur.is_active && r.is_active)) byKey.set(k, r);
  }
  const result = new Map<string, Row>();
  const toInsert: Desired[] = [];
  const toUpdate: { row: Row; patch: Row }[] = [];
  for (const d of desired) {
    const row = byKey.get(d.key);
    if (!row) {
      toInsert.push(d);
      continue;
    }
    result.set(d.key, row);
    if (mode.createOnly) {
      stats.unchanged++;
      continue;
    }
    const patch: Row = {};
    for (const [k, v] of Object.entries(d.update)) if (!eq(row[k], v)) patch[k] = v;
    if (Object.keys(patch).length) toUpdate.push({ row, patch });
    else stats.unchanged++;
  }

  if (opts.demoteFirst) await opts.demoteFirst(existing);

  for (const u of toUpdate) {
    const row = must(await admin.from(table).update(u.patch).eq("id", u.row.id).select("*").single(), `update ${table}`);
    result.set(keyOf(row), row);
    stats.updated++;
    // chaves podem variar de caixa; garante o mapeamento pelo key desejado
    for (const d of desired) if (norm(d.key) === norm(keyOf(row))) result.set(d.key, row);
  }
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100);
    const rows = must(await admin.from(table).insert(chunk.map((c) => c.insert)).select("*"), `insert ${table}`) as Row[];
    for (const r of rows) {
      const d = chunk.find((c) => norm(c.key) === norm(keyOf(r)));
      if (d) result.set(d.key, r);
      stats.created++;
    }
  }

  if (mode.prune) {
    const keep = new Set(desired.map((d) => norm(d.key)));
    for (const r of existing) {
      if (r.is_active && !keep.has(norm(keyOf(r)))) {
        must(await admin.from(table).update({ is_active: false }).eq("id", r.id), `deactivate ${table}`);
        stats.deactivated++;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restaurante + vínculo do dono
// ---------------------------------------------------------------------------
export async function ensureRestaurant(
  admin: Admin,
  data: ImportData,
  ownerId: string,
  mode: SyncMode,
  warnings: string[],
): Promise<{ id: string; created: boolean }> {
  const r = data.restaurant;
  let row = must(await admin.from("restaurants").select("*").eq("slug", r.slug).maybeSingle(), "select restaurant") as Row | null;
  let created = false;
  if (!row) {
    row = must(
      await admin.from("restaurants").insert({ name: r.name, slug: r.slug, status: "active", timezone: r.timezone, created_by: ownerId }).select("*").single(),
      "insert restaurant",
    ) as Row;
    created = true;
    must(
      await admin.rpc("log_audit", {
        p_restaurant: row.id,
        p_action: "restaurant.created",
        p_resource_type: "restaurant",
        p_resource_id: row.id,
        p_metadata: { slug: r.slug, owner_id: ownerId, by: "import-script" },
      }),
      "log_audit",
    );
  } else if (!mode.createOnly) {
    const patch: Row = {};
    if (row.name !== r.name) patch.name = r.name;
    if (row.status !== "active") patch.status = "active";
    if (row.timezone !== r.timezone) patch.timezone = r.timezone;
    if (Object.keys(patch).length) row = must(await admin.from("restaurants").update(patch).eq("id", row.id).select("*").single(), "update restaurant") as Row;
  }

  // Dono: mesmo efeito do RPC create_restaurant (membership owner/active). O RPC exige um superadmin autenticado,
  // então com service role gravamos o vínculo direto (como o seed-dev).
  const mine = must(await admin.from("restaurant_memberships").select("id,role,status").eq("restaurant_id", row.id).eq("user_id", ownerId).maybeSingle(), "select membership");
  if (!mine) {
    const other = must(await admin.from("restaurant_memberships").select("id,user_id").eq("restaurant_id", row.id).eq("role", "owner").neq("status", "revoked").limit(1), "select owner") as Row[];
    if (other.length) warnings.push(`restaurante ${r.slug} já tem outro dono vigente; o usuário local não foi vinculado`);
    else must(await admin.from("restaurant_memberships").insert({ restaurant_id: row.id, user_id: ownerId, role: "owner", status: "active", invited_by: ownerId }), "insert membership");
  } else if (mine.role !== "owner" || mine.status !== "active") {
    warnings.push(`vínculo do usuário local em ${r.slug} está como ${mine.role}/${mine.status} (papel owner é protegido por trigger; não alterado)`);
  }
  return { id: row.id, created };
}

// ---------------------------------------------------------------------------
// Configurações, horários, zona de entrega
// ---------------------------------------------------------------------------
export async function syncSettings(admin: Admin, rid: string, data: ImportData, mode: SyncMode, stats: Record<string, EntityStats>): Promise<void> {
  const s = data.settings;
  const st = (stats.settings ||= newStats());
  const desired: Row = {
    accepts_orders: true,
    enabled_fulfillment_types: s.fulfillmentTypes,
    whatsapp: s.whatsapp,
    phone: s.phone,
    address_text: s.addressText,
    storefront_url: s.storefrontUrl,
    storefront_origins: s.storefrontOrigins,
  };
  if (s.minOrderCents !== null) desired.min_order_cents = s.minOrderCents;

  const row = must(await admin.from("restaurant_settings").select("*").eq("restaurant_id", rid).maybeSingle(), "select settings") as Row | null;
  if (!row) {
    must(await admin.from("restaurant_settings").insert({ restaurant_id: rid, ...desired }), "insert settings");
    st.created++;
    return;
  }
  if (mode.createOnly) {
    st.unchanged++;
    return;
  }
  const patch: Row = {};
  for (const [k, v] of Object.entries(desired)) if (!eq(row[k], v)) patch[k] = v;
  if (Object.keys(patch).length) {
    must(await admin.from("restaurant_settings").update(patch).eq("restaurant_id", rid), "update settings");
    st.updated++;
  } else st.unchanged++;
}

const hhmm = (t: string) => String(t).slice(0, 5);

export async function syncHours(admin: Admin, rid: string, data: ImportData, mode: SyncMode, stats: Record<string, EntityStats>): Promise<void> {
  const st = (stats.businessHours ||= newStats());
  const existing = must(await admin.from("business_hours").select("id,weekday,opens_at,closes_at").eq("restaurant_id", rid), "select hours") as Row[];
  const sig = (w: number, a: string, b: string) => `${w}|${hhmm(a)}|${hhmm(b)}`;
  const have = new Set(existing.map((h) => sig(h.weekday, h.opens_at, h.closes_at)));
  const want = new Set(data.hours.map((h) => sig(h.weekday, h.opensAt, h.closesAt)));
  const same = have.size === want.size && [...want].every((k) => have.has(k)) && existing.length === data.hours.length;
  if (same) {
    st.unchanged += existing.length;
    return;
  }
  if (existing.length && mode.createOnly) {
    st.unchanged += existing.length;
    return;
  }
  // business_hours não tem chave única: troca o conjunto inteiro (o site define o horário completo).
  if (existing.length) must(await admin.from("business_hours").delete().eq("restaurant_id", rid), "reset hours");
  if (data.hours.length) {
    must(await admin.from("business_hours").insert(data.hours.map((h) => ({ restaurant_id: rid, weekday: h.weekday, opens_at: h.opensAt, closes_at: h.closesAt }))), "insert hours");
  }
  if (existing.length) st.updated += data.hours.length;
  else st.created += data.hours.length;
}

export async function syncZone(admin: Admin, rid: string, data: ImportData, mode: SyncMode, stats: Record<string, EntityStats>): Promise<void> {
  if (!data.deliveryZone) return;
  const st = (stats.deliveryZones ||= newStats());
  const z = data.deliveryZone;
  const existing = must(await admin.from("delivery_zones").select("*").eq("restaurant_id", rid), "select zones") as Row[];
  await syncTable(
    admin,
    "delivery_zones",
    existing,
    (r) => norm(r.name),
    [
      {
        key: norm(z.name),
        insert: { restaurant_id: rid, name: z.name, fee_cents: z.feeCents, min_order_cents: 0, estimated_minutes: null, neighborhoods: [], postal_code_prefixes: [], is_active: true },
        update: { fee_cents: z.feeCents, is_active: true },
      },
    ],
    mode,
    st,
  );
}

// ---------------------------------------------------------------------------
// Cardápio
// ---------------------------------------------------------------------------
export async function syncCatalog(admin: Admin, rid: string, data: ImportData, mode: SyncMode, report: RestaurantReport): Promise<void> {
  const S = report.stats;
  const st = (n: string) => (S[n] ||= newStats());

  // --- imagens (somente arquivos locais das pastas irmãs) ---
  const imagePath = new Map<string, string>();
  const files = [...new Set(data.categories.flatMap((c) => c.products.map((p) => p.imageFile).filter((f): f is string => !!f)))];
  for (const f of files) {
    const prepared = prepareAsset(mode.srcRoot, f);
    if (isSkipped(prepared)) {
      report.images.skipped.push(prepared);
      continue;
    }
    imagePath.set(f, await uploadAsset(admin, rid, "products", prepared));
    report.images.uploaded++;
  }

  // --- categorias ---
  const cats = await syncTable(
    admin,
    "menu_categories",
    await fetchAll(admin, "menu_categories", rid),
    (r) => norm(r.name),
    data.categories.map((c, i) => ({
      key: norm(c.name),
      insert: { restaurant_id: rid, name: c.name, description: c.description ?? null, sort_order: i + 1, is_active: true },
      update: { description: c.description ?? null, sort_order: i + 1, is_active: true },
    })),
    mode,
    st("categories"),
  );

  // --- grupos de adicionais + adicionais ---
  const groups = await syncTable(
    admin,
    "modifier_groups",
    await fetchAll(admin, "modifier_groups", rid),
    (r) => norm(r.name),
    data.modifierGroups.map((g, i) => ({
      key: norm(g.name),
      insert: { restaurant_id: rid, name: g.name, min_selections: g.min, max_selections: g.max, is_active: true, sort_order: i + 1 },
      update: { min_selections: g.min, max_selections: g.max, is_active: true, sort_order: i + 1 },
    })),
    mode,
    st("modifierGroups"),
  );
  const modDesired: Desired[] = [];
  for (const g of data.modifierGroups) {
    const gid = groups.get(norm(g.name))!.id as string;
    g.modifiers.forEach((m, i) =>
      modDesired.push({
        key: `${gid}|${norm(m.name)}`,
        insert: { restaurant_id: rid, group_id: gid, name: m.name, price_delta_cents: m.priceDeltaCents, is_available: true, is_active: true, sort_order: i + 1 },
        update: { price_delta_cents: m.priceDeltaCents, is_active: true, sort_order: i + 1 },
      }),
    );
  }
  await syncTable(admin, "modifiers", await fetchAll(admin, "modifiers", rid), (r) => `${r.group_id}|${norm(r.name)}`, modDesired, mode, st("modifiers"));

  // --- produtos ---
  const prodDesired: Desired[] = [];
  const flat: { cat: string; p: (typeof data.categories)[number]["products"][number]; index: number }[] = [];
  data.categories.forEach((c) => c.products.forEach((p, i) => flat.push({ cat: c.name, p, index: i })));
  for (const { cat, p, index } of flat) {
    const cid = cats.get(norm(cat))!.id as string;
    const price = p.variants?.length ? Math.min(...p.variants.map((v) => v.priceCents)) : (p.priceCents as number);
    const img = p.imageFile ? imagePath.get(p.imageFile) : undefined;
    const upd: Row = { description: p.description ?? null, price_cents: price, sort_order: index + 1, badges: p.badges ?? [], is_active: true };
    if (img) upd.image_path = img;
    prodDesired.push({
      key: `${cid}|${norm(p.name)}`,
      insert: { restaurant_id: rid, category_id: cid, name: p.name, is_available: true, ...upd },
      update: upd,
    });
  }
  const products = await syncTable(admin, "products", await fetchAll(admin, "products", rid), (r) => `${r.category_id}|${norm(r.name)}`, prodDesired, mode, st("products"));

  // --- variantes ---
  const existingVariants = await fetchAll(admin, "product_variants", rid);
  const varDesired: Desired[] = [];
  const managedProducts = new Set<string>();
  const wantDefault = new Map<string, string>(); // product_id -> chave da variante padrão
  for (const { cat, p } of flat) {
    if (!p.variants?.length) continue;
    const pid = products.get(`${cats.get(norm(cat))!.id}|${norm(p.name)}`)!.id as string;
    managedProducts.add(pid);
    const cheapest = p.variants.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
    p.variants.forEach((v, i) => {
      const isDefault = v === cheapest;
      const key = `${pid}|${norm(v.name)}`;
      if (isDefault) wantDefault.set(pid, key);
      varDesired.push({
        key,
        insert: { restaurant_id: rid, product_id: pid, name: v.name, price_cents: v.priceCents, sort_order: i + 1, is_available: true, is_default: isDefault, is_active: true },
        update: { price_cents: v.priceCents, sort_order: i + 1, is_default: isDefault, is_active: true },
      });
    });
  }
  // O índice único "uma variante padrão ativa por produto" exige rebaixar antes de promover.
  await syncTable(
    admin,
    "product_variants",
    existingVariants,
    (r) => `${r.product_id}|${norm(r.name)}`,
    varDesired,
    mode,
    st("variants"),
    {
      demoteFirst: async (rows) => {
        if (mode.createOnly) return;
        for (const r of rows) {
          if (!managedProducts.has(r.product_id) || !r.is_default || !r.is_active) continue;
          if (wantDefault.get(r.product_id) !== `${r.product_id}|${norm(r.name)}`) {
            must(await admin.from("product_variants").update({ is_default: false }).eq("id", r.id), "demote variant");
            r.is_default = false;
          }
        }
      },
    },
  );

  // --- vínculos produto <-> grupo ---
  const linkSt = st("productGroupLinks");
  const existingLinks = must(await admin.from("product_modifier_groups").select("product_id,group_id,sort_order").eq("restaurant_id", rid), "list links") as Row[];
  const haveLink = new Map(existingLinks.map((l) => [`${l.product_id}|${l.group_id}`, l]));
  const wantLinks = new Map<string, { product_id: string; group_id: string; sort_order: number }>();
  const managedForLinks = new Set<string>();
  for (const { cat, p } of flat) {
    const pid = products.get(`${cats.get(norm(cat))!.id}|${norm(p.name)}`)!.id as string;
    managedForLinks.add(pid);
    (p.modifierGroups ?? []).forEach((gname, i) => {
      const gid = groups.get(norm(gname))!.id as string;
      wantLinks.set(`${pid}|${gid}`, { product_id: pid, group_id: gid, sort_order: i });
    });
  }
  const upserts: Row[] = [];
  for (const [k, w] of wantLinks) {
    const cur = haveLink.get(k);
    if (!cur) {
      upserts.push({ restaurant_id: rid, ...w });
      linkSt.created++;
    } else if (!mode.createOnly && cur.sort_order !== w.sort_order) {
      upserts.push({ restaurant_id: rid, ...w });
      linkSt.updated++;
    } else linkSt.unchanged++;
  }
  for (let i = 0; i < upserts.length; i += 200) {
    must(await admin.from("product_modifier_groups").upsert(upserts.slice(i, i + 200), { onConflict: "product_id,group_id" }), "upsert links");
  }
  if (!mode.createOnly) {
    // vínculos dos produtos importados que não existem mais nos dados são removidos (vínculo não é dado de negócio).
    for (const l of existingLinks) {
      if (managedForLinks.has(l.product_id) && !wantLinks.has(`${l.product_id}|${l.group_id}`)) {
        must(await admin.from("product_modifier_groups").delete().eq("product_id", l.product_id).eq("group_id", l.group_id), "delete stale link");
        linkSt.deactivated++;
      }
    }
  }
}

/** Define o logo (arquivo local) do restaurante. */
export async function syncLogo(admin: Admin, rid: string, data: ImportData, mode: SyncMode, report: RestaurantReport): Promise<void> {
  if (!data.logoFile) return;
  const prepared = prepareAsset(mode.srcRoot, data.logoFile);
  if (isSkipped(prepared)) {
    report.images.skipped.push(prepared);
    return;
  }
  const cur = must(await admin.from("restaurants").select("logo_path").eq("id", rid).single(), "select logo") as Row;
  if (mode.createOnly && cur.logo_path) return;
  const p = await uploadAsset(admin, rid, "logo", prepared);
  report.images.uploaded++;
  if (cur.logo_path !== p) must(await admin.from("restaurants").update({ logo_path: p }).eq("id", rid), "update logo_path");
}

export async function importRestaurant(admin: Admin, data: ImportData, ownerId: string, mode: SyncMode): Promise<RestaurantReport> {
  const warnings: string[] = [];
  const { id, created } = await ensureRestaurant(admin, data, ownerId, mode, warnings);
  const report: RestaurantReport = { slug: data.restaurant.slug, id, restaurantCreated: created, stats: {}, images: { uploaded: 0, skipped: [] }, warnings };
  await syncSettings(admin, id, data, mode, report.stats);
  await syncHours(admin, id, data, mode, report.stats);
  await syncZone(admin, id, data, mode, report.stats);
  await syncLogo(admin, id, data, mode, report);
  await syncCatalog(admin, id, data, mode, report);
  return report;
}
