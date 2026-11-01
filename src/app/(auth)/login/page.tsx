import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getPublicEnvStatus } from "@/lib/env";
import { sanitizeNext } from "@/lib/utils/safe-redirect";
import { AuthShell, AuthSkeleton } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Entrar" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <LoginContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function LoginContent({
  searchParams,
}: {
  searchParams: PageProps<"/login">["searchParams"];
}) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  const params = await searchParams;
  const next = sanitizeNext(first(params.next)) ?? undefined;
  const callbackFailed = first(params.erro) === "callback";
  const passwordReset = first(params.senha) === "redefinida";

  return (
    <AuthShell>
      <Card aria-labelledby="titulo-login">
        <h1 id="titulo-login" className="text-2xl font-semibold tracking-tight text-fg">
          Entrar
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted">Acesse o painel do seu restaurante.</p>

        {passwordReset ? (
          <Alert tone="success" className="mb-5">
            Senha alterada. Entre com a nova senha.
          </Alert>
        ) : null}

        {callbackFailed ? (
          <Alert tone="danger" className="mb-5">
            O link de confirmação é inválido ou expirou. Entre com seu e-mail e senha ou
            crie a conta novamente.
          </Alert>
        ) : null}

        <LoginForm next={next} />
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        Ainda não tem conta?{" "}
        <Link href="/cadastro" className="font-medium text-accent-soft-fg underline underline-offset-4">
          Criar conta
        </Link>
      </p>
    </AuthShell>
  );
}
