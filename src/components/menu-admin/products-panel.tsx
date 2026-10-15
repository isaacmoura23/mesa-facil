"use client";

import { useMemo, useState } from "react";
import { PackageOpen, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import {
  deleteProductAction,
  reorderMenuAction,
  setProductStateAction,
} from "@/modules/menu/actions";
import { countLabel, moveId } from "@/modules/menu/format";
import type {
  MenuCategory,
  MenuProduct,
  MenuVariant,
  ModifierGroup,
  ProductGroupLink,
} from "@/modules/menu/types";
import { ProductFormDialog } from "./product-form-dialog";
import { ProductRow } from "./product-row";
import { useConfirm } from "./use-confirm";
import { useMenuAction } from "./use-menu-action";

type ProductsPanelProps = {
  slug: string;
  restaurantId: string;
  categories: MenuCategory[];
  products: MenuProduct[];
  variants: MenuVariant[];
  groups: ModifierGroup[];
  links: ProductGroupLink[];
  onGoToCategories: () => void;
};

type ProductSection = {
  key: string;
  category: MenuCategory | null;
  items: MenuProduct[];
};

const UNCATEGORIZED = "none";

export function ProductsPanel({
  slug,
  restaurantId,
  categories,
  products,
  variants,
  groups,
  links,
  onGoToCategories,
}: ProductsPanelProps) {
  const { run, pending } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [editing, setEditing] = useState<{ product: MenuProduct | null } | null>(null);

  const filtering = query.trim() !== "" || categoryFilter !== "all";

  const sections = useMemo<ProductSection[]>(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    const matches = (product: MenuProduct) => {
      if (categoryFilter === UNCATEGORIZED && product.category_id !== null) return false;
      if (categoryFilter !== "all" && categoryFilter !== UNCATEGORIZED && product.category_id !== categoryFilter) {
        return false;
      }
      return normalizedQuery === "" || product.name.toLocaleLowerCase("pt-BR").includes(normalizedQuery);
    };

    const knownCategoryIds = new Set(categories.map((category) => category.id));
    const result: ProductSection[] = [];

    const loose = products.filter((product) => !product.category_id || !knownCategoryIds.has(product.category_id));
    const looseVisible = loose.filter(matches);
    if (looseVisible.length > 0 || (!filtering && loose.length > 0)) {
      result.push({ key: UNCATEGORIZED, category: null, items: looseVisible });
    }
    for (const category of categories) {
      const items = products.filter((product) => product.category_id === category.id);
      const visible = items.filter(matches);
      if (visible.length > 0 || (!filtering && items.length > 0)) {
        result.push({ key: category.id, category, items: visible });
      }
    }
    return result;
  }, [categories, products, query, categoryFilter, filtering]);

  const groupCountByProduct = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of links) counts.set(link.product_id, (counts.get(link.product_id) ?? 0) + 1);
    return counts;
  }, [links]);

  const variantsByProduct = useMemo(() => {
    const byProduct = new Map<string, MenuVariant[]>();
    for (const variant of variants) {
      const list = byProduct.get(variant.product_id) ?? [];
      list.push(variant);
      byProduct.set(variant.product_id, list);
    }
    return byProduct;
  }, [variants]);

  const linkedGroupIds = (productId: string) =>
    links.filter((link) => link.product_id === productId).map((link) => link.group_id);

  function toggleActive(product: MenuProduct, next: boolean) {
    if (next) {
      void run(() => setProductStateAction(slug, product.id, "is_active", true), { key: product.id });
      return;
    }
    confirm({
      title: `Desativar "${product.name}"?`,
      description:
        "O produto deixa de aparecer no cardápio público imediatamente, mas continua aqui e no histórico de pedidos. Você pode reativá-lo quando quiser.",
      confirmLabel: "Desativar produto",
      tone: "danger",
      onConfirm: () => run(() => setProductStateAction(slug, product.id, "is_active", false), { key: product.id }),
    });
  }

  function requestDelete(product: MenuProduct) {
    confirm({
      title: `Excluir "${product.name}"?`,
      description:
        "Esta ação não pode ser desfeita. Produtos que já foram vendidos não podem ser excluídos; nesse caso, desative-o para tirá-lo do cardápio.",
      confirmLabel: "Excluir produto",
      tone: "danger",
      onConfirm: () => run(() => deleteProductAction(slug, product.id), { key: product.id }),
    });
  }

  const hasProducts = products.length > 0;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] lg:max-w-2xl">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="menu-search" className="text-sm font-medium text-fg">
              Buscar produto
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              />
              <input
                id="menu-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nome do produto"
                autoComplete="off"
                className={inputStyles(false, "pl-9")}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="menu-category-filter" className="text-sm font-medium text-fg">
              Categoria
            </label>
            <select
              id="menu-category-filter"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className={inputStyles(false)}
            >
              <option value="all">Todas</option>
              <option value={UNCATEGORIZED}>Sem categoria</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button onClick={() => setEditing({ product: null })}>
          <Plus aria-hidden="true" className="size-4" />
          Novo produto
        </Button>
      </div>

      {filtering && hasProducts ? (
        <p className="mb-3 text-sm text-muted" role="status">
          Filtro ativo: a ordem dos produtos só pode ser alterada sem busca e sem filtro de categoria.
        </p>
      ) : null}

      {!hasProducts ? (
        <EmptyState
          icon={<PackageOpen />}
          title="Nenhum produto cadastrado"
          description={
            categories.length === 0
              ? "Comece criando uma categoria (por exemplo, Lanches) e depois cadastre seus produtos com preço e foto."
              : "Cadastre seu primeiro produto com nome, preço e, se quiser, uma foto."
          }
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => setEditing({ product: null })}>
                <Plus aria-hidden="true" className="size-4" />
                Cadastrar produto
              </Button>
              {categories.length === 0 ? (
                <Button variant="secondary" onClick={onGoToCategories}>
                  Criar categoria
                </Button>
              ) : null}
            </div>
          }
        />
      ) : sections.length === 0 ? (
        <EmptyState
          title="Nenhum produto encontrado"
          description="Nenhum produto corresponde à busca ou à categoria escolhida."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setCategoryFilter("all");
              }}
            >
              Limpar filtros
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {sections.map((section) => {
            const ids = section.items.map((product) => product.id);
            return (
              <section key={section.key} aria-labelledby={`cat-${section.key}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
                  <h2 id={`cat-${section.key}`} className="text-base font-semibold text-fg">
                    {section.category ? section.category.name : "Sem categoria"}
                  </h2>
                  <span className="text-sm text-muted">{countLabel(section.items.length, "produto", "produtos")}</span>
                  {section.category && !section.category.is_active ? (
                    <Badge tone="warning">Categoria inativa: produtos fora do cardápio</Badge>
                  ) : null}
                </div>
                <Card padded={false}>
                  {section.items.length === 0 ? (
                    <p className="p-4 text-sm text-muted">Nenhum produto nesta categoria.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {section.items.map((product, index) => (
                        <ProductRow
                          key={product.id}
                          product={product}
                          variants={variantsByProduct.get(product.id) ?? []}
                          groupCount={groupCountByProduct.get(product.id) ?? 0}
                          canMoveUp={index > 0}
                          canMoveDown={index < section.items.length - 1}
                          reorderDisabled={filtering}
                          disabled={pending}
                          onToggleActive={(next) => toggleActive(product, next)}
                          onToggleAvailable={(next) =>
                            void run(() => setProductStateAction(slug, product.id, "is_available", next), {
                              key: product.id,
                            })
                          }
                          onMove={(direction) =>
                            void run(() => reorderMenuAction(slug, "product", moveId(ids, index, direction)), {
                              key: product.id,
                            })
                          }
                          onEdit={() => setEditing({ product })}
                          onDelete={() => requestDelete(product)}
                        />
                      ))}
                    </ul>
                  )}
                </Card>
              </section>
            );
          })}
        </div>
      )}

      <ProductFormDialog
        open={editing !== null}
        slug={slug}
        restaurantId={restaurantId}
        product={editing?.product ?? null}
        defaultCategoryId={
          categoryFilter !== "all" && categoryFilter !== UNCATEGORIZED ? categoryFilter : null
        }
        categories={categories}
        groups={groups}
        linkedGroupIds={editing?.product ? linkedGroupIds(editing.product.id) : []}
        variants={editing?.product ? (variantsByProduct.get(editing.product.id) ?? []) : []}
        onClose={() => setEditing(null)}
      />
      {dialog}
    </div>
  );
}
