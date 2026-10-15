import type { ReactNode } from "react";
import type { NavEntry } from "@/config/navigation";
import { BrandMark } from "@/components/brand-mark";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";

type ShellFrameProps = {
  /** Nome do ambiente (ex.: "Gestão", "Operação", "Plataforma"). */
  areaLabel: string;
  nav: readonly NavEntry[];
  /** Lado esquerdo do cabeçalho (seletor de restaurante ou título). */
  headerStart: ReactNode;
  /** Lado direito do cabeçalho (menu do usuário). */
  headerEnd: ReactNode;
  /** Rodapé da barra lateral e da gaveta móvel (ex.: trocar de ambiente). */
  navFooter?: ReactNode;
  /** Aviso exibido acima do conteúdo (ex.: restaurante aguardando ativação). */
  banner?: ReactNode;
  children: ReactNode;
};

/**
 * Estrutura comum dos ambientes autenticados: barra lateral fixa em telas
 * grandes, navegação inferior/gaveta em telas pequenas e cabeçalho fixo.
 */
export function ShellFrame({
  areaLabel,
  nav,
  headerStart,
  headerEnd,
  navFooter,
  banner,
  children,
}: ShellFrameProps) {
  const navLabel = `Navegação de ${areaLabel.toLowerCase()}`;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-control focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-fg"
      >
        Ir para o conteúdo
      </a>

      <aside className="hidden border-r border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-16 shrink-0 items-center border-b border-line px-5">
          <BrandMark href="/entrar" />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <p className="mb-2 px-3 text-xs font-medium text-muted">{areaLabel}</p>
          <SidebarNav items={nav} label={navLabel} />
        </div>
        {navFooter ? (
          <div className="shrink-0 border-t border-line p-3">{navFooter}</div>
        ) : null}
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <BrandMark href="/entrar" compact className="lg:hidden" />
            {headerStart}
          </div>
          <div className="flex shrink-0 items-center gap-1">{headerEnd}</div>
        </header>

        <main
          id="conteudo"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 sm:px-6 sm:py-8 lg:pb-10"
        >
          {banner ? <div className="mb-6">{banner}</div> : null}
          {children}
        </main>
      </div>

      <MobileNav items={nav} label={navLabel} drawerFooter={navFooter} />
    </div>
  );
}
