"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatCents } from "@/lib/format";
import { formatAxisCents, longDay, niceScale, shortDay } from "@/modules/dashboard/chart-math";

type Point = { day: string; orders: number; sales_cents: number };

const HEIGHT = 248;
const M = { l: 64, r: 12, t: 12, b: 30 };
/** Acima disso as barras ficam finas demais: vira linha com área. */
const MAX_BARS = 45;

function ordersLabel(n: number): string {
  return `${n} ${n === 1 ? "pedido" : "pedidos"}`;
}

function barPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

/**
 * Vendas por dia (barras ou linha). Passe o mouse ou use as setas do teclado
 * (o gráfico recebe foco) para ver cada dia; a tabela abaixo traz os mesmos dados.
 */
export function SalesChart({ series }: { series: Point[] }) {
  const hintId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = series.length;
  const bars = n <= MAX_BARS;
  const innerW = width - M.l - M.r;
  const innerH = HEIGHT - M.t - M.b;
  const base = M.t + innerH;
  const peak = series.reduce((max, p) => Math.max(max, p.sales_cents), 0);
  const scale = niceScale(peak);
  const band = innerW / Math.max(n, 1);

  const xOf = (i: number) => (bars ? M.l + band * (i + 0.5) : M.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1)));
  const yOf = (value: number) => M.t + innerH - (value / scale.max) * innerH;

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));
  const barWidth = Math.max(2, Math.min(band * 0.62, 32));

  const indexAt = (clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return 0;
    const x = clientX - rect.left;
    const raw = bars ? Math.floor((x - M.l) / band) : Math.round(((x - M.l) / innerW) * (n - 1));
    return Math.min(n - 1, Math.max(0, raw));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? n - 1;
    let next = current;
    if (event.key === "ArrowRight") next = Math.min(n - 1, current + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = n - 1;
    else if (event.key === "Escape") return setActive(null);
    else return;
    event.preventDefault();
    setActive(next);
  };

  const point = active !== null ? series[active] : null;
  const activeX = active !== null ? xOf(active) : 0;
  const linePoints = series.map((p, i) => `${xOf(i)},${yOf(p.sales_cents)}`).join(" ");

  return (
    <div>
      <div
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-roledescription="gráfico"
        aria-label="Vendas por dia"
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
          setActive((current) => current ?? n - 1);
        }}
        onBlur={() => {
          setFocused(false);
          setActive(null);
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => setActive(indexAt(event.clientX))}
        onPointerLeave={() => !focused && setActive(null)}
        className="relative select-none rounded-control"
        style={{ height: HEIGHT, touchAction: "pan-y" }}
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true" className="block">
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line x1={M.l} x2={width - M.r} y1={yOf(tick)} y2={yOf(tick)} stroke="var(--line)" strokeWidth={1} />
              <text x={M.l - 8} y={yOf(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">
                {formatAxisCents(tick)}
              </text>
            </g>
          ))}

          {active !== null && bars ? (
            <rect x={M.l + band * active} y={M.t} width={band} height={innerH} fill="var(--surface-2)" />
          ) : null}

          {bars
            ? series.map((p, i) =>
                p.sales_cents > 0 ? (
                  <path
                    key={p.day}
                    d={barPath(xOf(i) - barWidth / 2, yOf(p.sales_cents), barWidth, base)}
                    fill="var(--accent)"
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                ) : null,
              )
            : n > 0 && (
                <>
                  <polygon points={`${xOf(0)},${base} ${linePoints} ${xOf(n - 1)},${base}`} fill="var(--accent)" opacity={0.12} />
                  <polyline points={linePoints} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
                </>
              )}

          <line x1={M.l} x2={width - M.r} y1={base} y2={base} stroke="var(--line-strong)" strokeWidth={1} />

          {series.map((p, i) =>
            i % labelEvery === 0 ? (
              <text key={p.day} x={xOf(i)} y={base + 18} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {shortDay(p.day)}
              </text>
            ) : null,
          )}

          {point && !bars ? (
            <g>
              <line x1={activeX} x2={activeX} y1={M.t} y2={base} stroke="var(--line-strong)" strokeWidth={1} />
              <circle cx={activeX} cy={yOf(point.sales_cents)} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          ) : null}
        </svg>

        {point ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1 z-10 w-max max-w-[14rem] rounded-control border border-line-strong bg-surface px-3 py-2 text-xs shadow-pop"
            style={{
              left: activeX,
              transform: `translateX(${activeX > width * 0.6 ? "calc(-100% - 10px)" : "10px"})`,
            }}
          >
            <p className="font-medium text-fg">{longDay(point.day)}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums text-fg">{formatCents(point.sales_cents)}</p>
            <p className="text-muted">{ordersLabel(point.orders)}</p>
          </div>
        ) : null}
      </div>

      <p id={hintId} className="mt-2 text-xs text-muted">
        Passe o mouse sobre o gráfico ou, com ele focado, use as setas do teclado para ver cada dia.
      </p>
      <p className="sr-only" aria-live="polite">
        {focused && point ? `${longDay(point.day)}: ${formatCents(point.sales_cents)}, ${ordersLabel(point.orders)}` : ""}
      </p>

      <details className="mt-4 rounded-control border border-line">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-fg">
          Ver dados em tabela
        </summary>
        <div className="max-h-72 overflow-auto border-t border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">Vendas e pedidos por dia no período (pedidos cancelados e recusados não entram)</caption>
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Dia
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Pedidos
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Vendas
                </th>
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.day} className="border-t border-line">
                  <th scope="row" className="px-4 py-2 text-left font-normal text-fg">
                    {longDay(p.day)}
                  </th>
                  <td className="px-4 py-2 text-right tabular-nums text-fg">{p.orders}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg">{formatCents(p.sales_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
