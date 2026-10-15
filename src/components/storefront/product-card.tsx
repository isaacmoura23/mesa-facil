"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { useCart } from "@/modules/storefront/cart-context";
import { hasVariants, isOrderable } from "@/modules/storefront/product";
import type { MenuProduct } from "@/modules/storefront/schemas";
import { ProductBadges } from "./product-badges";
import { ProductImage, hasProductImage } from "./product-image";

type ProductCardProps = {
  slug: string;
  product: MenuProduct;
};

/**
 * Cartão de produto. O cartão inteiro leva ao detalhe (link esticado); o
 * botão "+" adiciona direto só quando o item não tem tamanhos nem grupos de
 * adicionais. Com tamanhos mostra "a partir de" (menor preço disponível).
 * Itens indisponíveis ficam marcados e sem botão de adicionar.
 */
export function ProductCard({ slug, product }: ProductCardProps) {
  const { addLine } = useCart();
  const { toast } = useToast();
  const hasGroups = product.modifierGroups.length > 0;
  const sized = hasVariants(product);
  const orderable = isOrderable(product);
  const image = hasProductImage(product.imagePath);
  const href = `/r/${encodeURIComponent(slug)}/produto/${product.id}`;

  function quickAdd() {
    addLine({
      productId: product.id,
      variantId: null,
      quantity: 1,
      modifierIds: [],
      notes: "",
      snapshot: {
        name: product.name,
        variantName: null,
        unitPriceCents: product.priceCents,
        imagePath: product.imagePath,
        modifiers: [],
      },
    });
    toast({ title: "Adicionado ao carrinho", description: product.name, tone: "success", duration: 2500 });
  }

  return (
    <li
      className={cn(
        "relative flex gap-3 rounded-card border border-line bg-surface p-3 shadow-card transition-colors hover:border-line-strong sm:p-4",
        !orderable && "bg-surface-2/60",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 flex-col", !orderable && "opacity-70")}>
        <h3 className="text-base font-semibold leading-snug text-fg">
          <Link
            href={href}
            className="rounded-control after:absolute after:inset-0 after:rounded-card focus-visible:outline-offset-4"
          >
            {product.name}
          </Link>
        </h3>
        <ProductBadges badges={product.badges} className="mt-1.5 flex flex-wrap gap-1.5" />
        {product.description ? (
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{product.description}</p>
        ) : null}
        <div className="mt-auto flex items-center gap-2 pt-3">
          <p className="text-base font-semibold tabular-nums text-fg">
            {sized ? <span className="mr-1 text-sm font-normal text-muted">a partir de</span> : null}
            {formatCents(product.priceCents)}
          </p>
          {!orderable ? <Badge tone="neutral">Indisponível</Badge> : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end justify-between gap-2">
        {image ? (
          <div className="relative size-24 overflow-hidden rounded-control bg-surface-2 sm:size-28">
            <ProductImage
              path={product.imagePath}
              alt=""
              sizes="(min-width: 640px) 112px, 96px"
              className={cn(!orderable && "grayscale")}
            />
          </div>
        ) : null}
        {orderable && !hasGroups && !sized ? (
          <button
            type="button"
            onClick={quickAdd}
            aria-label={`Adicionar ${product.name} ao carrinho`}
            className="relative z-10 ml-auto flex size-11 items-center justify-center rounded-control bg-accent text-accent-fg transition-colors hover:bg-accent-hover active:translate-y-px"
          >
            <Plus aria-hidden="true" className="size-5" />
          </button>
        ) : null}
        {orderable && (hasGroups || sized) ? (
          <span aria-hidden="true" className="ml-auto text-sm font-medium text-accent">
            {sized ? "Escolher tamanho" : "Personalizar"}
          </span>
        ) : null}
      </div>
    </li>
  );
}
