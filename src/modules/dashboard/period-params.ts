import { resolvePeriod, type PeriodPreset, type ResolvedPeriod } from "@/lib/period";

type RawParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Período a partir da query string, no fuso do restaurante. Sem `preset` usa o
 * padrão da tela; `preset` desconhecido ou personalizado inválido cai em 7 dias.
 */
export function periodFromParams(
  raw: RawParams,
  timezone: string | null,
  defaultPreset: PeriodPreset,
): ResolvedPeriod {
  const preset = firstParam(raw.preset) ?? defaultPreset;
  return resolvePeriod({
    preset,
    timezone,
    from: firstParam(raw.from),
    to: firstParam(raw.to),
  });
}

/** Parâmetros que reconstroem o mesmo período (para links e formulários). */
export function periodQuery(period: ResolvedPeriod): Record<string, string> {
  return period.preset === "custom"
    ? { preset: "custom", from: period.fromDate, to: period.toDate }
    : { preset: period.preset };
}

const DAY_MS = 86_400_000;

function utcDay(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Período imediatamente anterior, com o mesmo número de dias (ex.: 7 dias atrás
 * dos últimos 7 dias; "ontem" para "hoje"). Devolve null se não couber no limite
 * de 366 dias do banco.
 */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod | null {
  const first = utcDay(period.fromDate);
  const days = Math.round((utcDay(period.toDate) - first) / DAY_MS) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const previous = resolvePeriod({
    preset: "custom",
    timezone: period.timezone,
    from: iso(first - days * DAY_MS),
    to: iso(first - DAY_MS),
  });
  return previous.fellBack ? null : previous;
}

/** Texto da comparação: "ontem" quando o período é um único dia, senão "período anterior". */
export function comparisonLabel(period: ResolvedPeriod): string {
  return period.fromDate === period.toDate ? "o dia anterior" : "o período anterior";
}

const shortDate = (ymd: string) => ymd.split("-").reverse().join("/");

/** "Hoje (16/10/2026)" ou "Personalizado (01/10/2026 a 15/10/2026)". */
export function describePeriod(period: ResolvedPeriod): string {
  const range =
    period.fromDate === period.toDate
      ? shortDate(period.fromDate)
      : `${shortDate(period.fromDate)} a ${shortDate(period.toDate)}`;
  return `${period.label} (${range})`;
}
