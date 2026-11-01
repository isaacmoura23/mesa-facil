import { z } from "zod";
import { isRealCalendarDate } from "@/lib/validation/date";

/**
 * Schemas de entrada. Nenhum recebe `restaurant_id`: o restaurante sempre vem
 * do guard (slug -> memberships do usuário).
 */

export const TABLE_NAME_MAX = 40;
export const TABLE_CAPACITY_MAX = 50;

export const slugSchema = z.string().trim().min(1).max(63);
export const entityIdSchema = z.uuid("Identificador inválido. Atualize a página e tente de novo.");

export const tableFormSchema = z.object({
  name: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(1, "Informe o nome da mesa.")
        .max(TABLE_NAME_MAX, `O nome deve ter no máximo ${TABLE_NAME_MAX} caracteres.`),
    ),
  capacity: z
    .string()
    .trim()
    .min(1, "Informe a capacidade.")
    .regex(/^\d+$/, "Use apenas números inteiros.")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, "A capacidade mínima é 1 lugar.")
        .max(TABLE_CAPACITY_MAX, `A capacidade máxima é ${TABLE_CAPACITY_MAX} lugares.`),
    ),
});
export type TableFormInput = z.input<typeof tableFormSchema>;

/** Primeira mensagem de erro por campo. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filtros e paginação das comandas
// ---------------------------------------------------------------------------

export const TAB_PAGE_SIZE = 25;
export const CSV_MAX_ROWS = 5000;

export type TabFilters = {
  /** `ALL` = abertas e fechadas (e canceladas). */
  status: "ALL" | "OPEN" | "CLOSED" | "CANCELLED";
  /** Datas (YYYY-MM-DD, fuso de São Paulo) sobre a abertura. */
  from: string | null;
  to: string | null;
  /** UUID de mesa, `none` (sem mesa/balcão) ou `null` (todas). */
  table: string | null;
};

export const EMPTY_FILTERS: TabFilters = { status: "ALL", from: null, to: null, table: null };

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // Data de calendário real: "2026-02-30" rolaria para março e o Postgres recusaria o filtro (F-40).
  .refine(isRealCalendarDate);

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Interpreta a query string de forma tolerante: valor inválido é ignorado. */
export function parseTabFilters(params: RawParams): TabFilters {
  const status = z.enum(["ALL", "OPEN", "CLOSED", "CANCELLED"]).safeParse(first(params.status));
  const from = dateSchema.safeParse(first(params.from));
  const to = dateSchema.safeParse(first(params.to));
  const rawTable = first(params.table);
  const table =
    rawTable === "none" ? "none" : entityIdSchema.safeParse(rawTable).success ? (rawTable ?? null) : null;
  return {
    status: status.success ? status.data : "ALL",
    from: from.success ? from.data : null,
    to: to.success ? to.data : null,
    table,
  };
}

/** Filtros -> query string (sem `?`), usada em links, paginação e exportação. */
export function filtersToQuery(filters: TabFilters, extra: Record<string, string | null> = {}): string {
  const query = new URLSearchParams();
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.table) query.set("table", filters.table);
  for (const [key, value] of Object.entries(extra)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}
