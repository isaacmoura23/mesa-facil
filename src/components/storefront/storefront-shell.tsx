import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brand } from "@/config/brand";
import { getPublicEnvStatus } from "@/lib/env";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { CartProvider } from "@/modules/storefront/cart-context";
import { getPublicMenu } from "@/modules/storefront/data";
import { CartButton, FloatingCartBar } from "./cart-button";
import { CartDrawer } from "./cart-drawer";
import { FooterContact, HeaderWhatsApp } from "./restaurant-contact";
import { RestaurantLogo } from "./restaurant-logo";

/**
 * Moldura do cardápio público: cabeçalho, carrinho (contexto + painel) e
 * rodapé. O restaurante vem da RPC `public_menu` (cacheada por slug); slug
 * inexistente, inválido ou inativo vira 404. Deve ficar dentro de <Suspense>
 * porque lê `params`.
 */
export async function StorefrontShell({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: ReactNode;
}) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  const { slug } = await params;
  const menu = await getPublicMenu(slug);
  if (!menu) notFound();

  const { restaurant } = menu;
  const home = `/r/${encodeURIComponent(restaurant.slug)}`;

  return (
    <CartProvider slug={restaurant.slug}>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-pop"
        >
          Pular para o conteúdo
        </a>
        <header className="sticky top-0 z-30 border-b border-line bg-surface">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
            <Link href={home} className="flex min-w-0 flex-1 items-center gap-3 rounded-control">
              <RestaurantLogo name={restaurant.name} logoPath={restaurant.logoPath} />
              <span className="min-w-0 truncate text-base font-semibold text-fg">
                {restaurant.name}
              </span>
            </Link>
            <HeaderWhatsApp restaurant={restaurant} />
            <CartButton />
          </div>
        </header>

        <main id="conteudo" className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-6">
          {children}
        </main>

        <footer className="border-t border-line py-6">
          <FooterContact restaurant={restaurant} className="mb-5" />
          <p className="text-center text-xs text-muted">Cardápio digital por {brand.name}</p>
        </footer>
      </div>
      <FloatingCartBar />
      <CartDrawer />
    </CartProvider>
  );
}
