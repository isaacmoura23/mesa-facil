"use client";

import { useActionState, useState, type FormEvent } from "react";
import { registerRestaurantAction } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import {
  registerRestaurantSchema,
  slugify,
  toFieldErrors,
  type FieldErrors,
} from "@/lib/validation/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";

export function RegisterRestaurantForm() {
  const [state, formAction, pending] = useActionState(
    registerRestaurantAction,
    initialFormState,
  );
  const [name, setName] = useState(state.values?.name ?? "");
  const [slug, setSlug] = useState(state.values?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(Boolean(state.values?.slug));
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const parsed = registerRestaurantSchema.safeParse({ name, slug });
    if (!parsed.success) {
      event.preventDefault();
      setClientErrors(toFieldErrors(parsed.error));
      return;
    }
    setClientErrors({});
  }

  const errors = { ...state.fieldErrors, ...clientErrors };

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {state.status === "error" && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <TextField
        label="Nome do restaurante"
        name="name"
        autoComplete="organization"
        required
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (!slugEdited) setSlug(slugify(event.target.value));
        }}
        error={errors.name}
      />
      <TextField
        label="Endereço do cardápio"
        name="slug"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={slug}
        onChange={(event) => {
          setSlugEdited(true);
          setSlug(event.target.value.toLowerCase());
        }}
        hint={`Seu cardápio ficará em /r/${slug || "nome-do-restaurante"}. Use letras minúsculas, números e hífen.`}
        error={errors.slug}
      />

      <Button type="submit" size="lg" loading={pending}>
        {pending ? "Registrando..." : "Registrar restaurante"}
      </Button>
    </form>
  );
}
