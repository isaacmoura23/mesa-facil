import "server-only";
import { revalidatePath, updateTag } from "next/cache";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { storefrontMenuTag } from "@/modules/menu/tags";
import { z } from "zod";
import type { ActionResult } from "./types";

/**
 * Contexto comum das Server Actions de configurações. O restaurante é
 * resolvido pelo guard (`restaurant.settings.manage`) a partir do slug; nenhum
 * `restaurant_id` vem do formulário. A RLS (`has_permission`) também valida.
 */
export type Context = { restaurantId: string; slug: string; supabase: AppSupabaseClient };
export type Failure = Extract<ActionResult, { ok: false }>;
type Authorization = { ok: true; ctx: Context } | { ok: false; result: Failure };

const slugSchema = z.string().trim().min(1).max(63);

export async function authorize(slug: string): Promise<Authorization> {
  if (!getPublicEnvStatus().ok) {
    return {
      ok: false,
      result: { ok: false, message: "O Supabase ainda não está configurado neste ambiente." },
    };
  }
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) return { ok: false, result: { ok: false, message: "Restaurante inválido." } };
  const access = await requireRestaurantAccess(parsedSlug.data, {
    area: "app",
    permission: "restaurant.settings.manage",
  });
  const supabase = await createClient();
  return {
    ok: true,
    ctx: { restaurantId: access.restaurant.restaurant_id, slug: access.restaurant.slug, supabase },
  };
}

type DbError = { message?: string; code?: string } | null | undefined;

const CHECK_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ["BUSINESS_HOURS_OVERLAP", "Há intervalos que se sobrepõem no mesmo dia. Ajuste os horários."],
  ["BUSINESS_HOURS_LIMIT", "Use no máximo 6 intervalos por dia."],
  ["EXCEPTIONS_LIMIT", "Limite de 400 exceções atingido. Exclua datas passadas para cadastrar novas."],
  ["ZONES_LIMIT", "Limite de 50 regiões de entrega atingido."],
  ["INVALID_TIMEZONE", "Fuso horário inválido."],
  ["delivery_zones_fee_max", "Taxa de entrega acima do limite (R$ 1.000,00)."],
  ["min_order_max", "Pedido mínimo acima do limite (R$ 100.000,00)."],
  ["eta_max", "Tempo estimado acima do limite (1440 minutos)."],
  ["neighborhoods_valid", "Lista de bairros inválida (máximo de 100, sem itens vazios)."],
  ["fulfillment_valid", "Modalidades inválidas."],
  ["closed_no_times", "Um dia fechado não pode ter horários."],
  ["has_fulfillment", "Habilite pelo menos uma modalidade de atendimento."],
  ["prep_time_minutes", "Tempo de preparo inválido. Use de 1 a 600 minutos."],
  ["min_order_cents", "Pedido mínimo inválido. Use um valor igual ou maior que zero."],
  ["pickup_instructions", "As instruções de retirada estão longas demais."],
  ["distinct_times", "A abertura e o fechamento não podem ser iguais."],
  ["business_hour_exceptions_times", "Informe a abertura e o fechamento diferentes para o horário especial."],
  ["description", "A descrição está longa demais (máximo de 200 caracteres)."],
  ["delivery_zones_name", "O nome da região deve ter de 1 a 120 caracteres."],
  ["fee_cents", "Taxa de entrega inválida. Use um valor igual ou maior que zero."],
  ["estimated_minutes", "Tempo estimado inválido. Use um número de minutos maior que zero."],
  ["timezone", "Fuso horário inválido."],
  ["restaurants_name", "Nome inválido. Use de 2 a 120 caracteres."],
  ["logo_path", "Logo inválida. Envie o arquivo novamente."],
];

/** Converte erros do banco em mensagens PT-BR. Mensagens cruas nunca saem daqui. */
export function failure(error: DbError, fallback: string = GENERIC_ERROR_MESSAGE): Failure {
  const code = error?.code;
  const message = error?.message ?? "";
  if (code === "42501") return { ok: false, message: RPC_ERROR_MESSAGES.forbidden };
  if (code === "PGRST301" || code === "PGRST303") {
    return { ok: false, message: RPC_ERROR_MESSAGES.not_authenticated };
  }
  if (code === "23505") {
    return message.includes("on_date")
      ? { ok: false, message: "Já existe uma exceção cadastrada para esta data. Edite a existente." }
      : { ok: false, message: "Já existe um registro igual a este." };
  }
  if (code === "23503") {
    return {
      ok: false,
      message: "Este item está em uso e não pode ser excluído. Inative-o para tirá-lo da vitrine.",
    };
  }
  if (code === "23514") {
    const found = CHECK_MESSAGES.find(([needle]) => message.includes(needle));
    return {
      ok: false,
      message: found ? found[1] : "Algum dos valores informados não é aceito. Revise o formulário.",
    };
  }
  return { ok: false, message: rpcErrorMessage(error, fallback) };
}

export const LIVE_CHANGE_WARNING =
  "Vale agora para novos pedidos e para a vitrine. Pedidos já feitos não mudam.";

/** Atualiza as telas do painel e invalida o cache da vitrine pública. */
export function revalidateSettings(ctx: Context): void {
  revalidatePath(`/app/${ctx.slug}/configuracoes`);
  revalidatePath(`/r/${ctx.slug}`, "layout");
  updateTag(storefrontMenuTag(ctx.slug));
}
