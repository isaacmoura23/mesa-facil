import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { OrderTracker } from "@/components/storefront/order-tracker";
import { getPublicEnvStatus } from "@/lib/env";
import { isPublicCode } from "@/modules/orders-server/schemas";
import { trackOrder } from "@/modules/orders-server/service";
import { normalizeSlug } from "@/modules/storefront/data";

type Props = { params: Promise<{ slug: string; publicCode: string }> };

/**
 * O código na URL é o único segredo do acompanhamento: a página não é
 * indexável e é sempre renderizada por requisição (dinâmica = sem cache
 * compartilhado: `Cache-Control: private, no-store`).
 */
export const metadata: Metadata = {
  title: "Acompanhar pedido",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function Page({ params }: Props) {
  await connection();
  const { slug: rawSlug, publicCode: rawCode } = await params;
  const slug = normalizeSlug(rawSlug);
  const publicCode = decodeURIComponent(rawCode).trim();
  if (!slug || !isPublicCode(publicCode) || !getPublicEnvStatus().ok) notFound();

  const result = await trackOrder(slug, publicCode);
  if (result.status === "not_found") notFound();
  if (result.status === "error") throw new Error("Não foi possível consultar o pedido.");

  return <OrderTracker slug={slug} publicCode={publicCode} initial={result.order} />;
}
