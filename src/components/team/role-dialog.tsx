"use client";

import { useState, type FormEvent } from "react";
import { FormActions, FormDialog, FormError } from "@/components/menu-admin/form-dialog";
import { SelectField } from "@/components/menu-admin/fields";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Alert } from "@/components/ui/alert";
import { changeMemberRoleAction } from "@/modules/team/actions";
import { ASSIGNABLE_ROLES, type AssignableRole, type TeamMember } from "@/modules/team/types";
import { ROLE_HELP, displayName, roleLabel } from "./team-ui";

type RoleDialogProps = {
  slug: string;
  member: TeamMember | null;
  onClose: () => void;
};

export function RoleDialog({ slug, member, onClose }: RoleDialogProps) {
  const { run, pending } = useMenuAction();
  return (
    <FormDialog
      open={member !== null}
      title="Alterar função"
      description={member ? `Defina a nova função de ${displayName(member)}.` : undefined}
      locked={pending}
      onClose={onClose}
    >
      {member ? <RoleForm key={member.membership_id} slug={slug} member={member} run={run} pending={pending} onClose={onClose} /> : null}
    </FormDialog>
  );
}

function RoleForm({
  slug,
  member,
  run,
  pending,
  onClose,
}: {
  slug: string;
  member: TeamMember;
  run: ReturnType<typeof useMenuAction>["run"];
  pending: boolean;
  onClose: () => void;
}) {
  const initial = (ASSIGNABLE_ROLES as readonly string[]).includes(member.role) ? (member.role as AssignableRole) : "waiter";
  const [role, setRole] = useState<AssignableRole>(initial);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (role === member.role) {
      onClose();
      return;
    }
    const result = await run(() => changeMemberRoleAction(slug, member.membership_id, role), { inlineError: true });
    if (result.ok) onClose();
    else setError(result.message);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <SelectField
        label="Função"
        value={role}
        onChange={(event) => setRole(event.target.value as AssignableRole)}
        disabled={pending}
        hint={ROLE_HELP[role]}
      >
        {ASSIGNABLE_ROLES.map((item) => (
          <option key={item} value={item}>
            {roleLabel(item)}
          </option>
        ))}
      </SelectField>
      {member.overrides.length > 0 ? (
        <Alert tone="warning" title="Permissões personalizadas serão removidas">
          Esta pessoa tem {member.overrides.length} {member.overrides.length === 1 ? "permissão ajustada" : "permissões ajustadas"}.
          Ao trocar de função, tudo volta ao padrão da nova função.
        </Alert>
      ) : null}
      <FormError message={error} />
      <FormActions pending={pending} submitLabel="Salvar função" onCancel={onClose} />
    </form>
  );
}
