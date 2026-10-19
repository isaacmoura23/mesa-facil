import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  type PublicPreview,
} from "@/modules/restaurant-settings/types";

/**
 * "Como o cliente verá": resumo somente leitura calculado pela mesma RPC
 * pública (`public_menu`) que alimenta a vitrine e a API. Reflete o que está
 * salvo, não as alterações ainda não salvas nos formulários.
 */
export function CustomerPreview({ preview }: { preview: PublicPreview | null }) {
  return (
    <Card aria-labelledby="preview-title">
      <CardHeader
        title={<span id="preview-title">Como o cliente verá</span>}
        description="Leitura da vitrine pública com o que está salvo agora. Não é editável."
      />
      {preview === null ? (
        <p role="status" className="text-sm text-muted">
          Não foi possível ler a vitrine pública agora. Atualize a página para tentar de novo.
        </p>
      ) : (
        <PreviewBody preview={preview} />
      )}
    </Card>
  );
}

function PreviewBody({ preview }: { preview: PublicPreview }) {
  const { settings, is_open_now: open } = preview;
  const accepting = settings.accepts_orders && open;
  const reason = !settings.accepts_orders
    ? "Pedidos online pausados"
    : open
      ? "Recebendo pedidos"
      : "Fechado pelo horário";

  const types = FULFILLMENT_TYPES.filter((type) => settings.enabled_fulfillment_types.includes(type));

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={open ? "accent" : "neutral"}>{open ? "Aberto" : "Fechado"}</Badge>
        <Badge tone={accepting ? "accent" : "warning"}>{reason}</Badge>
      </div>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="text-muted">Modalidades</dt>
          <dd className="mt-0.5 font-medium text-fg">
            {types.length > 0 ? types.map((type) => FULFILLMENT_LABELS[type].label).join(", ") : "Nenhuma"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Preparo</dt>
          <dd className="mt-0.5 font-medium text-fg">
            {settings.prep_time_minutes ? `Cerca de ${settings.prep_time_minutes} min` : "Não informado"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Pedido mínimo</dt>
          <dd className="mt-0.5 font-medium text-fg">
            {settings.min_order_cents > 0 ? formatCents(settings.min_order_cents) : "Sem mínimo"}
          </dd>
        </div>
      </dl>
      <div>
        <h3 className="font-medium text-fg">Regiões de entrega ativas</h3>
        {settings.delivery_zones.length === 0 ? (
          <p className="mt-1 text-muted">Nenhuma região ativa: o cliente não vê opções de entrega.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {settings.delivery_zones.map((zone) => (
              <li key={zone.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span className="font-medium text-fg">{zone.name}</span>
                <span className="text-muted">
                  Taxa {formatCents(zone.fee_cents)}. Mínimo {formatCents(zone.min_order_cents)}.
                  {zone.estimated_minutes ? ` ${zone.estimated_minutes} min.` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
