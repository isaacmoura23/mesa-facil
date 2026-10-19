/** Matemática pura dos gráficos (escala "bonita", rótulos compactos, datas). */

/** Menor valor "redondo" (1, 2, 2.5, 5 x 10^n) >= max, dividido em `steps` marcas. */
export function niceScale(maxValue: number, steps = 4): { max: number; ticks: number[] } {
  if (!(maxValue > 0)) return { max: steps, ticks: Array.from({ length: steps + 1 }, (_, i) => i) };
  const rough = maxValue / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = [1, 2, 2.5, 5, 10].find((f) => normalized <= f) ?? 10;
  const step = factor * magnitude;
  return { max: step * steps, ticks: Array.from({ length: steps + 1 }, (_, i) => step * i) };
}

/** Eixo em reais compactos: "R$ 0", "R$ 250", "R$ 1,2 mil", "R$ 3 mi". Entrada em centavos. */
export function formatAxisCents(cents: number): string {
  const reais = cents / 100;
  const abs = Math.abs(reais);
  const trim = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (abs >= 1_000_000) return `R$ ${trim(reais / 1_000_000)} mi`;
  if (abs >= 1_000) return `R$ ${trim(reais / 1_000)} mil`;
  return `R$ ${trim(reais)}`;
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function parseDay(day: string): { y: number; m: number; d: number; weekday: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "16/10" (eixo). */
export function shortDay(day: string): string {
  const p = parseDay(day);
  return p ? `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}` : day;
}

/** "sex, 16 out 2026" (tooltip, tabela e leitores de tela). */
export function longDay(day: string): string {
  const p = parseDay(day);
  return p ? `${WEEKDAYS[p.weekday]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}` : day;
}
