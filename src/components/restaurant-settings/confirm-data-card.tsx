import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { whatsappToInput } from "@/modules/restaurant-profile/format";
import type { ContactRow } from "@/modules/restaurant-profile/types";
import {
  describeInterval,
  formatDateBr,
  weekFromRows,
  WEEKDAYS,
} from "@/modules/restaurant-settings/hours";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  type ExceptionRow,
  type HourRow,
  type SettingsRow,
  type ZoneRow,
} from "@/modules/restaurant-settings/types";

type Props = {
  slug: string;
  settings: SettingsRow;
  hours: HourRow[];
  exceptions: ExceptionRow[];
  zones: ZoneRow[];
  contact: ContactRow | null;
  today: string;
};

/**
 * "Confirme os dados do seu cardápio": resumo somente leitura de tudo que o
 * cardápio digital mostra ao cliente e que o dono controla. Cada linha avisa o
 * que está faltando e leva à tela onde se corrige. Não grava nada.
 */
export function ConfirmDataCard({ slug, settings, hours, exceptions, zones, contact, today }: Props) {
  const week = weekFromRows(hours);
  const activeZones = zones.filter((zone) => zone.is_active);
  const types = FULFILLMENT_TYPES.filter((type) => settings.enabled_fulfillment_types.includes(type));
  const todayException = exceptions.find((exception) => exception.on_date === today) ?? null;
  const upcomingClosures = exceptions.filter((exception) => exception.is_closed && exception.on_date >= today);

  const whatsapp = contact?.whatsapp ? whatsappToInput(contact.whatsapp) : "";
  const address = contact?.address_text?.trim() ?? "";
  const notice = contact?.storefront_notice?.trim() ?? "";

  const missing: string[] = [];
  if (hours.length === 0) missing.push("horários de funcionamento");
  if (types.includes("DELIVERY") && activeZones.length === 0) missing.push("região de entrega ativa");
  if (!whatsapp) missing.push("WhatsApp");
  if (!address) missing.push("endereço");

  return (
    <Card aria-labelledby="confirm-title">
      <CardHeader
        title={<span id="confirm-title">Confirme os dados do seu cardápio</span>}
        description="Confira o que o cliente vê no cardápio digital. O que você salvar aqui em Configurações e em Restaurante passa a valer para os próximos pedidos."
      />
      <div className="flex flex-col gap-5 text-sm">
        {contact === null ? (
          <p role="status" className="text-muted">
            Não foi possível ler o WhatsApp, o endereço e o aviso agora. Atualize a página para tentar de novo.
          </p>
        ) : missing.length > 0 ? (
          <Badge tone="warning">Falta preencher: {missing.join(", ")}</Badge>
        ) : (
          <Badge tone="accent">Dados principais preenchidos</Badge>
        )}

        <section aria-labelledby="confirm-hours">
          <h3 id="confirm-hours" className="font-medium text-fg">
            Horários
          </h3>
          {hours.length === 0 ? (
            <p className="mt-1 text-muted">Nenhum horário cadastrado: o cardápio aparece como fechado.</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {WEEKDAYS.map((day) => {
                const intervals = week[day.value] ?? [];
                return (
                  <li key={day.value} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1.5">
                    <span className="text-muted">{day.label}</span>
                    <span className="font-medium text-fg">
                      {intervals.length === 0 ? "Fechado" : intervals.map(describeInterval).join(" e ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {upcomingClosures.length > 0 && (
            <p className="mt-2 text-muted">
              Folgas marcadas: {upcomingClosures.map((exception) => formatDateBr(exception.on_date)).join(", ")}.
            </p>
          )}
          {todayException?.description && (
            <p className="mt-2 text-muted">Hoje há uma exceção: {todayException.description}</p>
          )}
        </section>

        <section aria-labelledby="confirm-delivery">
          <h3 id="confirm-delivery" className="font-medium text-fg">
            Pedidos e entrega
          </h3>
          <dl className="mt-2 grid gap-x-8 gap-y-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted">Modalidades</dt>
              <dd className="mt-0.5 font-medium text-fg">
                {types.length > 0 ? types.map((type) => FULFILLMENT_LABELS[type].label).join(", ") : "Nenhuma"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Pedidos online</dt>
              <dd className="mt-0.5 font-medium text-fg">{settings.accepts_orders ? "Ligados" : "Pausados"}</dd>
            </div>
            <div>
              <dt className="text-muted">Pedido mínimo</dt>
              <dd className="mt-0.5 font-medium text-fg">
                {settings.min_order_cents > 0 ? formatCents(settings.min_order_cents) : "Sem mínimo"}
              </dd>
            </div>
          </dl>
          {types.includes("DELIVERY") &&
            (activeZones.length === 0 ? (
              <p className="mt-2 text-muted">Nenhuma região de entrega ativa.</p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-line">
                {activeZones.map((zone) => (
                  <li key={zone.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1.5">
                    <span className="font-medium text-fg">{zone.name}</span>
                    <span className="text-muted">Taxa de entrega {formatCents(zone.fee_cents)}</span>
                  </li>
                ))}
              </ul>
            ))}
        </section>

        <section aria-labelledby="confirm-contact">
          <h3 id="confirm-contact" className="font-medium text-fg">
            Contato e aviso
          </h3>
          <dl className="mt-2 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-muted">WhatsApp</dt>
              <dd className="mt-0.5 font-medium text-fg">{whatsapp || "Não informado"}</dd>
            </div>
            <div>
              <dt className="text-muted">Endereço</dt>
              <dd className="mt-0.5 font-medium text-fg">{address || "Não informado"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted">Aviso fixo no topo do cardápio</dt>
              <dd className="mt-0.5 font-medium text-fg">{notice || "Sem aviso"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-muted">
            Para mudar WhatsApp, endereço ou aviso, use a tela{" "}
            <Link href={`/app/${slug}/restaurante`} className="font-medium text-fg underline">
              Restaurante
            </Link>
            . Horários, folgas e taxa de entrega são editados nas seções abaixo.
          </p>
        </section>
      </div>
    </Card>
  );
}
