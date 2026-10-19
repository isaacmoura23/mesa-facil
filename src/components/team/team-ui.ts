import { OPERATIONAL_PERMISSIONS, PERMISSION_LABELS, ROLE_LABELS } from "@/lib/auth/permissions";
import type { Permission, RestaurantRole } from "@/lib/auth/types";
import type { AssignableRole, TeamMember } from "@/modules/team/types";

export const ROLE_HELP: Record<AssignableRole, string> = {
  manager: "Opera o dia a dia: pedidos, mesas, comandas, pagamentos e cardápio.",
  cashier: "Recebe pagamentos, aceita pedidos e cuida das comandas.",
  kitchen: "Acompanha pedidos e atualiza o preparo.",
  waiter: "Atende mesas, abre comandas e cria pedidos.",
};

export const ROLE_ORDER: Record<RestaurantRole, number> = {
  owner: 0,
  manager: 1,
  cashier: 2,
  waiter: 3,
  kitchen: 4,
};

export function roleLabel(role: RestaurantRole): string {
  return ROLE_LABELS[role];
}

export type PermissionGroup = {
  title: string;
  items: { key: Permission; hint: string }[];
};

/** `team.manage` aparece, mas sempre bloqueada (não delegável). */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: "Pedidos",
    items: [
      { key: "orders.view", hint: "Acompanhar a fila de pedidos." },
      { key: "orders.create", hint: "Lançar pedidos pelo salão ou balcão." },
      { key: "orders.accept", hint: "Aceitar pedidos recebidos." },
      { key: "orders.reject", hint: "Recusar pedidos recebidos." },
      { key: "orders.update_status", hint: "Avançar o preparo e a entrega." },
      { key: "orders.cancel", hint: "Cancelar pedidos em andamento." },
    ],
  },
  {
    title: "Mesas e comandas",
    items: [
      { key: "tables.view", hint: "Ver o mapa de mesas." },
      { key: "tables.operate", hint: "Mudar o estado das mesas." },
      { key: "tabs.view", hint: "Ver comandas abertas." },
      { key: "tabs.manage", hint: "Abrir, lançar itens e fechar comandas." },
      { key: "tables.manage", hint: "Cadastrar e editar mesas." },
    ],
  },
  {
    title: "Caixa e impressão",
    items: [
      { key: "payments.record", hint: "Registrar pagamentos manualmente." },
      { key: "print.request", hint: "Pedir impressão de comandas e contas." },
    ],
  },
  {
    title: "Gestão",
    items: [
      { key: "menu.manage", hint: "Editar o cardápio." },
      { key: "reports.view", hint: "Ver relatórios e indicadores." },
      { key: "restaurant.settings.manage", hint: "Alterar dados e configurações do restaurante." },
      { key: "team.manage", hint: "Convidar pessoas e definir permissões." },
    ],
  },
];

const OPERATIONAL = new Set<string>(OPERATIONAL_PERMISSIONS);

export function isOperational(permission: Permission): boolean {
  return OPERATIONAL.has(permission);
}

export function permissionLabel(permission: Permission): string {
  return PERMISSION_LABELS[permission];
}

/**
 * Padrão do papel para uma permissão, derivado da própria resposta de
 * `list_team`: sem override, o efetivo é o padrão; com override, o padrão é o inverso.
 */
export function defaultGranted(member: TeamMember, permission: Permission): boolean {
  const override = member.overrides.find((item) => item.permission === permission);
  if (override) return !override.granted;
  return member.permissions.includes(permission);
}

export function displayName(member: TeamMember): string {
  return member.full_name?.trim() || member.email || member.invited_email || "Sem nome";
}

export function displayEmail(member: TeamMember): string | null {
  return member.email ?? member.invited_email;
}

export function initialsOf(member: TeamMember): string {
  const source = member.full_name?.trim() || displayEmail(member) || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[1][0] : "");
  return letters.toUpperCase();
}

export function sortMembers(members: TeamMember[]): TeamMember[] {
  return [...members].sort((a, b) => {
    const byRole = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (byRole !== 0) return byRole;
    return displayName(a).localeCompare(displayName(b), "pt-BR");
  });
}
