import Link from "next/link";
import { brand } from "@/config/brand";
import { BrandMark } from "@/components/brand-mark";
import { buttonStyles } from "@/components/ui/button";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <BrandMark />
        <nav aria-label="Principal" className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/planos"
            className={buttonStyles({ variant: "ghost", size: "sm", className: "hidden sm:inline-flex" })}
          >
            Planos
          </Link>
          <Link href="/login" className={buttonStyles({ variant: "ghost", size: "sm" })}>
            Entrar
          </Link>
          <Link href="/cadastro" className={buttonStyles({ size: "sm" })}>
            Criar conta
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <BrandMark />
          <p className="mt-2 max-w-sm text-sm text-muted">{brand.tagline}.</p>
        </div>
        <nav aria-label="Rodapé">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href="/planos" className="rounded-control text-muted hover:text-fg">
                Planos
              </Link>
            </li>
            <li>
              <Link href="/login" className="rounded-control text-muted hover:text-fg">
                Entrar
              </Link>
            </li>
            <li>
              <Link href="/cadastro" className="rounded-control text-muted hover:text-fg">
                Criar conta
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
