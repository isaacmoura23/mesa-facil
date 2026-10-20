import { describeAudit, safeMetadataEntries } from "@/modules/team/audit";
import { csvText } from "@/modules/reports/csv";
import type { AuditEntry } from "./types";

export { safeMetadataEntries };

export const AUDIT_PREFIXES = [
  { value: "", label: "Todas as ações" },
  { value: "platform.", label: "Plataforma (planos, assinaturas, configurações)" },
  { value: "support.", label: "Suporte" },
  { value: "restaurant.", label: "Restaurantes" },
  { value: "member.", label: "Equipe dos restaurantes" },
  { value: "order", label: "Pedidos" },
  { value: "tab.", label: "Comandas" },
  { value: "payment.", label: "Pagamentos" },
  { value: "settings.", label: "Configurações dos restaurantes" },
] as const;

function text(value: unknown, max = 80): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

function statusName(value: unknown): string {
  switch (value) {
    case "trial":
    case "trialing":
      return "teste";
    case "active":
      return "ativa";
    case "past_due":
      return "em atraso";
    case "cancelled":
    case "canceled":
      return "cancelada";
    case "suspended":
      return "suspenso";
    default:
      return "outro estado";
  }
}

type Describe = (metadata: Record<string, unknown>) => string;

const PLATFORM_DESCRIBERS: Record<string, Describe> = {
  "platform.plan_created": (m) => `Criou o plano ${text(m.code) ?? text(m.name) ?? ""}`.trim(),
  "platform.plan_updated": (m) => `Atualizou o plano ${text(m.code) ?? text(m.name) ?? ""}`.trim(),
  "platform.plan_upserted": (m) => `Salvou o plano ${text(m.code) ?? text(m.name) ?? ""}`.trim(),
  "platform.subscription_changed": (m) => `Alterou uma assinatura (${statusName(m.status_to ?? m.status)})`,
  "platform.subscription_note": () => "Registrou uma nota interna de assinatura",
  "platform.ticket_note": () => "Registrou uma nota interna de ticket",
  "platform.subscription_set": (m) => `Alterou uma assinatura (${statusName(m.status_to ?? m.status)})`,
  "platform.subscription_updated": (m) => `Alterou uma assinatura (${statusName(m.status_to ?? m.status)})`,
  "platform.setting_updated": (m) => `Alterou a configuração ${text(m.key) ?? "da plataforma"}`,
  "platform.ticket_updated": () => "Atualizou um ticket de suporte",
  "platform.restaurant_created": () => "Criou um restaurante",
  "platform.restaurant_status_changed": (m) => `Alterou o estado de um restaurante para ${statusName(m.status_to ?? m.status ?? m.to)}`,
  "support.session_opened": () => "Abriu uma sessão de suporte (somente leitura)",
  "support.session_closed": () => "Encerrou uma sessão de suporte",
  "support.overview_viewed": () => "Consultou a visão de suporte de um restaurante",
};

export function describePlatformAudit(action: string, metadata: Record<string, unknown>): { text: string; known: boolean } {
  const describe = Object.hasOwn(PLATFORM_DESCRIBERS, action) ? PLATFORM_DESCRIBERS[action] : undefined;
  if (describe) return { text: describe(metadata), known: true };
  return describeAudit(action, metadata);
}

export const CSV_LIMIT = 5000;

/** CSV da auditoria: ";", BOM, neutraliza fórmulas e só exporta metadata não sensível. */
export function buildAuditCsv(rows: AuditEntry[], truncated: boolean): string {
  const header = ["Data", "Ator", "Restaurante", "Ação", "Descrição", "Detalhes"].map(csvText).join(";");
  const lines = [header];
  for (const row of rows) {
    const { text: description } = describePlatformAudit(row.action, row.metadata);
    const details = safeMetadataEntries(row.metadata)
      .map((entry) => `${entry.key}=${entry.value}`)
      .join(", ");
    lines.push(
      [row.createdAt, row.actorName ?? (row.actorId ? "Usuário" : "Sistema"), row.restaurantName ?? "", row.action, description, details]
        .map(csvText)
        .join(";"),
    );
  }
  if (truncated) lines.push(csvText(`Aviso: resultado limitado a ${CSV_LIMIT} linhas.`));
  return `﻿${lines.join("\r\n")}\r\n`;
}
