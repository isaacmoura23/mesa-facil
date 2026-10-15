"use client";

import { useState, useSyncExternalStore } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { printBridge } from "@/modules/operations/print-bridge";
import type { OperationsOrder } from "@/modules/operations/types";
import { dispatchCount, subscribeSessionLog } from "@/modules/printing/session-log";
import type { PrintDocumentType } from "@/modules/printing/types";

type PrintButtonProps = {
  order: OperationsOrder;
  /** Permissão `print.request` do usuário (a RPC confere de novo no banco). */
  allowed: boolean;
  size?: "sm" | "md" | "lg";
  iconOnly?: boolean;
  /** Documentos oferecidos no diálogo (padrão: comanda de preparo e recibo). */
  documentTypes?: readonly PrintDocumentType[];
  /** Rótulo quando o pedido ainda não foi enviado nesta sessão. */
  label?: string;
};

/**
 * Botão "Imprimir comanda" / "Reimprimir". Abre o diálogo de impressão do
 * `print-bridge`; sem permissão fica desabilitado (aria-disabled) com o motivo.
 * Ele nunca afirma que algo foi impresso: o diálogo informa o que de fato ocorreu.
 */
export function PrintButton({
  order,
  allowed,
  size = "md",
  iconOnly = false,
  documentTypes,
  label = "Imprimir comanda",
}: PrintButtonProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sent = useSyncExternalStore(
    subscribeSessionLog,
    () => dispatchCount(order.id),
    () => 0,
  );
  const text = sent > 0 ? "Reimprimir" : label;

  const blockedReason = !allowed
    ? "Você não tem permissão para imprimir pedidos."
    : !printBridge.available
      ? printBridge.unavailableReason
      : null;

  async function handleClick() {
    if (blockedReason || busy) return;
    setBusy(true);
    try {
      await printBridge.print(order, documentTypes);
    } catch (cause) {
      toast({
        title: "Não foi possível imprimir",
        description: cause instanceof Error ? cause.message : "Tente novamente.",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size={size}
      loading={busy}
      aria-disabled={blockedReason ? true : undefined}
      title={
        blockedReason ??
        (sent > 0
          ? "Reimprimir cria um novo pedido de impressão (o pedido continua o mesmo)"
          : "Abre o diálogo de impressão do navegador")
      }
      aria-label={iconOnly ? `${text} do pedido ${order.order_number}` : undefined}
      onClick={handleClick}
      className={iconOnly ? "px-0 aspect-square" : undefined}
    >
      <Printer aria-hidden="true" className="size-4" />
      {iconOnly ? null : text}
    </Button>
  );
}
