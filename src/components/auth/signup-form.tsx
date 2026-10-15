"use client";

import { useActionState, useState, type FormEvent } from "react";
import Link from "next/link";
import { signupAction } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { signupSchema, toFieldErrors, type FieldErrors } from "@/lib/validation/auth";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { PasswordField } from "./password-field";

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signupAction, initialFormState);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = signupSchema.safeParse({
      fullName: data.get("fullName"),
      email: data.get("email"),
      password: data.get("password"),
      confirmPassword: data.get("confirmPassword"),
    });
    if (!parsed.success) {
      event.preventDefault();
      setClientErrors(toFieldErrors(parsed.error));
      return;
    }
    setClientErrors({});
  }

  if (state.status === "success") {
    return (
      <div className="flex flex-col gap-5">
        <Alert tone="success" title="Quase lá">
          {state.message}
        </Alert>
        <Link href="/login" className={buttonStyles({ variant: "secondary", size: "lg", fullWidth: true })}>
          Ir para o login
        </Link>
      </div>
    );
  }

  const errors = { ...state.fieldErrors, ...clientErrors };

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {state.status === "error" && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <TextField
        label="Nome completo"
        name="fullName"
        autoComplete="name"
        required
        defaultValue={state.values?.fullName}
        error={errors.fullName}
      />
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
        autoComplete="new-password"
        hint="Mínimo de 8 caracteres, com letras e números."
        required
        error={errors.password}
      />
      <PasswordField
        label="Repita a senha"
        name="confirmPassword"
        autoComplete="new-password"
        required
        error={errors.confirmPassword}
      />

      <Button type="submit" size="lg" fullWidth loading={pending}>
        {pending ? "Criando conta..." : "Criar conta"}
      </Button>
    </form>
  );
}
