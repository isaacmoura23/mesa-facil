"use client";

import { createRoot, type Root } from "react-dom/client";
import type { BillDocumentType } from "@/modules/printing/bill";
import { BillPrintDialog } from "./bill-print-dialog";

/**
 * Monta o diálogo de impressão da conta numa raiz React própria (filha direta
 * de <body>, `#tp-host`), como `openPrintDialog` faz para pedidos. Só um
 * diálogo de impressão por vez na página.
 */
let current: { root: Root; container: HTMLElement } | null = null;

export function openBillPrintDialog(tabId: string, documentType: BillDocumentType, placeLabel?: string): void {
  if (typeof document === "undefined" || current || document.getElementById("tp-host")) return;
  const container = document.createElement("div");
  container.id = "tp-host";
  document.body.appendChild(container);
  const root = createRoot(container);
  current = { root, container };

  const close = () => {
    const active = current;
    if (!active) return;
    current = null;
    active.root.unmount();
    active.container.remove();
  };

  root.render(<BillPrintDialog tabId={tabId} documentType={documentType} placeLabel={placeLabel} onClose={close} />);
}
