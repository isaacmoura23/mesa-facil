"use client";

import { useState } from "react";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import {
  deleteCategoryAction,
  reorderMenuAction,
  setCategoryActiveAction,
} from "@/modules/menu/actions";
import { countLabel, moveId } from "@/modules/menu/format";
import type { MenuCategory, MenuProduct } from "@/modules/menu/types";
import { CategoryFormDialog } from "./category-form-dialog";
import { Switch } from "./fields";
import { IconButton } from "./icon-button";
import { ReorderButtons } from "./reorder-buttons";
import { useConfirm } from "./use-confirm";
import { useMenuAction } from "./use-menu-action";

type CategoriesPanelProps = {
  slug: string;
  categories: MenuCategory[];
  products: MenuProduct[];
};

export function CategoriesPanel({ slug, categories, products }: CategoriesPanelProps) {
  const { run, pending, isBusy } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ category: MenuCategory | null } | null>(null);

  const productCount = (categoryId: string) =>
    products.filter((product) => product.category_id === categoryId).length;

  const orderedIds = categories.map((category) => category.id);

  function toggleActive(category: MenuCategory, next: boolean) {
    if (next) {
      void run(() => setCategoryActiveAction(slug, category.id, true), { key: category.id });
      return;
    }
    const total = productCount(category.id);
    confirm({
      title: `Desativar "${category.name}"?`,
      description:
        total > 0
          ? `A categoria e os ${countLabel(total, "produto", "produtos")} dela saem do cardápio público imediatamente. Você pode reativar quando quiser.`
          : "A categoria sai do cardápio público imediatamente. Você pode reativar quando quiser.",
      confirmLabel: "Desativar",
      tone: "danger",
      onConfirm: () => run(() => setCategoryActiveAction(slug, category.id, false), { key: category.id }),
    });
  }

  function requestDelete(category: MenuCategory) {
    const total = productCount(category.id);
    if (total > 0) {
      toast({
        title: `"${category.name}" ainda tem ${countLabel(total, "produto", "produtos")}`,
        description: "Mova ou exclua os produtos antes, ou apenas desative a categoria.",
        tone: "danger",
        duration: 9000,
      });
      return;
    }
    confirm({
      title: `Excluir "${category.name}"?`,
      description: "Esta ação não pode ser desfeita. A categoria está vazia e será removida.",
      confirmLabel: "Excluir categoria",
      tone: "danger",
      onConfirm: () => run(() => deleteCategoryAction(slug, category.id), { key: category.id }),
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {countLabel(categories.length, "categoria", "categorias")}. A ordem daqui é a ordem do cardápio.
        </p>
        <Button onClick={() => setEditing({ category: null })}>
          <Plus aria-hidden="true" className="size-4" />
          Nova categoria
        </Button>
      </div>

      {categories.length === 0 ? (
        <EmptyState
          icon={<Tags />}
          title="Nenhuma categoria ainda"
          description="Crie categorias como Lanches, Bebidas e Sobremesas para organizar os produtos do cardápio."
          action={
            <Button onClick={() => setEditing({ category: null })}>
              <Plus aria-hidden="true" className="size-4" />
              Criar a primeira categoria
            </Button>
          }
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {categories.map((category, index) => {
              const total = productCount(category.id);
              const busy = isBusy(category.id);
              return (
                <li key={category.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-fg">{category.name}</p>
                      {!category.is_active ? <Badge tone="warning">Inativa</Badge> : null}
                    </div>
                    {category.description ? (
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted">{category.description}</p>
                    ) : null}
                    <p className="mt-0.5 text-sm text-muted">{countLabel(total, "produto", "produtos")}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                    <Switch
                      label="Ativa"
                      checked={category.is_active}
                      disabled={pending}
                      onChange={(next) => toggleActive(category, next)}
                    />
                    <ReorderButtons
                      name={category.name}
                      canMoveUp={index > 0}
                      canMoveDown={index < categories.length - 1}
                      disabled={pending}
                      onMove={(direction) =>
                        void run(() => reorderMenuAction(slug, "category", moveId(orderedIds, index, direction)), {
                          key: category.id,
                        })
                      }
                    />
                    <IconButton
                      label={`Editar ${category.name}`}
                      disabled={pending}
                      onClick={() => setEditing({ category })}
                    >
                      <Pencil aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Excluir ${category.name}`}
                      tone="danger"
                      disabled={pending || busy}
                      onClick={() => requestDelete(category)}
                    >
                      <Trash2 aria-hidden="true" />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <CategoryFormDialog
        open={editing !== null}
        slug={slug}
        category={editing?.category ?? null}
        onClose={() => setEditing(null)}
      />
      {dialog}
    </div>
  );
}
