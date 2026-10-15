import { openPrintDialog } from "@/components/printing/open-print-dialog";
import type { PrintDocumentType } from "@/modules/printing/types";
import type { OperationsOrder } from "./types";

/**
 * Ponte entre as telas de operação e a impressão (OPS-B).
 *
 * `print(order)` abre o diálogo de impressão: ele pede a impressão ao servidor
 * (`request_print`), mostra o documento, abre o diálogo do navegador
 * (`window.print()` + `@media print`) e registra `mark_print_job`. A ponte
 * nunca afirma que algo foi impresso, só que o diálogo foi aberto.
 */
export type PrintBridge = {
  available: boolean;
  /** Dica exibida enquanto `available` for false. */
  unavailableReason: string;
  /** Abre o diálogo de impressão. `documentTypes` limita os documentos oferecidos. */
  print: (order: OperationsOrder, documentTypes?: readonly PrintDocumentType[]) => Promise<void>;
};

export const printBridge: PrintBridge = {
  available: true,
  unavailableReason: "",
  print: async (order, documentTypes) => {
    openPrintDialog(order, documentTypes);
  },
};
