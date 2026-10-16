"use client";

import { memo } from "react";
import Link from "next/link";
import { Clock, Users } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/modules/operations/format";
import { formatOpenFor, tabSubtitle } from "@/modules/tables/format";
import {
  TABLE_STATUS_LABELS,
  type RestaurantTable,
  type TabSummary,
  type TableStatus,
} from "@/modules/tables/types";

const TONES: Record<TableStatus, BadgeTone> = {
  AVAILABLE: "accent",
  OCCUPIED: "info",
  CLEANING: "warning",
  INACTIVE: "neutral",
};

const FRAME: Record<TableStatus, string> = {
  AVAILABLE: "border-line",
  OCCUPIED: "border-info-soft-fg/40 ring-1 ring-info-soft-fg/20",
  CLEANING: "border-warning-soft-fg/40 ring-1 ring-warning-soft-fg/20",
  INACTIVE: "border-line opacity-70",
};

type TableCardProps = {
  table: RestaurantTable;
  tab: TabSummary | null;
  now: number;
  detailHref: string | null;
  canOpenTab: boolean;
  canRelease: boolean;
  busy: boolean;
  onOpenTab: (table: RestaurantTable) => void;
  onRelease: (table: RestaurantTable) => void;
};

function TableCardView({
  table,
  tab,
  now,
  detailHref,
  canOpenTab,
  canRelease,
  busy,
  onOpenTab,
  onRelease,
}: TableCardProps) {
  const subtitle = tab ? tabSubtitle(tab) : "";

  return (
    <li
      className={cn(
        "flex min-h-44 flex-col rounded-card border bg-surface p-4 shadow-card",
        FRAME[table.status],
        busy && "opacity-70",
      )}
      aria-busy={busy || undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-xl font-semibold text-fg">{table.name}</h3>
          {table.area ? <p className="truncate text-xs text-muted">{table.area}</p> : null}
        </div>
        <Badge tone={TONES[table.status]}>{TABLE_STATUS_LABELS[table.status]}</Badge>
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
        <Users aria-hidden="true" className="size-4" />
        {table.capacity ? `${table.capacity} lugares` : "Capacidade não informada"}
      </p>

      {tab ? (
        <div className="mt-3 rounded-control bg-surface-2 px-3 py-2">
          <p className="text-lg font-semibold tabular-nums text-fg">{formatMoney(tab.consumedCents)}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Clock aria-hidden="true" className="size-3.5" />
            Aberta há {formatOpenFor(tab.opened_at, now)}
            {tab.ordersCount > 0 ? `, ${tab.ordersCount} ${tab.ordersCount === 1 ? "pedido" : "pedidos"}` : ""}
          </p>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      ) : null}

      <div className="mt-auto pt-4">
        {table.status === "AVAILABLE" ? (
          canOpenTab ? (
            <Button fullWidth size="lg" onClick={() => onOpenTab(table)} disabled={busy} loading={busy}>
              Abrir comanda
            </Button>
          ) : (
            <p className="text-sm text-muted">Seu papel não abre comandas.</p>
          )
        ) : null}

        {table.status === "OCCUPIED" ? (
          detailHref ? (
            <Link href={detailHref} className={buttonStyles({ variant: "secondary", size: "lg", fullWidth: true })}>
              Ver comanda
            </Link>
          ) : (
            <p className="text-sm text-muted">
              {tab ? "Seu papel não vê comandas." : "Sem comanda visível para esta mesa."}
            </p>
          )
        ) : null}

        {table.status === "CLEANING" ? (
          canRelease ? (
            <Button
              fullWidth
              size="lg"
              variant="secondary"
              onClick={() => onRelease(table)}
              disabled={busy}
              loading={busy}
            >
              Liberar mesa
            </Button>
          ) : (
            <p className="text-sm text-muted">Aguardando limpeza. Seu papel não libera mesas.</p>
          )
        ) : null}

        {table.status === "INACTIVE" ? (
          <p className="text-sm text-muted">Mesa desativada pela gestão.</p>
        ) : null}
      </div>
    </li>
  );
}

export const TableCard = memo(TableCardView);
