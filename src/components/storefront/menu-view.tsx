"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import type { MenuCategory } from "@/modules/storefront/schemas";
import { ProductCard } from "./product-card";

const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const sectionId = (categoryId: string) => `cat-${categoryId}`;

type MenuViewProps = {
  slug: string;
  categories: MenuCategory[];
};

/** Busca por nome, navegação fixa por categoria (scroll-spy) e lista de produtos. */
export function MenuView({ slug, categories }: MenuViewProps) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  // Após um clique na aba, ignora o scroll-spy até a rolagem assentar.
  const spyPaused = useRef(false);

  const visible = useMemo(() => {
    const needle = fold(query.trim());
    return categories
      .map((category) => ({
        ...category,
        products: needle
          ? category.products.filter(
              (p) => fold(p.name).includes(needle) || fold(p.description ?? "").includes(needle),
            )
          : category.products,
      }))
      .filter((category) => category.products.length > 0);
  }, [categories, query]);

  const totalProducts = visible.reduce((sum, c) => sum + c.products.length, 0);
  const visibleKey = visible.map((c) => c.id).join("|");
  const currentId =
    activeId && visible.some((c) => c.id === activeId) ? activeId : (visible[0]?.id ?? null);

  // Scroll-spy leve: IntersectionObserver (sem listener de scroll).
  useEffect(() => {
    const ids = visibleKey ? visibleKey.split("|") : [];
    const elements = ids
      .map((id) => document.getElementById(sectionId(id)))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const inView = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inView.add(entry.target.id);
          else inView.delete(entry.target.id);
        }
        if (spyPaused.current) return;
        const first = elements.find((el) => inView.has(el.id));
        if (first) setActiveId(first.id.slice("cat-".length));
      },
      // Faixa de observação logo abaixo do cabeçalho + abas fixas.
      { rootMargin: "-112px 0px -65% 0px" },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [visibleKey]);

  // Mantém a aba ativa visível na barra horizontal.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !currentId) return;
    const pill = nav.querySelector<HTMLElement>(`[data-cat="${CSS.escape(currentId)}"]`);
    if (!pill) return;
    const target = pill.offsetLeft - (nav.clientWidth - pill.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [currentId]);

  function goTo(categoryId: string) {
    const el = document.getElementById(sectionId(categoryId));
    if (!el) return;
    setActiveId(categoryId);
    spyPaused.current = true;
    window.setTimeout(() => {
      spyPaused.current = false;
    }, 800);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (categories.length === 0) {
    return (
      <EmptyState
        title="Cardápio em preparação"
        description="O restaurante ainda não publicou itens. Volte em breve."
      />
    );
  }

  return (
    <div>
      <div className="relative">
        <label htmlFor="busca-cardapio" className="sr-only">
          Buscar no cardápio
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        />
        <input
          id="busca-cardapio"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder="Buscar item pelo nome"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={inputStyles(false, "pl-9 pr-11 [&::-webkit-search-cancel-button]:hidden")}
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Limpar busca"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-control text-muted hover:text-fg"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {query.trim()
          ? totalProducts === 0
            ? "Nenhum item encontrado."
            : `${totalProducts} ${totalProducts === 1 ? "item encontrado" : "itens encontrados"}.`
          : ""}
      </p>

      {visible.length > 0 ? (
        <nav
          aria-label="Categorias do cardápio"
          className="sticky top-14 z-20 -mx-4 mt-3 border-b border-line bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/85"
        >
          <div
            ref={navRef}
            className="flex gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {visible.map((category) => {
              const active = category.id === currentId;
              return (
                <a
                  key={category.id}
                  href={`#${sectionId(category.id)}`}
                  data-cat={category.id}
                  aria-current={active ? "true" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    goTo(category.id);
                  }}
                  className={cn(
                    "inline-flex h-10 shrink-0 items-center rounded-control px-4 text-sm font-medium transition-colors",
                    active
                      ? "bg-accent text-accent-fg"
                      : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {category.name}
                </a>
              );
            })}
          </div>
        </nav>
      ) : null}

      {visible.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Search />}
            title="Nenhum item encontrado"
            description={`Não achamos nada para "${query.trim()}". Tente outro nome.`}
          />
        </div>
      ) : (
        <div className="mt-2 space-y-8">
          {visible.map((category) => (
            <section
              key={category.id}
              id={sectionId(category.id)}
              aria-labelledby={`${sectionId(category.id)}-titulo`}
              className="scroll-mt-28 pt-4"
            >
              <h2
                id={`${sectionId(category.id)}-titulo`}
                className="mb-3 text-lg font-semibold tracking-tight text-fg"
              >
                {category.name}
              </h2>
              <ul className="grid gap-3 md:grid-cols-2">
                {category.products.map((product) => (
                  <ProductCard key={product.id} slug={slug} product={product} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
