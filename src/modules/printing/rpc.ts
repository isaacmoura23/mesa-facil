import type { AppSupabaseClient } from "@/lib/supabase/types";
import { parsePrintError } from "./errors";
import { requestTabPrintResultSchema, type BillDocumentType, type RequestTabPrintResult } from "./bill";
import {
  requestPrintResultSchema,
  type PrintDocumentType,
  type PrintJobStatus,
  type RequestPrintResult,
} from "./types";

/** Registra o pedido de impressão no servidor (quem e quando) e devolve o payload do documento. */
export async function requestPrint(
  supabase: AppSupabaseClient,
  orderId: string,
  documentType: PrintDocumentType,
): Promise<RequestPrintResult> {
  const { data, error } = await supabase.rpc("request_print", {
    p_order: orderId,
    p_document_type: documentType,
  });
  if (error) throw new Error(parsePrintError(error));
  const parsed = requestPrintResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Resposta inesperada do servidor ao pedir a impressão.");
  return parsed.data;
}

/** DISPATCHED = diálogo de impressão aberto (não confirma papel impresso). FAILED = erro ao tentar. */
export async function markPrintJob(
  supabase: AppSupabaseClient,
  jobId: string,
  status: PrintJobStatus,
): Promise<void> {
  const { error } = await supabase.rpc("mark_print_job", { p_job: jobId, p_status: status });
  if (error) throw new Error(parsePrintError(error));
}

/** Conta parcial/final da comanda. Cada chamada cria um novo pedido de impressão (reimpressão = novo job). */
export async function requestTabPrint(
  supabase: AppSupabaseClient,
  tabId: string,
  documentType: BillDocumentType,
): Promise<RequestTabPrintResult> {
  const { data, error } = await supabase.rpc("request_tab_print", {
    p_tab: tabId,
    p_document_type: documentType,
  });
  if (error) throw new Error(parsePrintError(error));
  const parsed = requestTabPrintResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Resposta inesperada do servidor ao pedir a impressão da conta.");
  return parsed.data;
}
