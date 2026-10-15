import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { MenuWorkspace } from "@/components/menu-admin/menu-workspace";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getMenuAdminData } from "@/modules/menu/queries";

export const metadata: Metadata = { title: "Cardápio" };

export default async function Page({ params }: PageProps<"/app/[slug]/cardapio">) {
  const { slug } = await params;
  const access = await requireRestaurantAccess(slug, { area: "app", permission: "menu.manage" });
  const { restaurant } = access;
  const result = await getMenuAdminData(restaurant.restaurant_id);
  const isPublic = restaurant.status === "active";

  return (
    <>
      <PageHeader
        title="Cardápio"
        description="Categorias, produtos, fotos e adicionais do seu restaurante."
        actions={
          isPublic ? (
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
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-col gap-3">
        {!isPublic ? (
          <Alert tone="warning" title="O cardápio público está fora do ar">
            O restaurante ainda não está ativo, e o público só enxerga restaurantes ativos. Você pode preparar
            o cardápio, mas os clientes só o verão depois da ativação.
          </Alert>
        ) : null}
        <Alert tone="info" title="O cardápio é ao vivo">
          Não existe rascunho: cada alteração vale no cardápio público assim que é salva. Para tirar algo do
          ar sem apagar, desative o produto ou a categoria.
        </Alert>
      </div>

      {result.ok ? (
        <MenuWorkspace slug={restaurant.slug} restaurantId={restaurant.restaurant_id} data={result.data} />
      ) : (
        <Alert tone="danger" title="Não foi possível carregar o cardápio">
          {result.message}
        </Alert>
      )}
    </>
  );
}
