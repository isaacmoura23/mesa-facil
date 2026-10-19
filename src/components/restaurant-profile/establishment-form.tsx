"use client";

import { useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImagePlus, Lock, Trash2 } from "lucide-react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { ProductThumb } from "@/components/menu-admin/product-thumb";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { SaveBar, SelectField } from "@/components/restaurant-settings/fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { publicImageUrl, PUBLIC_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/client";
import { IMAGE_ACCEPT, IMAGE_RULES_TEXT, validateImageFile } from "@/modules/menu/image";
import { saveEstablishmentAction } from "@/modules/restaurant-profile/actions";
import { buildLogoPath } from "@/modules/restaurant-profile/logo";
import { establishmentSchema, fieldErrorsOf, NAME_MAX } from "@/modules/restaurant-profile/schemas";
import { TIMEZONES } from "@/modules/restaurant-profile/timezones";
import type { EstablishmentRow } from "@/modules/restaurant-profile/types";

type EstablishmentFormProps = {
  slug: string;
  restaurantId: string;
  status: "pending" | "active" | "suspended";
  establishment: EstablishmentRow;
};

function omitLogoError(errors: Record<string, string>): Record<string, string> {
  const rest = { ...errors };
  delete rest.logo;
  return rest;
}

const STATUS_LABELS = { active: "Ativo", pending: "Aguardando aprovação", suspended: "Suspenso" } as const;

/** Seção "Dados do estabelecimento": nome, logo e fuso editáveis; slug e status só leitura. */
export function EstablishmentForm({ slug, restaurantId, status, establishment }: EstablishmentFormProps) {
  const { run, pending } = useMenuAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const logoHintId = useId();
  const [saved, setSaved] = useState(establishment);
  const [name, setName] = useState(establishment.name);
  const [timezone, setTimezone] = useState(establishment.timezone);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = name !== saved.name || timezone !== saved.timezone || file !== null || removeLogo;
  const savedUrl = removeLogo ? null : publicImageUrl(saved.logo_path);
  const shownUrl = file ? preview : savedUrl;
  const hasLogo = file !== null || savedUrl !== null;

  // Se o fuso salvo não está na lista oferecida, ele continua selecionável.
  const knownZone = TIMEZONES.some((option) => option.value === timezone);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!chosen) return;
    const problem = validateImageFile(chosen);
    if (problem) {
      setErrors((current) => ({ ...current, logo: problem }));
      return;
    }
    setErrors((current) => omitLogoError(current));
    const reader = new FileReader();
    reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(chosen);
    setFile(chosen);
    setRemoveLogo(false);
  }

  function clearLogo() {
    setFile(null);
    setPreview(null);
    setRemoveLogo(true);
    setErrors((current) => omitLogoError(current));
  }

  function discard() {
    setName(saved.name);
    setTimezone(saved.timezone);
    setFile(null);
    setPreview(null);
    setRemoveLogo(false);
    setErrors({});
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, timezone, logoPath: null as string | null, removeLogo };
    const parsed = establishmentSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error));
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);

    let uploadedPath: string | null = null;
    if (file) {
      const problem = validateImageFile(file);
      if (problem) {
        setErrors({ logo: problem });
        return;
      }
      setUploading(true);
      // Cliente do usuário: o RLS do Storage confere restaurante e permissão.
      const path = buildLogoPath(restaurantId, file.type);
      const { error } = await createClient()
        .storage.from(PUBLIC_BUCKET)
        .upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
      setUploading(false);
      if (error) {
        setErrors({ logo: "Não foi possível enviar a logo. Verifique o arquivo e tente novamente." });
        return;
      }
      uploadedPath = path;
    }

    const result = await run(
      () => saveEstablishmentAction(slug, { ...input, logoPath: uploadedPath }),
      { inlineError: true },
    );
    if (result.ok) {
      setSaved({
        name: parsed.data.name,
        timezone: parsed.data.timezone,
        logo_path: uploadedPath ?? (removeLogo ? null : saved.logo_path),
      });
      setName(parsed.data.name);
      setFile(null);
      setPreview(null);
      setRemoveLogo(false);
      return;
    }
    if (uploadedPath) void createClient().storage.from(PUBLIC_BUCKET).remove([uploadedPath]);
    setErrors(result.fieldErrors ?? {});
    setFormError(result.fieldErrors ? null : result.message);
  }

  return (
    <Card aria-labelledby="establishment-title">
      <CardHeader
        title={<span id="establishment-title">Dados do estabelecimento</span>}
        description="Nome, logo e fuso horário aparecem no cardápio e definem a hora dos seus horários de funcionamento."
      />
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <TextField
          label="Nome do restaurante"
          required
          maxLength={NAME_MAX}
          autoComplete="organization"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />

        <div className="flex flex-col gap-2">
          <span id={`${logoHintId}-label`} className="text-sm font-medium text-fg">
            Logo
          </span>
          <div className="flex items-center gap-4">
            <ProductThumb url={shownUrl} name={`Logo de ${saved.name}`} size="lg" />
            <div className="flex min-w-0 flex-col items-start gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending || uploading}
                  onClick={() => fileInput.current?.click()}
                  aria-describedby={logoHintId}
                >
                  <ImagePlus aria-hidden="true" className="size-4" />
                  {hasLogo ? "Trocar logo" : "Escolher logo"}
                </Button>
                {hasLogo ? (
                  <Button variant="ghost" size="sm" disabled={pending || uploading} onClick={clearLogo}>
                    <Trash2 aria-hidden="true" className="size-4" />
                    Remover
                  </Button>
                ) : null}
              </div>
              <p id={logoHintId} className="text-sm text-muted">
                {file ? `Selecionada: ${file.name}. ` : ""}
                {IMAGE_RULES_TEXT}
              </p>
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT}
            onChange={handleFile}
            className="sr-only"
            tabIndex={-1}
            aria-labelledby={`${logoHintId}-label`}
          />
          {errors.logo ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {errors.logo}
            </p>
          ) : null}
        </div>

        <SelectField
          label="Fuso horário"
          hint="Define o horário de abertura, as exceções e o relatório do dia."
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          error={errors.timezone}
        >
          {knownZone ? null : <option value={timezone}>{timezone}</option>}
          {(["Brasil", "Outros"] as const).map((group) => (
            <optgroup key={group} label={group === "Brasil" ? "Brasil" : "Outros países"}>
              {TIMEZONES.filter((option) => option.group === group).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectField>

        <div className="rounded-control bg-surface-2 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Lock aria-hidden="true" className="size-4 text-muted" />
            Controlados pela plataforma
          </p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Endereço (slug)</dt>
              <dd className="mt-0.5 font-mono text-fg">/{slug}</dd>
            </div>
            <div>
              <dt className="text-muted">Situação</dt>
              <dd className="mt-0.5">
                <Badge tone={status === "active" ? "accent" : "warning"}>{STATUS_LABELS[status]}</Badge>
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            O slug é o endereço público do seu cardápio e a situação (ativo ou suspenso) é decidida pela
            plataforma. Para trocar o slug, fale com o suporte.
          </p>
        </div>

        <FormError message={formError} />
        <SaveBar
          dirty={dirty}
          pending={pending || uploading}
          label="Salvar dados"
          onDiscard={discard}
        />
      </form>
    </Card>
  );
}
