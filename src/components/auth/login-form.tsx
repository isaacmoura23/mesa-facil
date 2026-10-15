"use client";

import { useActionState, useState, type FormEvent } from "react";
import { loginAction } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { loginSchema, toFieldErrors, type FieldErrors } from "@/lib/validation/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { PasswordField } from "./password-field";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialFormState);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = loginSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
    });
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

      {next ? <input type="hidden" name="next" value={next} /> : null}

      <TextField
        label="E-mail"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
        error={errors.email}
      />
      <PasswordField
        label="Senha"
        name="password"
        autoComplete="current-password"
        required
        error={errors.password}
      />

      <Button type="submit" size="lg" fullWidth loading={pending}>
        {pending ? "Entrando..." : "Entrar"}
      </Button>
    </form>
  );
}
