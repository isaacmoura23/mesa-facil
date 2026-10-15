"use client";

import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { Switch } from "./fields";
import { IconButton } from "./icon-button";
import { ReorderButtons } from "./reorder-buttons";
import { useConfirm } from "./use-confirm";
import {
  MAX_VARIANTS,
  ensureDefault,
  moveDraft,
  newVariantDraft,
  type VariantDraft,
} from "./variant-drafts";

type VariantsEditorProps = {
  drafts: VariantDraft[];
  onChange: (next: VariantDraft[]) => void;
  /** Erros por chave `variants`, `variants.<i>.name`, `variants.<i>.price`. */
  errors: Record<string, string>;
  disabled?: boolean;
};

/**
 * Lista editável de tamanhos (P, M, G...). A ordem, o padrão e a remoção só
 * valem depois de salvar o produto. Regra: com tamanhos, exatamente um é o padrão.
 */
export function VariantsEditor({ drafts, onChange, errors, disabled = false }: VariantsEditorProps) {
  const radioName = useId();
  const { confirm, dialog } = useConfirm();
  const atLimit = drafts.length >= MAX_VARIANTS;

  function update(key: string, patch: Partial<VariantDraft>) {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  function makeDefault(key: string) {
    onChange(drafts.map((draft) => ({ ...draft, isDefault: draft.key === key })));
  }

  function add() {
    if (atLimit) return;
    onChange([...drafts, newVariantDraft(drafts.length === 0)]);
  }

  function remove(draft: VariantDraft) {
    const apply = () => onChange(ensureDefault(drafts.filter((item) => item.key !== draft.key)));
    if (!draft.id) {
      apply();
      return;
    }
    confirm({
      title: `Remover o tamanho "${draft.name.trim() || "sem nome"}"?`,
      description:
        "A remoção só vale quando você salvar o produto. Se este tamanho já foi vendido, ele não é apagado: fica desativado para preservar o histórico de pedidos (desative em vez de excluir).",
      confirmLabel: "Remover tamanho",
      tone: "danger",
      onConfirm: async () => apply(),
    });
  }

  return (
    <>
      <fieldset className="rounded-control border border-line p-3" disabled={disabled}>
        <legend className="px-1 text-sm font-medium text-fg">Tamanhos (opcional)</legend>
        <p className="mb-3 text-sm text-muted">
          Para vender por tamanho (ex.: P, M e G), cadastre cada um com o seu preço. O cliente precisa
          escolher um, e o cardápio mostra “a partir de” o menor preço.
        </p>

        {drafts.length === 0 ? (
          <p className="mb-3 rounded-control bg-surface-2 px-3 py-2 text-sm text-muted">
            Nenhum tamanho. O produto é vendido por um preço único.
          </p>
        ) : (
          <ul className="mb-3 flex flex-col gap-3">
            {drafts.map((draft, index) => {
              const nameError = errors[`variants.${index}.name`];
              const priceError = errors[`variants.${index}.price`];
              const label = draft.name.trim() || `tamanho ${index + 1}`;
              return (
                <li
                  key={draft.key}
                  role="group"
                  aria-label={`Tamanho ${index + 1}`}
                  className="rounded-control border border-line bg-surface-2/40 p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9.5rem]">
                    <TextField
                      label="Nome"
                      required
                      maxLength={40}
                      placeholder="Ex.: Grande"
                      value={draft.name}
                      onChange={(event) => update(draft.key, { name: event.target.value })}
                      error={nameError}
                      autoComplete="off"
                    />
                    <TextField
                      label="Preço (R$)"
                      required
                      inputMode="decimal"
                      placeholder="0,00"
                      value={draft.price}
                      onChange={(event) => update(draft.key, { price: event.target.value })}
                      error={priceError}
                      autoComplete="off"
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-fg">
                      <input
                        type="radio"
                        name={radioName}
                        checked={draft.isDefault}
                        onChange={() => makeDefault(draft.key)}
                        className="size-5 accent-(--accent)"
                      />
                      Padrão
                    </label>
                    <Switch
                      label="Disponível"
                      checked={draft.isAvailable}
                      onChange={(checked) => update(draft.key, { isAvailable: checked })}
                    />
                    <div className="ml-auto flex items-center">
                      <ReorderButtons
                        name={label}
                        canMoveUp={index > 0}
                        canMoveDown={index < drafts.length - 1}
                        onMove={(direction) => onChange(moveDraft(drafts, index, direction))}
                      />
                      <IconButton label={`Remover ${label}`} tone="danger" onClick={() => remove(draft)}>
                        <Trash2 aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {errors.variants ? (
          <p role="alert" className="mb-3 text-sm font-medium text-danger">
            {errors.variants}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={add} disabled={atLimit}>
            <Plus aria-hidden="true" className="size-4" />
            {drafts.length === 0 ? "Adicionar tamanhos" : "Adicionar tamanho"}
          </Button>
          <span className="text-xs text-muted" aria-live="polite">
            {drafts.length} de {MAX_VARIANTS}
          </span>
        </div>
      </fieldset>
      {dialog}
    </>
  );
}
