"use client";

import { useId, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  STATUS_LABELS,
  type FulfillmentType,
  type OrderStatus,
} from "@/modules/operations/types";
import { DEFAULT_HISTORY_FILTERS, PERIOD_LABELS, type HistoryFilters, type HistoryPeriod } from "./history-model";

type HistoryFiltersProps = {
  applied: HistoryFilters;
  onApply: (filters: HistoryFilters) => void;
};

const PERIODS = Object.keys(PERIOD_LABELS) as HistoryPeriod[];

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Filtros em rascunho: só valem ao clicar em "Aplicar" (evita uma consulta por tecla). */
export function HistoryFiltersForm({ applied, onApply }: HistoryFiltersProps) {
  const [draft, setDraft] = useState<HistoryFilters>(applied);
  const ids = { period: useId(), from: useId(), to: useId(), fulfillment: useId(), status: useId(), number: useId() };
  const invalidRange = draft.period === "custom" && (!draft.from || (draft.to !== "" && draft.to < draft.from));

  function patch(change: Partial<HistoryFilters>) {
    setDraft((current) => ({ ...current, ...change }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalidRange) return;
    onApply({ ...draft, number: draft.number.replace(/\D/g, "").slice(0, 9) });
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Filtros do histórico"
      className="grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-6"
    >
      <Field label="Período" htmlFor={ids.period}>
        <select
          id={ids.period}
          value={draft.period}
          onChange={(event) => patch({ period: event.target.value as HistoryPeriod })}
          className={inputStyles()}
        >
          {PERIODS.map((key) => (
            <option key={key} value={key}>
              {PERIOD_LABELS[key]}
            </option>
          ))}
        </select>
      </Field>
      {draft.period === "custom" ? (
        <>
          <Field label="De" htmlFor={ids.from}>
            <input
              id={ids.from}
              type="date"
              value={draft.from}
              onChange={(event) => patch({ from: event.target.value })}
              aria-invalid={invalidRange || undefined}
              className={inputStyles(invalidRange)}
            />
          </Field>
          <Field label="Até" htmlFor={ids.to}>
            <input
              id={ids.to}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => patch({ to: event.target.value })}
              className={inputStyles(invalidRange)}
            />
          </Field>
        </>
      ) : null}
      <Field label="Modalidade" htmlFor={ids.fulfillment}>
        <select
          id={ids.fulfillment}
          value={draft.fulfillment}
          onChange={(event) => patch({ fulfillment: event.target.value as FulfillmentType | "ALL" })}
          className={inputStyles()}
        >
          <option value="ALL">Todas</option>
          {FULFILLMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {FULFILLMENT_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Estado" htmlFor={ids.status}>
        <select
          id={ids.status}
          value={draft.status}
          onChange={(event) => patch({ status: event.target.value as OrderStatus | "ALL" })}
          className={inputStyles()}
        >
          <option value="ALL">Todos</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Número do pedido" htmlFor={ids.number}>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            id={ids.number}
            inputMode="numeric"
            autoComplete="off"
            value={draft.number}
            onChange={(event) => patch({ number: event.target.value.replace(/\D/g, "").slice(0, 9) })}
            placeholder="Ex.: 128"
            className={inputStyles(false, "pl-9")}
          />
        </div>
      </Field>
      <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-1">
        <Button type="submit" size="md" className="flex-1" disabled={invalidRange}>
          Aplicar
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            setDraft(DEFAULT_HISTORY_FILTERS);
            onApply(DEFAULT_HISTORY_FILTERS);
          }}
        >
          Limpar
        </Button>
      </div>
      {invalidRange ? (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2 xl:col-span-6">
          Informe a data inicial. A data final não pode ser anterior à inicial.
        </p>
      ) : null}
    </form>
  );
}
