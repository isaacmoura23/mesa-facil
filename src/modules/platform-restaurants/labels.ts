import { ROLE_LABELS } from "@/lib/auth/permissions";
import type { BadgeTone } from "@/components/ui/badge";

export const RESTAURANT_STATUS_LABEL: Record<string, string> = {
  pending: "Aguardando aprovação",
  active: "Ativo",
  suspended: "Suspenso",
};
export const RESTAURANT_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  active: "accent",
  suspended: "danger",
};

export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  trial: "Em teste",
  active: "Ativa",
  past_due: "Em atraso",
  cancelled: "Cancelada",
};
export const SUBSCRIPTION_STATUS_TONE: Record<string, BadgeTone> = {
  trial: "info",
  active: "accent",
  past_due: "warning",
  cancelled: "neutral",
};

export const MEMBER_STATUS_LABEL: Record<string, string> = {
  active: "Ativo",
  invited: "Convidado",
  revoked: "Revogado",
};

export function roleLabel(role: string | null): string {
  if (!role) return "Sem papel";
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as keyof typeof ROLE_LABELS] : role;
}

export const SUPPORT_READONLY_REASON =
  "Seu perfil é de suporte (somente leitura). Esta ação exige um superadministrador.";

/** Ações de auditoria específicas da plataforma (as demais vêm de `describeAudit`). */
export function describePlatformAudit(action: string, metadata: Record<string, unknown>): string | null {
  const reason = typeof metadata.reason === "string" && metadata.reason.trim() ? metadata.reason.trim().slice(0, 200) : null;
  switch (action) {
    case "platform.restaurant_created":
      return "Restaurante criado pela plataforma";
    case "platform.restaurant_status_changed": {
      const to = typeof metadata.status_to === "string" ? metadata.status_to : null;
      const label = to === "suspended" ? "Restaurante suspenso" : to === "active" ? "Restaurante reativado" : "Situação do restaurante alterada";
      return reason ? `${label}. Motivo: ${reason}` : label;
    }
    case "support.session_opened":
      return reason ? `Sessão de suporte aberta. Justificativa: ${reason}` : "Sessão de suporte aberta";
    default:
      return null;
  }
}
