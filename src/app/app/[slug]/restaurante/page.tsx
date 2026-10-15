import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ExternalLink, Hammer } from "lucide-react";
import { ApiInfo } from "@/components/restaurant-profile/api-info";
import { ContactForm } from "@/components/restaurant-profile/contact-form";
import { OriginsEditor } from "@/components/restaurant-profile/origins-editor";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { getRestaurantProfile } from "@/modules/restaurant-profile/queries";

export const metadata: Metadata = { title: "Restaurante" };

const LOAD_ERROR = "Tente atualizar a página. Se continuar, avise o suporte.";

/** Origem do SaaS para montar a URL da API: variável pública ou o host da requisição. */
async function resolveBaseUrl(): Promise<string> {
  const status = getPublicEnvStatus();
  if (status.ok && status.env.siteUrl) return status.env.siteUrl.replace(/\/+$/, "");
  const list = await headers();
  const host = list.get("x-forwarded-host") ?? list.get("host") ?? "localhost:3000";
  const protocol = list.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

export default async function Page({ params }: PageProps<"/app/[slug]/restaurante">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, {
    area: "app",
    permission: "restaurant.settings.manage",
  });
  const { restaurant } = access;
  const [profile, baseUrl] = await Promise.all([
    getRestaurantProfile(restaurant.restaurant_id),
    resolveBaseUrl(),
  ]);

  return (
    <>
      <PageHeader
        title="Restaurante"
        description="Contato, vitrine e acesso à API do seu cardápio."
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

        <ApiInfo baseUrl={baseUrl} slug={restaurant.slug} />

        <Card aria-labelledby="upcoming-title">
          <CardHeader
            title={<span id="upcoming-title">Dados cadastrais, horários e zonas de entrega</span>}
            description="Ainda não é possível editar estes dados pelo painel."
          />
          <div className="flex items-start gap-3 text-sm text-muted">
            <Hammer aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              A edição do nome, dos horários de funcionamento e das zonas de entrega está prevista para a
              Fase 5. Por enquanto, estes dados seguem como estão cadastrados.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
