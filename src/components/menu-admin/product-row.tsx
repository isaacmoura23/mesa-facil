"use client";

import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/format";
import { publicImageUrl } from "@/lib/storage";
import { BADGE_LABELS, BADGE_TONES, knownBadges } from "@/modules/menu/badges";
import { countLabel } from "@/modules/menu/format";
import type { MenuProduct, MenuVariant } from "@/modules/menu/types";
import { Switch } from "./fields";
import { IconButton } from "./icon-button";
import { ProductThumb } from "./product-thumb";
import { ReorderButtons } from "./reorder-buttons";

type ProductRowProps = {
  product: MenuProduct;
  /** Tamanhos ativos do produto (vazio = preço único). */
  variants: MenuVariant[];
  groupCount: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Reordenar fica desligado enquanto há busca/filtro (a lista estaria incompleta). */
  reorderDisabled: boolean;
  disabled: boolean;
  onToggleActive: (next: boolean) => void;
  onToggleAvailable: (next: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function ProductRow({
  product,
  variants,
  groupCount,
  canMoveUp,
  canMoveDown,
  reorderDisabled,
  disabled,
  onToggleActive,
  onToggleAvailable,
  onMove,
  onEdit,
  onDelete,
}: ProductRowProps) {
  const badges = knownBadges(product.badges);
  // A vitrine usa o menor preço entre os tamanhos disponíveis (ou entre todos, se nenhum estiver).
  const availablePrices = variants.filter((variant) => variant.is_available).map((variant) => variant.price_cents);
  const allPrices = variants.map((variant) => variant.price_cents);
  const priced = availablePrices.length > 0 ? availablePrices : allPrices;
  const startingPrice = priced.length > 0 ? Math.min(...priced) : product.price_cents;

  return (
    <li className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ProductThumb url={publicImageUrl(product.image_path)} name={`Imagem de ${product.name}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium text-fg">{product.name}</p>
            {!product.is_active ? <Badge tone="warning">Oculto</Badge> : null}
            {product.is_active && !product.is_available ? <Badge tone="danger">Indisponível</Badge> : null}
          </div>
          {badges.length > 0 ? (
            <ul aria-label="Selos" className="mt-1.5 flex flex-wrap gap-1.5">
              {badges.map((badge) => (
                <li key={badge}>
                  <Badge tone={BADGE_TONES[badge]}>{BADGE_LABELS[badge]}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {product.description ? (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted">{product.description}</p>
          ) : null}
          <p className="mt-1 text-sm text-muted">
            {variants.length > 0 ? <span>a partir de </span> : null}
            <span className="font-semibold text-fg tabular-nums">{formatCents(startingPrice)}</span>
            {variants.length > 0 ? <span>, {countLabel(variants.length, "tamanho", "tamanhos")}</span> : null}
            {groupCount > 0 ? <span>, {countLabel(groupCount, "grupo de adicionais", "grupos de adicionais")}</span> : null}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:justify-end">
        <Switch label="Visível" checked={product.is_active} disabled={disabled} onChange={onToggleActive} />
        <Switch label="Disponível" checked={product.is_available} disabled={disabled} onChange={onToggleAvailable} />
        <div className="flex items-center">
          <ReorderButtons
            name={product.name}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            disabled={disabled || reorderDisabled}
            onMove={onMove}
          />
          <IconButton label={`Editar ${product.name}`} disabled={disabled} onClick={onEdit}>
            <Pencil aria-hidden="true" />
          </IconButton>
          <IconButton label={`Excluir ${product.name}`} tone="danger" disabled={disabled} onClick={onDelete}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </li>
  );
}
