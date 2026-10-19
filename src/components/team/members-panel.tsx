"use client";

import { useState } from "react";
import { Copy, KeyRound, MailPlus, RefreshCw, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";
import { useConfirm } from "@/components/menu-admin/use-confirm";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { resendInviteAction, revokeMemberAction } from "@/modules/team/actions";
import { formatDate, formatDateTime } from "@/modules/team/audit";
import type { TeamMember } from "@/modules/team/types";
import { InviteDialog } from "./invite-dialog";
import { PermissionsDialog } from "./permissions-dialog";
import { RoleDialog } from "./role-dialog";
import { displayEmail, displayName, initialsOf, roleLabel, sortMembers } from "./team-ui";

type MembersPanelProps = {
  slug: string;
  restaurantName: string;
  members: TeamMember[];
  currentUserId: string;
};

const STATUS_TONE: Record<TeamMember["status"], BadgeTone> = {
  active: "accent",
  invited: "warning",
  revoked: "neutral",
};

const STATUS_LABEL: Record<TeamMember["status"], string> = {
  active: "Ativo",
  invited: "Convite pendente",
  revoked: "Acesso revogado",
};

export function MembersPanel({ slug, restaurantName, members, currentUserId }: MembersPanelProps) {
  const { run, isBusy } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const { toast } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleFor, setRoleFor] = useState<string | null>(null);
  const [permsFor, setPermsFor] = useState<string | null>(null);

  const sorted = sortMembers(members);
  const active = sorted.filter((member) => member.status === "active");
  const pending = sorted.filter((member) => member.status === "invited");
  const revoked = sorted.filter((member) => member.status === "revoked");

  const roleMember = members.find((member) => member.membership_id === roleFor) ?? null;
  const permsMember = members.find((member) => member.membership_id === permsFor) ?? null;
  const isSelf = (member: TeamMember) => member.user_id !== null && member.user_id === currentUserId;

  function revoke(member: TeamMember) {
    const isInvite = member.status === "invited";
    confirm({
      title: isInvite ? "Cancelar este convite?" : "Revogar o acesso?",
      description: isInvite
        ? `O convite para ${displayEmail(member) ?? "esta pessoa"} deixa de valer. Você pode convidar de novo depois.`
        : `${displayName(member)} perde o acesso ao painel e à operação imediatamente. Você pode convidar a pessoa de novo depois.`,
      confirmLabel: isInvite ? "Cancelar convite" : "Revogar acesso",
      tone: "danger",
      onConfirm: async () => {
        await run(() => revokeMemberAction(slug, member.membership_id), { key: member.membership_id });
      },
    });
  }

  async function resend(member: TeamMember) {
    await run(() => resendInviteAction(slug, member.membership_id), { key: member.membership_id });
  }

  async function copyInstructions(member: TeamMember) {
    const email = displayEmail(member) ?? "";
    const text =
      `Você foi convidado(a) para a equipe de ${restaurantName} como ${roleLabel(member.role)}. ` +
      `Acesse ${window.location.origin}/entrar, cadastre-se (ou entre) com o e-mail ${email}, confirme o e-mail e aceite o convite.`;
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Instruções copiadas", tone: "success" });
    } catch {
      toast({ title: "Não foi possível copiar", description: "Copie manualmente: peça para a pessoa entrar em /entrar com este e-mail.", tone: "danger" });
    }
  }

  const readOnlyPerms = permsMember ? permsMember.role === "owner" || isSelf(permsMember) : true;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Você monitora o restaurante e a equipe opera. Convide pessoas, defina a função de cada uma e ajuste
          permissões só quando o padrão da função não servir.
        </p>
        <Button onClick={() => setInviteOpen(true)} className="self-start sm:self-auto">
          <UserPlus aria-hidden="true" className="size-4" />
          Convidar pessoa
        </Button>
      </div>

      {pending.length > 0 ? (
        <section aria-labelledby="pending-title" className="rounded-card border border-warning-soft-fg/30 bg-warning-soft p-4 sm:p-5">
          <h2 id="pending-title" className="flex items-center gap-2 text-base font-semibold text-warning-soft-fg">
            <MailPlus aria-hidden="true" className="size-4" />
            Convites pendentes ({pending.length})
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-warning-soft-fg">
            Nenhum e-mail é enviado. Peça para cada pessoa se cadastrar em <strong>/entrar</strong> com o e-mail
            indicado, confirmar o e-mail e aceitar o convite.
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {pending.map((member) => (
              <li key={member.membership_id} className="flex flex-col gap-3 rounded-control bg-surface p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">{displayEmail(member)}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {roleLabel(member.role)}
                    {member.created_at ? ` - convidado em ${formatDate(member.created_at)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copyInstructions(member)}>
                    <Copy aria-hidden="true" className="size-4" />
                    Copiar instruções
                  </Button>
                  <Button size="sm" variant="secondary" loading={isBusy(member.membership_id)} onClick={() => void resend(member)}>
                    {isBusy(member.membership_id) ? null : <RefreshCw aria-hidden="true" className="size-4" />}
                    Renovar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => revoke(member)} disabled={isBusy(member.membership_id)}>
                    Cancelar convite
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="active-title">
        <h2 id="active-title" className="mb-3 text-base font-semibold text-fg">
          Integrantes ({active.length})
        </h2>
        {active.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="Ainda não há integrantes ativos"
            description="Convide a primeira pessoa da equipe. Ela aparece aqui depois de aceitar o convite."
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {active.map((member) => {
              const self = isSelf(member);
              const owner = member.role === "owner";
              const busy = isBusy(member.membership_id);
              return (
                <li key={member.membership_id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-soft-fg"
                    >
                      {initialsOf(member)}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="truncate text-sm font-semibold text-fg">{displayName(member)}</p>
                        {self ? <Badge tone="info">Você</Badge> : null}
                        <Badge tone={owner ? "accent" : "neutral"}>{roleLabel(member.role)}</Badge>
                        <Badge tone={STATUS_TONE[member.status]}>{STATUS_LABEL[member.status]}</Badge>
                        {member.overrides.length > 0 ? (
                          <Badge tone="warning">
                            {member.overrides.length} {member.overrides.length === 1 ? "ajuste" : "ajustes"}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-sm text-muted">{displayEmail(member) ?? "E-mail indisponível"}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {member.permissions.length} permissões -{" "}
                        {member.last_sign_in_at ? `último acesso em ${formatDateTime(member.last_sign_in_at)}` : "ainda não acessou"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <Button size="sm" variant="secondary" onClick={() => setPermsFor(member.membership_id)}>
                      {owner || self ? <ShieldCheck aria-hidden="true" className="size-4" /> : <KeyRound aria-hidden="true" className="size-4" />}
                      {owner || self ? "Ver permissões" : "Permissões"}
                    </Button>
                    {!owner && !self ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => setRoleFor(member.membership_id)} disabled={busy}>
                          Função
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => revoke(member)} loading={busy} className="text-danger hover:bg-danger-soft">
                          {busy ? null : <UserMinus aria-hidden="true" className="size-4" />}
                          Revogar
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {revoked.length > 0 ? (
        <details className="rounded-card border border-line bg-surface">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-muted hover:text-fg">
            Acessos revogados ({revoked.length})
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {revoked.map((member) => (
              <li key={member.membership_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{displayName(member)}</p>
                  <p className="truncate text-xs text-muted">
                    {displayEmail(member) ?? "E-mail indisponível"} - {roleLabel(member.role)}
                  </p>
                </div>
                <Button size="sm" variant="secondary" loading={isBusy(member.membership_id)} onClick={() => void resend(member)}>
                  Convidar de novo
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <InviteDialog slug={slug} open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <RoleDialog slug={slug} member={roleMember} onClose={() => setRoleFor(null)} />
      <PermissionsDialog slug={slug} member={permsMember} readOnly={readOnlyPerms} onClose={() => setPermsFor(null)} />
      {dialog}
    </div>
  );
}
