import "server-only";
import { createClient } from "@/lib/supabase/server";
import { failureFrom, loadFailure, type Result } from "@/modules/reports/errors";
import {
  customerDetailSchema,
  customerListSchema,
  PAGE_SIZE,
  type CustomerCursor,
  type CustomerDetail,
  type CustomerList,
} from "./schemas";

/**
 * Leituras de clientes SOMENTE pelas RPCs (permissão `reports.view` validada
 * no banco; o restaurante vem do guard). Sem cache: dados pessoais.
 */
export async function listCustomers(
  restaurantId: string,
  search: string,
  cursor: CustomerCursor | null,
): Promise<Result<CustomerList>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_customers", {
    p_restaurant: restaurantId,
    p_search: search || null,
    p_cursor: cursor,
    p_limit: PAGE_SIZE,
  });
  if (error) return failureFrom(error);
  const parsed = customerListSchema.safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : loadFailure();
}

/** Detalhe do cliente; a RPC grava a auditoria `customer.viewed`. */
export async function getCustomer(restaurantId: string, customerId: string): Promise<Result<CustomerDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_customer", {
    p_restaurant: restaurantId,
    p_customer: customerId,
  });
  if (error) return failureFrom(error);
  const parsed = customerDetailSchema.safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : loadFailure();
}
