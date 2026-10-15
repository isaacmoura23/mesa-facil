"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils/cn";
import type { MenuAdminData } from "@/modules/menu/types";
import { CategoriesPanel } from "./categories-panel";
import { ModifiersPanel } from "./modifiers-panel";
import { ProductsPanel } from "./products-panel";

type TabKey = "produtos" | "categorias" | "adicionais";

type MenuWorkspaceProps = {
  slug: string;
  restaurantId: string;
  data: MenuAdminData;
};

export function MenuWorkspace({ slug, restaurantId, data }: MenuWorkspaceProps) {
  const [tab, setTab] = useState<TabKey>("produtos");
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    produtos: null,
    categorias: null,
    adicionais: null,
  });

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "produtos", label: "Produtos", count: data.products.length },
    { key: "categorias", label: "Categorias", count: data.categories.length },
    { key: "adicionais", label: "Adicionais", count: data.groups.length },
  ];

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next].key;
    setTab(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Seções do cardápio"
        className="mb-6 grid grid-cols-3 gap-1 rounded-control bg-surface-2 p-1 sm:inline-grid sm:grid-cols-[repeat(3,minmax(8rem,auto))]"
      >
        {tabs.map((item, index) => {
          const selected = tab === item.key;
          return (
            <button
              key={item.key}
              ref={(node) => {
                tabRefs.current[item.key] = node;
              }}
              role="tab"
              type="button"
              id={`tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`panel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "flex min-h-10 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium transition-colors",
                selected ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
              )}
            >
              {item.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  selected ? "bg-accent-soft text-accent-soft-fg" : "bg-line text-muted",
                )}
              >
                {item.count}
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="outline-offset-4">
        {tab === "produtos" ? (
          <ProductsPanel
            slug={slug}
            restaurantId={restaurantId}
            categories={data.categories}
            products={data.products}
            variants={data.variants}
            groups={data.groups}
            links={data.links}
            onGoToCategories={() => setTab("categorias")}
          />
        ) : null}
        {tab === "categorias" ? (
          <CategoriesPanel slug={slug} categories={data.categories} products={data.products} />
        ) : null}
        {tab === "adicionais" ? (
          <ModifiersPanel
            slug={slug}
            categories={data.categories}
            products={data.products}
            groups={data.groups}
            modifiers={data.modifiers}
            links={data.links}
          />
        ) : null}
      </div>
    </div>
  );
}
