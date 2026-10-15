"use client";

import { useState } from "react";
import { Link2, Pencil, Plus, Trash2, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
import {
  deleteModifierAction,
  deleteModifierGroupAction,
  reorderMenuAction,
  setModifierAvailableAction,
  setModifierGroupActiveAction,
} from "@/modules/menu/actions";
import { countLabel, moveId } from "@/modules/menu/format";
import type {
  MenuCategory,
  MenuProduct,
  Modifier,
  ModifierGroup,
  ProductGroupLink,
} from "@/modules/menu/types";
import { Switch } from "./fields";
import { IconButton } from "./icon-button";
import { LinkProductsDialog, ModifierDialog, ModifierGroupDialog } from "./modifier-dialogs";
import { ReorderButtons } from "./reorder-buttons";
import { useConfirm } from "./use-confirm";
import { useMenuAction } from "./use-menu-action";

type ModifiersPanelProps = {
  slug: string;
  categories: MenuCategory[];
  products: MenuProduct[];
  groups: ModifierGroup[];
  modifiers: Modifier[];
  links: ProductGroupLink[];
};

function selectionRule(group: ModifierGroup): string {
  if (group.min_selections === 0) return `Opcional, até ${group.max_selections}`;
  if (group.min_selections === group.max_selections) {
    return `Obrigatório: escolher ${group.min_selections}`;
  }
  return `Obrigatório: escolher de ${group.min_selections} a ${group.max_selections}`;
}

export function ModifiersPanel({ slug, categories, products, groups, modifiers, links }: ModifiersPanelProps) {
  const { run, pending, isBusy } = useMenuAction();
  const { confirm, dialog } = useConfirm();
  const [groupEditing, setGroupEditing] = useState<{ group: ModifierGroup | null } | null>(null);
  const [itemEditing, setItemEditing] = useState<{ group: ModifierGroup; modifier: Modifier | null } | null>(null);
  const [linking, setLinking] = useState<ModifierGroup | null>(null);

  const categoryName = (id: string | null) => categories.find((category) => category.id === id)?.name;

  const productOptions = products.map((product) => ({
    id: product.id,
    name: product.is_active ? product.name : `${product.name} (oculto)`,
    hint: categoryName(product.category_id) ?? "Sem categoria",
  }));

  function toggleGroupActive(group: ModifierGroup, next: boolean) {
    if (next) {
      void run(() => setModifierGroupActiveAction(slug, group.id, true), { key: group.id });
      return;
    }
    confirm({
      title: `Desativar "${group.name}"?`,
      description:
        "O grupo deixa de ser oferecido nos produtos ligados a ele, no cardápio público. Os itens e os vínculos ficam guardados.",
      confirmLabel: "Desativar grupo",
      tone: "danger",
      onConfirm: () => run(() => setModifierGroupActiveAction(slug, group.id, false), { key: group.id }),
    });
  }

  function requestDeleteGroup(group: ModifierGroup, itemCount: number, productCount: number) {
    confirm({
      title: `Excluir "${group.name}"?`,
      description: `Esta ação não pode ser desfeita. ${countLabel(itemCount, "item será removido", "itens serão removidos")} e o grupo sai de ${countLabel(productCount, "produto", "produtos")}. Pedidos já feitos não mudam. Para apenas esconder, desative o grupo.`,
      confirmLabel: "Excluir grupo",
      tone: "danger",
      onConfirm: () => run(() => deleteModifierGroupAction(slug, group.id), { key: group.id }),
    });
  }

  function requestDeleteItem(item: Modifier) {
    confirm({
      title: `Excluir "${item.name}"?`,
      description: "Esta ação não pode ser desfeita. Pedidos já feitos mantêm o nome e o preço registrados.",
      confirmLabel: "Excluir item",
      tone: "danger",
      onConfirm: () => run(() => deleteModifierAction(slug, item.id), { key: item.id }),
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {countLabel(groups.length, "grupo", "grupos")}. Vincule cada grupo aos produtos que o oferecem.
        </p>
        <Button onClick={() => setGroupEditing({ group: null })}>
          <Plus aria-hidden="true" className="size-4" />
          Novo grupo
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="Nenhum grupo de adicionais"
          description="Grupos permitem ao cliente personalizar o pedido, como escolher molhos ou incluir bacon por um valor extra."
          action={
            <Button onClick={() => setGroupEditing({ group: null })}>
              <Plus aria-hidden="true" className="size-4" />
              Criar o primeiro grupo
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {groups.map((group, groupIndex) => {
            const items = modifiers.filter((modifier) => modifier.group_id === group.id);
            const linkedProducts = links.filter((link) => link.group_id === group.id);
            const busy = isBusy(group.id);
            return (
              <li key={group.id}>
                <Card padded={false} as="article" aria-labelledby={`group-${group.id}`}>
                  <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 id={`group-${group.id}`} className="text-base font-semibold text-fg">
                          {group.name}
                        </h3>
                        {!group.is_active ? <Badge tone="warning">Inativo</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-sm text-muted">
                        {selectionRule(group)}. {countLabel(linkedProducts.length, "produto", "produtos")} com este grupo.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:justify-end">
                      <Switch
                        label="Ativo"
                        checked={group.is_active}
                        disabled={pending}
                        onChange={(next) => toggleGroupActive(group, next)}
                      />
                      <div className="flex items-center">
                        <ReorderButtons
                          name={group.name}
                          canMoveUp={groupIndex > 0}
                          canMoveDown={groupIndex < groups.length - 1}
                          disabled={pending}
                          onMove={(direction) =>
                            void run(
                              () =>
                                reorderMenuAction(
                                  slug,
                                  "modifier_group",
                                  moveId(
                                    groups.map((item) => item.id),
                                    groupIndex,
                                    direction,
                                  ),
                                ),
                              { key: group.id },
                            )
                          }
                        />
                        <IconButton label={`Produtos com ${group.name}`} disabled={pending} onClick={() => setLinking(group)}>
                          <Link2 aria-hidden="true" />
                        </IconButton>
                        <IconButton label={`Editar ${group.name}`} disabled={pending} onClick={() => setGroupEditing({ group })}>
                          <Pencil aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Excluir ${group.name}`}
                          tone="danger"
                          disabled={pending || busy}
                          onClick={() => requestDeleteGroup(group, items.length, linkedProducts.length)}
                        >
                          <Trash2 aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                  </div>

                  {items.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-muted">
                      Este grupo ainda não tem itens. Adicione as opções que o cliente poderá escolher.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {items.map((item, itemIndex) => (
                        <li key={item.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-fg">{item.name}</p>
                              {!item.is_available ? <Badge tone="danger">Indisponível</Badge> : null}
                            </div>
                            <p className="text-sm text-muted tabular-nums">
                              {item.price_delta_cents > 0 ? `+ ${formatCents(item.price_delta_cents)}` : "Sem custo adicional"}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3">
                            <Switch
                              label="Disponível"
                              checked={item.is_available}
                              disabled={pending}
                              onChange={(next) =>
                                void run(() => setModifierAvailableAction(slug, item.id, next), { key: item.id })
                              }
                            />
                            <div className="flex items-center">
                              <ReorderButtons
                                name={item.name}
                                canMoveUp={itemIndex > 0}
                                canMoveDown={itemIndex < items.length - 1}
                                disabled={pending}
                                onMove={(direction) =>
                                  void run(
                                    () =>
                                      reorderMenuAction(
                                        slug,
                                        "modifier",
                                        moveId(
                                          items.map((entry) => entry.id),
                                          itemIndex,
                                          direction,
                                        ),
                                      ),
                                    { key: item.id },
                                  )
                                }
                              />
                              <IconButton
                                label={`Editar ${item.name}`}
                                disabled={pending}
                                onClick={() => setItemEditing({ group, modifier: item })}
                              >
                                <Pencil aria-hidden="true" />
                              </IconButton>
                              <IconButton
                                label={`Excluir ${item.name}`}
                                tone="danger"
                                disabled={pending}
                                onClick={() => requestDeleteItem(item)}
                              >
                                <Trash2 aria-hidden="true" />
                              </IconButton>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="border-t border-line p-3">
                    <Button variant="secondary" size="sm" onClick={() => setItemEditing({ group, modifier: null })}>
                      <Plus aria-hidden="true" className="size-4" />
                      Adicionar item
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {groupEditing ? (
        <ModifierGroupDialog open slug={slug} group={groupEditing.group} onClose={() => setGroupEditing(null)} />
      ) : null}
      {itemEditing ? (
        <ModifierDialog
          open
          slug={slug}
          group={itemEditing.group}
          modifier={itemEditing.modifier}
          onClose={() => setItemEditing(null)}
        />
      ) : null}
      {linking ? (
        <LinkProductsDialog
          open
          slug={slug}
          group={linking}
          products={productOptions}
          linkedProductIds={links.filter((link) => link.group_id === linking.id).map((link) => link.product_id)}
          onClose={() => setLinking(null)}
        />
      ) : null}
      {dialog}
    </div>
  );
}
