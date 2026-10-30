import type { AppSupabaseClient } from "@/lib/supabase/types";
import { BillingActionError, parseBillingError } from "./errors";
import {
  cancelTabResultSchema,
  closeTabResultSchema,
  recordPaymentResultSchema,
  tabBalanceSchema,
  type RecordPaymentInput,
  type RecordPaymentResult,
  type TabBalance,
} from "./types";

const UNEXPECTED = "Resposta inesperada do servidor. Atualize a comanda e confira o saldo.";

function fail(error: { message?: string; code?: string }): never {
  throw new BillingActionError(parseBillingError(error));
}

function unexpected(): never {
  throw new BillingActionError({ code: "UNEXPECTED_RESPONSE", message: UNEXPECTED, stale: true });
}

export async function getTabBalance(supabase: AppSupabaseClient, tabId: string): Promise<TabBalance> {
  const { data, error } = await supabase.rpc("get_tab_balance", { p_tab: tabId });
  if (error) fail(error);
  const parsed = tabBalanceSchema.safeParse(data);
  if (!parsed.success) unexpected();
  return parsed.data;
}

/** `reference` é a chave de idempotência da tentativa: repetir a mesma tentativa não duplica o pagamento. */
export async function recordPayment(
  supabase: AppSupabaseClient,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  const { data, error } = await supabase.rpc("record_payment", {
    p_tab: input.tabId ?? null,
    p_order: input.orderId ?? null,
    p_method: input.method,
    p_amount_cents: input.amountCents,
    p_tendered_cents: input.method === "CASH" ? input.tenderedCents : null,
    p_reference: input.reference,
  });
  if (error) fail(error);
  const parsed = recordPaymentResultSchema.safeParse(data);
  if (!parsed.success) unexpected();
  return parsed.data;
}

export async function closeTab(
  supabase: AppSupabaseClient,
  tabId: string,
  unpaidReason: string | null,
): Promise<void> {
  const { data, error } = await supabase.rpc("close_tab", { p_tab: tabId, p_unpaid_reason: unpaidReason });
  if (error) fail(error);
  if (!closeTabResultSchema.safeParse(data).success) unexpected();
}

export async function cancelTab(supabase: AppSupabaseClient, tabId: string, reason: string): Promise<void> {
  const { data, error } = await supabase.rpc("cancel_tab", { p_tab: tabId, p_reason: reason });
  if (error) fail(error);
  if (!cancelTabResultSchema.safeParse(data).success) unexpected();
}
