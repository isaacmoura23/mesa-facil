"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import { getPublicEnvStatus } from "@/lib/env";
import { PUBLIC_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  isOwnProductImagePath,
} from "./image";
import {
  categorySchema,
  entityIdSchema,
  fieldErrorsOf,
  formToRecord,
  groupIdsSchema,
  imagePathSchema,
  modifierGroupSchema,
  modifierSchema,
  productSchema,
  reorderSchema,
  slugSchema,
} from "./schemas";
import { storefrontMenuTag } from "./tags";
import type { VariantInput } from "./schemas";
import type { ActionResult, ReorderKind } from "./types";

/**
 * Server Actions do cardápio (admin).
 *
 * Autorização: TODA ação resolve o restaurante pelo guard
 * (`requireRestaurantAccess` com `menu.manage`), a partir do slug. Nenhum
 * `restaurant_id` vem do cliente. As escritas usam o cliente Supabase do
 * usuário, então a RLS também valida (`has_permission(..., 'menu.manage')`).
 */

type Context = {
  restaurantId: string;
  slug: string;
  supabase: AppSupabaseClient;
};

type Failure = Extract<ActionResult, { ok: false }>;

type Authorization = { ok: true; ctx: Context } | { ok: false; result: Failure };

const SERVER_NOT_CONFIGURED: Failure = {
  ok: false,
  message: "O Supabase ainda não está configurado neste ambiente.",
};

async function authorize(slug: string): Promise<Authorization> {
  if (!getPublicEnvStatus().ok) return { ok: false, result: SERVER_NOT_CONFIGURED };
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return { ok: false, result: { ok: false, message: "Restaurante inválido." } };
  }

  const access = await requireRestaurantAccess(parsedSlug.data, {
    area: "app",
    permission: "menu.manage",
  });
  const supabase = await createClient();
  return {
    ok: true,
    ctx: {
      restaurantId: access.restaurant.restaurant_id,
      slug: access.restaurant.slug,
      supabase,
    },
  };
}

type DbError = { message?: string; code?: string } | null | undefined;

/** CHECK violations: a mensagem do Postgres cita o nome da constraint. */
function checkViolationMessage(message: string | undefined): string {
  if (message?.includes("products_badges_valid")) {
    return "Selos inválidos: escolha até 4 selos diferentes da lista.";
  }
  if (message?.includes("product_variants_name_len")) {
    return "O nome do tamanho deve ter de 1 a 40 caracteres.";
  }
  if (message?.includes("product_variants")) {
    return "Algum dos tamanhos tem um valor não aceito. Revise nome e preço.";
  }
  return "Algum dos valores informados não é aceito. Revise o formulário.";
}

function uniqueViolationMessage(message: string | undefined): string {
  if (message?.includes("product_variants_name_uq")) {
    return "Já existe um tamanho com esse nome neste produto.";
  }
  if (message?.includes("product_variants_one_default_uq")) {
    return "Só pode haver um tamanho padrão por produto.";
  }
  return "Já existe um item igual a este. Revise os valores informados.";
}

/** Converte erros do banco em mensagens PT-BR. Mensagens cruas nunca saem daqui. */
function failure(error: DbError, fallback: string = GENERIC_ERROR_MESSAGE): Failure {
  const code = error?.code;
  if (code === "42501") return { ok: false, message: RPC_ERROR_MESSAGES.forbidden };
  if (code === "PGRST301" || code === "PGRST303") {
    return { ok: false, message: RPC_ERROR_MESSAGES.not_authenticated };
  }
  if (code === "23503") {
    return {
      ok: false,
      message: "Um dos itens relacionados não existe mais. Atualize a página e tente de novo.",
    };
  }
  if (code === "23514") return { ok: false, message: checkViolationMessage(error?.message) };
  if (code === "23505") return { ok: false, message: uniqueViolationMessage(error?.message) };
  return { ok: false, message: rpcErrorMessage(error, fallback) };
}

function fail(message: string): Failure {
  return { ok: false, message };
}

function revalidateMenu(ctx: Context): void {
  revalidatePath(`/app/${ctx.slug}/cardapio`);
  // O cardápio público é ao vivo: qualquer cache dele deve ser invalidado.
  revalidatePath(`/r/${ctx.slug}`, "layout");
  updateTag(storefrontMenuTag(ctx.slug));
}

const SAVED_NOT_FOUND = "Item não encontrado. Ele pode ter sido removido; atualize a página.";

// ---------------------------------------------------------------------------
// Ordenação
// ---------------------------------------------------------------------------

const TABLE_BY_KIND: Record<ReorderKind, string> = {
  category: "menu_categories",
  product: "products",
  modifier_group: "modifier_groups",
  modifier: "modifiers",
};

async function nextSortOrder(
  ctx: Context,
  table: string,
  scope?: { column: string; value: string | null },
): Promise<number> {
  let query = ctx.supabase
    .from(table)
    .select("sort_order")
    .eq("restaurant_id", ctx.restaurantId);
  if (scope) {
    query = scope.value === null ? query.is(scope.column, null) : query.eq(scope.column, scope.value);
  }
  const { data } = await query.order("sort_order", { ascending: false }).limit(1);
  const parsed = z.array(z.object({ sort_order: z.number() })).safeParse(data);
  const last = parsed.success ? parsed.data[0]?.sort_order : undefined;
  return (last ?? 0) + 1;
}

function isMissingFunction(error: DbError): boolean {
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    Boolean(error?.message?.includes("Could not find the function"))
  );
}

export async function reorderMenuAction(
  slug: string,
  kind: ReorderKind,
  ids: string[],
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = reorderSchema.safeParse({ kind, ids });
  if (!parsed.success) return fail("Não foi possível reordenar: lista inválida.");

  const { error } = await ctx.supabase.rpc("reorder_menu", {
    p_restaurant: ctx.restaurantId,
    p_kind: parsed.data.kind,
    p_ids: parsed.data.ids,
  });

  if (error && isMissingFunction(error)) {
    // Contingência até a RPC `reorder_menu` (migração 112+) existir no banco:
    // grava `sort_order` item a item. A RLS continua exigindo `menu.manage`.
    const table = TABLE_BY_KIND[parsed.data.kind];
    const results = await Promise.all(
      parsed.data.ids.map((id, index) =>
        ctx.supabase
          .from(table)
          .update({ sort_order: index + 1 })
          .eq("id", id)
          .eq("restaurant_id", ctx.restaurantId),
      ),
    );
    const firstError = results.find((result) => result.error)?.error;
    if (firstError) return failure(firstError, "Não foi possível reordenar agora.");
  } else if (error) {
    return failure(error, "Não foi possível reordenar agora.");
  }

  revalidateMenu(ctx);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

export async function saveCategoryAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = categorySchema.safeParse(formToRecord(formData));
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { id, name, description } = parsed.data;

  if (id) {
    const { data, error } = await ctx.supabase
      .from("menu_categories")
      .update({ name, description })
      .eq("id", id)
      .eq("restaurant_id", ctx.restaurantId)
      .select("id");
    if (error) return failure(error, "Não foi possível salvar a categoria.");
    if (!data?.length) return fail(SAVED_NOT_FOUND);
  } else {
    const sortOrder = await nextSortOrder(ctx, "menu_categories");
    const { error } = await ctx.supabase.from("menu_categories").insert({
      restaurant_id: ctx.restaurantId,
      name,
      description,
      sort_order: sortOrder,
    });
    if (error) return failure(error, "Não foi possível criar a categoria.");
  }

  revalidateMenu(ctx);
  return { ok: true, message: id ? "Categoria atualizada." : "Categoria criada." };
}

export async function setCategoryActiveAction(
  slug: string,
  categoryId: string,
  active: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(categoryId);
  if (!id.success) return fail("Categoria inválida.");

  const { data, error } = await ctx.supabase
    .from("menu_categories")
    .update({ is_active: active === true })
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível alterar a categoria.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return {
    ok: true,
    message: active ? "Categoria ativada." : "Categoria desativada. Ela saiu do cardápio público.",
  };
}

export async function deleteCategoryAction(
  slug: string,
  categoryId: string,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(categoryId);
  if (!id.success) return fail("Categoria inválida.");

  // "Excluir só se vazia": o banco soltaria os produtos (categoria nula), então
  // a regra é aplicada aqui antes de apagar.
  const { count, error: countError } = await ctx.supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", ctx.restaurantId)
    .eq("category_id", id.data);
  if (countError) return failure(countError, "Não foi possível verificar a categoria.");
  if ((count ?? 0) > 0) {
    return fail(
      "Esta categoria ainda tem produtos. Mova ou exclua os produtos antes, ou apenas desative a categoria.",
    );
  }

  const { data, error } = await ctx.supabase
    .from("menu_categories")
    .delete()
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir a categoria.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return { ok: true, message: "Categoria excluída." };
}

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

function isProductImageOf(ctx: Context, path: string | null | undefined): path is string {
  return Boolean(path) && path!.startsWith(`restaurants/${ctx.restaurantId}/products/`) && !path!.includes("..");
}

async function removeImageFile(ctx: Context, path: string | null | undefined): Promise<void> {
  if (!isProductImageOf(ctx, path)) return;
  // Melhor esforço: um arquivo órfão não deve desfazer a operação principal.
  await ctx.supabase.storage.from(PUBLIC_BUCKET).remove([path]);
}

const storageObjectSchema = z.object({
  name: z.string(),
  metadata: z
    .object({ size: z.number().optional(), mimetype: z.string().optional() })
    .nullable()
    .optional(),
});

/** Confere no Storage se o arquivo enviado existe e respeita tipo e tamanho. */
async function verifyUploadedImage(ctx: Context, path: string): Promise<string | null> {
  const lastSlash = path.lastIndexOf("/");
  const folder = path.slice(0, lastSlash);
  const fileName = path.slice(lastSlash + 1);

  const { data, error } = await ctx.supabase.storage
    .from(PUBLIC_BUCKET)
    .list(folder, { search: fileName, limit: 5 });
  if (error) return "Não foi possível conferir a imagem enviada.";

  const objects = z.array(storageObjectSchema).safeParse(data);
  const found = objects.success ? objects.data.find((item) => item.name === fileName) : undefined;
  if (!found) return "Não encontramos a imagem enviada. Envie o arquivo novamente.";

  const size = found.metadata?.size;
  const mimetype = found.metadata?.mimetype;
  if (
    (typeof size === "number" && size > MAX_IMAGE_BYTES) ||
    (typeof mimetype === "string" && !ALLOWED_IMAGE_TYPES.includes(mimetype))
  ) {
    await ctx.supabase.storage.from(PUBLIC_BUCKET).remove([path]);
    return "A imagem enviada não atende aos requisitos (JPG, PNG, WebP ou AVIF, até 5 MB).";
  }
  return null;
}

const groupLinkRowSchema = z.object({ product_id: z.string(), group_id: z.string() });

/** Deixa os vínculos produto<->grupo exatamente como `wantedIds` (lado fixo + lado variável). */
async function syncLinks(
  ctx: Context,
  fixed: "product_id" | "group_id",
  fixedId: string,
  wantedIds: string[],
): Promise<Failure | null> {
  const other = fixed === "product_id" ? "group_id" : "product_id";

  const { data, error } = await ctx.supabase
    .from("product_modifier_groups")
    .select("product_id, group_id")
    .eq("restaurant_id", ctx.restaurantId)
    .eq(fixed, fixedId);
  if (error) return failure(error, "Não foi possível ler os vínculos de adicionais.");

  const rows = z.array(groupLinkRowSchema).safeParse(data);
  const currentIds = rows.success ? rows.data.map((row) => row[other]) : [];
  const wanted = new Set(wantedIds);
  const current = new Set(currentIds);

  const toRemove = currentIds.filter((id) => !wanted.has(id));
  const toAdd = wantedIds.filter((id) => !current.has(id));

  if (toRemove.length > 0) {
    const { error: removeError } = await ctx.supabase
      .from("product_modifier_groups")
      .delete()
      .eq("restaurant_id", ctx.restaurantId)
      .eq(fixed, fixedId)
      .in(other, toRemove);
    if (removeError) return failure(removeError, "Não foi possível desvincular os adicionais.");
  }

  if (toAdd.length > 0) {
    const { error: addError } = await ctx.supabase.from("product_modifier_groups").insert(
      toAdd.map((otherId, index) => ({
        restaurant_id: ctx.restaurantId,
        [fixed]: fixedId,
        [other]: otherId,
        sort_order: index,
      })),
    );
    if (addError) return failure(addError, "Não foi possível vincular os adicionais.");
  }
  return null;
}

const variantRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_default: z.boolean(),
});

const soldVariantNote = (name: string) =>
  `O tamanho "${name}" já foi vendido, então foi desativado em vez de excluído (o histórico de pedidos é preservado).`;

const lower = (value: string) => value.trim().toLocaleLowerCase("pt-BR");

type VariantSyncOutcome = { error: Failure | null; notes: string[] };

/**
 * Deixa os tamanhos ATIVOS do produto exatamente como `wanted` (na ordem).
 * Ordem das escritas, por causa dos índices únicos parciais do banco (nome entre
 * ativos e um único padrão): 1) remove/desativa; 2) tira o padrão de quem o
 * perde; 3) renomeia via nome temporário quando dois nomes se cruzam; 4) grava
 * os existentes; 5) insere os novos. O restaurante vem do guard; a RLS valida.
 */
async function syncVariants(
  ctx: Context,
  productId: string,
  wanted: VariantInput[],
): Promise<VariantSyncOutcome> {
  const notes: string[] = [];
  const table = () => ctx.supabase.from("product_variants");
  const stop = (error: DbError, fallback: string): VariantSyncOutcome => ({
    error: failure(error, fallback),
    notes,
  });

  const { data, error } = await table()
    .select("id, name, is_default")
    .eq("restaurant_id", ctx.restaurantId)
    .eq("product_id", productId)
    .eq("is_active", true);
  if (error) return stop(error, "Não foi possível ler os tamanhos.");
  const parsedRows = z.array(variantRowSchema).safeParse(data);
  if (!parsedRows.success) return { error: fail("Não foi possível ler os tamanhos."), notes };
  const current = parsedRows.data;
  const currentById = new Map(current.map((row) => [row.id, row]));

  for (const variant of wanted) {
    if (variant.id && !currentById.has(variant.id)) {
      return {
        error: fail("Um dos tamanhos não existe mais. Reabra o produto e tente de novo."),
        notes,
      };
    }
  }

  const keptIds = new Set(wanted.flatMap((variant) => (variant.id ? [variant.id] : [])));

  // 1) Remoção: excluir só se nunca foi vendido; senão desativar.
  for (const row of current.filter((item) => !keptIds.has(item.id))) {
    const { data: sold, error: soldError } = await ctx.supabase.rpc("variant_has_orders", {
      vid: row.id,
    });
    if (soldError) return stop(soldError, "Não foi possível verificar o tamanho.");

    let removed = false;
    if (sold !== true) {
      const { data: deleted, error: deleteError } = await table()
        .delete()
        .eq("id", row.id)
        .eq("restaurant_id", ctx.restaurantId)
        .select("id");
      if (deleteError) return stop(deleteError, "Não foi possível excluir o tamanho.");
      removed = (deleted?.length ?? 0) > 0;
    }
    if (!removed) {
      // A policy de DELETE filtra tamanhos vendidos em silêncio: desativa no lugar.
      const { error: deactivateError } = await table()
        .update({ is_active: false, is_default: false })
        .eq("id", row.id)
        .eq("restaurant_id", ctx.restaurantId);
      if (deactivateError) return stop(deactivateError, "Desative o tamanho em vez de excluir.");
      notes.push(soldVariantNote(row.name));
    }
  }

  const existing = wanted.flatMap((variant, index) => {
    const row = variant.id ? currentById.get(variant.id) : undefined;
    return variant.id && row ? [{ variant, id: variant.id, index, row }] : [];
  });

  // 2) Quem deixa de ser o padrão libera o índice único antes de outro assumir.
  for (const item of existing) {
    if (item.row.is_default && !item.variant.isDefault) {
      const { error: clearError } = await table()
        .update({ is_default: false })
        .eq("id", item.id)
        .eq("restaurant_id", ctx.restaurantId);
      if (clearError) return stop(clearError, "Não foi possível atualizar os tamanhos.");
    }
  }

  // 3) Nomes que se cruzam (ex.: P<->G): passa por um nome temporário.
  const namesTaken = new Set(existing.map((item) => lower(item.row.name)));
  for (const item of existing) {
    const after = lower(item.variant.name);
    if (lower(item.row.name) !== after && namesTaken.has(after)) {
      const { error: tempError } = await table()
        .update({ name: `tmp-${item.id.slice(0, 8)}` })
        .eq("id", item.id)
        .eq("restaurant_id", ctx.restaurantId);
      if (tempError) return stop(tempError, "Não foi possível atualizar os tamanhos.");
    }
  }

  // 4) Existentes.
  for (const item of existing) {
    const { error: updateError } = await table()
      .update({
        name: item.variant.name,
        price_cents: item.variant.price,
        is_available: item.variant.isAvailable,
        is_default: item.variant.isDefault,
        sort_order: item.index + 1,
        is_active: true,
      })
      .eq("id", item.id)
      .eq("restaurant_id", ctx.restaurantId);
    if (updateError) return stop(updateError, "Não foi possível atualizar os tamanhos.");
  }

  // 5) Novos.
  const created = wanted.flatMap((variant, index) =>
    variant.id
      ? []
      : [
          {
            restaurant_id: ctx.restaurantId,
            product_id: productId,
            name: variant.name,
            price_cents: variant.price,
            is_available: variant.isAvailable,
            is_default: variant.isDefault,
            sort_order: index + 1,
          },
        ],
  );
  if (created.length > 0) {
    const { error: insertError } = await table().insert(created);
    if (insertError) return stop(insertError, "Não foi possível criar os tamanhos.");
  }

  return { error: null, notes };
}

export async function saveProductAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const record = formToRecord(formData);
  const parsed = productSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { id, name, description, price, categoryId, isActive, isAvailable, badges, variants } =
    parsed.data;
  // Só mexe nos tamanhos quando o formulário os enviou (o campo existe, ainda que "[]").
  const syncVariantsRequested = formData.has("variants");

  const newImage = imagePathSchema.safeParse(record.imagePath ?? "");
  const newImagePath = newImage.success ? newImage.data : null;
  const removeImage = record.removeImage === "true";

  const groupIds = formData.has("groupsSynced")
    ? groupIdsSchema.safeParse(formData.getAll("groupIds").filter((v) => typeof v === "string"))
    : null;
  if (groupIds && !groupIds.success) return fail("Seleção de adicionais inválida.");

  if (newImagePath) {
    if (!isOwnProductImagePath(newImagePath, ctx.restaurantId)) {
      return fail("Caminho de imagem inválido.");
    }
    const problem = await verifyUploadedImage(ctx, newImagePath);
    if (problem) return fail(problem);
  }

  let productId = id;
  let previousImage: string | null = null;

  if (id) {
    const { data: current, error: readError } = await ctx.supabase
      .from("products")
      .select("image_path")
      .eq("id", id)
      .eq("restaurant_id", ctx.restaurantId)
      .maybeSingle();
    if (readError) {
      await removeImageFile(ctx, newImagePath);
      return failure(readError, "Não foi possível salvar o produto.");
    }
    if (!current) {
      await removeImageFile(ctx, newImagePath);
      return fail(SAVED_NOT_FOUND);
    }
    previousImage = z.string().nullable().catch(null).parse(current.image_path);

    const imageChange =
      newImagePath !== null ? { image_path: newImagePath } : removeImage ? { image_path: null } : {};

    const { error } = await ctx.supabase
      .from("products")
      .update({
        name,
        description,
        // Com tamanhos o preço do produto não é editado: mantém o valor atual.
        ...(price === null ? {} : { price_cents: price }),
        category_id: categoryId,
        is_active: isActive,
        is_available: isAvailable,
        badges,
        ...imageChange,
      })
      .eq("id", id)
      .eq("restaurant_id", ctx.restaurantId);
    if (error) {
      await removeImageFile(ctx, newImagePath);
      return failure(error, "Não foi possível salvar o produto.");
    }
  } else {
    const sortOrder = await nextSortOrder(ctx, "products", {
      column: "category_id",
      value: categoryId,
    });
    const { data, error } = await ctx.supabase
      .from("products")
      .insert({
        restaurant_id: ctx.restaurantId,
        name,
        description,
        // Sem preço digitado (produto com tamanhos), grava o menor tamanho como base.
        price_cents: price ?? Math.min(...variants.map((variant) => variant.price)),
        category_id: categoryId,
        is_active: isActive,
        is_available: isAvailable,
        badges,
        image_path: newImagePath,
        sort_order: sortOrder,
      })
      .select("id")
      .single();
    if (error) {
      await removeImageFile(ctx, newImagePath);
      return failure(error, "Não foi possível criar o produto.");
    }
    productId = z.string().parse(data.id);
  }

  // A imagem antiga só é apagada depois que o produto já aponta para a nova.
  if (previousImage && (newImagePath || removeImage) && previousImage !== newImagePath) {
    await removeImageFile(ctx, previousImage);
  }

  const warnings: string[] = [];

  if (syncVariantsRequested && productId) {
    const outcome = await syncVariants(ctx, productId, variants);
    if (outcome.error) {
      warnings.push(
        `Os tamanhos não foram salvos por completo: ${outcome.error.message} Reabra o produto para conferir.`,
      );
    }
    warnings.push(...outcome.notes);
  }

  if (groupIds?.success && productId) {
    const linkError = await syncLinks(ctx, "product_id", productId, groupIds.data);
    if (linkError) warnings.push(`Os adicionais não foram atualizados: ${linkError.message}`);
  }

  revalidateMenu(ctx);
  const message = id ? "Produto atualizado." : "Produto criado.";
  return warnings.length > 0 ? { ok: true, message, warning: warnings.join(" ") } : { ok: true, message };
}

export async function setProductStateAction(
  slug: string,
  productId: string,
  field: "is_active" | "is_available",
  value: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(productId);
  if (!id.success || (field !== "is_active" && field !== "is_available")) {
    return fail("Produto inválido.");
  }

  const { data, error } = await ctx.supabase
    .from("products")
    .update({ [field]: value === true })
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível alterar o produto.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  const message =
    field === "is_active"
      ? value
        ? "Produto ativado e visível no cardápio."
        : "Produto desativado. Ele saiu do cardápio público."
      : value
        ? "Produto marcado como disponível."
        : "Produto marcado como indisponível.";
  return { ok: true, message };
}

const SOLD_PRODUCT_MESSAGE =
  "Este produto já foi vendido e não pode ser excluído, para preservar o histórico de pedidos. Desative o produto para tirá-lo do cardápio.";

export async function deleteProductAction(
  slug: string,
  productId: string,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(productId);
  if (!id.success) return fail("Produto inválido.");

  const { data: sold, error: soldError } = await ctx.supabase.rpc("product_has_orders", {
    pid: id.data,
  });
  if (soldError) return failure(soldError, "Não foi possível verificar o histórico do produto.");
  if (sold === true) return fail(SOLD_PRODUCT_MESSAGE);

  const { data: current } = await ctx.supabase
    .from("products")
    .select("image_path")
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .maybeSingle();
  const image = z.string().nullable().catch(null).parse(current?.image_path ?? null);

  const { data, error } = await ctx.supabase
    .from("products")
    .delete()
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir o produto.");
  // A policy de DELETE filtra produtos vendidos em silêncio (0 linhas, sem erro).
  if (!data?.length) return fail(SOLD_PRODUCT_MESSAGE);

  await removeImageFile(ctx, image);
  revalidateMenu(ctx);
  return { ok: true, message: "Produto excluído." };
}

export async function setProductGroupsAction(
  slug: string,
  productId: string,
  groupIds: string[],
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(productId);
  const ids = groupIdsSchema.safeParse(groupIds);
  if (!id.success || !ids.success) return fail("Seleção inválida.");

  const error = await syncLinks(ctx, "product_id", id.data, ids.data);
  if (error) return error;

  revalidateMenu(ctx);
  return { ok: true, message: "Adicionais do produto atualizados." };
}

export async function setGroupProductsAction(
  slug: string,
  groupId: string,
  productIds: string[],
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(groupId);
  const ids = groupIdsSchema.safeParse(productIds);
  if (!id.success || !ids.success) return fail("Seleção inválida.");

  const error = await syncLinks(ctx, "group_id", id.data, ids.data);
  if (error) return error;

  revalidateMenu(ctx);
  return { ok: true, message: "Produtos do grupo atualizados." };
}

// ---------------------------------------------------------------------------
// Grupos de adicionais
// ---------------------------------------------------------------------------

export async function saveModifierGroupAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = modifierGroupSchema.safeParse(formToRecord(formData));
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { id, name, min, max } = parsed.data;

  if (id) {
    const { data, error } = await ctx.supabase
      .from("modifier_groups")
      .update({ name, min_selections: min, max_selections: max })
      .eq("id", id)
      .eq("restaurant_id", ctx.restaurantId)
      .select("id");
    if (error) return failure(error, "Não foi possível salvar o grupo.");
    if (!data?.length) return fail(SAVED_NOT_FOUND);
  } else {
    const sortOrder = await nextSortOrder(ctx, "modifier_groups");
    const { error } = await ctx.supabase.from("modifier_groups").insert({
      restaurant_id: ctx.restaurantId,
      name,
      min_selections: min,
      max_selections: max,
      sort_order: sortOrder,
    });
    if (error) return failure(error, "Não foi possível criar o grupo.");
  }

  revalidateMenu(ctx);
  return { ok: true, message: id ? "Grupo atualizado." : "Grupo criado." };
}

export async function setModifierGroupActiveAction(
  slug: string,
  groupId: string,
  active: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(groupId);
  if (!id.success) return fail("Grupo inválido.");

  const { data, error } = await ctx.supabase
    .from("modifier_groups")
    .update({ is_active: active === true })
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível alterar o grupo.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return {
    ok: true,
    message: active ? "Grupo ativado." : "Grupo desativado. Ele não aparece mais nos produtos.",
  };
}

export async function deleteModifierGroupAction(
  slug: string,
  groupId: string,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(groupId);
  if (!id.success) return fail("Grupo inválido.");

  // Itens e vínculos saem junto (cascade). Pedidos antigos mantêm o histórico
  // nos snapshots (nome e preço do adicional).
  const { data, error } = await ctx.supabase
    .from("modifier_groups")
    .delete()
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir o grupo.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return { ok: true, message: "Grupo excluído." };
}

// ---------------------------------------------------------------------------
// Itens de adicionais
// ---------------------------------------------------------------------------

export async function saveModifierAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = modifierSchema.safeParse(formToRecord(formData));
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { id, groupId, name, price, isAvailable } = parsed.data;

  if (id) {
    const { data, error } = await ctx.supabase
      .from("modifiers")
      .update({ name, price_delta_cents: price, is_available: isAvailable })
      .eq("id", id)
      .eq("restaurant_id", ctx.restaurantId)
      .select("id");
    if (error) return failure(error, "Não foi possível salvar o item.");
    if (!data?.length) return fail(SAVED_NOT_FOUND);
  } else {
    const sortOrder = await nextSortOrder(ctx, "modifiers", { column: "group_id", value: groupId });
    const { error } = await ctx.supabase.from("modifiers").insert({
      restaurant_id: ctx.restaurantId,
      group_id: groupId,
      name,
      price_delta_cents: price,
      is_available: isAvailable,
      sort_order: sortOrder,
    });
    if (error) return failure(error, "Não foi possível criar o item.");
  }

  revalidateMenu(ctx);
  return { ok: true, message: id ? "Item atualizado." : "Item adicionado." };
}

export async function setModifierAvailableAction(
  slug: string,
  modifierId: string,
  available: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(modifierId);
  if (!id.success) return fail("Item inválido.");

  const { data, error } = await ctx.supabase
    .from("modifiers")
    .update({ is_available: available === true })
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível alterar o item.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return { ok: true, message: available ? "Item disponível." : "Item marcado como indisponível." };
}

export async function deleteModifierAction(
  slug: string,
  modifierId: string,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const id = entityIdSchema.safeParse(modifierId);
  if (!id.success) return fail("Item inválido.");

  const { data, error } = await ctx.supabase
    .from("modifiers")
    .delete()
    .eq("id", id.data)
    .eq("restaurant_id", ctx.restaurantId)
    .select("id");
  if (error) return failure(error, "Não foi possível excluir o item.");
  if (!data?.length) return fail(SAVED_NOT_FOUND);

  revalidateMenu(ctx);
  return { ok: true, message: "Item excluído." };
}
