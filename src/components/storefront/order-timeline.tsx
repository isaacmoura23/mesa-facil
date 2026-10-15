import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { TrackedOrder } from "@/modules/orders-server/tracking";
import { formatClock, timelineSteps } from "@/modules/storefront/order-status";

/**
 * Linha do tempo do pedido (lista ordenada). Etapas já alcançadas ficam
 * marcadas e mostram a hora do histórico; a etapa atual é destacada.
 * Em recusa/cancelamento, as etapas alcançadas ficam e uma última etapa de
 * erro encerra a lista.
 */
export function OrderTimeline({ order }: { order: TrackedOrder }) {
  const steps = timelineSteps(order.fulfillmentType);
  const failed = order.status === "REJECTED" || order.status === "CANCELLED";
  const reached = new Map(order.statusHistory.map((h) => [h.status, h.at]));
  const currentIndex = steps.findIndex((s) => s.status === order.status);

  return (
    <ol className="space-y-0" aria-label="Etapas do pedido">
      {steps.map((step, index) => {
        const at = reached.get(step.status);
        const isCurrent = !failed && order.status !== "COMPLETED" && index === currentIndex;
        const isDone = failed ? reached.has(step.status) : index < currentIndex || order.status === "COMPLETED";
        const isLast = index === steps.length - 1 && !failed;
        return (
          <li
            key={step.status}
            aria-current={isCurrent ? "step" : undefined}
            className="relative flex gap-3 pb-5 last:pb-0"
          >
            {!isLast || failed ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-[0.6875rem] top-6 h-[calc(100%-1.5rem)] w-0.5",
                  isDone ? "bg-accent" : "bg-line",
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                isDone && "border-accent bg-accent text-accent-fg",
                isCurrent && "border-accent bg-surface",
                !isDone && !isCurrent && "border-line bg-surface",
              )}
            >
              {isDone ? <Check className="size-3.5" strokeWidth={3} /> : null}
              {isCurrent ? <span className="size-2.5 rounded-full bg-accent motion-safe:animate-pulse" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm",
                  isCurrent ? "font-semibold text-fg" : isDone ? "font-medium text-fg" : "text-muted",
                )}
              >
                {step.label}
                <span className="sr-only">
                  {isCurrent ? " (etapa atual)" : isDone ? " (concluída)" : " (pendente)"}
                </span>
              </p>
              {at && (isDone || isCurrent) ? (
                <p className="text-xs text-muted tabular-nums">{formatClock(at, order.timezone)}</p>
              ) : null}
            </div>
          </li>
        );
      })}
      {failed ? (
        <li aria-current="step" className="relative flex gap-3">
          <span
            aria-hidden="true"
            className="relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-danger text-danger-fg"
          >
            <X className="size-3.5" strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-danger">
              {order.status === "REJECTED" ? "Pedido recusado" : "Pedido cancelado"}
            </p>
            {reached.get(order.status) ? (
              <p className="text-xs text-muted tabular-nums">
                {formatClock(reached.get(order.status) as string, order.timezone)}
              </p>
            ) : null}
          </div>
        </li>
      ) : null}
    </ol>
  );
}
