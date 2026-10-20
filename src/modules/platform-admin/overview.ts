import { FULFILLMENT_LABELS } from "@/modules/operations/types";
import { isRec, num, str, type Rec } from "./normalize";

/** Visão de suporte (somente leitura) normalizada. Sem dados pessoais de clientes. */

export type OverviewOrder = {
  number: string;
  status: string;
  fulfillment: string;
  payment: string;
  totalCents: number;
  createdAt: string | null;
};

export type SupportOverview = {
  sessionId: string;
  reason: string;
  startedAt: string | null;
  expiresAt: string | null;
  restaurant: { name: string; slug: string | null; status: string | null; timezone: string | null };
  menu: { label: string; value: number }[];
  settings: { label: string; value: string }[];
  team: { role: string; status: string; name: string | null }[];
  orders: OverviewOrder[];
  tabs: { label: string; totalCents: number; openedAt: string | null }[];
};

const MENU_LABELS: [string, string][] = [
  ["categories", "Categorias"],
  ["categories_active", "Categorias ativas"],
  ["products", "Produtos"],
  ["products_active", "Produtos ativos"],
  ["products_available", "Produtos disponíveis"],
  ["tables", "Mesas"],
];

function list(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRec) : [];
}

function yesNo(value: unknown): string | null {
  return typeof value === "boolean" ? (value ? "Sim" : "Não") : null;
}

export function toOverview(data: Rec): SupportOverview | null {
  const session = isRec(data.session) ? data.session : null;
  const restaurant = isRec(data.restaurant) ? data.restaurant : null;
  if (!session || !restaurant) return null;
  const menu = isRec(data.menu) ? data.menu : {};
  const settings = isRec(data.settings) ? data.settings : {};

  const settingsRows: { label: string; value: string }[] = [];
  const accepts = yesNo(settings.accepts_orders);
  if (accepts) settingsRows.push({ label: "Aceita pedidos", value: accepts });
  const prep = num(settings, "prep_time_minutes");
  if (prep !== null) settingsRows.push({ label: "Tempo de preparo", value: `${prep} min` });
  const single = yesNo(settings.single_tab_per_table);
  if (single) settingsRows.push({ label: "Uma comanda por mesa", value: single });
  if (Array.isArray(settings.enabled_fulfillment_types)) {
    settingsRows.push({
      label: "Modalidades ativas",
      value: settings.enabled_fulfillment_types.filter((v): v is string => typeof v === "string")
        .map((v) => ((FULFILLMENT_LABELS as Record<string, string>)[v] ?? "Outra"))
        .join(", ") || "Nenhuma",
    });
  }

  return {
    sessionId: str(session, "id") ?? "",
    reason: str(session, "reason") ?? "",
    startedAt: str(session, "started_at"),
    expiresAt: str(session, "expires_at"),
    restaurant: {
      name: str(restaurant, "name") ?? "Restaurante",
      slug: str(restaurant, "slug"),
      status: str(restaurant, "status"),
      timezone: str(restaurant, "timezone"),
    },
    menu: MENU_LABELS.map(([key, label]) => ({ label, value: num(menu, key) ?? 0 })),
    settings: settingsRows,
    team: list(data.team).map((row) => ({
      role: str(row, "role") ?? "",
      status: str(row, "status") ?? "",
      name: str(row, "full_name"),
    })),
    orders: list(data.recent_orders).map((row) => ({
      number: String(row.order_number ?? ""),
      status: str(row, "status") ?? "",
      fulfillment: str(row, "fulfillment_type") ?? "",
      payment: str(row, "payment_status") ?? "",
      totalCents: num(row, "total_cents") ?? 0,
      createdAt: str(row, "created_at"),
    })),
    tabs: list(data.open_tabs).map((row) => ({
      label: str(row, "label") ?? "Comanda",
      totalCents: num(row, "total_cents") ?? 0,
      openedAt: str(row, "opened_at"),
    })),
  };
}
