"use server";

import { revalidatePath } from "next/cache";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { GENERIC_ERROR_MESSAGE, planErrorMessage, RPC_ERROR_MESSAGES } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { getTableHistory, sortTables } from "./queries";
import {
  entityIdSchema,
  fieldErrorsOf,
  slugSchema,
  tableFormSchema,
  type TableFormInput,
} from "./schemas";
import { tableRowSchema, type ActionResult, type Result, type TableHistoryEntry } from "./types";
import { z } from "zod";

/**
 * Server Actions do cadastro de mesas (e leitura do histórico de uma mesa).
 *
 * Autorização: TODA ação resolve o restaurante pelo guard
 * (`requireRestaurantAccess`), a partir do slug; nenhum `restaurant_id` vem do
 * cliente. As escritas usam o cliente Supabase do usuário, então a RLS e as
 * RPCs (`set_table_status`) também validam. O estado operacional da mesa
 * (OCCUPIED/CLEANING) nunca é alterado aqui.
 */

type Context = { restaurantId: string; slug: string; supabase: AppSupabaseClient };
type Failure = Extract<ActionResult, { ok: false }>;
type Authorization = { ok: true; ctx: Context } | { ok: false; result: Failure };

const NOT_CONFIGURED: Failure = {
  ok: false,
  message: "O Supabase ainda não está configurado neste ambiente.",
};

async function authorize(
  slug: string,
  permission: "tables.manage" | "tables.view",
): Promise<Authorization> {
  if (!getPublicEnvStatus().ok) return { ok: false, result: NOT_CONFIGURED };
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return { ok: false, result: { ok: false, message: "Restaurante inválido." } };
  const access = await requireRestaurantAccess(parsed.data, { area: "app", permission });
  const supabase = await createClient();
  return {
    ok: true,
    ctx: { restaurantId: access.restaurant.restaurant_id, slug: access.restaurant.slug, supabase },
  };
}

type DbError = { message?: string; code?: string } | null | undefined;

const HAS_OPEN_TAB_MESSAGE =
  "Esta mesa tem uma comanda aberta. Feche ou cancele a comanda (a equipe faz isso na Operação) antes de inativar a mesa.";
const HAS_HISTORY_MESSAGE =
  "Esta mesa já tem histórico de uso e não pode ser excluída. Inative em vez de excluir.";

/** Converte erros do banco/RPC em mensagens PT-BR. Mensagens cruas nunca saem daqui. */
function failure(error: DbError, fallback: string = GENERIC_ERROR_MESSAGE): Failure {
  const planMessage = planErrorMessage(error);
  if (planMessage) return { ok: false, message: planMessage };
  const code = error?.code;
  const message = error?.message ?? "";
  if (message.includes("TABLE_HAS_OPEN_TAB")) return { ok: false, message: HAS_OPEN_TAB_MESSAGE };
  if (message.includes("TABLE_INVALID_TRANSITION")) {
    return {
      ok: false,
      message: "A mesa está em uso pela equipe e não pode mudar para esse estado agora. Atualize a página.",
    };
  }
  if (message.includes("TABLE_NOT_FOUND")) {
    return { ok: false, message: "Mesa não encontrada. Ela pode ter sido removida; atualize a página." };
  }
  if (code === "42501" || message.includes("FORBIDDEN")) {
    return { ok: false, message: RPC_ERROR_MESSAGES.forbidden };
  }
  if (code === "PGRST301" || code === "PGRST303") {
    return { ok: false, message: RPC_ERROR_MESSAGES.not_authenticated };
  }
  if (code === "23505") {
    return {
      ok: false,
      message: "Já existe uma mesa com esse nome.",
      fieldErrors: { name: "Já existe uma mesa com esse nome." },
    };
  }
  if (code === "23503") return { ok: false, message: HAS_HISTORY_MESSAGE };
  if (code === "23514") {
    return { ok: false, message: "Nome ou capacidade não aceitos. Revise os campos e tente de novo." };
  }
  return { ok: false, message: fallback };
}

function revalidateTables(ctx: Context): void {
  revalidatePath(`/app/${ctx.slug}/mesas`);
  revalidatePath(`/operacao/${ctx.slug}/mesas`);
}

/** Casa o nome sem diferenciar maiúsculas (o banco só barra duplicatas exatas). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function nameTaken(ctx: Context, name: string, exceptId?: string): Promise<boolean> {
  let query = ctx.supabase
    .from("restaurant_tables")
    .select("id", { head: true, count: "exact" })
    .eq("restaurant_id", ctx.restaurantId)
    .ilike("name", escapeLike(name));
  if (exceptId) query = query.neq("id", exceptId);
  const { count } = await query;
  return (count ?? 0) > 0;
}

const NAME_TAKEN: Failure = {
  ok: false,
  message: "Já existe uma mesa com esse nome.",
  fieldErrors: { name: "Já existe uma mesa com esse nome." },
};

export async function createTableAction(slug: string, input: TableFormInput): Promise<ActionResult> {
  const auth = await authorize(slug, "tables.manage");
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = tableFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos do formulário.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  if (await nameTaken(ctx, parsed.data.name)) return NAME_TAKEN;

  // Nova mesa vai para o fim da ordem de exibição.
  const last = await ctx.supabase
    .from("restaurant_tables")
    .select("sort_order")
    .eq("restaurant_id", ctx.restaurantId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const lastOrder = z.array(z.object({ sort_order: z.number() })).catch([]).parse(last.data)[0]?.sort_order ?? 0;

  // `qr_token` nunca é enviado: é gerado no servidor (F-03).
  const { error } = await ctx.supabase.from("restaurant_tables").insert({
    restaurant_id: ctx.restaurantId,
    name: parsed.data.name,
    capacity: parsed.data.capacity,
    sort_order: lastOrder + 1,
  });
  if (error) return failure(error);

  revalidateTables(ctx);
  return { ok: true, message: "Mesa criada." };
}

export async function updateTableAction(
  slug: string,
  tableId: string,
  input: TableFormInput,
): Promise<ActionResult> {
  const auth = await authorize(slug, "tables.manage");
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(tableId);
  if (!id.success) return { ok: false, message: id.error.issues[0]?.message ?? "Mesa inválida." };
  const parsed = tableFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos do formulário.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  if (await nameTaken(ctx, parsed.data.name, id.data)) return NAME_TAKEN;

  const { data, error } = await ctx.supabase
    .from("restaurant_tables")
    .update({ name: parsed.data.name, capacity: parsed.data.capacity })
    .eq("restaurant_id", ctx.restaurantId)
    .eq("id", id.data)
    .select("id");
  if (error) return failure(error);
  if (!data || data.length === 0) {
    return { ok: false, message: "Mesa não encontrada. Ela pode ter sido removida; atualize a página." };
  }

  revalidateTables(ctx);
  return { ok: true, message: "Mesa atualizada." };
}

/** Inativa (AVAILABLE -> INACTIVE) ou reativa (INACTIVE -> AVAILABLE) via RPC. */
export async function setTableActiveAction(
  slug: string,
  tableId: string,
  active: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug, "tables.manage");
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(tableId);
  if (!id.success) return { ok: false, message: id.error.issues[0]?.message ?? "Mesa inválida." };

  if (!active) {
    // Mensagem clara antes de chegar à RPC (que também bloqueia).
    const open = await ctx.supabase
      .from("tabs")
      .select("id", { head: true, count: "exact" })
      .eq("restaurant_id", ctx.restaurantId)
      .eq("table_id", id.data)
      .eq("status", "OPEN");
    if ((open.count ?? 0) > 0) return { ok: false, message: HAS_OPEN_TAB_MESSAGE };
  }

  const { error } = await ctx.supabase.rpc("set_table_status", {
    p_table: id.data,
    p_to: active ? "AVAILABLE" : "INACTIVE",
  });
  if (error) return failure(error);

  revalidateTables(ctx);
  return { ok: true, message: active ? "Mesa reativada." : "Mesa inativada." };
}

/** Exclui uma mesa INACTIVE sem histórico (a RLS também exige INACTIVE). */
export async function deleteTableAction(slug: string, tableId: string): Promise<ActionResult> {
  const auth = await authorize(slug, "tables.manage");
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(tableId);
  if (!id.success) return { ok: false, message: id.error.issues[0]?.message ?? "Mesa inválida." };

  const current = await ctx.supabase
    .from("restaurant_tables")
    .select("status")
    .eq("restaurant_id", ctx.restaurantId)
    .eq("id", id.data)
    .maybeSingle();
  if (current.error) return failure(current.error);
  if (!current.data) {
    return { ok: false, message: "Mesa não encontrada. Ela pode ter sido removida; atualize a página." };
  }
  if (current.data.status !== "INACTIVE") {
    return { ok: false, message: "Só mesas inativas podem ser excluídas. Inative a mesa primeiro." };
  }

  // Histórico de uso: comandas ou pedidos ligados à mesa.
  const [tabs, orders] = await Promise.all([
    ctx.supabase
      .from("tabs")
      .select("id", { head: true, count: "exact" })
      .eq("restaurant_id", ctx.restaurantId)
      .eq("table_id", id.data),
    ctx.supabase
      .from("orders")
      .select("id", { head: true, count: "exact" })
      .eq("restaurant_id", ctx.restaurantId)
      .eq("table_id", id.data),
  ]);
  if ((tabs.count ?? 0) > 0 || (orders.count ?? 0) > 0) {
    return { ok: false, message: HAS_HISTORY_MESSAGE };
  }

  const { data, error } = await ctx.supabase
    .from("restaurant_tables")
    .delete()
    .eq("restaurant_id", ctx.restaurantId)
    .eq("id", id.data)
    .eq("status", "INACTIVE")
    .select("id");
  if (error) return failure(error);
  if (!data || data.length === 0) {
    return { ok: false, message: "Não foi possível excluir. A mesa mudou de estado; atualize a página." };
  }

  revalidateTables(ctx);
  return { ok: true, message: "Mesa excluída." };
}

/** Move a mesa uma posição na ordem de exibição (renumera `sort_order`). */
export async function moveTableAction(
  slug: string,
  tableId: string,
  direction: -1 | 1,
): Promise<ActionResult> {
  const auth = await authorize(slug, "tables.manage");
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(tableId);
  if (!id.success || (direction !== -1 && direction !== 1)) {
    return { ok: false, message: "Pedido inválido. Atualize a página e tente de novo." };
  }

  const res = await ctx.supabase
    .from("restaurant_tables")
    .select("id, name, capacity, status, sort_order")
    .eq("restaurant_id", ctx.restaurantId)
    .limit(1000);
  if (res.error) return failure(res.error);
  const ordered = sortTables(z.array(tableRowSchema).catch([]).parse(res.data));

  const from = ordered.findIndex((row) => row.id === id.data);
  const to = from + direction;
  if (from < 0) return { ok: false, message: "Mesa não encontrada. Atualize a página." };
  if (to < 0 || to >= ordered.length) return { ok: true };

  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  const changes = ordered
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => row.sort_order !== index);
  const results = await Promise.all(
    changes.map(({ row, index }) =>
      ctx.supabase
        .from("restaurant_tables")
        .update({ sort_order: index })
        .eq("restaurant_id", ctx.restaurantId)
        .eq("id", row.id),
    ),
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) return failure(failed.error);

  revalidateTables(ctx);
  return { ok: true };
}

/** Últimas comandas de uma mesa (leitura). Exige ver mesas e comandas. */
export async function loadTableHistoryAction(
  slug: string,
  tableId: string,
): Promise<Result<TableHistoryEntry[]>> {
  const parsedSlug = slugSchema.safeParse(slug);
  const id = entityIdSchema.safeParse(tableId);
  if (!getPublicEnvStatus().ok || !parsedSlug.success || !id.success) {
    return { ok: false, message: "Não foi possível carregar o histórico." };
  }
  const access = await requireRestaurantAccess(parsedSlug.data, {
    area: "app",
    permission: "tabs.view",
  });
  return getTableHistory(access.restaurant.restaurant_id, id.data);
}
