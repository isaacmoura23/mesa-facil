import type { Metadata } from "next";
import Link from "next/link";
import { getPublicEnvStatus } from "@/lib/env";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Esqueci minha senha" };

export default function ForgotPasswordPage() {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  return (
    <AuthShell>
      <Card aria-labelledby="titulo-esqueci">
        <h1 id="titulo-esqueci" className="text-2xl font-semibold tracking-tight text-fg">
          Esqueci minha senha
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted">
          Informe o e-mail da sua conta. Enviaremos um link para você criar uma nova senha.
        </p>
        <ForgotPasswordForm />
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        Lembrou a senha?{" "}
        <Link href="/login" className="font-medium text-accent-soft-fg underline underline-offset-4">
          Entrar
        </Link>
      </p>
    </AuthShell>
  );
}
