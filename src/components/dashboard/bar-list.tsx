import { cn } from "@/lib/utils/cn";

export type BarItem = {
  key: string;
  label: string;
  /** Linha secundária (variante, percentual...). */
  detail?: string;
  value: number;
  valueLabel: string;
  /** Cor da barra (CSS); padrão: acento do tema. */
  color?: string;
};

/**
 * Barras horizontais em HTML/CSS. O rótulo e o valor ficam em texto na própria
 * lista (a barra é só reforço visual), então a lista já é a alternativa acessível.
 */
export function BarList({ items, label, className }: { items: BarItem[]; label: string; className?: string }) {
  const max = items.reduce((m, item) => Math.max(m, item.value), 0);
  return (
    <ul aria-label={label} className={cn("flex flex-col gap-4", className)}>
      {items.map((item) => {
        const pct = max > 0 ? Math.max(item.value > 0 ? 1.5 : 0, (item.value / max) * 100) : 0;
        return (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-fg" title={item.label}>
                {item.label}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">{item.valueLabel}</span>
            </div>
            {item.detail ? <p className="mt-0.5 text-xs text-muted">{item.detail}</p> : null}
            <div aria-hidden="true" className="mt-1.5 h-2">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${pct}%`, background: item.color ?? "var(--accent)" }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
