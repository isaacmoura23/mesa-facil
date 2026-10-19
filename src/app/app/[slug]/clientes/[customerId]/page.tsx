import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  CustomerAddresses,
  CustomerContact,
  CustomerOrders,
  CustomerStats,
} from "@/components/customers/customer-detail-view";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getCustomer } from "@/modules/customers/queries";
import { customerIdSchema } from "@/modules/customers/schemas";
import { makeDateFormatters } from "@/modules/reports/format";
import { getRestaurantTimezone } from "@/modules/reports/queries";

export const metadata: Metadata = { title: "Cliente" };

export default async function Page({ params }: PageProps<"/app/[slug]/clientes/[customerId]">) {
  const { slug, customerId } = await params;
  const { restaurant } = await requireRestaurantAccess(slug, { area: "app", permission: "reports.view" });

  const id = customerIdSchema.safeParse(customerId);
  if (!id.success) notFound();

  const result = await getCustomer(restaurant.restaurant_id, id.data);
  if (!result.ok && (result.code === "CUSTOMER_NOT_FOUND" || result.code === "RESTAURANT_NOT_FOUND")) notFound();

  const back = (
    <Link href={`/app/${restaurant.slug}/clientes`} className={buttonStyles({ variant: "secondary" })}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      Todos os clientes
    </Link>
  );

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Cliente" actions={back} />
        <Alert tone="danger" title="Não foi possível carregar o cliente">
          {result.message}
        </Alert>
      </>
    );
  }

  const detail = result.data;
  const dates = makeDateFormatters(await getRestaurantTimezone(restaurant.restaurant_id));

  return (
    <>
      <PageHeader
        title={detail.customer.name?.trim() || "Cliente sem nome"}
        description="Contato, endereços e histórico de pedidos."
        actions={back}
      />

      <div className="mb-5">
        <Alert tone="info" title="Dados pessoais protegidos">
          O acesso a dados de clientes é registrado. Use as informações apenas para a operação do restaurante.
        </Alert>
      </div>

      <CustomerStats detail={detail} dates={dates} />

      <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2">
        <CustomerContact customer={detail.customer} />
        <CustomerAddresses addresses={detail.addresses} />
      </div>

      <section aria-labelledby="orders-title">
        <h2 id="orders-title" className="mb-3 text-lg font-semibold text-fg">
          Histórico de pedidos
        </h2>
        <CustomerOrders
          slug={restaurant.slug}
          orders={detail.orders}
          total={detail.stats.orders_count}
          dates={dates}
        />
      </section>
    </>
  );
}
