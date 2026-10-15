import { z } from "zod";

/**
 * Modelo do carrinho do cliente (somente navegador, por restaurante).
 *
 * Regra de ouro: o carrinho NÃO é fonte de verdade de preço. A verdade é
 * `product_id + variant_id + quantity + modifier_ids + notes`, que o servidor
 * reprecifica em `validate_cart`. O `snapshot` (nome, tamanho, preço,
 * adicionais) existe apenas para exibir o carrinho sem consultar o servidor, e
 * é sempre rotulado como estimativa na interface.
 *
 * Versões do armazenamento:
 * - v1: sem variantes. Ao ler, as linhas v1 são migradas para v2 com
 *   `variantId: null`; se o produto hoje tem variantes, o servidor responde
 *   VARIANT_REQUIRED e o cliente corrige (escolhe o tamanho) ou remove a linha.
 * - v2: linha com `variantId` e `snapshot.variantName`.
 */

export const CART_SCHEMA_VERSION = 2;
export const LEGACY_CART_SCHEMA_VERSION = 1;
export const MAX_LINES = 50;
export const MAX_QUANTITY = 99;
export const MAX_NOTES = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CartSnapshot = {
  name: string;
  /** Nome do tamanho escolhido (só para exibição); null se o produto não tem variantes. */
  variantName: string | null;
  /** Preço base estimado: o da variante escolhida ou, sem variante, o do produto. */
  unitPriceCents: number;
  imagePath: string | null;
  modifiers: { id: string; name: string; priceDeltaCents: number }[];
};

export type CartLine = {
  /** Identificador local da linha (não é enviado ao servidor). */
  id: string;
  productId: string;
  /** Variante (tamanho) escolhida; null para produto sem variantes. */
  variantId: string | null;
  quantity: number;
  modifierIds: string[];
  notes: string;
  snapshot: CartSnapshot;
};

export type CartState = { version: typeof CART_SCHEMA_VERSION; lines: CartLine[] };

export const EMPTY_CART: CartState = Object.freeze({
  version: CART_SCHEMA_VERSION,
  lines: [],
}) as CartState;

const text = (max: number) => z.string().max(max);

const lineSchema = z.object({
  id: z.string().min(1).max(64),
  productId: z.string().regex(UUID),
  // Ausente (v1) ou inválido => sem variante.
  variantId: z.string().regex(UUID).nullable().optional().catch(null),
  quantity: z.number().int(),
  modifierIds: z.array(z.string().regex(UUID)).max(60),
  notes: z.string(),
  snapshot: z.object({
    name: text(300),
    variantName: text(100).nullable().optional().catch(null),
    unitPriceCents: z.number().int().min(0).max(100_000_000),
    imagePath: z.string().max(500).nullable().catch(null),
    modifiers: z
      .array(
        z.object({
          id: z.string().regex(UUID),
          name: text(300),
          priceDeltaCents: z.number().int().min(-100_000_000).max(100_000_000),
        }),
      )
      .max(60),
  }),
});

/** Chave de agrupamento: mesmo produto + mesma variante + mesmos adicionais + mesma observação. */
export function lineKey(
  line: Pick<CartLine, "productId" | "variantId" | "modifierIds" | "notes">,
): string {
  return `${line.productId}|${line.variantId ?? ""}|${[...line.modifierIds].sort().join(",")}|${line.notes.trim()}`;
}

export function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(value)));
}

export function newLineId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Sanea o JSON lido do localStorage: versão desconhecida, formato inesperado
 * ou linhas inválidas são descartados. Aceita v2 e migra v1 (sem variante).
 * Nunca lança.
 */
export function sanitizeCart(raw: unknown): CartState {
  if (!raw || typeof raw !== "object") return EMPTY_CART;
  const input = raw as { version?: unknown; lines?: unknown };
  const legacy = input.version === LEGACY_CART_SCHEMA_VERSION;
  if ((input.version !== CART_SCHEMA_VERSION && !legacy) || !Array.isArray(input.lines)) {
    return EMPTY_CART;
  }

  const lines: CartLine[] = [];
  const seenIds = new Set<string>();
  for (const candidate of input.lines.slice(0, MAX_LINES)) {
    const parsed = lineSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const l = parsed.data;
    if (seenIds.has(l.id)) continue;
    seenIds.add(l.id);
    const variantId = legacy ? null : (l.variantId?.toLowerCase() ?? null);
    lines.push({
      id: l.id,
      productId: l.productId.toLowerCase(),
      variantId,
      quantity: clampQuantity(l.quantity),
      modifierIds: Array.from(new Set(l.modifierIds.map((m) => m.toLowerCase()))),
      notes: l.notes.slice(0, MAX_NOTES),
      snapshot: {
        name: l.snapshot.name,
        variantName: variantId ? (l.snapshot.variantName?.trim() || null) : null,
        unitPriceCents: l.snapshot.unitPriceCents,
        imagePath: l.snapshot.imagePath,
        modifiers: l.snapshot.modifiers,
      },
    });
  }
  return lines.length === 0 ? EMPTY_CART : { version: CART_SCHEMA_VERSION, lines };
}

/** Preço unitário ESTIMADO (snapshot). Só para exibição. */
export function estimatedUnitCents(line: CartLine): number {
  const extras = line.snapshot.modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0);
  return Math.max(0, line.snapshot.unitPriceCents + extras);
}

export function estimatedLineCents(line: CartLine): number {
  return estimatedUnitCents(line) * line.quantity;
}

export function estimatedSubtotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + estimatedLineCents(line), 0);
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function cartStorageKey(slug: string): string {
  return `mesafacil:cart:v${CART_SCHEMA_VERSION}:${slug}`;
}

/** Chave da versão anterior (lida uma vez e removida: ver cart-store). */
export function legacyCartStorageKey(slug: string): string {
  return `mesafacil:cart:v${LEGACY_CART_SCHEMA_VERSION}:${slug}`;
}

export type CartLineInput = Omit<CartLine, "id">;

/** Adiciona ou agrupa uma linha. Retorna o novo estado (puro). */
export function withAddedLine(state: CartState, input: CartLineInput): CartState {
  let incoming: CartLineInput = {
    ...input,
    quantity: clampQuantity(input.quantity),
    notes: input.notes.trim().slice(0, MAX_NOTES),
  };
  // Correção de linha migrada da v1: ao escolher o tamanho de um produto que já
  // estava no carrinho sem tamanho (mesmos adicionais e observação), a linha
  // antiga (inválida: o servidor exige a variante) é absorvida pela nova.
  if (incoming.variantId !== null) {
    const orphanKey = lineKey({ ...incoming, variantId: null });
    const orphans = state.lines.filter((l) => lineKey(l) === orphanKey);
    if (orphans.length > 0) {
      const carried = orphans.reduce((sum, l) => sum + l.quantity, 0);
      incoming = { ...incoming, quantity: clampQuantity(incoming.quantity + carried) };
      state = { ...state, lines: state.lines.filter((l) => !orphans.includes(l)) };
    }
  }
  const key = lineKey(incoming);
  const existing = state.lines.find((l) => lineKey(l) === key);
  if (existing) {
    return {
      ...state,
      lines: state.lines.map((l) =>
        l.id === existing.id
          ? { ...l, quantity: clampQuantity(l.quantity + incoming.quantity), snapshot: incoming.snapshot }
          : l,
      ),
    };
  }
  if (state.lines.length >= MAX_LINES) return state;
  return { ...state, lines: [...state.lines, { id: newLineId(), ...incoming }] };
}

/** Itens enviados à action de validação (o servidor reprecifica tudo). */
export function toCheckoutItems(lines: CartLine[]) {
  return lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    quantity: l.quantity,
    modifierIds: l.modifierIds,
    notes: l.notes.trim(),
  }));
}
