import { z } from "zod";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { StaffCartItemPayload } from "@/modules/tables/types";

/** Erro de uma venda de balcão, com a mensagem em português para a tela. */
export class CounterSaleError extends Error {
  constructor(
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  UNAUTHENTICATED: "Sua sessão expirou. Entre de novo.",
  FORBIDDEN: "Você não tem permissão para vender no balcão.",
  RESTAURANT_NOT_FOUND: "Restaurante não encontrado ou sem acesso.",
  RESTAURANT_UNAVAILABLE: "O restaurante está indisponível no momento.",
  INVALID_TENDERED: "O valor recebido precisa cobrir o total da venda.",
  INVALID_AMOUNT: "O total da venda precisa ser maior que zero.",
  INVALID_NOTES: "A observação é inválida (máximo de 1000 caracteres).",
  INVALID_IDEMPOTENCY_KEY: "Não foi possível identificar esta tentativa. Atualize a página e tente de novo.",
};

export function parseCounterSaleError(error: { message?: string } | null | undefined): CounterSaleError {
  const message = error?.message ?? "";
  const code = /^([A-Z_]{4,40})\b/.exec(message)?.[1] ?? null;
  if (code && FRIENDLY[code]) return new CounterSaleError(FRIENDLY[code], code);
  if (/permission denied|row-level security/i.test(message)) return new CounterSaleError(FRIENDLY.FORBIDDEN, "FORBIDDEN");
  return new CounterSaleError("Não foi possível concluir a venda. Verifique a conexão e tente de novo.", code);
}

const itemError = z.object({ message: z.string().optional(), code: z.string().optional() }).passthrough();

const resultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    idempotent_replay: z.boolean(),
    order: z.object({
      id: z.string(),
      order_number: z.number().int(),
      total_cents: z.number().int(),
      payment_status: z.string(),
    }),
    change_cents: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), errors: z.array(itemError) }),
]);

export type CounterSaleResult = {
  orderId: string;
  orderNumber: number;
  totalCents: number;
  changeCents: number;
  replay: boolean;
};

/**
 * Grava a venda inteira (pedido + pagamento em dinheiro) numa única chamada. `idempotencyKey` identifica a
 * TENTATIVA: reenviar após uma falha de rede devolve o mesmo pedido, sem cobrar duas vezes.
 */
export async function createCounterSale(
  supabase: AppSupabaseClient,
  input: {
    restaurantId: string;
    items: StaffCartItemPayload[];
    tenderedCents: number | null;
    notes: string | null;
    idempotencyKey: string;
  },
): Promise<CounterSaleResult> {
  const { data, error } = await supabase.rpc("create_counter_sale" as never, {
    p_restaurant: input.restaurantId,
    p_items: input.items,
    p_tendered_cents: input.tenderedCents,
    p_notes: input.notes,
    p_idempotency_key: input.idempotencyKey,
  } as never);
  if (error) throw parseCounterSaleError(error);
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) throw new CounterSaleError("Resposta inesperada do servidor. Confira em Pedidos antes de tentar de novo.");
  if (!parsed.data.ok) {
    throw new CounterSaleError("Algum item não está mais disponível. Atualize o cardápio e revise o pedido.", "ITEMS_INVALID");
  }
  const { order, change_cents, idempotent_replay } = parsed.data;
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    totalCents: order.total_cents,
    changeCents: change_cents,
    replay: idempotent_replay,
  };
}
