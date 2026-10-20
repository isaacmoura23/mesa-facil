"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Switch, TextAreaField } from "@/components/menu-admin/fields";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { saveSettingsAction } from "@/modules/platform-admin/actions";
import { fieldErrorsOf, settingsFormSchema } from "@/modules/platform-admin/schemas";
import type { PlatformSettings } from "@/modules/platform-admin/types";
import { ReadOnlyNotice } from "./common";

type Values = {
  registrationEnabled: boolean;
  defaultTrialDays: string;
  supportEmail: string;
  maintenanceMessage: string;
};

function toValues(settings: PlatformSettings): Values {
  return {
    registrationEnabled: settings.registrationEnabled,
    defaultTrialDays: String(settings.defaultTrialDays),
    supportEmail: settings.supportEmail,
    maintenanceMessage: settings.maintenanceMessage,
  };
}

const KEY_OF: Record<keyof Values, string> = {
  registrationEnabled: "registration_enabled",
  defaultTrialDays: "default_trial_days",
  supportEmail: "support_email",
  maintenanceMessage: "maintenance_message",
};

export function SettingsForm({ settings, canWrite }: { settings: PlatformSettings; canWrite: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const saved = toValues(settings);
  const [values, setValues] = useState<Values>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changed = (Object.keys(values) as (keyof Values)[]).filter((key) => values[key] !== saved[key]);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = settingsFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError("Revise os campos destacados.");
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof saveSettingsAction>>;
      try {
        result = await saveSettingsAction(values, changed.map((key) => KEY_OF[key]));
      } catch {
        result = { ok: false, message: "Não foi possível salvar agora. Tente novamente em instantes." };
      }
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.message);
        return;
      }
      toast({ title: result.message ?? "Configurações salvas", tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-6">
        {!canWrite ? <ReadOnlyNotice /> : null}
        <Card as="section" aria-labelledby="config-form">
          <CardHeader title={<span id="config-form">Configurações da plataforma</span>} />
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <Switch
              checked={values.registrationEnabled}
              onChange={(checked) => set("registrationEnabled", checked)}
              disabled={!canWrite}
              label="Cadastro de novos restaurantes"
              description="Quando desligado, ninguém consegue registrar um novo restaurante."
            />
            {!values.registrationEnabled ? (
              <Alert tone="warning">
                Com o cadastro desligado, novos restaurantes são bloqueados. Restaurantes existentes continuam funcionando.
              </Alert>
            ) : null}
            <TextField
              label="Dias de teste padrão"
              inputMode="numeric"
              disabled={!canWrite}
              value={values.defaultTrialDays}
              error={errors.defaultTrialDays}
              hint="De 0 a 365 dias para novas assinaturas em teste."
              onChange={(e) => set("defaultTrialDays", e.target.value)}
            />
            <TextField
              label="E-mail de suporte"
              type="email"
              disabled={!canWrite}
              value={values.supportEmail}
              error={errors.supportEmail}
              maxLength={200}
              onChange={(e) => set("supportEmail", e.target.value)}
            />
            <TextAreaField
              label="Mensagem de manutenção"
              hint="Opcional, até 300 caracteres. Deixe vazio para não exibir aviso."
              rows={3}
              maxLength={300}
              disabled={!canWrite}
              value={values.maintenanceMessage}
              error={errors.maintenanceMessage}
              onChange={(e) => set("maintenanceMessage", e.target.value)}
            />
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            {canWrite ? (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={() => setValues(saved)} disabled={pending || changed.length === 0}>
                  Descartar alterações
                </Button>
                <Button type="submit" loading={pending} disabled={changed.length === 0}>
                  Salvar configurações
                </Button>
              </div>
            ) : null}
          </form>
        </Card>
      </div>

      <Card as="section" aria-labelledby="config-atual" className="self-start">
        <CardHeader title={<span id="config-atual">Estado atual</span>} description="Valores gravados no banco." />
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Cadastro de restaurantes</dt>
            <dd>
              <Badge tone={settings.registrationEnabled ? "accent" : "warning"}>{settings.registrationEnabled ? "Ligado" : "Desligado"}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Dias de teste</dt>
            <dd className="font-medium tabular-nums text-fg">{settings.defaultTrialDays}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">E-mail de suporte</dt>
            <dd className="min-w-0 break-all font-medium text-fg">{settings.supportEmail || "Não definido"}</dd>
          </div>
          <div>
            <dt className="text-muted">Mensagem de manutenção</dt>
            <dd className="mt-1 break-words font-medium text-fg">{settings.maintenanceMessage || "Nenhuma"}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
