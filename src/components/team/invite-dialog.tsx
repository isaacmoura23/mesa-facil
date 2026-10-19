"use client";

import { useState, type FormEvent } from "react";
import { FormActions, FormDialog, FormError } from "@/components/menu-admin/form-dialog";
import { SelectField } from "@/components/menu-admin/fields";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Alert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/input";
import { inviteMemberAction } from "@/modules/team/actions";
import { inviteSchema } from "@/modules/team/schemas";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@/modules/team/types";
import { ROLE_HELP, roleLabel } from "./team-ui";

type InviteDialogProps = {
  slug: string;
  open: boolean;
  onClose: () => void;
};

export function InviteDialog({ slug, open, onClose }: InviteDialogProps) {
  const { run, pending } = useMenuAction();
  return (
    <FormDialog
      open={open}
      title="Convidar pessoa"
      description="O convite fica pendente até a pessoa aceitar com a própria conta."
      locked={pending}
      onClose={onClose}
    >
      <InviteForm slug={slug} run={run} pending={pending} onClose={onClose} />
    </FormDialog>
  );
}

type RunFn = ReturnType<typeof useMenuAction>["run"];

function InviteForm({ slug, run, pending, onClose }: { slug: string; run: RunFn; pending: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("waiter");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = inviteSchema.safeParse({ email, role });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    const result = await run(() => inviteMemberAction(slug, parsed.data), { inlineError: true });
    if (result.ok) {
      onClose();
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <TextField
        label="E-mail da pessoa"
        type="email"
        name="email"
        autoComplete="off"
        inputMode="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={errors.email}
        disabled={pending}
      />
      <SelectField
        label="Função"
        required
        value={role}
        onChange={(event) => setRole(event.target.value as AssignableRole)}
        error={errors.role}
        disabled={pending}
        hint={ROLE_HELP[role]}
      >
        {ASSIGNABLE_ROLES.map((item) => (
          <option key={item} value={item}>
            {roleLabel(item)}
          </option>
        ))}
      </SelectField>
      <Alert tone="info" title="Como a pessoa entra">
        <p>
          Nenhum e-mail é enviado por enquanto. Peça para a pessoa se cadastrar (ou entrar) em{" "}
          <strong>/entrar</strong> usando exatamente <strong>este e-mail</strong>, confirmar o e-mail da conta e
          aceitar o convite. O proprietário não pode ser convidado.
        </p>
      </Alert>
      <FormError message={formError} />
      <FormActions pending={pending} submitLabel="Criar convite" onCancel={onClose} />
    </form>
  );
}
