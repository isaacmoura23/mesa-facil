import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getPublicEnvStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth/session";
import { AuthShell, AuthSkeleton } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Criar nova senha" };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

/** Só abre o formulário com a sessão de recuperação criada pelo link do e-mail (/auth/callback). */
async function ResetPasswordContent() {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;
  const user = await getCurrentUser();

  return (
    <AuthShell>
      <Card aria-labelledby="titulo-redefinir">
        <h1 id="titulo-redefinir" className="text-2xl font-semibold tracking-tight text-fg">
          Criar nova senha
        </h1>
        {user ? (
          <>
            <p className="mt-1 mb-6 text-sm text-muted">Escolha uma senha nova para a sua conta.</p>
            <ResetPasswordForm />
          </>
        ) : (
          <div className="mt-4 flex flex-col gap-5">
            <Alert tone="danger">
              O link de recuperação é inválido, expirou ou já foi usado. Peça um novo link.
            </Alert>
            <Link href="/esqueci-senha" className={buttonStyles({ variant: "secondary", size: "lg", fullWidth: true })}>
              Pedir novo link
            </Link>
          </div>
        )}
      </Card>
    </AuthShell>
  );
}
