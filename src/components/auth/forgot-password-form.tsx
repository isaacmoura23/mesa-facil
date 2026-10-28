"use client";

import { useActionState, useState, type FormEvent } from "react";
import Link from "next/link";
import { forgotPasswordAction } from "@/lib/auth/actions";
import { initialFormState } from "@/lib/auth/form-state";
import { forgotPasswordSchema, toFieldErrors, type FieldErrors } from "@/lib/validation/auth";
import { TurnstileWidget } from "@/components/captcha/turnstile-widget";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialFormState);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = forgotPasswordSchema.safeParse({ email: data.get("email") });
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
        <Alert tone="success" title="Confira seu e-mail">
          {state.message}
        </Alert>
        <Link href="/login" className={buttonStyles({ variant: "secondary", size: "lg", fullWidth: true })}>
          Voltar para o login
        </Link>
      </div>
    );
  }

  const errors = { ...state.fieldErrors, ...clientErrors };

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {state.status === "error" && state.message ? <Alert tone="danger">{state.message}</Alert> : null}

      <TextField
        label="E-mail da conta"
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
      <TurnstileWidget resetKey={state} className="flex justify-center" />

      <Button type="submit" size="lg" fullWidth loading={pending}>
        {pending ? "Enviando..." : "Enviar link de recuperação"}
      </Button>
    </form>
  );
}
