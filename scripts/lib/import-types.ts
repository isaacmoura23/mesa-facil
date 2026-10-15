/**
 * Tipos e validação dos arquivos de dados da importação (scripts/data/*.json).
 * A validação espelha os CHECKs do banco (migrações 0101, 0102 e 0113) para falhar ANTES de tocar no banco.
 */

export const ALLOWED_BADGES = ["NEW", "POPULAR", "REGIONAL", "SWEET", "SPICY", "VEGETARIAN"] as const;
export type Badge = (typeof ALLOWED_BADGES)[number];

export interface ImportVariant {
  name: string;
  priceCents: number;
}

export interface ImportModifier {
  name: string;
  priceDeltaCents: number;
}

export interface ImportModifierGroup {
  name: string;
  min: number;
  max: number;
  modifiers: ImportModifier[];
}

export interface ImportProduct {
  name: string;
  description?: string | null;
  /** Preço do produto sem variantes. Com variantes é derivado (menor preço). */
  priceCents?: number;
  variants?: ImportVariant[];
  badges?: Badge[];
  /** Caminho relativo à raiz das pastas irmãs (--src-root), ex.: "nai/public/assets/img/bebidas/x.webp". */
  imageFile?: string;
  /** Nomes de grupos (ImportData.modifierGroups[].name), na ordem de exibição. */
  modifierGroups?: string[];
}

export interface ImportCategory {
  name: string;
  description?: string | null;
  products: ImportProduct[];
}

export interface ImportData {
  _source?: string;
  restaurant: { name: string; slug: string; timezone: string };
  settings: {
    storefrontUrl: string;
    storefrontOrigins: string[];
    whatsapp: string | null;
    phone: string | null;
    addressText: string | null;
    fulfillmentTypes: ("DELIVERY" | "PICKUP" | "DINE_IN")[];
    minOrderCents: number | null;
  };
  /** Taxa fixa. demoValue=true: o próprio site marca o valor como DEMONSTRAÇÃO (a confirmar com a loja). */
  deliveryZone: { name: string; feeCents: number; demoValue?: boolean } | null;
  hours: { weekday: number; opensAt: string; closesAt: string }[];
  logoFile: string | null;
  modifierGroups: ImportModifierGroup[];
  categories: ImportCategory[];
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const len = (s: string) => s.trim().length;

/** Devolve a lista de problemas (vazia = válido). */
export function validateImportData(d: ImportData): string[] {
  const errs: string[] = [];
  const e = (m: string) => errs.push(`[${d.restaurant?.slug ?? "?"}] ${m}`);

  const r = d.restaurant;
  if (!r || len(r.name) < 2 || len(r.name) > 120) e("nome do restaurante deve ter 2..120 caracteres");
  if (!r || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.slug) || r.slug.length < 3 || r.slug.length > 63) e("slug inválido");

  const s = d.settings;
  if (!/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^\s<>"']*)?$/.test(s.storefrontUrl) || s.storefrontUrl.length > 200) e("storefrontUrl inválida");
  if (s.storefrontOrigins.length > 5) e("máx. 5 storefrontOrigins");
  for (const o of s.storefrontOrigins) if (!/^https:\/\/[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(o)) e(`origem inválida: ${o}`);
  if (new Set(s.storefrontOrigins).size !== s.storefrontOrigins.length) e("storefrontOrigins duplicadas");
  if (s.whatsapp !== null && !/^\+?[0-9]{10,15}$/.test(s.whatsapp)) e("whatsapp inválido");
  if (s.phone !== null && !/^[0-9+()./ -]{6,30}$/.test(s.phone)) e("telefone inválido");
  if (s.addressText !== null && s.addressText.length > 200) e("address_text > 200");
  if (s.fulfillmentTypes.length < 1) e("ao menos uma modalidade");
  if (s.minOrderCents !== null && (!isInt(s.minOrderCents) || s.minOrderCents < 0)) e("minOrderCents inválido");

  if (d.deliveryZone && (!isInt(d.deliveryZone.feeCents) || d.deliveryZone.feeCents < 0 || len(d.deliveryZone.name) < 1)) e("zona de entrega inválida");

  const seenWd = new Set<string>();
  for (const h of d.hours) {
    if (!isInt(h.weekday) || h.weekday < 0 || h.weekday > 6) e(`weekday inválido: ${h.weekday}`);
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(h.opensAt) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(h.closesAt)) e(`hora inválida em ${h.weekday}`);
    if (h.opensAt === h.closesAt) e(`abre = fecha em ${h.weekday}`);
    const k = `${h.weekday}|${h.opensAt}|${h.closesAt}`;
    if (seenWd.has(k)) e(`horário duplicado: ${k}`);
    seenWd.add(k);
  }

  const groupNames = new Set<string>();
  for (const g of d.modifierGroups) {
    if (len(g.name) < 1 || len(g.name) > 120) e(`grupo "${g.name}": nome 1..120`);
    if (groupNames.has(g.name.toLowerCase())) e(`grupo duplicado: ${g.name}`);
    groupNames.add(g.name.toLowerCase());
    if (!isInt(g.min) || !isInt(g.max) || g.min < 0 || g.max < 1 || g.min > g.max) e(`grupo "${g.name}": min/max inválidos`);
    if (g.modifiers.length < 1) e(`grupo "${g.name}": sem modificadores`);
    if (g.max > g.modifiers.length) e(`grupo "${g.name}": max (${g.max}) > nº de opções (${g.modifiers.length})`);
    const mn = new Set<string>();
    for (const m of g.modifiers) {
      if (len(m.name) < 1 || len(m.name) > 120) e(`modificador "${m.name}": nome 1..120`);
      if (!isInt(m.priceDeltaCents) || m.priceDeltaCents < 0) e(`modificador "${m.name}": preço inválido`);
      if (mn.has(m.name.toLowerCase())) e(`modificador duplicado em "${g.name}": ${m.name}`);
      mn.add(m.name.toLowerCase());
    }
  }

  const catNames = new Set<string>();
  for (const c of d.categories) {
    if (len(c.name) < 1 || len(c.name) > 120) e(`categoria "${c.name}": nome 1..120`);
    if (catNames.has(c.name.toLowerCase())) e(`categoria duplicada: ${c.name}`);
    catNames.add(c.name.toLowerCase());
    if (c.description && c.description.length > 500) e(`categoria "${c.name}": descrição > 500`);
    const pn = new Set<string>();
    for (const p of c.products) {
      const where = `${c.name} / ${p.name}`;
      if (len(p.name) < 1 || len(p.name) > 160) e(`produto "${where}": nome 1..160`);
      if (pn.has(p.name.toLowerCase())) e(`produto duplicado na categoria: ${where}`);
      pn.add(p.name.toLowerCase());
      if (p.description && p.description.length > 1000) e(`produto "${where}": descrição > 1000`);
      if (p.variants?.length) {
        if (p.priceCents !== undefined) e(`produto "${where}": tem variantes e priceCents`);
        const vn = new Set<string>();
        for (const v of p.variants) {
          if (len(v.name) < 1 || v.name.length > 40) e(`variante "${where} / ${v.name}": nome 1..40`);
          if (!isInt(v.priceCents) || v.priceCents < 0) e(`variante "${where} / ${v.name}": preço inválido`);
          if (vn.has(v.name.trim().toLowerCase())) e(`variante duplicada em "${where}": ${v.name}`);
          vn.add(v.name.trim().toLowerCase());
        }
      } else if (!isInt(p.priceCents) || (p.priceCents as number) < 0) {
        e(`produto "${where}": sem preço`);
      }
      const b = p.badges ?? [];
      if (b.length > 4 || new Set(b).size !== b.length) e(`produto "${where}": badges inválidos`);
      for (const x of b) if (!ALLOWED_BADGES.includes(x)) e(`produto "${where}": badge desconhecido ${x}`);
      for (const gname of p.modifierGroups ?? []) {
        if (!groupNames.has(gname.toLowerCase())) e(`produto "${where}": grupo inexistente "${gname}"`);
      }
      if ((p.modifierGroups ?? []).length !== new Set(p.modifierGroups ?? []).size) e(`produto "${where}": grupo repetido`);
    }
  }
  return errs;
}

export function countData(d: ImportData) {
  const products = d.categories.flatMap((c) => c.products);
  return {
    categories: d.categories.length,
    products: products.length,
    variants: products.reduce((n, p) => n + (p.variants?.length ?? 0), 0),
    productsWithVariants: products.filter((p) => p.variants?.length).length,
    modifierGroups: d.modifierGroups.length,
    modifiers: d.modifierGroups.reduce((n, g) => n + g.modifiers.length, 0),
    productGroupLinks: products.reduce((n, p) => n + (p.modifierGroups?.length ?? 0), 0),
    productImages: products.filter((p) => p.imageFile).length,
    badges: products.reduce((n, p) => n + (p.badges?.length ?? 0), 0),
  };
}
