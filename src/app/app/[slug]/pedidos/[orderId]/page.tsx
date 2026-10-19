import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import {
  OrderHeaderBadges,
  OrderItems,
  OrderPayment,
  OrderPrints,
  OrderSummary,
  OrderTimeline,
} from "@/components/dashboard/order-detail";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { formatTimeTz, ordersQuery, parseOrderFilters } from "@/modules/dashboard/orders";
import { getOrderDetail } from "@/modules/dashboard/orders-queries";
import { periodFromParams } from "@/modules/dashboard/period-params";
import { getRestaurantTimezone } from "@/modules/dashboard/queries";

export const metadata: Metadata = { title: "Detalhe do pedido" };

export default async function Page({ params, searchParams }: PageProps<"/app/[slug]/pedidos/[orderId]">) {
  const { slug, orderId } = await params;
  const query = await searchParams;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "orders.view" });
  const { restaurant } = access;

  if (!z.uuid().safeParse(orderId).success) notFound();

  const timezone = await getRestaurantTimezone(restaurant.restaurant_id);
  const period = periodFromParams(query, timezone, "today");
  const backHref = `/app/${restaurant.slug}/pedidos?${ordersQuery(period, parseOrderFilters(query))}`;

  const result = await getOrderDetail(restaurant.restaurant_id, orderId);
  if (result.ok && !result.data) notFound();

  const now = new Date();
  const back = (
    <Link href={backHref} className={buttonStyles({ variant: "secondary", size: "sm" })}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      Voltar aos pedidos
    </Link>
  );

  if (!result.ok || !result.data) {
    return (
      <>
        <PageHeader title="Pedido" actions={back} />
        <Alert tone="danger" title="Não foi possível carregar o pedido">
          {result.ok ? "Pedido não encontrado." : result.message}
        </Alert>
      </>
    );
  }

  const detail = result.data;
  return (
    <>
      <PageHeader
        title={`Pedido #${detail.order.order_number}`}
        badge={<OrderHeaderBadges detail={detail} />}
        actions={back}
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Alert tone="info" className="flex-1">
          Monitoramento: a operação é feita pela equipe em <span className="font-medium">/operacao</span>.
        </Alert>
        <AutoRefresh generatedAt={now.toISOString()} timeLabel={formatTimeTz(now.toISOString(), period.timezone)} />
      </div>
      <div className="flex flex-col gap-6">
        <OrderSummary detail={detail} timezone={period.timezone} />
        <OrderItems detail={detail} />
        <div className="grid gap-6 lg:grid-cols-2">
          <OrderPayment detail={detail} timezone={period.timezone} />
          <OrderTimeline detail={detail} timezone={period.timezone} />
        </div>
        <OrderPrints detail={detail} timezone={period.timezone} />
      </div>
    </>
  );
}
