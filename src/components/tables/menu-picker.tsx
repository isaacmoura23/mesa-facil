"use client";

import { useMemo, useState } from "react";
import { Search, UtensilsCrossed } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { normalizeText } from "@/modules/tables/format";
import { hasVariants, isOrderable } from "@/modules/storefront/product";
import type { MenuProduct, PublicMenu } from "@/modules/storefront/schemas";

type MenuPickerProps = {
  menu: PublicMenu | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onPick: (product: MenuProduct) => void;
  /** Quantidade já no pedido, por produto (selo na linha). */
  inCart: ReadonlyMap<string, number>;
};

/** Cardápio completo para a equipe: busca + categorias + itens (indisponíveis desabilitados). */
export function MenuPicker({ menu, loading, error, onRetry, onPick, inCart }: MenuPickerProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("ALL");

  const categories = useMemo(() => (menu?.categories ?? []).filter((c) => c.products.length > 0), [menu]);

  const sections = useMemo(() => {
    const query = normalizeText(search);
    return categories
      .filter((c) => category === "ALL" || c.id === category)
      .map((c) => ({
        ...c,
        products: query
          ? c.products.filter((p) => normalizeText(`${p.name} ${p.description ?? ""}`).includes(query))
          : c.products,
      }))
      .filter((c) => c.products.length > 0);
  }, [categories, category, search]);

  if (loading && !menu) {
    return (
      <div className="space-y-2 p-5" aria-busy="true">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-control" />
        ))}
      </div>
    );
  }

  if (!menu) {
    return (
      <div className="p-5">
        <Alert tone="danger" title="Não foi possível carregar o cardápio">
          <div className="flex flex-wrap items-center gap-3">
            <span>{error ?? "Erro inesperado."}</span>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Tentar de novo
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line px-5 py-3">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar item do cardápio"
            placeholder="Buscar item"
            className={inputStyles(false, "pl-9")}
          />
        </div>
        {categories.length > 1 ? (
          <div role="group" aria-label="Categorias" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <CategoryChip active={category === "ALL"} onClick={() => setCategory("ALL")} label="Tudo" />
            {categories.map((c) => (
              <CategoryChip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} label={c.name} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {sections.length === 0 ? (
          <EmptyState
            icon={<UtensilsCrossed />}
            title={search ? "Nenhum item encontrado" : "Cardápio vazio"}
            description={search ? "Revise a busca ou a categoria." : "Cadastre produtos no cardápio para lançar pedidos."}
          />
        ) : (
          sections.map((section) => (
            <section key={section.id} className="mb-6 last:mb-0" aria-label={section.name}>
              <h3 className="mb-2 text-sm font-semibold text-muted">{section.name}</h3>
              <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                {section.products.map((product) => {
                  const orderable = isOrderable(product);
                  const count = inCart.get(product.id) ?? 0;
                  return (
                    <li key={product.id}>
                      <button
                        type="button"
                        disabled={!orderable}
                        onClick={() => onPick(product)}
                        className={cn(
                          "flex min-h-16 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-2 text-left transition-colors",
                          orderable ? "hover:border-line-strong hover:bg-surface-2 active:translate-y-px" : "cursor-not-allowed opacity-55",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-medium text-fg">{product.name}</span>
                          {product.description ? (
                            <span className="block truncate text-xs text-muted">{product.description}</span>
                          ) : null}
                        </span>
                        {count > 0 ? <Badge tone="accent">{count} no pedido</Badge> : null}
                        {orderable ? (
                          <span className="shrink-0 text-right text-sm font-semibold tabular-nums text-fg">
                            {hasVariants(product) ? <span className="mr-1 text-xs font-normal text-muted">a partir de</span> : null}
                            {formatCents(product.priceCents)}
                          </span>
                        ) : (
                          <Badge tone="neutral">Indisponível</Badge>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function CategoryChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-10 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line bg-surface text-fg hover:bg-surface-2",
      )}
    >
      {label}
    </button>
  );
}
