import Link from "next/link";
import { Download } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import { PERIOD_PRESETS } from "@/lib/period";
import { REPORT_GROUPS, REPORT_KEYS, REPORTS } from "@/modules/reports/catalog";
import { reportQuery, type ReportFilters } from "@/modules/reports/schemas";

const labelClass = "text-sm font-medium text-fg";

/** Seletor dos relatórios: links que preservam o período e o agrupamento. */
export function ReportPicker({ slug, filters }: { slug: string; filters: ReportFilters }) {
  return (
    <nav aria-label="Relatórios" className="mb-5">
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
        {REPORT_KEYS.map((key) => {
          const active = key === filters.report;
          return (
            <li key={key} className="shrink-0">
              <Link
                href={`/app/${slug}/relatorios?${reportQuery(filters, { report: key })}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center rounded-control border px-3 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "border-accent bg-accent-soft text-accent-soft-fg"
                    : "border-line bg-surface text-fg hover:bg-surface-2",
                )}
              >
                {REPORTS[key].label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Filtros por GET (funcionam sem JavaScript e ficam na URL). */
export function ReportFilterForm({ slug, filters }: { slug: string; filters: ReportFilters }) {
  const { period, report } = filters;
  const grouped = REPORTS[report].grouped;
  return (
    <form
      method="get"
      aria-label="Filtros do relatório"
      className="mb-5 grid grid-cols-1 gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
    >
      <input type="hidden" name="report" value={report} />
      <div className="flex flex-col gap-2">
        <label htmlFor="r-preset" className={labelClass}>
          Período
        </label>
        <select id="r-preset" name="preset" defaultValue={period.preset} className={inputStyles()}>
          {PERIOD_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="r-from" className={labelClass}>
          De (personalizado)
        </label>
        <input id="r-from" type="date" name="from" defaultValue={period.fromDate} className={inputStyles()} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="r-to" className={labelClass}>
          Até (personalizado)
        </label>
        <input id="r-to" type="date" name="to" defaultValue={period.toDate} className={inputStyles()} />
      </div>
      {grouped ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="r-group" className={labelClass}>
            Agrupar
          </label>
          <select id="r-group" name="group" defaultValue={filters.group} className={inputStyles()}>
            {REPORT_GROUPS.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="hidden lg:block" aria-hidden="true" />
      )}
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
        <button type="submit" className={buttonStyles({ variant: "primary", className: "flex-1 lg:flex-none" })}>
          Aplicar
        </button>
        <a
          href={`/app/${slug}/relatorios/export?${reportQuery(filters)}`}
          download
          className={buttonStyles({ variant: "secondary", className: "flex-1 lg:flex-none" })}
        >
          <Download aria-hidden="true" className="size-4" />
          CSV
          <span className="sr-only"> do relatório com o período e o agrupamento atuais</span>
        </a>
      </div>
      <p className="text-sm text-muted sm:col-span-2 lg:col-span-full">
        As datas só valem quando o período é &quot;Personalizado&quot; (até 366 dias). Horários no fuso do
        restaurante ({period.timezone}).
      </p>
    </form>
  );
}
