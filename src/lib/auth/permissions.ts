import type { AppArea, Permission, RestaurantRole } from "./types";

/** Permissões que alteram o estado da operação. O `owner` nunca as recebe. */
export const OPERATIONAL_PERMISSIONS = [
  "orders.create",
  "orders.accept",
  "orders.reject",
  "orders.update_status",
  "orders.cancel",
  "tables.operate",
  "tabs.manage",
  "payments.record",
  "print.request",
] as const satisfies readonly Permission[];

/** Qualquer permissão que dá acesso a telas de /operacao (inclui as de leitura). */
export const OPERACAO_ACCESS_PERMISSIONS = [
  "orders.view",
  "tables.view",
  "tabs.view",
  ...OPERATIONAL_PERMISSIONS,
] as const satisfies readonly Permission[];

/** Permissões administrativas que dão acesso a /app mesmo fora de owner|manager. */
export const ADMIN_PERMISSIONS = [
  "menu.manage",
  "tables.manage",
  "reports.view",
  "team.manage",
  "restaurant.settings.manage",
] as const satisfies readonly Permission[];

export const ROLE_LABELS: Record<RestaurantRole, string> = {
  owner: "Proprietário",
  manager: "Gerente",
  cashier: "Caixa",
  kitchen: "Cozinha",
  waiter: "Garçom",
};

export const STATUS_LABELS = {
  pending: "Aguardando ativação",
  active: "Ativo",
  suspended: "Suspenso",
} as const;

export function hasAny(
  granted: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return required.some((permission) => granted.has(permission));
}

/**
 * Regras de entrada por ambiente:
 * - /app: papel owner|manager OU alguma permissão administrativa.
 * - /operacao: alguma permissão operacional/de visualização, e nunca para o
 *   `owner` (ele acompanha tudo em modo leitura dentro de /app).
 */
export function canEnterArea(
  area: AppArea,
  role: RestaurantRole,
  granted: ReadonlySet<string>,
): boolean {
  if (area === "app") {
    return (
      role === "owner" || role === "manager" || hasAny(granted, ADMIN_PERMISSIONS)
    );
  }
  return role !== "owner" && hasAny(granted, OPERACAO_ACCESS_PERMISSIONS);
}

/** Página inicial padrão de cada papel (usada após o login). */
export function homePathFor(slug: string, role: RestaurantRole): string {
  const encoded = encodeURIComponent(slug);
  return role === "owner" || role === "manager"
    ? `/app/${encoded}/dashboard`
    : `/operacao/${encoded}/pedidos`;
}

export function areaHomePath(slug: string, area: AppArea): string {
  const encoded = encodeURIComponent(slug);
  return area === "app"
    ? `/app/${encoded}/dashboard`
    : `/operacao/${encoded}/pedidos`;
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  "orders.view": "Ver pedidos",
  "orders.create": "Criar pedidos",
  "orders.accept": "Aceitar pedidos",
  "orders.reject": "Recusar pedidos",
  "orders.update_status": "Atualizar status de pedidos",
  "orders.cancel": "Cancelar pedidos",
  "menu.manage": "Gerenciar cardápio",
  "tables.view": "Ver mesas",
  "tables.manage": "Cadastrar mesas",
  "tables.operate": "Operar mesas",
  "tabs.view": "Ver comandas",
  "tabs.manage": "Gerenciar comandas",
  "payments.record": "Registrar pagamentos",
  "print.request": "Solicitar impressão",
  "reports.view": "Ver relatórios",
  "team.manage": "Gerenciar equipe",
  "restaurant.settings.manage": "Configurar restaurante",
};
