"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type MouseEvent } from "react";
import { Spinner } from "@/components/ui/spinner";
import { buttonStyles } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";

const PRESETS = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "month", label: "Este mês" },
] as const;

const MAX_DAYS = 366;

type Props = {
  basePath: string;
  preset: string;
  fromDate: string;
  toDate: string;
  /** Texto do período efetivo, ex.: "Últimos 7 dias (10/10/2026 a 16/10/2026)". */
  summary: string;
  /** O período personalizado informado era inválido e caiu em 7 dias. */
  fellBack: boolean;
  /** Outros parâmetros preservados ao trocar o período (filtros da tela). */
  extra?: Record<string, string>;
};

function href(basePath: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${basePath}?${query}` : basePath;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Filtro de período por GET: os atalhos são links e o formulário personalizado
 * funciona sem JavaScript. Com JavaScript a troca é uma transição (a tela
 * antiga continua visível) e o resultado é anunciado em uma região aria-live.
 */
export function PeriodFilter({ basePath, preset, fromDate, toDate, summary, fellBack, extra = {} }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [from, setFrom] = useState(fromDate);
  const [to, setTo] = useState(toDate);
  const [error, setError] = useState<string | null>(null);

  const go = (params: Record<string, string>) => startTransition(() => router.push(href(basePath, params)));

  const onPreset = (event: MouseEvent<HTMLAnchorElement>, value: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setError(null);
    go({ ...extra, preset: value });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!from || !to) return setError("Informe a data inicial e a data final.");
    if (to < from) return setError("A data final deve ser igual ou posterior à inicial.");
    if (daysBetween(from, to) > MAX_DAYS) return setError(`O período pode ter no máximo ${MAX_DAYS} dias.`);
    setError(null);
    go({ ...extra, preset: "custom", from, to });
  };

  const chip =
    "inline-flex h-9 items-center rounded-control border px-3 text-sm font-medium transition-colors select-none";

  return (
    <section aria-label="Período" className="mb-6 rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((item) => {
          const active = preset === item.value;
          return (
            <a
              key={item.value}
              href={href(basePath, { ...extra, preset: item.value })}
              onClick={(event) => onPreset(event, item.value)}
              aria-current={active ? "true" : undefined}
              className={cn(
                chip,
                active
                  ? "border-transparent bg-accent text-accent-fg"
                  : "border-line-strong bg-surface text-fg hover:bg-surface-2",
              )}
            >
              {item.label}
            </a>
          );
        })}
        <button
          type="button"
          onClick={() => setCustomOpen((open) => !open)}
          aria-expanded={customOpen}
          aria-controls="period-custom"
          className={cn(
            chip,
            preset === "custom"
              ? "border-transparent bg-accent text-accent-fg"
              : "border-line-strong bg-surface text-fg hover:bg-surface-2",
          )}
        >
          Personalizado
        </button>
        {pending ? <Spinner decorative className="ml-1 text-muted" /> : null}
      </div>

      <form
        id="period-custom"
        method="get"
        action={basePath}
        onSubmit={onSubmit}
        hidden={!customOpen}
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[repeat(2,minmax(0,12rem))_auto] sm:items-end"
      >
        {Object.entries(extra).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <input type="hidden" name="preset" value="custom" />
        <div className="flex flex-col gap-2">
          <label htmlFor="period-from" className="text-sm font-medium text-fg">
            De
          </label>
          <input
            id="period-from"
            name="from"
            type="date"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={inputStyles(Boolean(error))}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="period-to" className="text-sm font-medium text-fg">
            Até
          </label>
          <input
            id="period-to"
            name="to"
            type="date"
            required
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={inputStyles(Boolean(error))}
          />
        </div>
        <button type="submit" className={buttonStyles({ variant: "primary" })}>
          Aplicar período
        </button>
        {error ? (
          <p role="alert" className="text-sm text-danger sm:col-span-3">
            {error}
          </p>
        ) : null}
      </form>

      <p className="mt-3 text-sm text-muted">
        Período: <span className="font-medium text-fg">{summary}</span>
        <span className="sr-only"> (horário do restaurante)</span>
      </p>
      {fellBack ? (
        <p className="mt-1 text-sm text-warning-soft-fg">
          O período personalizado informado é inválido (use datas existentes e até {MAX_DAYS} dias). Mostrando os
          últimos 7 dias.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Atualizando os dados…" : `Período exibido: ${summary}`}
      </p>
    </section>
  );
}
