"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/input";
import { saveCategoryAction } from "@/modules/menu/actions";
import { categorySchema, fieldErrorsOf, formToRecord } from "@/modules/menu/schemas";
import type { MenuCategory } from "@/modules/menu/types";
import { TextAreaField } from "./fields";
import { FormActions, FormDialog, FormError } from "./form-dialog";
import { useMenuAction } from "./use-menu-action";

type CategoryFormDialogProps = {
  open: boolean;
  slug: string;
  /** `null` cria uma categoria nova. */
  category: MenuCategory | null;
  onClose: () => void;
};

export function CategoryFormDialog({ open, slug, category, onClose }: CategoryFormDialogProps) {
  const { run, pending } = useMenuAction();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function handleClose() {
    setErrors({});
    setFormError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("id", category?.id ?? "");

    const parsed = categorySchema.safeParse(formToRecord(formData));
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);
    const result = await run(() => saveCategoryAction(slug, formData), { inlineError: true });
    if (result.ok) handleClose();
    else {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? null : result.message);
    }
  }

  return (
    <FormDialog
      open={open}
      title={category ? "Editar categoria" : "Nova categoria"}
      description="As categorias agrupam os produtos no cardápio, na ordem em que aparecem aqui."
      locked={pending}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          name="name"
          label="Nome da categoria"
          required
          maxLength={120}
          defaultValue={category?.name ?? ""}
          error={errors.name}
          autoComplete="off"
          autoFocus
        />
        <TextAreaField
          name="description"
          label="Descrição (opcional)"
          maxLength={500}
          defaultValue={category?.description ?? ""}
          error={errors.description}
        />
        <FormError message={formError} />
        <FormActions pending={pending} submitLabel={category ? "Salvar alterações" : "Criar categoria"} onCancel={handleClose} />
      </form>
    </FormDialog>
  );
}
