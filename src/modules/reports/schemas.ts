import { z } from "zod";
import { isPeriodPreset, resolvePeriod, type ResolvedPeriod } from "@/lib/period";
import {
  DEFAULT_REPORT,
  REPORTS,
  isReportGroup,
  isReportKey,
  type ReportGroup,
  type ReportKey,
} from "./catalog";

// ---------------------------------------------------------------------------
// Resposta da RPC `restaurant_report`
// ---------------------------------------------------------------------------

const cellSchema = z.union([z.string(), z.number(), z.null()]);
export type ReportCell = z.infer<typeof cellSchema>;

export const reportColumnTypeSchema = z.enum(["date", "integer", "cents", "text"]).catch("text");
export type ReportColumnType = z.infer<typeof reportColumnTypeSchema>;

export const reportResponseSchema = z.object({
  report: z.string(),
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: reportColumnTypeSchema })),
  rows: z.array(z.record(z.string(), cellSchema)),
  totals: z
    .record(z.string(), cellSchema)
    .nullish()
    .transform((value) => value ?? {}),
  truncated: z.boolean().catch(false),
});
export type ReportData = z.infer<typeof reportResponseSchema>;
export type ReportColumn = ReportData["columns"][number];
export type ReportRow = ReportData["rows"][number];

// ---------------------------------------------------------------------------
// Filtros (query string, tolerantes: valor inválido cai no padrão com aviso)
// ---------------------------------------------------------------------------

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type ReportFilters = {
  report: ReportKey;
  /** Agrupamento efetivo (sempre `day` quando o relatório não agrupa). */
  group: ReportGroup;
  period: ResolvedPeriod;
  warnings: string[];
};

export function parseReportFilters(params: RawParams, timezone: string): ReportFilters {
  const warnings: string[] = [];

  const rawReport = first(params.report);
  let report: ReportKey = DEFAULT_REPORT;
  if (rawReport) {
    if (isReportKey(rawReport)) report = rawReport;
    else warnings.push(`Relatório desconhecido. Mostrando "${REPORTS[DEFAULT_REPORT].label}".`);
  }

  const rawGroup = first(params.group);
  let group: ReportGroup = "day";
  if (rawGroup) {
    if (isReportGroup(rawGroup)) group = rawGroup;
    else warnings.push("Agrupamento inválido. Usando agrupamento por dia.");
  }

  const rawPreset = first(params.preset);
  const period = resolvePeriod({
    preset: rawPreset,
    timezone,
    from: first(params.from),
    to: first(params.to),
  });
  if (period.fellBack) {
    warnings.push(
      "Período personalizado inválido (informe datas válidas, com início antes do fim e até 366 dias). Mostrando os últimos 7 dias.",
    );
  } else if (rawPreset && !isPeriodPreset(rawPreset)) {
    warnings.push("Período desconhecido. Mostrando os últimos 7 dias.");
  }

  return { report, group: REPORTS[report].grouped ? group : "day", period, warnings };
}

/** Query string canônica dos filtros (links, CSV). */
export function reportQuery(filters: ReportFilters, override: { report?: ReportKey } = {}): string {
  const report = override.report ?? filters.report;
  const qs = new URLSearchParams();
  qs.set("report", report);
  qs.set("preset", filters.period.preset);
  if (filters.period.preset === "custom") {
    qs.set("from", filters.period.fromDate);
    qs.set("to", filters.period.toDate);
  }
  if (REPORTS[report].grouped && filters.group !== "day") qs.set("group", filters.group);
  return qs.toString();
}
