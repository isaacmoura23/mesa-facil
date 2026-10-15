import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckoutForm } from "@/components/storefront/checkout-form";
import { getPublicMenu } from "@/modules/storefront/data";

export const metadata: Metadata = { title: "Finalizar pedido" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const menu = await getPublicMenu(slug);
  if (!menu) notFound();
  return <CheckoutForm slug={menu.restaurant.slug} settings={menu.settings} />;
}
