import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { EstablishmentForm } from "@/components/restaurant-profile/establishment-form";
import { ContactForm } from "@/components/restaurant-profile/contact-form";
import { OriginsEditor } from "@/components/restaurant-profile/origins-editor";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getRestaurantProfile } from "@/modules/restaurant-profile/queries";

export const metadata: Metadata = { title: "Restaurante" };

const LOAD_ERROR = "Tente atualizar a página. Se continuar, avise o suporte.";

export default async function Page({ params }: PageProps<"/app/[slug]/restaurante">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, {
    area: "app",
    permission: "restaurant.settings.manage",
  });
  const { restaurant } = access;
  const profile = await getRestaurantProfile(restaurant.restaurant_id);

  return (
    <>
      <PageHeader
        title="Restaurante"
        description="Dados do estabelecimento, contato, vitrine e domínios autorizados."
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
        {profile.establishment ? (
          <EstablishmentForm
            slug={restaurant.slug}
            restaurantId={restaurant.restaurant_id}
            status={restaurant.status}
            establishment={profile.establishment}
          />
        ) : (
          <Alert tone="danger" title="Não foi possível carregar os dados do estabelecimento">
            {LOAD_ERROR} A edição foi bloqueada para não sobrescrever os dados atuais.
          </Alert>
        )}

        {profile.contact ? (
          <ContactForm slug={restaurant.slug} contact={profile.contact} />
        ) : (
          <Alert tone="danger" title="Não foi possível carregar o contato e a vitrine">
            {LOAD_ERROR} A edição foi bloqueada para não sobrescrever os dados atuais.
          </Alert>
        )}

        {profile.origins ? (
          <OriginsEditor slug={restaurant.slug} origins={profile.origins} />
        ) : (
          <Alert tone="danger" title="Não foi possível carregar os domínios autorizados">
            {LOAD_ERROR} A edição foi bloqueada para não apagar os domínios cadastrados.
          </Alert>
        )}
      </div>
    </>
  );
}
