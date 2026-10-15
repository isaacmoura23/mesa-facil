"use client";

import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/input";
import { PUBLIC_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/client";
import { saveProductAction } from "@/modules/menu/actions";
import { centsToInput } from "@/modules/menu/format";
import { buildProductImagePath, validateImageFile } from "@/modules/menu/image";
import { fieldErrorsOf, formToRecord, productSchema } from "@/modules/menu/schemas";
import { knownBadges, type ProductBadge } from "@/modules/menu/badges";
import type {
  ActionResult,
  MenuCategory,
  MenuProduct,
  MenuVariant,
  ModifierGroup,
} from "@/modules/menu/types";
import { BadgePicker } from "./badge-picker";
import { CheckRow, SelectField, Switch, TextAreaField } from "./fields";
import { FormActions, FormDialog, FormError } from "./form-dialog";
import { ProductImageField } from "./product-image-field";
import { useMenuAction } from "./use-menu-action";
import { VariantsEditor } from "./variants-editor";
import { draftsFromVariants, ensureDefault, serializeDrafts } from "./variant-drafts";

type ProductFormDialogProps = {
  open: boolean;
  slug: string;
  /** Só monta o caminho do arquivo; o servidor deriva o restaurante pelo guard. */
  restaurantId: string;
  /** `null` cria um produto novo. */
  product: MenuProduct | null;
  /** Categoria pré-selecionada ao criar. */
  defaultCategoryId?: string | null;
  categories: MenuCategory[];
  groups: ModifierGroup[];
  linkedGroupIds: string[];
  /** Tamanhos ativos do produto sendo editado. */
  variants: MenuVariant[];
  onClose: () => void;
};

export function ProductFormDialog(props: ProductFormDialogProps) {
  const { run, pending } = useMenuAction();
  const { open, product, onClose } = props;

  return (
    <FormDialog
      open={open}
      title={product ? "Editar produto" : "Novo produto"}
      description="As alterações aparecem no cardápio público assim que você salvar."
      locked={pending}
      onClose={onClose}
    >
      <ProductForm {...props} run={run} pending={pending} />
    </FormDialog>
  );
}

type ProductFormProps = ProductFormDialogProps & {
  run: (task: () => Promise<ActionResult>, options?: { inlineError?: boolean }) => Promise<ActionResult>;
  pending: boolean;
};

function ProductForm({
  slug,
  restaurantId,
  product,
  defaultCategoryId,
  categories,
  groups,
  linkedGroupIds,
  variants,
  onClose,
  run,
  pending,
}: ProductFormProps) {
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [isAvailable, setIsAvailable] = useState(product?.is_available ?? true);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(() => new Set(linkedGroupIds));
  const [variantDrafts, setVariantDrafts] = useState(() => ensureDefault(draftsFromVariants(variants)));
  const [badges, setBadges] = useState<ProductBadge[]>(() => knownBadges(product?.badges ?? []));
  const [priceText, setPriceText] = useState(product ? centsToInput(product.price_cents) : "");
  const [file, setFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const busy = pending || uploading;
  const hasVariants = variantDrafts.length > 0;

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  }

  async function uploadImage(chosen: File): Promise<{ path: string } | { error: string }> {
    const problem = validateImageFile(chosen);
    if (problem) return { error: problem };

    // Cliente do usuário: o RLS do Storage confere restaurante e permissão.
    const supabase = createClient();
    const path = buildProductImagePath(restaurantId, chosen.type);
    const { error } = await supabase.storage.from(PUBLIC_BUCKET).upload(path, chosen, {
      contentType: chosen.type,
      cacheControl: "31536000",
      upsert: false,
    });
    if (error) {
      return { error: "Não foi possível enviar a imagem. Verifique o arquivo e tente novamente." };
    }
    return { path };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("id", product?.id ?? "");
    formData.set("isActive", String(isActive));
    formData.set("isAvailable", String(isAvailable));
    formData.set("groupsSynced", "1");
    formData.set("price", hasVariants ? "" : priceText);
    formData.set("variants", serializeDrafts(variantDrafts));
    formData.set("badges", badges.join(","));
    for (const groupId of selectedGroups) formData.append("groupIds", groupId);

    const parsed = productSchema.safeParse(formToRecord(formData));
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);

    let uploadedPath: string | null = null;
    if (file) {
      setUploading(true);
      const uploaded = await uploadImage(file);
      setUploading(false);
      if ("error" in uploaded) {
        setErrors({ image: uploaded.error });
        return;
      }
      uploadedPath = uploaded.path;
      formData.set("imagePath", uploadedPath);
    } else if (removeImage) {
      formData.set("removeImage", "true");
    }

    const result = await run(() => saveProductAction(slug, formData), { inlineError: true });
    if (result.ok) {
      onClose();
      return;
    }

    if (uploadedPath) {
      // O produto não foi salvo: não deixa o arquivo órfão no bucket.
      void createClient().storage.from(PUBLIC_BUCKET).remove([uploadedPath]);
    }
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <TextField
        name="name"
        label="Nome do produto"
        required
        maxLength={160}
        defaultValue={product?.name ?? ""}
        error={errors.name}
        autoComplete="off"
        autoFocus
      />
      <TextAreaField
        name="description"
        label="Descrição (opcional)"
        maxLength={1000}
        defaultValue={product?.description ?? ""}
        error={errors.description}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {hasVariants ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-fg">Preço sem tamanho</p>
            <p className="rounded-control bg-surface-2 px-3 py-2.5 text-sm text-muted">
              Oculto: com tamanhos, o preço vem de cada tamanho e o cardápio mostra “a partir de” o menor.
            </p>
          </div>
        ) : (
          <TextField
            name="price"
            label="Preço (R$)"
            required
            inputMode="decimal"
            placeholder="0,00"
            hint="Ex.: 25,90. Para vender por tamanho, adicione tamanhos abaixo."
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            error={errors.price}
            autoComplete="off"
          />
        )}
        <SelectField
          name="categoryId"
          label="Categoria"
          defaultValue={product ? (product.category_id ?? "") : (defaultCategoryId ?? "")}
          error={errors.categoryId}
        >
          <option value="">Sem categoria</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
              {category.is_active ? "" : " (inativa)"}
            </option>
          ))}
        </SelectField>
      </div>

      <ProductImageField
        currentPath={product?.image_path ?? null}
        file={file}
        removed={removeImage}
        disabled={busy}
        onSelect={(chosen) => {
          setFile(chosen);
          if (chosen) setRemoveImage(false);
          setErrors((current) => ({ ...current, image: "" }));
        }}
        onRemove={() => setRemoveImage(true)}
      />
      {errors.image ? <p role="alert" className="-mt-2 text-sm font-medium text-danger">{errors.image}</p> : null}

      <VariantsEditor drafts={variantDrafts} onChange={setVariantDrafts} errors={errors} disabled={busy} />

      <BadgePicker value={badges} onChange={setBadges} error={errors.badges} disabled={busy} />

      <fieldset className="rounded-control border border-line p-3">
        <legend className="px-1 text-sm font-medium text-fg">Adicionais deste produto</legend>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">
            Nenhum grupo de adicionais criado ainda. Crie grupos na aba Adicionais para vinculá-los aqui.
          </p>
        ) : (
          <div className="flex max-h-48 flex-col overflow-y-auto">
            {groups.map((group) => (
              <CheckRow
                key={group.id}
                checked={selectedGroups.has(group.id)}
                onChange={(checked) => toggleGroup(group.id, checked)}
                label={group.is_active ? group.name : `${group.name} (inativo)`}
                hint={
                  group.min_selections > 0
                    ? `Obrigatório: escolher de ${group.min_selections} a ${group.max_selections}`
                    : `Opcional: até ${group.max_selections}`
                }
              />
            ))}
          </div>
        )}
      </fieldset>

      <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
        <Switch
          checked={isActive}
          onChange={setIsActive}
          label="Visível no cardápio"
          description="Desligue para ocultar sem apagar."
          disabled={busy}
        />
        <Switch
          checked={isAvailable}
          onChange={setIsAvailable}
          label="Disponível"
          description="Desligue quando acabar o estoque."
          disabled={busy}
        />
      </div>

      <FormError message={formError} />
      <FormActions pending={busy} submitLabel={product ? "Salvar alterações" : "Criar produto"} onCancel={onClose} />
    </form>
  );
}
