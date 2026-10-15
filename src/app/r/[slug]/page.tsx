import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MenuView } from "@/components/storefront/menu-view";
import { RecentOrders } from "@/components/storefront/recent-orders";
import { RestaurantHero } from "@/components/storefront/restaurant-hero";
import { getPublicMenu } from "@/modules/storefront/data";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const menu = await getPublicMenu(slug).catch(() => null);
  if (!menu) return { title: "Cardápio" };
  return {
    title: menu.restaurant.name,
    description: `Cardápio digital de ${menu.restaurant.name}. Veja os itens, monte seu carrinho e confira o total.`,
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const menu = await getPublicMenu(slug);
  if (!menu) notFound();

  return (
    <>
      <RestaurantHero menu={menu} />
      <RecentOrders slug={menu.restaurant.slug} />
      <MenuView slug={menu.restaurant.slug} categories={menu.categories} />
    </>
  );
}
