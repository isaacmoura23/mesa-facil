"use client";

import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export type ConfirmRequest = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<unknown>;
};

/**
 * Confirmação antes de ações destrutivas (excluir/desativar). Devolve a função
 * `confirm(pedido)` e o elemento `dialog`, que deve ser renderizado uma vez.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [pending, setPending] = useState(false);

  const dialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ""}
      description={request?.description}
      confirmLabel={request?.confirmLabel}
      tone={request?.tone}
      pending={pending}
      onClose={() => setRequest(null)}
      onConfirm={async () => {
        if (!request) return;
        setPending(true);
        try {
          await request.onConfirm();
        } finally {
          setPending(false);
          setRequest(null);
        }
      }}
    />
  );

  return { confirm: setRequest, dialog };
}
