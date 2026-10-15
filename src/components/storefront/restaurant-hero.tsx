import type { ReactNode } from "react";
import { Bike, Clock, Store, UtensilsCrossed, Wallet, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/format";
import {
  FULFILLMENT_LABELS,
  type Fulfillment,
  type PublicMenu,
} from "@/modules/storefront/schemas";

const FULFILLMENT_ICONS: Record<Fulfillment, LucideIcon> = {
  DELIVERY: Bike,
  PICKUP: Store,
  DINE_IN: UtensilsCrossed,
};

function Fact({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 text-sm text-muted">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

/** Nome, aberto/fechado e modalidades. `is_open_now` é informativo. */
export function RestaurantHero({ menu }: { menu: PublicMenu }) {
  const { restaurant, settings, isOpenNow } = menu;
  const paused = !settings.acceptsOrders;
  const open = isOpenNow && !paused;

  return (
    <section aria-labelledby="restaurante-titulo" className="mb-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1
          id="restaurante-titulo"
          className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl"
        >
          {restaurant.name}
        </h1>
        <Badge tone={open ? "accent" : "warning"}>
          {paused ? "Pedidos pausados" : isOpenNow ? "Aberto agora" : "Fechado no momento"}
        </Badge>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Informações do restaurante">
        {settings.fulfillmentTypes.map((type) => (
          <Fact key={type} icon={FULFILLMENT_ICONS[type]}>
            {FULFILLMENT_LABELS[type]}
          </Fact>
        ))}
        {settings.prepTimeMinutes ? (
          <Fact icon={Clock}>Preparo em cerca de {settings.prepTimeMinutes} min</Fact>
        ) : null}
        {settings.minOrderCents > 0 ? (
          <Fact icon={Wallet}>Pedido mínimo {formatCents(settings.minOrderCents)}</Fact>
        ) : null}
      </ul>

      {!open ? (
        <Alert tone="warning" className="mt-4">
          {paused
            ? "Este restaurante pausou os pedidos por enquanto. Você pode olhar o cardápio, mas não conseguirá finalizar um pedido agora."
            : "Estamos fechados neste momento. Você pode olhar o cardápio e montar o carrinho, mas só conseguirá finalizar o pedido no horário de funcionamento."}
        </Alert>
      ) : null}
    </section>
  );
}
