import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RefreshOnFocus } from "@/components/tables-admin/live";
import {
  TabOrders,
  TabPayments,
  TabSummaryCard,
  TabTimeline,
} from "@/components/tables-admin/tab-detail-view";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { TAB_STATUS_LABELS, TAB_STATUS_TONES } from "@/modules/tables-admin/format";
import { getTabDetail } from "@/modules/tables-admin/queries";
import { entityIdSchema } from "@/modules/tables-admin/schemas";

export const metadata: Metadata = { title: "Comanda" };

export default async function Page({ params }: PageProps<"/app/[slug]/comandas/[tabId]">) {
  const { slug, tabId } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "tabs.view" });
  const { restaurant } = access;

  const id = entityIdSchema.safeParse(tabId);
  if (!id.success) notFound();

  const result = await getTabDetail(restaurant.restaurant_id, id.data, {
    orders: access.can("orders.view"),
    payments: access.canAny(["reports.view", "payments.record"]),
  });
  if (result.ok === "notfound") notFound();

  const back = (
    <Link href={`/app/${restaurant.slug}/comandas`} className={buttonStyles({ variant: "secondary" })}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      Todas as comandas
    </Link>
  );

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Comanda" actions={back} />
        <Alert tone="danger" title="Não foi possível carregar a comanda">
          {result.message}
        </Alert>
      </>
    );
  }

  const detail = result.data;
  return (
    <>
      <PageHeader
        title={`Comanda ${detail.shortCode}`}
        badge={<Badge tone={TAB_STATUS_TONES[detail.tab.status]}>{TAB_STATUS_LABELS[detail.tab.status]}</Badge>}
        description={detail.tableName ?? (detail.tab.label ? `Balcão: ${detail.tab.label}` : "Comanda de balcão")}
        actions={back}
      />

      <div className="mb-6">
        <Alert tone="info" title="Monitoramento">
          Esta área é somente leitura. A operação (lançar pedidos, receber e fechar) é feita pela equipe em{" "}
          <span className="font-medium">/operacao</span>.
        </Alert>
      </div>

      <RefreshOnFocus />
      <div className="flex flex-col gap-6">
        <TabSummaryCard detail={detail} />
        <TabOrders detail={detail} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <TabPayments detail={detail} />
          <TabTimeline entries={detail.timeline} />
        </div>
      </div>
    </>
  );
}
