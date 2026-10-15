"use client";

import { useId, useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publicImageUrl } from "@/lib/storage";
import { IMAGE_ACCEPT, IMAGE_RULES_TEXT, validateImageFile } from "@/modules/menu/image";
import { ProductThumb } from "./product-thumb";

type ProductImageFieldProps = {
  /** Caminho já salvo no produto (ou `null`). */
  currentPath: string | null;
  /** Arquivo escolhido e ainda não enviado. */
  file: File | null;
  /** O usuário pediu para remover a imagem atual. */
  removed: boolean;
  disabled?: boolean;
  onSelect: (file: File | null) => void;
  onRemove: () => void;
};

/**
 * Escolha de imagem do produto. O arquivo só é validado e pré-visualizado
 * aqui; o envio ao Storage acontece ao salvar o produto.
 */
export function ProductImageField({
  currentPath,
  file,
  removed,
  disabled,
  onSelect,
  onRemove,
}: ProductImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedUrl = removed ? null : publicImageUrl(currentPath);
  const shownUrl = file ? preview : savedUrl;
  const hasImage = Boolean(file) || Boolean(savedUrl);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!chosen) return;

    const problem = validateImageFile(chosen);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    const reader = new FileReader();
    reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(chosen);
    onSelect(chosen);
  }

  function handleRemove() {
    setError(null);
    setPreview(null);
    onSelect(null);
    onRemove();
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg" id={`${hintId}-label`}>
        Imagem do produto
      </span>
      <div className="flex items-center gap-4">
        <ProductThumb url={shownUrl} name="Pré-visualização da imagem" size="lg" />
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              aria-describedby={hintId}
            >
              <ImagePlus aria-hidden="true" className="size-4" />
              {hasImage ? "Trocar imagem" : "Escolher imagem"}
            </Button>
            {hasImage ? (
              <Button variant="ghost" size="sm" disabled={disabled} onClick={handleRemove}>
                <Trash2 aria-hidden="true" className="size-4" />
                Remover
              </Button>
            ) : null}
          </div>
          <p id={hintId} className="text-sm text-muted">
            {file ? `Selecionada: ${file.name}. ` : ""}
            {IMAGE_RULES_TEXT}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        onChange={handleChange}
        className="sr-only"
        tabIndex={-1}
        aria-labelledby={`${hintId}-label`}
      />
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
