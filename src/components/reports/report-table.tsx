import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { REPORTS, type ReportGroup, type ReportKey } from "@/modules/reports/catalog";
import { formatCell, formatInt, numberOf } from "@/modules/reports/format";
import type { ReportData } from "@/modules/reports/schemas";

/** Linhas exibidas na tela; o CSV traz o relatório completo. */
export const DISPLAY_ROW_LIMIT = 300;

type Tile = { label: string; value: string };

function summaryTiles(report: ReportKey, data: ReportData): Tile[] {
  const { totals, columns } = data;
  if (report === "cancellations") {
    return [
      { label: "Cancelados", value: formatInt(numberOf(totals.cancelled_count)) },
      { label: "Recusados", value: formatInt(numberOf(totals.rejected_count)) },
      { label: "Valor perdido", value: formatCents(numberOf(totals.lost_sales_cents)) },
    ];
  }
  return columns
    .filter((column) => (column.type === "cents" || column.type === "integer") && typeof totals[column.key] === "number")
    .slice(0, 4)
    .map((column) => ({
      label: column.label,
      value: column.type === "cents" ? formatCents(numberOf(totals[column.key])) : formatInt(numberOf(totals[column.key])),
    }));
}

export function ReportSummary({ report, data }: { report: ReportKey; data: ReportData }) {
  const tiles = summaryTiles(report, data);
  if (tiles.length === 0) return null;
  return (
    <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
          <dt className="text-xs font-medium text-muted">{tile.label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-fg sm:text-xl">{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReportTable({
  report,
  data,
  group,
  periodLabel,
}: {
  report: ReportKey;
  data: ReportData;
  group: ReportGroup;
  periodLabel: string;
}) {
  const { columns, rows, totals } = data;
  const shown = rows.slice(0, DISPLAY_ROW_LIMIT);
  const hasTotals = columns.some((column) => totals[column.key] !== undefined);
  const numeric = (type: string) => type === "cents" || type === "integer";
  const cellBase = "px-3 py-2.5 text-sm whitespace-nowrap";

  return (
    <div>
      <div
        role="region"
        aria-label={`Tabela: ${REPORTS[report].label}`}
        tabIndex={0}
        className="overflow-x-auto rounded-card border border-line bg-surface shadow-card"
      >
        <table className="w-full min-w-max border-collapse">
          <caption className="sr-only">
            {REPORTS[report].label}, {periodLabel}
          </caption>
          <thead>
            <tr className="border-b border-line-strong bg-surface-2">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "px-3 py-2.5 text-xs font-semibold text-muted",
                    numeric(column.type) ? "text-right" : "text-left",
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((row, index) => (
              <tr key={index} className="hover:bg-surface-2">
                {columns.map((column, columnIndex) => {
                  const text = formatCell(column, row[column.key], group);
                  const className = cn(
                    cellBase,
                    numeric(column.type) ? "text-right tabular-nums" : "text-left",
                    "text-fg",
                    column.key === "reason" && "max-w-[28rem] truncate",
                  );
                  return columnIndex === 0 ? (
                    <th key={column.key} scope="row" className={cn(className, "font-medium")}>
                      {text}
                    </th>
                  ) : (
                    <td key={column.key} className={className} title={column.key === "reason" ? text : undefined}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {hasTotals ? (
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-surface-2 font-semibold">
                {columns.map((column, columnIndex) => {
                  const className = cn(
                    cellBase,
                    "text-fg",
                    numeric(column.type) ? "text-right tabular-nums" : "text-left",
                  );
                  return columnIndex === 0 ? (
                    <th key={column.key} scope="row" className={className}>
                      Total
                    </th>
                  ) : (
                    <td key={column.key} className={className}>
                      {totals[column.key] === undefined ? "" : formatCell(column, totals[column.key], group)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {rows.length > shown.length ? (
        <p className="mt-2 text-sm text-muted">
          Exibindo as primeiras {formatInt(shown.length)} de {formatInt(rows.length)} linhas. O CSV traz todas.
        </p>
      ) : null}
    </div>
  );
}
