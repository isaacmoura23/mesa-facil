"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resetPasswordSchema, toFieldErrors, type FieldErrors } from "@/lib/validation/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PasswordField } from "./password-field";

/**
 * Define a nova senha da sessão de recuperação (aberta por /auth/callback). A troca é feita pelo cliente do
 * navegador, que já guarda a sessão: uma Server Action que grava cookies e devolve estado faria o Next
 * re-renderizar a página dentro da resposta da ação (invariante de cookies), então fica fora do servidor.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = resetPasswordSchema.safeParse({
      password: data.get("password"),
      confirmPassword: data.get("confirmPassword"),
    });
    setMessage(null);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    if (error) {
      setBusy(false);
      if (error.code === "weak_password") {
        setErrors({ password: "Senha considerada fraca. Escolha outra mais forte." });
      } else if (error.code === "same_password") {
        setErrors({ password: "Escolha uma senha diferente da atual." });
      } else if (error.status === 401 || error.code === "session_not_found" || error.code === "user_not_found") {
        setMessage("O link de recuperação expirou ou já foi usado. Peça um novo em Esqueci minha senha.");
      } else {
        setMessage("Não foi possível alterar a senha agora. Tente novamente em instantes.");
      }
      return;
    }

    // Encerra a sessão de recuperação: a pessoa entra de novo com a senha nova.
    await supabase.auth.signOut();
    router.replace("/login?senha=redefinida");
  }

  return (
    // method="post": se o envio acontecer antes da hidratação, a senha nunca vai para a URL.
    <form method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {message ? <Alert tone="danger">{message}</Alert> : null}
      <PasswordField
        label="Nova senha"
        name="password"
        autoComplete="new-password"
        hint="Mínimo de 8 caracteres, com letras e números."
        required
        error={errors.password}
      />
      <PasswordField
        label="Repita a nova senha"
        name="confirmPassword"
        autoComplete="new-password"
        required
        error={errors.confirmPassword}
      />
      <Button type="submit" size="lg" fullWidth loading={busy}>
        {busy ? "Salvando..." : "Salvar nova senha"}
      </Button>
    </form>
  );
}
