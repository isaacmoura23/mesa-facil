"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openBillPrintDialog } from "@/components/printing/open-bill-print-dialog";
import { BILL_DOCUMENT_LABELS, BILL_DOCUMENT_TYPES, type BillDocumentType } from "@/modules/printing/bill";

type PrintBillActionsProps = {
  tabId: string;
  placeLabel: string;
  canPrint: boolean;
  /** Estado da comanda: parcial só com comanda aberta; final com aberta ou fechada; cancelada não tem conta. */
  tabStatus: string;
};

/** Botões "Conta parcial" e "Conta final": abrem o diálogo de impressão (o servidor registra cada pedido). */
export function PrintBillActions({ tabId, placeLabel, canPrint, tabStatus }: PrintBillActionsProps) {
  const blockedFor = (type: BillDocumentType): string | null => {
    if (!canPrint) return "Você não tem permissão para imprimir.";
    if (tabStatus === "CANCELLED") return "Comandas canceladas não têm conta para imprimir.";
    if (type === "PARTIAL_BILL" && tabStatus !== "OPEN") return "A conta parcial só vale para comanda aberta. Use a conta final.";
    return null;
  };
  const reasons = Array.from(new Set(BILL_DOCUMENT_TYPES.map(blockedFor).filter((reason): reason is string => reason !== null)));

  return (
    <section aria-labelledby="tb-print-title" className="flex flex-col gap-3">
      <h3 id="tb-print-title" className="text-sm font-semibold">
        Imprimir conta
      </h3>
      <div className="flex flex-wrap gap-2">
        {BILL_DOCUMENT_TYPES.map((type) => (
          <Button
            key={type}
            variant="secondary"
            onClick={() => openBillPrintDialog(tabId, type, placeLabel)}
            disabled={blockedFor(type) !== null}
            aria-describedby={reasons.length > 0 ? "tb-print-reason" : undefined}
          >
            <Printer aria-hidden="true" className="size-4" />
            {BILL_DOCUMENT_LABELS[type]}
          </Button>
        ))}
      </div>
      {reasons.length > 0 ? (
        <p id="tb-print-reason" className="text-xs text-muted">
          {reasons.join(" ")}
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-muted">
          Abre o diálogo de impressão do navegador. A conta não é documento fiscal.
        </p>
      )}
    </section>
  );
}
