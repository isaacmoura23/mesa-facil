import { z } from "zod";
import { parseToCents } from "@/lib/format";
import { PAYMENT_METHODS, type PaymentMethod } from "@/modules/orders-server/schemas";

/**
 * Pagamento declarado no checkout e armazenamento local dos pedidos recentes.
 * NÃO existe pagamento online: o cliente só informa COMO vai pagar na
 * entrega/retirada. Módulo puro (usado no cliente e no servidor).
 */

export const PAYMENT_HINTS: Record<PaymentMethod, string> = {
  CASH: "Pague em dinheiro ao receber ou retirar",
  PIX: "Pague por Pix ao receber ou retirar",
  CARD: "Pague com cartão ao receber ou retirar",
};

export const paymentFormSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS, { error: "Escolha como vai pagar." }),
    /** Texto digitado (ex.: "100" ou "100,00"); vazio = sem troco. */
    changeFor: z.string().trim().max(20, "Valor inválido."),
  })
  .superRefine((value, ctx) => {
    if (value.method !== "CASH" || value.changeFor === "") return;
    const cents = parseToCents(value.changeFor);
    if (cents === null || cents <= 0 || cents > 100_000_000) {
      ctx.addIssue({ code: "custom", path: ["changeFor"], message: "Informe um valor válido, ex.: 100,00." });
    }
  });

export type PaymentFormValues = z.input<typeof paymentFormSchema>;
export type PaymentFieldErrors = Partial<Record<keyof PaymentFormValues, string>>;

export const EMPTY_PAYMENT_FORM: { method: ""; changeFor: string } = { method: "", changeFor: "" };

/** Centavos do troco (null = sem troco). Só vale para dinheiro. */
export function changeForCents(payment: { method: string; changeFor: string }): number | null {
  if (payment.method !== "CASH" || payment.changeFor.trim() === "") return null;
  return parseToCents(payment.changeFor);
}

// ---------------------------------------------------------------------------
// Chave de idempotência por tentativa de checkout (sessionStorage até o sucesso)
// ---------------------------------------------------------------------------

export function idempotencyStorageKey(slug: string): string {
  return `mesafacil:checkout-key:v1:${slug}`;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.padEnd(16, "0");
  }
}

/** Hash curto (djb2) do conteúdo do pedido: mudou o conteúdo, muda a chave. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Lê (ou cria) a chave da tentativa atual. A MESMA chave é reutilizada enquanto
 * o conteúdo do pedido for o mesmo (duplo clique, reenvio após falha de rede,
 * recarregar a página): o servidor devolve o mesmo pedido. Sem sessionStorage,
 * vale só em memória (um duplo clique ainda é barrado pela trava do botão).
 */
export function getCheckoutKey(slug: string, contentHash: string): string {
  try {
    const raw = window.sessionStorage.getItem(idempotencyStorageKey(slug));
    const stored = raw ? (JSON.parse(raw) as { key?: unknown; hash?: unknown }) : null;
    if (
      stored &&
      stored.hash === contentHash &&
      typeof stored.key === "string" &&
      /^[A-Za-z0-9_-]{16,100}$/.test(stored.key)
    ) {
      return stored.key;
    }
    const key = newKey();
    window.sessionStorage.setItem(idempotencyStorageKey(slug), JSON.stringify({ key, hash: contentHash }));
    return key;
  } catch {
    return newKey();
  }
}

/** Descarta a chave (após sucesso ou quando o conteúdo do pedido muda). */
export function clearCheckoutKey(slug: string): void {
  try {
    window.sessionStorage.removeItem(idempotencyStorageKey(slug));
  } catch {
    /* sem storage: nada a limpar */
  }
}

// ---------------------------------------------------------------------------
// Pedidos recentes (localStorage, até 5)
// ---------------------------------------------------------------------------

export const RECENT_ORDERS_KEY = "mesafacil:recent-orders:v1";
export const MAX_RECENT_ORDERS = 5;

export type RecentOrder = { slug: string; publicCode: string; orderNumber: number | null; at: string };

const recentSchema = z.array(
  z.object({
    slug: z.string().max(63),
    publicCode: z.string().regex(/^[A-Za-z0-9-]{3,40}$/),
    orderNumber: z.number().int().nullable().catch(null),
    at: z.string().max(40),
  }),
);

export function readRecentOrders(): RecentOrder[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ORDERS_KEY);
    if (!raw) return [];
    const parsed = recentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(0, MAX_RECENT_ORDERS) : [];
  } catch {
    return [];
  }
}

export function rememberOrder(entry: RecentOrder): void {
  try {
    const rest = readRecentOrders().filter((o) => o.publicCode !== entry.publicCode);
    window.localStorage.setItem(
      RECENT_ORDERS_KEY,
      JSON.stringify([entry, ...rest].slice(0, MAX_RECENT_ORDERS)),
    );
  } catch {
    /* storage indisponível: o pedido continua acessível pelo link */
  }
}
