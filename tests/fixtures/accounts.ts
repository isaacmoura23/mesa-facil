/**
 * Contas de TESTE (somente Supabase local). E-mails @example.test (domínio reservado,
 * nunca roteável). A senha abaixo é fixa de propósito e só vale para o banco local.
 * Todos os dados criados por estas contas são marcados como DEMO.
 */
export const TEST_PASSWORD = "DemoLocal#Test2026";

export type RestaurantKey = "a" | "b";
export type Role = "owner" | "manager" | "cashier" | "kitchen" | "waiter";
export type PlatformRole = "superadmin" | "support";

export interface AccountDef {
  email: string;
  fullName: string;
  /** Vínculo com restaurante DEMO (omitido para contas de plataforma / sem vínculo). */
  restaurant?: RestaurantKey;
  role?: Role;
  platformRole?: PlatformRole;
}

const acc = (d: AccountDef): AccountDef => d;

export const ACCOUNTS = {
  ownerA: acc({ email: "owner.a@example.test", fullName: "DEMO Dono A", restaurant: "a", role: "owner" }),
  managerA: acc({ email: "manager.a@example.test", fullName: "DEMO Gerente A", restaurant: "a", role: "manager" }),
  cashierA: acc({ email: "cashier.a@example.test", fullName: "DEMO Caixa A", restaurant: "a", role: "cashier" }),
  kitchenA: acc({ email: "kitchen.a@example.test", fullName: "DEMO Cozinha A", restaurant: "a", role: "kitchen" }),
  waiterA: acc({ email: "waiter.a@example.test", fullName: "DEMO Garcom A", restaurant: "a", role: "waiter" }),
  /** Garçom "descartável": os testes de equipe alteram papel/overrides/revogação nele e restauram. */
  waiter2A: acc({ email: "waiter2.a@example.test", fullName: "DEMO Garcom 2 A", restaurant: "a", role: "waiter" }),

  ownerB: acc({ email: "owner.b@example.test", fullName: "DEMO Dono B", restaurant: "b", role: "owner" }),
  managerB: acc({ email: "manager.b@example.test", fullName: "DEMO Gerente B", restaurant: "b", role: "manager" }),
  cashierB: acc({ email: "cashier.b@example.test", fullName: "DEMO Caixa B", restaurant: "b", role: "cashier" }),
  kitchenB: acc({ email: "kitchen.b@example.test", fullName: "DEMO Cozinha B", restaurant: "b", role: "kitchen" }),
  waiterB: acc({ email: "waiter.b@example.test", fullName: "DEMO Garcom B", restaurant: "b", role: "waiter" }),

  superadmin: acc({ email: "superadmin@example.test", fullName: "DEMO Superadmin", platformRole: "superadmin" }),
  support: acc({ email: "support@example.test", fullName: "DEMO Suporte", platformRole: "support" }),
  /** Usuário autenticado sem nenhum vínculo. */
  plain: acc({ email: "plain@example.test", fullName: "DEMO Usuario Sem Vinculo" }),
} satisfies Record<string, AccountDef>;

export type AccountKey = keyof typeof ACCOUNTS;
export const ACCOUNT_KEYS = Object.keys(ACCOUNTS) as AccountKey[];

export const DEMO_RESTAURANTS = {
  a: { id: "00000000-0000-4000-8000-0000000000a1", name: "DEMO Restaurante A", slug: "demo-a" },
  b: { id: "00000000-0000-4000-8000-0000000000b1", name: "DEMO Restaurante B", slug: "demo-b" },
} as const;

/** Prefixo dos usuários/restaurantes efêmeros criados pelos testes (o seed limpa sobras). */
export const EPHEMERAL_PREFIX = "zz-";
export const EPHEMERAL_EMAIL_DOMAIN = "@example.test";
