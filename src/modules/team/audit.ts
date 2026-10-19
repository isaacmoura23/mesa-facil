import { PERMISSION_LABELS, ROLE_LABELS } from "@/lib/auth/permissions";
import { PERMISSIONS, RESTAURANT_ROLES } from "@/lib/auth/types";
import type { Permission, RestaurantRole } from "@/lib/auth/types";

/** Fuso fixo do painel (docs/CONTRACT.md: America/Sao_Paulo, sem horário de verão). */
export const PANEL_TIME_ZONE = "America/Sao_Paulo";
const OFFSET = "-03:00";

/**
 * Categorias do filtro. `prefixes` é o que vai em `p_action_prefix`; o banco registra
 * hoje `member.*` (equipe) e `order.*`, então a busca usa o prefixo real de cada área.
 */
export const AUDIT_CATEGORIES = [
  { key: "", label: "Todas as atividades", prefix: null },
  { key: "orders", label: "Pedidos", prefix: "order" },
  { key: "tab", label: "Comandas", prefix: "tab." },
  { key: "table", label: "Mesas", prefix: "table." },
  { key: "payment", label: "Pagamentos", prefix: "payment." },
  { key: "team", label: "Equipe", prefix: "member." },
  { key: "menu", label: "Cardápio", prefix: "menu." },
  { key: "settings", label: "Configurações", prefix: "settings." },
  { key: "restaurant", label: "Restaurante e suporte", prefix: "restaurant." },
  { key: "customer", label: "Clientes", prefix: "customer." },
] as const;

export function prefixForCategory(key: string): string | null {
  return AUDIT_CATEGORIES.find((item) => item.key === key)?.prefix ?? null;
}

/** Início do dia (00:00) no fuso do painel, em ISO com offset. */
export function startOfDayIso(date: string): string | null {
  return date ? `${date}T00:00:00.000${OFFSET}` : null;
}

export function endOfDayIso(date: string): string | null {
  return date ? `${date}T23:59:59.999${OFFSET}` : null;
}

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: PANEL_TIME_ZONE,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const dateOnly = new Intl.DateTimeFormat("pt-BR", {
  timeZone: PANEL_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateTime.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateOnly.format(date);
}

function roleName(value: unknown): string {
  return typeof value === "string" && (RESTAURANT_ROLES as readonly string[]).includes(value)
    ? ROLE_LABELS[value as RestaurantRole]
    : "função desconhecida";
}

function permissionName(value: unknown): string {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value)
    ? PERMISSION_LABELS[value as Permission]
    : "uma permissão";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 120) : null;
}

type Describe = (metadata: Record<string, unknown>) => string;

const DESCRIBERS: Record<string, Describe> = {
  "member.invited": (m) => `Convidou ${text(m.email) ?? "uma pessoa"} como ${roleName(m.role)}`,
  "member.invitation_accepted": (m) => `Convite aceito (função: ${roleName(m.role)})`,
  "member.role_changed": (m) => `Alterou a função de ${roleName(m.from)} para ${roleName(m.to)}`,
  "member.revoked": (m) => `Revogou o acesso de um integrante (${roleName(m.role)})`,
  "member.permission_changed": (m) =>
    `${m.granted === true ? "Concedeu" : "Removeu"} a permissão "${permissionName(m.permission)}" (${roleName(m.role)})`,
  "order.staff_created": () => "Criou um pedido pela equipe",
  "payment.recorded": () => "Registrou um pagamento",
  "print.requested": () => "Solicitou uma impressão",
  "tab.opened": () => "Abriu uma comanda",
  "tab.closed": () => "Fechou uma comanda",
  "tab.closed_unpaid": () => "Fechou uma comanda sem pagamento",
  "tab.cancelled": () => "Cancelou uma comanda",
  "table.qr_rotated": () => "Gerou um novo QR Code de mesa",
  "table.status_changed": () => "Alterou o estado de uma mesa",
  "customer.viewed": () => "Consultou os dados de um cliente",
  "menu.reordered": () => "Reordenou itens do cardápio",
  "restaurant.created": () => "Restaurante criado",
  "restaurant.registered": () => "Restaurante registrado",
  "restaurant.updated_by_platform": () => "Dados do restaurante atualizados pela plataforma",
  "support.session_opened": () => "Suporte da plataforma abriu uma sessão de atendimento",
  "support.session_closed": () => "Suporte da plataforma encerrou a sessão de atendimento",
};

export function describeAudit(action: string, metadata: Record<string, unknown>): { text: string; known: boolean } {
  const describe = Object.hasOwn(DESCRIBERS, action) ? DESCRIBERS[action] : undefined;
  if (describe) return { text: describe(metadata), known: true };
  return { text: "Atividade registrada no sistema", known: false };
}

const SENSITIVE_KEY = /token|secret|senha|password|passwd|api[-_]?key|authorization|cookie|jwt|credential|hash|signature|otp|cvv|card/i;

export type MetadataEntry = { key: string; value: string };

/** Defesa em profundidade: o banco já sanitiza, mas nunca exibimos chaves sensíveis. */
export function safeMetadataEntries(metadata: Record<string, unknown>): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  for (const [key, raw] of Object.entries(metadata)) {
    if (SENSITIVE_KEY.test(key)) continue;
    let value: string;
    if (typeof raw === "string") value = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") value = String(raw);
    else if (raw === null || raw === undefined) continue;
    else value = "(dados adicionais)";
    entries.push({ key: key.slice(0, 40), value: value.length > 120 ? `${value.slice(0, 117)}...` : value });
    if (entries.length >= 12) break;
  }
  return entries;
}
