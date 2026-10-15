"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/input";
import {
  saveModifierAction,
  saveModifierGroupAction,
  setGroupProductsAction,
} from "@/modules/menu/actions";
import { centsToInput } from "@/modules/menu/format";
import {
  fieldErrorsOf,
  formToRecord,
  modifierGroupSchema,
  modifierSchema,
} from "@/modules/menu/schemas";
import type { Modifier, ModifierGroup } from "@/modules/menu/types";
import { CheckRow, Switch } from "./fields";
import { FormActions, FormDialog, FormError } from "./form-dialog";
import { useMenuAction } from "./use-menu-action";

// ---------------------------------------------------------------------------
// Grupo de adicionais
// ---------------------------------------------------------------------------

type GroupDialogProps = {
  open: boolean;
  slug: string;
  /** `null` cria um grupo novo. */
  group: ModifierGroup | null;
  onClose: () => void;
};

export function ModifierGroupDialog({ open, slug, group, onClose }: GroupDialogProps) {
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
    formData.set("id", group?.id ?? "");

    const parsed = modifierGroupSchema.safeParse(formToRecord(formData));
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);
    const result = await run(() => saveModifierGroupAction(slug, formData), { inlineError: true });
    if (result.ok) handleClose();
    else {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? null : result.message);
    }
  }

  return (
    <FormDialog
      open={open}
      title={group ? "Editar grupo de adicionais" : "Novo grupo de adicionais"}
      description="Um grupo reúne opções que o cliente escolhe no produto, como Molhos ou Extras."
      locked={pending}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          name="name"
          label="Nome do grupo"
          required
          maxLength={120}
          defaultValue={group?.name ?? ""}
          error={errors.name}
          autoComplete="off"
          autoFocus
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="min"
            label="Mínimo de escolhas"
            required
            type="number"
            inputMode="numeric"
            min={0}
            max={50}
            step={1}
            hint="0 deixa a escolha opcional."
            defaultValue={group ? String(group.min_selections) : "0"}
            error={errors.min}
          />
          <TextField
            name="max"
            label="Máximo de escolhas"
            required
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            step={1}
            hint="Quantas opções o cliente pode marcar."
            defaultValue={group ? String(group.max_selections) : "1"}
            error={errors.max}
          />
        </div>
        <FormError message={formError} />
        <FormActions pending={pending} submitLabel={group ? "Salvar alterações" : "Criar grupo"} onCancel={handleClose} />
      </form>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Item de adicional
// ---------------------------------------------------------------------------

type ModifierDialogProps = {
  open: boolean;
  slug: string;
  group: ModifierGroup | null;
  /** `null` cria um item novo dentro de `group`. */
  modifier: Modifier | null;
  onClose: () => void;
};

export function ModifierDialog({ open, slug, group, modifier, onClose }: ModifierDialogProps) {
  const { run, pending } = useMenuAction();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [available, setAvailable] = useState(modifier?.is_available ?? true);

  function handleClose() {
    setErrors({});
    setFormError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!group) return;
    const formData = new FormData(event.currentTarget);
    formData.set("id", modifier?.id ?? "");
    formData.set("groupId", group.id);
    formData.set("isAvailable", String(available));

    const parsed = modifierSchema.safeParse(formToRecord(formData));
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);
    const result = await run(() => saveModifierAction(slug, formData), { inlineError: true });
    if (result.ok) handleClose();
    else {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? null : result.message);
    }
  }

  return (
    <FormDialog
      open={open}
      title={modifier ? "Editar item" : "Novo item"}
      description={group ? `Grupo: ${group.name}` : undefined}
      locked={pending}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          name="name"
          label="Nome do item"
          required
          maxLength={120}
          defaultValue={modifier?.name ?? ""}
          error={errors.name}
          autoComplete="off"
          autoFocus
        />
        <TextField
          name="price"
          label="Preço adicional (R$)"
          inputMode="decimal"
          placeholder="0,00"
          hint="Deixe em branco ou 0,00 para item sem custo. Ex.: 4,50"
          defaultValue={modifier ? centsToInput(modifier.price_delta_cents) : ""}
          error={errors.price}
          autoComplete="off"
        />
        <Switch
          checked={available}
          onChange={setAvailable}
          label="Disponível"
          description="Desligue quando acabar o ingrediente."
          disabled={pending}
        />
        <FormError message={formError} />
        <FormActions pending={pending} submitLabel={modifier ? "Salvar alterações" : "Adicionar item"} onCancel={handleClose} />
      </form>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Vincular grupo a produtos
// ---------------------------------------------------------------------------

type LinkProductsDialogProps = {
  open: boolean;
  slug: string;
  group: ModifierGroup | null;
  products: { id: string; name: string; hint?: string }[];
  linkedProductIds: string[];
  onClose: () => void;
};

export function LinkProductsDialog({
  open,
  slug,
  group,
  products,
  linkedProductIds,
  onClose,
}: LinkProductsDialogProps) {
  const { run, pending } = useMenuAction();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(linkedProductIds));
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!group) return;
    setFormError(null);
    const result = await run(() => setGroupProductsAction(slug, group.id, [...selected]), {
      inlineError: true,
    });
    if (result.ok) onClose();
    else setFormError(result.message);
  }

  return (
    <FormDialog
      open={open}
      title="Produtos com este grupo"
      description={group ? `Marque os produtos que oferecem "${group.name}".` : undefined}
      locked={pending}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {products.length === 0 ? (
          <p className="text-sm text-muted">Nenhum produto cadastrado ainda.</p>
        ) : (
          <div className="flex max-h-72 flex-col overflow-y-auto rounded-control border border-line p-1">
            {products.map((product) => (
              <CheckRow
                key={product.id}
                label={product.name}
                hint={product.hint}
                checked={selected.has(product.id)}
                onChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(product.id);
                    else next.delete(product.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
        <FormError message={formError} />
        <FormActions pending={pending} submitLabel="Salvar vínculos" onCancel={onClose} />
      </form>
    </FormDialog>
  );
}
