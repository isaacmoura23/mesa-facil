"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { GENERIC_ERROR_MESSAGE } from "@/lib/errors";
import type { ActionResult } from "@/modules/menu/types";

type RunOptions = {
  /** Identifica o item em andamento (para desabilitar só os controles dele). */
  key?: string;
  /** Formulários mostram o erro inline; os demais usam toast. */
  inlineError?: boolean;
};

/**
 * Executa uma Server Action do cardápio com estado de carregamento e
 * feedback (toast de sucesso/aviso; erro em toast quando não for inline).
 * Erros inesperados (rede, servidor) viram uma mensagem genérica em PT-BR.
 */
export function useMenuAction() {
  const { toast } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const run = useCallback(
    async (task: () => Promise<ActionResult>, options: RunOptions = {}): Promise<ActionResult> => {
      setBusyKey(options.key ?? "__action__");
      let result: ActionResult;
      try {
        result = await task();
      } catch {
        result = { ok: false, message: GENERIC_ERROR_MESSAGE };
      } finally {
        setBusyKey(null);
      }

      if (result.ok) {
        if (result.warning) {
          toast({ title: result.message ?? "Salvo.", description: result.warning, tone: "info", duration: 9000 });
        } else if (result.message) {
          toast({ title: result.message, tone: "success" });
        }
      } else if (!options.inlineError) {
        toast({ title: result.message, tone: "danger", duration: 9000 });
      }
      return result;
    },
    [toast],
  );

  return {
    run,
    pending: busyKey !== null,
    isBusy: (key: string) => busyKey === key,
  };
}
