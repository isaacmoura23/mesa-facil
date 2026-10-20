"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { slugify } from "@/lib/validation/auth";
import { createRestaurantAction } from "@/modules/platform-restaurants/actions";
import { SUPPORT_READONLY_REASON } from "@/modules/platform-restaurants/labels";

/**
 * "Novo restaurante". Somente superadmin escreve: para o perfil de suporte o
 * botão fica desabilitado e o motivo aparece em texto (o banco é a autoridade).
 */
export function NewRestaurantForm({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const panelId = useId();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) document.getElementById(`${panelId}-name`)?.focus();
  }, [open, panelId]);

  const reset = () => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setOwnerEmail("");
    setErrors({});
    setFormError(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      const result = await createRestaurantAction({ name, slug, ownerEmail });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        // Sem campo associado, o erro vai para o alerta do formulário.
        if (!result.fieldErrors || Object.keys(result.fieldErrors).length === 0) setFormError(result.message);
        return;
      }
      toast({ title: result.message ?? "Restaurante criado", tone: "success" });
      reset();
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button
          onClick={() => setOpen(true)}
          disabled={!canWrite}
          aria-describedby={canWrite ? undefined : reasonId}
          aria-expanded={false}
          aria-controls={panelId}
        >
          <Plus aria-hidden="true" className="size-4" />
          Novo restaurante
        </Button>
        {!canWrite ? (
          <p id={reasonId} className="max-w-md text-xs text-muted">
            {SUPPORT_READONLY_REASON}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Card id={panelId} className="w-full" aria-labelledby={`${panelId}-title`}>
      <CardHeader
        title={<span id={`${panelId}-title`}>Novo restaurante</span>}
        description="O dono precisa ter criado uma conta antes. O restaurante nasce ativo, com assinatura de teste no plano padrão."
      />
      <form onSubmit={onSubmit} noValidate className="grid gap-4 md:grid-cols-3">
        <TextField
          label="Nome do restaurante"
          required
          name="name"
          autoComplete="off"
          maxLength={120}
          value={name}
          error={errors.name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(slugify(event.target.value));
          }}
          id={`${panelId}-name`}
        />
        <TextField
          label="Endereço (slug)"
          required
          name="slug"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={63}
          hint="3 a 63 letras minúsculas, números e hífen."
          value={slug}
          error={errors.slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value.toLowerCase());
          }}
        />
        <TextField
          label="E-mail do dono"
          required
          type="email"
          name="ownerEmail"
          autoComplete="off"
          inputMode="email"
          maxLength={254}
          hint="A conta do dono já deve existir."
          value={ownerEmail}
          error={errors.ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
        />
        {formError ? (
          <div className="md:col-span-3">
            <Alert tone="danger">{formError}</Alert>
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end md:col-span-3">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancelar
          </Button>
          <Button type="submit" loading={pending}>
            Criar restaurante
          </Button>
        </div>
      </form>
    </Card>
  );
}
