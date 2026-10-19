import { z } from "zod";

export const SEARCH_MAX = 100;
export const PAGE_SIZE = 25;

export const customerIdSchema = z.uuid();

// ---------------------------------------------------------------------------
// Respostas das RPCs `list_customers` e `get_customer`
// ---------------------------------------------------------------------------

export const customerRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  orders_count: z.number(),
  last_order_at: z.string().nullable(),
  total_spent_cents: z.number(),
});
export type CustomerRow = z.infer<typeof customerRowSchema>;

/** Cursor keyset opaco: o banco devolve e valida `{t, id}`. */
export const cursorSchema = z.object({ t: z.string().min(1).max(64), id: z.uuid() }).strict();
export type CustomerCursor = z.infer<typeof cursorSchema>;

export const customerListSchema = z.object({
  rows: z.array(customerRowSchema),
  next_cursor: cursorSchema.nullish().transform((value) => value ?? null),
});
export type CustomerList = z.infer<typeof customerListSchema>;

export const customerDetailSchema = z.object({
  customer: z.object({
    id: z.string(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    created_at: z.string().nullable(),
  }),
  addresses: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      postal_code: z.string().nullable(),
      street: z.string().nullable(),
      number: z.string().nullable(),
      complement: z.string().nullable(),
      neighborhood: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      reference: z.string().nullable(),
      is_default: z.boolean().nullable(),
    }),
  ),
  orders: z.array(
    z.object({
      id: z.string(),
      order_number: z.union([z.number(), z.string()]).nullable(),
      created_at: z.string(),
      fulfillment_type: z.string(),
      status: z.string(),
      total_cents: z.number(),
    }),
  ),
  stats: z.object({
    orders_count: z.number(),
    total_spent_cents: z.number(),
    last_order_at: z.string().nullable(),
  }),
});
export type CustomerDetail = z.infer<typeof customerDetailSchema>;
export type CustomerAddress = CustomerDetail["addresses"][number];
export type CustomerOrder = CustomerDetail["orders"][number];

// ---------------------------------------------------------------------------
// Filtros da URL
// ---------------------------------------------------------------------------

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type CustomerFilters = { q: string; cursor: CustomerCursor | null };

export function encodeCursor(cursor: CustomerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): CustomerCursor | null {
  if (!raw || raw.length > 400) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseCustomerFilters(params: RawParams): CustomerFilters {
  const q = (first(params.q) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, SEARCH_MAX);
  const cursor = decodeCursor(first(params.cursor));
  return { q, cursor };
}

export function customersQuery(q: string, cursor?: CustomerCursor | null): string {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (cursor) qs.set("cursor", encodeCursor(cursor));
  return qs.toString();
}
