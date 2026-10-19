"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Switch } from "@/components/menu-admin/fields";
import { FormDialog } from "@/components/menu-admin/form-dialog";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resetMemberPermissionsAction, setMemberPermissionAction } from "@/modules/team/actions";
import type { TeamMember } from "@/modules/team/types";
import {
  PERMISSION_GROUPS,
  defaultGranted,
  displayName,
  isOperational,
  permissionLabel,
  roleLabel,
} from "./team-ui";

type PermissionsDialogProps = {
  slug: string;
  member: TeamMember | null;
  /** Somente leitura: proprietário ou o próprio usuário. */
  readOnly: boolean;
  onClose: () => void;
};

export function PermissionsDialog({ slug, member, readOnly, onClose }: PermissionsDialogProps) {
  const { run, pending, isBusy } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [announce, setAnnounce] = useState("");

  const isOwner = member?.role === "owner";

  async function toggle(permission: string, label: string, next: boolean) {
    if (!member) return;
    const result = await run(() => setMemberPermissionAction(slug, member.membership_id, permission, next), {
      key: permission,
    });
    if (result.ok) setAnnounce(`${label}: ${next ? "concedida" : "removida"}.`);
  }

  function reset() {
    if (!member) return;
    confirm({
      title: "Voltar ao padrão da função?",
      description: `Remove os ${member.overrides.length} ajustes de ${displayName(member)} e restaura as permissões padrão de ${roleLabel(member.role)}.`,
      confirmLabel: "Voltar ao padrão",
      onConfirm: async () => {
        await run(() => resetMemberPermissionsAction(slug, member.membership_id), { key: "__reset__" });
      },
    });
  }

  return (
    <>
      <FormDialog
        open={member !== null}
        title={member ? `Permissões de ${displayName(member)}` : "Permissões"}
        description={member ? `Função: ${roleLabel(member.role)}` : undefined}
        locked={pending}
        onClose={onClose}
      >
        {member ? (
          <div className="flex flex-col gap-5">
            {isOwner ? (
              <Alert tone="info" title="Permissões do proprietário são fixas">
                O proprietário monitora e administra, mas nunca opera: pedidos, mesas, comandas, pagamentos e
                impressão ficam com a equipe.
              </Alert>
            ) : readOnly ? (
              <Alert tone="info" title="Você não altera o próprio acesso">
                Peça a outro proprietário, se houver, ou use outra conta para ajustar o seu vínculo.
              </Alert>
            ) : (
              <Alert tone="info" title="O dono monitora, a equipe opera">
                Marque só o que a pessoa precisa fazer. O padrão vem da função {roleLabel(member.role)} e os ajustes
                valem apenas para este integrante.
              </Alert>
            )}

            {PERMISSION_GROUPS.map((group) => (
              <section key={group.title} aria-labelledby={`perm-${group.title}`}>
                <h3 id={`perm-${group.title}`} className="mb-1 text-sm font-semibold text-fg">
                  {group.title}
                </h3>
                <ul className="divide-y divide-line rounded-control border border-line">
                  {group.items.map(({ key, hint }) => {
                    const granted = member.permissions.includes(key);
                    const standard = defaultGranted(member, key);
                    const customized = granted !== standard;
                    const label = permissionLabel(key);
                    const lockReason =
                      key === "team.manage"
                        ? "Não pode ser delegada: só o proprietário gerencia a equipe."
                        : isOwner && isOperational(key)
                          ? "Nunca concedida ao proprietário: o dono monitora, a equipe opera."
                          : null;
                    const locked = lockReason !== null || readOnly || isOwner;
                    return (
                      <li key={key} className="px-3 py-1.5">
                        {lockReason ? (
                          <div className="flex min-h-11 items-start gap-2.5 py-2 text-sm">
                            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-fg">
                                {label}
                                <span className="sr-only">
                                  {" "}
                                  (bloqueada: {granted ? "concedida" : "não concedida"})
                                </span>
                              </p>
                              <p className="text-xs text-muted">{lockReason}</p>
                            </div>
                            <Badge tone={granted ? "accent" : "neutral"}>{granted ? "Concedida" : "Bloqueada"}</Badge>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-3">
                            <Switch
                              checked={granted}
                              onChange={(next) => void toggle(key, label, next)}
                              label={label}
                              description={`${hint} Padrão da função: ${standard ? "concedida" : "não concedida"}.`}
                              disabled={locked || pending}
                              className="min-w-0 flex-1"
                            />
                            {isBusy(key) ? (
                              <Badge tone="info">Salvando</Badge>
                            ) : customized ? (
                              <Badge tone="warning">Personalizada</Badge>
                            ) : null}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <p role="status" className="sr-only">
              {announce}
            </p>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              {!isOwner && !readOnly ? (
                <Button variant="secondary" onClick={reset} disabled={pending || member.overrides.length === 0}>
                  Voltar ao padrão da função
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={onClose} disabled={pending}>
                Fechar
              </Button>
            </div>
          </div>
        ) : null}
      </FormDialog>
      {dialog}
    </>
  );
}
