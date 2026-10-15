"use client";

import { useId } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { inputStyles } from "@/components/ui/input";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  type OrderFilters,
  type PeriodKey,
} from "@/modules/operations/types";

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Hoje" },
  { key: "24h", label: "Últimas 24 h" },
  { key: "7d", label: "Últimos 7 dias" },
  { key: "custom", label: "Personalizado" },
];

type OrderFiltersProps = {
  filters: OrderFilters;
  onChange: (patch: Partial<OrderFilters>) => void;
  /** Em telas pequenas, modalidade e período ficam recolhidos atrás do botão Filtros. */
  open: boolean;
  onToggle: () => void;
};

export function OrderFiltersBar({ filters, onChange, open, onToggle }: OrderFiltersProps) {
  const panelId = useId();
  const searchId = useId();
  const periodId = useId();
  const fromId = useId();
  const toId = useId();

  const activeFilters = (filters.fulfillment !== "ALL" ? 1 : 0) + (filters.period !== "today" ? 1 : 0);
  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
      <div className="flex items-center gap-2 xl:w-72 xl:shrink-0">
      <div className="min-w-0 flex-1">
        <label htmlFor={searchId} className="sr-only">
          Buscar por número ou nome
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            id={searchId}
            type="search"
            inputMode="search"
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder="Ex.: 128 ou Maria"
            className={inputStyles(false, "pl-9")}
          />
        </div>
      </div>

        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 xl:hidden"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          Filtros{activeFilters > 0 ? ` (${activeFilters})` : ""}
        </button>
      </div>
      <div
        id={panelId}
        className={cn("gap-3 xl:flex xl:items-end xl:gap-4", open ? "grid" : "hidden")}
      >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-fg">Modalidade</legend>
        <div className="flex gap-1 rounded-control border border-line bg-surface-2 p-1">
          {(["ALL", ...FULFILLMENT_TYPES] as const).map((type) => {
            const active = filters.fulfillment === type;
            return (
              <button
                key={type}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ fulfillment: type })}
                className={cn(
                  "h-9 flex-1 rounded-[0.45rem] px-3 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-accent text-accent-fg shadow-card" : "text-fg hover:bg-surface",
                )}
              >
                {type === "ALL" ? "Todas" : FULFILLMENT_LABELS[type]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={periodId} className="text-sm font-medium text-fg">
          Período dos encerrados
        </label>
        <div className="flex flex-wrap gap-2">
          <select
            id={periodId}
            value={filters.period}
            onChange={(event) => onChange({ period: event.target.value as PeriodKey })}
            className={inputStyles(false, "w-auto min-w-40")}
          >
            {PERIODS.map((period) => (
              <option key={period.key} value={period.key}>
                {period.label}
              </option>
            ))}
          </select>
          {filters.period === "custom" ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor={fromId} className="sr-only">
                  Data inicial
                </label>
                <input
                  id={fromId}
                  type="date"
                  value={filters.from}
                  max={filters.to || undefined}
                  onChange={(event) => onChange({ from: event.target.value })}
                  className={inputStyles(false, "w-auto")}
                />
                <span aria-hidden="true" className="text-muted">
                  a
                </span>
                <label htmlFor={toId} className="sr-only">
                  Data final
                </label>
                <input
                  id={toId}
                  type="date"
                  value={filters.to}
                  min={filters.from || undefined}
                  onChange={(event) => onChange({ to: event.target.value })}
                  className={inputStyles(false, "w-auto")}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
          </div>
    </div>
  );
}
