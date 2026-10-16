"use client";

import { useState, type FormEvent } from "react";
import { FormActions, FormDialog, FormError } from "@/components/menu-admin/form-dialog";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { TextField } from "@/components/ui/input";
import { createTableAction, updateTableAction } from "@/modules/tables-admin/actions";
import {
  TABLE_CAPACITY_MAX,
  TABLE_NAME_MAX,
  fieldErrorsOf,
  tableFormSchema,
} from "@/modules/tables-admin/schemas";
import type { TableRow } from "@/modules/tables-admin/types";

type TableFormDialogProps = {
  open: boolean;
  slug: string;
  /** `null` = nova mesa. */
  table: TableRow | null;
  onClose: () => void;
};

export function TableFormDialog({ open, slug, table, onClose }: TableFormDialogProps) {
  return (
    <FormDialog
      open={open}
      title={table ? "Editar mesa" : "Nova mesa"}
      description={
        table
          ? "O nome e a capacidade aparecem para a equipe na Operação."
          : "Cadastre uma mesa do salão. O nome precisa ser único no restaurante."
      }
      onClose={onClose}
    >
      <TableForm slug={slug} table={table} onClose={onClose} />
    </FormDialog>
  );
}

function TableForm({ slug, table, onClose }: Omit<TableFormDialogProps, "open">) {
  const { run, pending } = useMenuAction();
  const [name, setName] = useState(table?.name ?? "");
  const [capacity, setCapacity] = useState(table?.capacity ? String(table.capacity) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const parsed = tableFormSchema.safeParse({ name, capacity });
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      return;
    }
    setErrors({});
    const result = await run(
      () =>
        table
          ? updateTableAction(slug, table.id, { name, capacity })
          : createTableAction(slug, { name, capacity }),
      { inlineError: true },
    );
    if (result.ok) {
      onClose();
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FormError message={formError} />
      <TextField
        label="Nome da mesa"
        name="name"
        required
        autoFocus
        autoComplete="off"
        maxLength={TABLE_NAME_MAX + 20}
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={errors.name}
        hint={`Até ${TABLE_NAME_MAX} caracteres. Ex.: Mesa 12, Varanda 3.`}
      />
      <TextField
        label="Capacidade (lugares)"
        name="capacity"
        required
        inputMode="numeric"
        autoComplete="off"
        value={capacity}
        onChange={(event) => setCapacity(event.target.value)}
        error={errors.capacity}
        hint={`De 1 a ${TABLE_CAPACITY_MAX} lugares.`}
      />
      <FormActions pending={pending} submitLabel={table ? "Salvar" : "Criar mesa"} onCancel={onClose} />
    </form>
  );
}
