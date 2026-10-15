/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verificação pós-importação, SEM chave privilegiada:
 *   1) RPC `public_menu(slug)` com a chave anon;
 *   2) (opcional) API pública `GET {apiBase}/api/public/v1/restaurants/{slug}/menu`.
 * Compara produto a produto (nome, preço, variantes, selos, adicionais) com o arquivo de dados.
 */
import { createClient } from "@supabase/supabase-js";
import type { ImportData } from "./import-types";

interface NProduct {
  name: string;
  description: string | null;
  priceCents: number;
  badges: string[];
  variants: { name: string; priceCents: number; isDefault: boolean }[];
  groups: { name: string; min: number; max: number | null; mods: { name: string; delta: number }[] }[];
  hasImage: boolean;
}
interface NMenu {
  restaurantName: string;
  contact: { whatsapp: string | null; phone: string | null; addressText: string | null };
  storefrontUrl: string | null;
  fulfillment: string[];
  zones: { name: string; feeCents: number }[];
  hours: string[];
  hasLogo: boolean;
  categories: { name: string; description: string | null; products: NProduct[] }[];
}

const hh = (t: string) => String(t).slice(0, 5);

function fromRpc(j: any): NMenu {
  return {
    restaurantName: j.restaurant.name,
    contact: { whatsapp: j.restaurant.contact?.whatsapp ?? null, phone: j.restaurant.contact?.phone ?? null, addressText: j.restaurant.contact?.address_text ?? null },
    storefrontUrl: j.restaurant.storefront_url ?? null,
    fulfillment: [...(j.settings.enabled_fulfillment_types ?? [])].sort(),
    zones: (j.settings.delivery_zones ?? []).map((z: any) => ({ name: z.name, feeCents: z.fee_cents })),
    hours: (j.settings.business_hours ?? []).map((h: any) => `${h.weekday}|${hh(h.opens_at)}|${hh(h.closes_at)}`).sort(),
    hasLogo: !!j.restaurant.logo_path,
    categories: (j.categories ?? []).map((c: any) => ({
      name: c.name,
      description: c.description ?? null,
      products: (c.products ?? []).map((p: any) => ({
        name: p.name,
        description: p.description ?? null,
        priceCents: p.price_cents,
        badges: p.badges ?? [],
        variants: (p.variants ?? []).map((v: any) => ({ name: v.name, priceCents: v.price_cents, isDefault: v.is_default })),
        groups: (p.modifier_groups ?? []).map((g: any) => ({
          name: g.name,
          min: g.min_selections,
          max: g.max_selections,
          mods: (g.modifiers ?? []).map((m: any) => ({ name: m.name, delta: m.price_delta_cents })),
        })),
        hasImage: !!p.image_path,
      })),
    })),
  };
}

function fromApi(j: any): NMenu {
  const d = j.data ?? j;
  return {
    restaurantName: d.restaurant.name,
    contact: { whatsapp: d.restaurant.contact?.whatsapp ?? null, phone: d.restaurant.contact?.phone ?? null, addressText: d.restaurant.contact?.addressText ?? null },
    storefrontUrl: d.restaurant.storefrontUrl ?? null,
    fulfillment: [...(d.settings.fulfillmentTypes ?? [])].sort(),
    zones: (d.settings.deliveryZones ?? []).map((z: any) => ({ name: z.name, feeCents: z.feeCents })),
    hours: (d.settings.businessHours ?? []).map((h: any) => `${h.weekday}|${hh(h.opensAt)}|${hh(h.closesAt)}`).sort(),
    hasLogo: !!d.restaurant.logoUrl,
    categories: (d.categories ?? []).map((c: any) => ({
      name: c.name,
      description: c.description ?? null,
      products: (c.products ?? []).map((p: any) => ({
        name: p.name,
        description: p.description ?? null,
        priceCents: p.priceCents,
        badges: p.badges ?? [],
        variants: (p.variants ?? []).map((v: any) => ({ name: v.name, priceCents: v.priceCents, isDefault: v.isDefault })),
        groups: (p.modifierGroups ?? []).map((g: any) => ({
          name: g.name,
          min: g.minSelections,
          max: g.maxSelections,
          mods: (g.modifiers ?? []).map((m: any) => ({ name: m.name, delta: m.priceDeltaCents })),
        })),
        hasImage: !!p.imageUrl,
      })),
    })),
  };
}

export interface VerifyResult {
  source: string;
  products: number;
  categories: number;
  problems: string[];
}

/** Compara um menu normalizado com o esperado. */
function compare(data: ImportData, m: NMenu, source: string): VerifyResult {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(msg);
  const g = data.modifierGroups;
  const groupIndex = new Map(g.map((x, i) => [x.name, i]));

  if (m.restaurantName !== data.restaurant.name) bad(`nome do restaurante: "${m.restaurantName}" != "${data.restaurant.name}"`);
  // a API v1 pode serializar a URL com barra final (new URL().toString()); a origem é a mesma.
  const noSlash = (u: string) => u.replace(/\/+$/, "");
  if (noSlash(m.storefrontUrl ?? "") !== noSlash(data.settings.storefrontUrl)) bad(`storefrontUrl: ${m.storefrontUrl} != ${data.settings.storefrontUrl}`);
  if (m.contact.whatsapp !== data.settings.whatsapp) bad("whatsapp diferente");
  if (m.contact.phone !== data.settings.phone) bad("telefone diferente");
  if (m.contact.addressText !== data.settings.addressText) bad("endereço diferente");
  if (JSON.stringify(m.fulfillment) !== JSON.stringify([...data.settings.fulfillmentTypes].sort())) bad(`modalidades: ${m.fulfillment.join(",")}`);
  const wantHours = data.hours.map((h) => `${h.weekday}|${h.opensAt}|${h.closesAt}`).sort();
  if (JSON.stringify(m.hours) !== JSON.stringify(wantHours)) bad(`horários divergem: ${m.hours.join(" ")} != ${wantHours.join(" ")}`);
  if (data.deliveryZone) {
    const z = m.zones.find((x) => x.name === data.deliveryZone!.name);
    if (!z) bad("zona de entrega ausente");
    else if (z.feeCents !== data.deliveryZone.feeCents) bad(`taxa de entrega ${z.feeCents} != ${data.deliveryZone.feeCents}`);
  }
  if (data.logoFile && !m.hasLogo) bad("logo ausente (arquivo pulado?)");

  // Categorias: ordem e nomes. (O menu pode conter, no fim, categorias fora dos dados, p.ex. "Outros".)
  data.categories.forEach((c, ci) => {
    const got = m.categories[ci];
    if (!got || got.name !== c.name) {
      bad(`categoria #${ci + 1}: esperado "${c.name}", obtido "${got?.name ?? "(nenhuma)"}"`);
      return;
    }
    if ((got.description ?? null) !== (c.description ?? null)) bad(`categoria "${c.name}": descrição diverge`);
    if (got.products.length !== c.products.length) bad(`categoria "${c.name}": ${got.products.length} produtos != ${c.products.length}`);
    c.products.forEach((p, pi) => {
      const gp = got.products[pi];
      const where = `${c.name} / ${p.name}`;
      if (!gp || gp.name !== p.name) {
        bad(`${where}: posição ${pi + 1} traz "${gp?.name ?? "(nenhum)"}"`);
        return;
      }
      const wantPrice = p.variants?.length ? Math.min(...p.variants.map((v) => v.priceCents)) : (p.priceCents as number);
      if (gp.priceCents !== wantPrice) bad(`${where}: preço ${gp.priceCents} != ${wantPrice}`);
      if ((gp.description ?? null) !== (p.description ?? null)) bad(`${where}: descrição diverge`);
      if (JSON.stringify([...gp.badges].sort()) !== JSON.stringify([...(p.badges ?? [])].sort())) bad(`${where}: selos ${gp.badges.join(",")} != ${(p.badges ?? []).join(",")}`);
      if (p.imageFile && !gp.hasImage) bad(`${where}: imagem esperada ausente (arquivo pulado?)`);

      const wantVars = p.variants ?? [];
      if (gp.variants.length !== wantVars.length) bad(`${where}: ${gp.variants.length} variantes != ${wantVars.length}`);
      else {
        const cheapest = wantVars.length ? Math.min(...wantVars.map((v) => v.priceCents)) : 0;
        wantVars.forEach((v, i) => {
          const gv = gp.variants[i];
          if (gv.name !== v.name || gv.priceCents !== v.priceCents) bad(`${where}: variante #${i + 1} ${gv.name}=${gv.priceCents} != ${v.name}=${v.priceCents}`);
          const shouldDefault = v.priceCents === cheapest && wantVars.findIndex((x) => x.priceCents === cheapest) === i;
          if (gv.isDefault !== shouldDefault) bad(`${where}: variante "${v.name}" padrão=${gv.isDefault}, esperado ${shouldDefault}`);
        });
      }

      // O menu ordena os grupos por sort_order do GRUPO e depois pelo vínculo.
      const wantGroups = [...(p.modifierGroups ?? [])].sort((a, b) => (groupIndex.get(a) ?? 0) - (groupIndex.get(b) ?? 0));
      if (gp.groups.length !== wantGroups.length) bad(`${where}: ${gp.groups.length} grupos != ${wantGroups.length}`);
      else {
        wantGroups.forEach((gn, i) => {
          const def = g.find((x) => x.name === gn)!;
          const gg = gp.groups[i];
          if (gg.name !== def.name) bad(`${where}: grupo #${i + 1} "${gg.name}" != "${def.name}"`);
          if (gg.min !== def.min || (gg.max !== null && gg.max !== def.max)) bad(`${where}: grupo "${def.name}" min/max ${gg.min}/${gg.max} != ${def.min}/${def.max}`);
          if (gg.mods.length !== def.modifiers.length) bad(`${where}: grupo "${def.name}" ${gg.mods.length} opções != ${def.modifiers.length}`);
          else def.modifiers.forEach((mo, k) => {
            if (gg.mods[k].name !== mo.name || gg.mods[k].delta !== mo.priceDeltaCents) bad(`${where}: "${def.name}" opção ${gg.mods[k].name}=+${gg.mods[k].delta} != ${mo.name}=+${mo.priceDeltaCents}`);
          });
        });
      }
    });
  });
  const extra = m.categories.slice(data.categories.length);
  if (extra.length) bad(`categorias extras no menu (fora dos dados): ${extra.map((c) => `${c.name}[${c.products.length}]`).join(", ")}`);

  return { source, products: m.categories.reduce((n, c) => n + c.products.length, 0), categories: m.categories.length, problems };
}

export async function verifyRestaurant(opts: { url: string; anonKey: string; data: ImportData; apiBase?: string }): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const anon = createClient(opts.url, opts.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: rpc, error } = await anon.rpc("public_menu", { p_slug: opts.data.restaurant.slug });
  if (error || !rpc) out.push({ source: "rpc public_menu (anon)", products: 0, categories: 0, problems: [`RPC falhou: ${error?.message ?? "restaurante não encontrado/ativo"}`] });
  else out.push(compare(opts.data, fromRpc(rpc), "rpc public_menu (anon)"));

  if (opts.apiBase) {
    const u = `${opts.apiBase.replace(/\/+$/, "")}/api/public/v1/restaurants/${opts.data.restaurant.slug}/menu`;
    try {
      const res = await fetch(u, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) out.push({ source: `GET ${u}`, products: 0, categories: 0, problems: [`HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`] });
      else out.push(compare(opts.data, fromApi(body), `GET /api/public/v1/restaurants/${opts.data.restaurant.slug}/menu`));
    } catch (e) {
      out.push({ source: `GET ${u}`, products: 0, categories: 0, problems: [`falha de rede: ${(e as Error).message}`] });
    }
  }
  return out;
}
