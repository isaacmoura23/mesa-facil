"use client";

import { createRoot, type Root } from "react-dom/client";
import type { OperationsOrder } from "@/modules/operations/types";
import type { PrintDocumentType } from "@/modules/printing/types";
import { PrintDialog } from "./print-dialog";

/**
 * Monta o diálogo de impressão numa raiz React própria (filha direta de <body>),
 * para que qualquer tela possa abrir a impressão sem hospedar o componente.
 * O CSS de impressão esconde tudo que não for este host.
 */
let current: { root: Root; container: HTMLElement } | null = null;

export function openPrintDialog(
  order: OperationsOrder,
  documentTypes: readonly PrintDocumentType[] = ["KITCHEN_TICKET", "ORDER_RECEIPT"],
): void {
  if (typeof document === "undefined" || current) return;
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

  root.render(<PrintDialog order={order} documentTypes={documentTypes} onClose={close} />);
}
