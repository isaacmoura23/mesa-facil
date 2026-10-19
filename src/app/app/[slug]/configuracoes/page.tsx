import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { AcceptsOrdersCard } from "@/components/restaurant-settings/accepts-orders-card";
import { CustomerPreview } from "@/components/restaurant-settings/customer-preview";
import { ExceptionsManager } from "@/components/restaurant-settings/exceptions-manager";
import { HoursEditor } from "@/components/restaurant-settings/hours-editor";
import { RulesForm } from "@/components/restaurant-settings/rules-form";
import { ZonesManager } from "@/components/restaurant-settings/zones-manager";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { timezoneLabel } from "@/modules/restaurant-profile/timezones";
import { getSettingsPageData } from "@/modules/restaurant-settings/queries";

export const metadata: Metadata = { title: "Configurações" };

const LOAD_ERROR = "Tente atualizar a página. Se continuar, avise o suporte.";

function LoadError({ title }: { title: string }) {
  return (
    <Alert tone="danger" title={title}>
      {LOAD_ERROR} A edição foi bloqueada para não sobrescrever os dados atuais.
    </Alert>
  );
}

export default async function Page({ params }: PageProps<"/app/[slug]/configuracoes">) {
  const { slug } = await params;
  const { restaurant } = await requireRestaurantAccess(slug, {
    area: "app",
    permission: "restaurant.settings.manage",
  });
  const data = await getSettingsPageData({ restaurantId: restaurant.restaurant_id, slug: restaurant.slug });
  const deliveryEnabled = data.settings?.enabled_fulfillment_types.includes("DELIVERY") ?? false;

  return (
    <>
      <PageHeader
        title="Configurações"
        description="Pedidos online, modalidades, horários e regiões de entrega do seu restaurante."
        actions={
          <Link
            href={`/r/${restaurant.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            prefetch={false}
            className={buttonStyles({ variant: "secondary" })}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            Ver cardápio público
            <span className="sr-only"> (abre em uma nova aba)</span>
          </Link>
        }
      />

      <div className="flex max-w-3xl flex-col gap-6">
        <Alert tone="info" title="As mudanças valem na hora">
          Cada seção tem o seu botão de salvar. Ao salvar, a vitrine e a API passam a usar os novos valores para
          os próximos pedidos. Pedidos já feitos guardam os valores da época e não são alterados.
        </Alert>

        {data.settings ? (
          <AcceptsOrdersCard
            slug={restaurant.slug}
            acceptsOrders={data.settings.accepts_orders}
            openNow={data.preview?.is_open_now ?? null}
            hasHours={(data.hours?.length ?? 0) > 0}
          />
        ) : (
          <LoadError title="Não foi possível carregar o funcionamento" />
        )}

        {data.settings ? (
          <RulesForm slug={restaurant.slug} settings={data.settings} />
        ) : (
          <LoadError title="Não foi possível carregar as modalidades e regras" />
        )}

        {data.hours ? (
          <HoursEditor slug={restaurant.slug} hours={data.hours} timezoneLabel={timezoneLabel(data.timezone)} />
        ) : (
          <LoadError title="Não foi possível carregar os horários" />
        )}

        {data.exceptions ? (
          <ExceptionsManager slug={restaurant.slug} exceptions={data.exceptions} today={data.today} />
        ) : (
          <LoadError title="Não foi possível carregar as exceções" />
        )}

        {data.zones ? (
          <ZonesManager slug={restaurant.slug} zones={data.zones} deliveryEnabled={deliveryEnabled} />
        ) : (
          <LoadError title="Não foi possível carregar as regiões de entrega" />
        )}

        <CustomerPreview preview={data.preview} />
      </div>
    </>
  );
}
