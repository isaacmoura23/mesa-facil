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

const shortDate = (ymd: string) => ymd.split("-").reverse().join("/");

/** "Hoje (16/10/2026)" ou "Personalizado (01/10/2026 a 15/10/2026)". */
export function describePeriod(period: ResolvedPeriod): string {
  const range =
    period.fromDate === period.toDate
      ? shortDate(period.fromDate)
      : `${shortDate(period.fromDate)} a ${shortDate(period.toDate)}`;
  return `${period.label} (${range})`;
}
