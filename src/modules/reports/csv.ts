import { formatYmd, textLabel } from "./format";
import type { ReportCell, ReportColumn, ReportData } from "./schemas";

/**
 * CSV dos relatórios: separador ";", BOM UTF-8, vírgula decimal (Excel pt-BR).
 * Os relatórios não contêm dados pessoais (são agregados).
 */

const REASON_MAX = 80;

/** Centavos -> "1234,56" (aritmética inteira, sem ponto flutuante). */
export function centsToCsv(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole},${fraction}`;
}

/** Neutraliza injeção de fórmula (=, +, -, @, tab, CR) e escapa aspas. */
export function csvText(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const safe = /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvNumeric(value: string): string {
  return `"${value}"`;
}

function cellToCsv(column: ReportColumn, value: ReportCell | undefined): string {
  if (value === null || value === undefined || value === "") return '""';
  if (column.type === "cents") return typeof value === "number" ? csvNumeric(centsToCsv(value)) : '""';
  if (column.type === "integer") return typeof value === "number" ? csvNumeric(String(Math.trunc(value))) : '""';
  if (column.type === "date") return csvText(formatYmd(String(value)));
  const text = textLabel(column.key, String(value));
  return csvText(column.key === "reason" ? text.slice(0, REASON_MAX) : text);
}

export function buildReportCsv(data: ReportData): string {
  const lines: string[] = [data.columns.map((column) => csvText(column.label)).join(";")];
  for (const row of data.rows) {
    lines.push(data.columns.map((column) => cellToCsv(column, row[column.key])).join(";"));
  }
  const hasTotals = data.columns.some((column) => data.totals[column.key] !== undefined);
  if (hasTotals) {
    lines.push(
      data.columns
        .map((column, index) => (index === 0 ? csvText("Total") : cellToCsv(column, data.totals[column.key])))
        .join(";"),
    );
  }
  if (data.truncated) {
    lines.push(csvText("Aviso: resultado limitado a 5000 linhas."));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
