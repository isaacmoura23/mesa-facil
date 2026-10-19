"use client";

import { useState, type FormEvent } from "react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { saveAcceptsOrdersAction } from "@/modules/restaurant-settings/actions";
import { SaveBar, Switch } from "./fields";

type AcceptsOrdersCardProps = {
  slug: string;
  acceptsOrders: boolean;
  /** Aberto agora segundo os horários (RPC pública); `null` quando não foi possível calcular. */
  openNow: boolean | null;
  hasHours: boolean;
};

/** Seção "Funcionamento": pausa dos pedidos online e indicador de aberto agora. */
export function AcceptsOrdersCard({ slug, acceptsOrders, openNow, hasHours }: AcceptsOrdersCardProps) {
  const { run, pending } = useMenuAction();
  const [saved, setSaved] = useState(acceptsOrders);
  const [value, setValue] = useState(acceptsOrders);
  const [formError, setFormError] = useState<string | null>(null);
  const dirty = value !== saved;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const result = await run(() => saveAcceptsOrdersAction(slug, { acceptsOrders: value }), {
      inlineError: true,
    });
    if (result.ok) setSaved(value);
    else setFormError(result.message);
  }

  let situation: { tone: "accent" | "warning" | "neutral"; text: string };
  if (!saved) {
    situation = { tone: "warning", text: "Pedidos online pausados" };
  } else if (openNow === true) {
    situation = { tone: "accent", text: "Recebendo pedidos online" };
  } else if (openNow === false) {
    situation = {
      tone: "neutral",
      text: hasHours ? "Fora do horário: a vitrine mostra fechado" : "Sem horários: a vitrine mostra fechado",
    };
  } else {
    situation = { tone: "neutral", text: "Situação indisponível" };
  }

  return (
    <Card aria-labelledby="accepts-title">
      <CardHeader
        title={<span id="accepts-title">Funcionamento</span>}
        description="Pause ou reabra os pedidos online do cardápio."
        action={
          openNow === null ? null : (
            <Badge tone={openNow ? "accent" : "neutral"}>{openNow ? "Aberto agora" : "Fechado agora"}</Badge>
          )
        }
      />
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Switch
          checked={value}
          onChange={setValue}
          label="Aceitando pedidos online"
          description="Ao pausar, a vitrine deixa de aceitar novos pedidos e avisa o cliente. Pedidos em andamento, mesas e comandas continuam funcionando normalmente: a pausa só vale para a vitrine online."
        />
        <p className="text-sm text-muted">
          Agora: <Badge tone={situation.tone}>{situation.text}</Badge>
        </p>
        <FormError message={formError} />
        <SaveBar
          dirty={dirty}
          pending={pending}
          label="Salvar funcionamento"
          onDiscard={() => setValue(saved)}
        />
      </form>
    </Card>
  );
}
