import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { ConnectionState } from "@/modules/operations/types";

const COPY: Record<ConnectionState, { label: string; tone: string }> = {
  connecting: { label: "Conectando...", tone: "bg-surface-2 text-muted" },
  online: { label: "Ao vivo", tone: "bg-accent-soft text-accent-soft-fg" },
  reconnecting: { label: "Reconectando...", tone: "bg-warning-soft text-warning-soft-fg" },
  offline: { label: "Sem conexão", tone: "bg-danger-soft text-danger-soft-fg" },
};

export function ConnectionIndicator({
  state,
  syncing,
  onRefresh,
}: {
  state: ConnectionState;
  syncing: boolean;
  onRefresh: () => void;
}) {
  const { label, tone } = COPY[state];
  const Icon = state === "offline" ? WifiOff : state === "online" ? Wifi : RefreshCw;
  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        className={cn("inline-flex h-9 items-center gap-2 rounded-full px-3 text-sm font-medium", tone)}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-4", (state === "reconnecting" || state === "connecting") && "motion-safe:animate-spin")}
        />
        {label}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        className="inline-flex h-9 items-center gap-1.5 rounded-control px-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60"
        aria-label="Atualizar pedidos agora"
      >
        <RefreshCw aria-hidden="true" className={cn("size-4", syncing && "motion-safe:animate-spin")} />
        <span className="hidden sm:inline">Atualizar</span>
      </button>
    </div>
  );
}
