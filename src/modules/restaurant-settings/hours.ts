/**
 * Horários de funcionamento: tipos, conversões e validação de sobreposição.
 * Funções puras, usadas no navegador (validação imediata) e no servidor
 * (autoridade). `closes < opens` significa virada de dia (ex.: 18:00 às 02:00).
 */

export const WEEKDAYS = [
  { value: 0, label: "Domingo", short: "Dom" },
  { value: 1, label: "Segunda-feira", short: "Seg" },
  { value: 2, label: "Terça-feira", short: "Ter" },
  { value: 3, label: "Quarta-feira", short: "Qua" },
  { value: 4, label: "Quinta-feira", short: "Qui" },
  { value: 5, label: "Sexta-feira", short: "Sex" },
  { value: 6, label: "Sábado", short: "Sáb" },
] as const;

export const MAX_INTERVALS_PER_DAY = 4;

export type Interval = { opens: string; closes: string };
/** Índice = dia da semana (0 = domingo). */
export type WeekHours = Interval[][];

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM:SS" (do Postgres) -> "HH:MM". */
export function trimSeconds(time: string): string {
  return time.slice(0, 5);
}

export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function emptyWeek(): WeekHours {
  return Array.from({ length: 7 }, () => []);
}

export function weekFromRows(
  rows: readonly { weekday: number; opens_at: string; closes_at: string }[],
): WeekHours {
  const week = emptyWeek();
  for (const row of rows) {
    week[row.weekday]?.push({ opens: trimSeconds(row.opens_at), closes: trimSeconds(row.closes_at) });
  }
  for (const day of week) day.sort((a, b) => a.opens.localeCompare(b.opens));
  return week;
}

export function cloneWeek(week: WeekHours): WeekHours {
  return week.map((day) => day.map((interval) => ({ ...interval })));
}

export function sameWeek(a: WeekHours, b: WeekHours): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isOvernight(interval: Interval): boolean {
  return toMinutes(interval.closes) < toMinutes(interval.opens);
}

export function describeInterval(interval: Interval): string {
  return `${interval.opens} às ${interval.closes}${isOvernight(interval) ? " (até o dia seguinte)" : ""}`;
}

const WEEK_MINUTES = 7 * 1440;

/** Intervalo absoluto na semana, em minutos. A virada de dia estende o fim. */
function absoluteRange(weekday: number, interval: Interval): [number, number] {
  const start = weekday * 1440 + toMinutes(interval.opens);
  let end = weekday * 1440 + toMinutes(interval.closes);
  if (end <= start) end += 1440;
  return [start, end];
}

export type WeekProblem = { weekday: number; message: string };

/**
 * Valida a grade semanal: horários válidos, abertura diferente do fechamento,
 * limite de intervalos por dia e SEM sobreposição (inclusive o trecho que
 * passa da meia-noite sobre o dia seguinte, e de sábado para domingo).
 */
export function validateWeek(week: WeekHours): WeekProblem | null {
  const ranges: { weekday: number; start: number; end: number; label: string }[] = [];

  for (const [weekday, intervals] of week.entries()) {
    const dayName = WEEKDAYS[weekday]?.label ?? "Dia";
    if (intervals.length > MAX_INTERVALS_PER_DAY) {
      return { weekday, message: `${dayName}: use no máximo ${MAX_INTERVALS_PER_DAY} intervalos.` };
    }
    for (const interval of intervals) {
      if (!TIME_PATTERN.test(interval.opens) || !TIME_PATTERN.test(interval.closes)) {
        return { weekday, message: `${dayName}: informe a abertura e o fechamento.` };
      }
      if (interval.opens === interval.closes) {
        return { weekday, message: `${dayName}: a abertura e o fechamento não podem ser iguais.` };
      }
      const [start, end] = absoluteRange(weekday, interval);
      ranges.push({ weekday, start, end, label: describeInterval(interval) });
    }
  }

  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      // Compara também com a semana seguinte/anterior (sábado vira domingo).
      for (const shift of [0, WEEK_MINUTES, -WEEK_MINUTES]) {
        if (a.start < b.end + shift && b.start + shift < a.end) {
          const dayName = WEEKDAYS[b.weekday]?.label ?? "Dia";
          const otherName = WEEKDAYS[a.weekday]?.label ?? "Dia";
          return {
            weekday: b.weekday,
            message:
              a.weekday === b.weekday
                ? `${dayName}: os intervalos ${a.label} e ${b.label} se sobrepõem.`
                : `${dayName}: o intervalo ${b.label} se sobrepõe ao de ${otherName} (${a.label}).`,
          };
        }
      }
    }
  }
  return null;
}

export function intervalKey(weekday: number, interval: Interval): string {
  return `${weekday}|${interval.opens}|${interval.closes}`;
}

/** Data local (AAAA-MM-DD) de "agora" em um fuso IANA; recai em São Paulo se inválido. */
export function localDateIn(timezone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(at);
  }
}

export function formatDateBr(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
export function weekdayOf(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
