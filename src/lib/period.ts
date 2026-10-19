/**
 * Períodos de relatório no fuso do restaurante.
 * Retorna janelas [from, to) em UTC (ISO) prontas para as RPCs `dashboard_metrics` e `restaurant_report`.
 * Limite máximo de 366 dias (mesmo do banco); entrada inválida cai no preset de 7 dias.
 */
export type PeriodPreset = "today" | "yesterday" | "7d" | "30d" | "month" | "custom";

export const PERIOD_PRESETS: readonly { value: PeriodPreset; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "month", label: "Este mês" },
  { value: "custom", label: "Personalizado" },
];

export const MAX_PERIOD_DAYS = 366;
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export type ResolvedPeriod = {
  preset: PeriodPreset;
  label: string;
  timezone: string;
  /** Início inclusivo, UTC. */
  from: Date;
  /** Fim exclusivo, UTC. */
  to: Date;
  fromIso: string;
  toIso: string;
  /** Datas locais (YYYY-MM-DD) inclusivas, para exibir e repopular formulários. */
  fromDate: string;
  toDate: string;
  /** Preset personalizado inválido caiu em 7 dias. */
  fellBack: boolean;
};

type Ymd = { y: number; m: number; d: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function safeTimezone(tz: string | null | undefined): string {
  const candidate = tz && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Offset (ms) do fuso em um instante: horário local = UTC + offset. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Meia-noite local do dia (y,m,d) no fuso, convertida para UTC. */
function zonedStartOfDay({ y, m, d }: Ymd, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = tzOffsetMs(new Date(guess), tz);
  let utc = guess - first;
  const second = tzOffsetMs(new Date(utc), tz);
  if (second !== first) utc = guess - second;
  return new Date(utc);
}

function todayIn(tz: string, now: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function pad(n: number, size = 2): string {
  return String(n).padStart(size, "0");
}

function fmt({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function parseYmd(value: string | null | undefined): Ymd | null {
  const match = value ? DATE_RE.exec(value) : null;
  if (!match) return null;
  const ymd = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  const check = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  if (check.getUTCFullYear() !== ymd.y || check.getUTCMonth() + 1 !== ymd.m || check.getUTCDate() !== ymd.d) return null;
  return ymd;
}

function dayCount(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === "string" && PERIOD_PRESETS.some((p) => p.value === value);
}

export function resolvePeriod(input: {
  preset?: string | null;
  timezone?: string | null;
  /** YYYY-MM-DD, só para `custom`. */
  from?: string | null;
  to?: string | null;
  now?: Date;
}): ResolvedPeriod {
  const timezone = safeTimezone(input.timezone);
  const now = input.now ?? new Date();
  const today = todayIn(timezone, now);
  let preset: PeriodPreset = isPeriodPreset(input.preset) ? input.preset : "7d";
  let fellBack = false;
  let first: Ymd;
  let last: Ymd; // inclusivo

  if (preset === "custom") {
    const f = parseYmd(input.from);
    const t = parseYmd(input.to);
    if (f && t && dayCount(f, t) >= 0 && dayCount(f, t) + 1 <= MAX_PERIOD_DAYS) {
      first = f;
      last = t;
    } else {
      preset = "7d";
      fellBack = true;
      first = addDays(today, -6);
      last = today;
    }
  } else if (preset === "today") {
    first = today;
    last = today;
  } else if (preset === "yesterday") {
    first = addDays(today, -1);
    last = first;
  } else if (preset === "30d") {
    first = addDays(today, -29);
    last = today;
  } else if (preset === "month") {
    first = { y: today.y, m: today.m, d: 1 };
    last = today;
  } else {
    first = addDays(today, -6);
    last = today;
  }

  const from = zonedStartOfDay(first, timezone);
  const to = zonedStartOfDay(addDays(last, 1), timezone);
  const label = PERIOD_PRESETS.find((p) => p.value === preset)?.label ?? "Período";
  return {
    preset,
    label,
    timezone,
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    fromDate: fmt(first),
    toDate: fmt(last),
    fellBack,
  };
}
