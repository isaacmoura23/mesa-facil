import type { Permission } from "@/lib/auth/types";

export type IconName =
  | "dashboard"
  | "orders"
  | "kitchen"
  | "tables"
  | "tabs"
  | "history"
  | "menu"
  | "customers"
  | "reports"
  | "team"
  | "restaurant"
  | "settings"
  | "plans"
  | "subscriptions"
  | "support"
  | "audit"
  | "cash";

/** Item de navegação já resolvido (serializável para Client Components). */
export type NavEntry = {
  href: string;
  label: string;
  icon: IconName;
  /** Tela exibida apenas em modo leitura neste ambiente. */
  readOnly?: boolean;
};

type NavDefinition = {
  segment: string;
  label: string;
  icon: IconName;
  /** Basta UMA das permissões. Sem valor: visível a todos do ambiente. */
  anyOf?: readonly Permission[];
  readOnly?: boolean;
};

/**
 * Gestão (/app/[slug]): visão do dono/gerente. Telas operacionais
 * (pedidos, mesas, comandas) são SOMENTE LEITURA aqui; quem opera usa /operacao.
 */
const APP_NAV: readonly NavDefinition[] = [
  { segment: "dashboard", label: "Visão geral", icon: "dashboard" },
  { segment: "pedidos", label: "Pedidos", icon: "orders", anyOf: ["orders.view"], readOnly: true },
  { segment: "cardapio", label: "Cardápio", icon: "menu", anyOf: ["menu.manage"] },
  { segment: "mesas", label: "Mesas", icon: "tables", anyOf: ["tables.view", "tables.manage"], readOnly: true },
  { segment: "caixa", label: "Caixa", icon: "cash", anyOf: ["cash.view"], readOnly: true },
  { segment: "comandas", label: "Comandas", icon: "tabs", anyOf: ["tabs.view"], readOnly: true },
  { segment: "clientes", label: "Clientes", icon: "customers", anyOf: ["reports.view"] },
  { segment: "relatorios", label: "Relatórios", icon: "reports", anyOf: ["reports.view"] },
  { segment: "equipe", label: "Equipe", icon: "team", anyOf: ["team.manage"] },
  { segment: "restaurante", label: "Restaurante", icon: "restaurant", anyOf: ["restaurant.settings.manage"] },
  { segment: "configuracoes", label: "Configurações", icon: "settings", anyOf: ["restaurant.settings.manage"] },
];

/** Operação (/operacao/[slug]): telas de trabalho do dia a dia. */
const OPERACAO_NAV: readonly NavDefinition[] = [
  { segment: "pedidos", label: "Pedidos", icon: "orders", anyOf: ["orders.view"] },
  { segment: "cozinha", label: "Cozinha", icon: "kitchen", anyOf: ["orders.view"] },
  { segment: "mesas", label: "Mesas", icon: "tables", anyOf: ["tables.view"] },
  { segment: "caixa", label: "Caixa", icon: "cash", anyOf: ["cash.view"] },
  { segment: "comandas", label: "Comandas", icon: "tabs", anyOf: ["tabs.view"] },
  { segment: "historico", label: "Histórico", icon: "history", anyOf: ["orders.view"] },
];

export const PLATFORM_NAV: readonly NavEntry[] = [
  { href: "/platform/dashboard", label: "Visão geral", icon: "dashboard" },
  { href: "/platform/restaurants", label: "Restaurantes", icon: "restaurant" },
  { href: "/platform/plans", label: "Planos", icon: "plans" },
  { href: "/platform/subscriptions", label: "Assinaturas", icon: "subscriptions" },
  { href: "/platform/support", label: "Suporte", icon: "support" },
  { href: "/platform/audit-logs", label: "Auditoria", icon: "audit" },
  { href: "/platform/settings", label: "Configurações", icon: "settings" },
];

function resolve(
  definitions: readonly NavDefinition[],
  basePath: string,
  canAny: (permissions: readonly Permission[]) => boolean,
): NavEntry[] {
  return definitions
    .filter((item) => !item.anyOf || canAny(item.anyOf))
    .map((item) => ({
      href: `${basePath}/${item.segment}`,
      label: item.label,
      icon: item.icon,
      readOnly: item.readOnly,
    }));
}

/** Itens de /app/[slug] filtrados pelas permissões efetivas do usuário. */
export function buildAppNav(
  slug: string,
  canAny: (permissions: readonly Permission[]) => boolean,
): NavEntry[] {
  return resolve(APP_NAV, `/app/${encodeURIComponent(slug)}`, canAny);
}

/** Itens de /operacao/[slug] filtrados pelas permissões efetivas do usuário. */
export function buildOperacaoNav(
  slug: string,
  canAny: (permissions: readonly Permission[]) => boolean,
): NavEntry[] {
  return resolve(OPERACAO_NAV, `/operacao/${encodeURIComponent(slug)}`, canAny);
}
