import { z } from "zod";
import { entityIdSchema } from "./schemas";

// Cursor keyset (opened_at desc, id desc), opaco para o cliente.
const cursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)$/),
  id: entityIdSchema,
});
export type TabCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: TabCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): TabCursor | null {
  if (!raw) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
