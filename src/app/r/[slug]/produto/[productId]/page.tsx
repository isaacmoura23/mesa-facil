import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetail } from "@/components/storefront/product-detail";
import { getPublicMenu } from "@/modules/storefront/data";
import { isUuid } from "@/modules/storefront/schemas";

type Props = { params: Promise<{ slug: string; productId: string }> };

async function findProduct(slug: string, productId: string) {
  if (!isUuid(productId)) return null;
  const menu = await getPublicMenu(slug);
  if (!menu) return null;
  // Busca só no cardápio deste restaurante: ID de outro restaurante não existe aqui.
  for (const category of menu.categories) {
    const product = category.products.find((p) => p.id === productId.toLowerCase());
    if (product) return { menu, product };
  }
  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, productId } = await params;
  const found = await findProduct(slug, productId).catch(() => null);
  return { title: found ? `${found.product.name} | ${found.menu.restaurant.name}` : "Item" };
}

export default async function Page({ params }: Props) {
  const { slug, productId } = await params;
  const found = await findProduct(slug, productId);
  if (!found) notFound();
  return <ProductDetail slug={found.menu.restaurant.slug} product={found.product} />;
}
