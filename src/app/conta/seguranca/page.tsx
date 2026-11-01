import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { getPublicEnvStatus } from "@/lib/env";
import { requireUser } from "@/lib/auth/guards";
import { getMfaFactors, getMfaState } from "@/lib/auth/mfa";
import { isPlatformAdmin } from "@/lib/auth/rpc";
import { sanitizeNext } from "@/lib/utils/safe-redirect";
import { AuthShell, AuthSkeleton } from "@/components/auth/auth-shell";
import { MfaSetup } from "@/components/auth/mfa-setup";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Segurança da conta", robots: { index: false, follow: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function SecurityPage(props: PageProps<"/conta/seguranca">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <SecurityContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function SecurityContent({ searchParams }: { searchParams: PageProps<"/conta/seguranca">["searchParams"] }) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;
  await requireUser("/conta/seguranca");

  const params = await searchParams;
  const next = sanitizeNext(first(params.next));
  const required = first(params.obrigatorio) === "1" && (await isPlatformAdmin());
  const [factors, state] = await Promise.all([getMfaFactors(), getMfaState()]);

  return (
    <AuthShell size="lg">
      <Card aria-labelledby="titulo-seguranca">
        <h1 id="titulo-seguranca" className="text-2xl font-semibold tracking-tight text-fg">
          Segurança da conta
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted">
          A verificação em duas etapas pede, além da senha, um código de 6 números gerado no seu celular.
        </p>
        {required ? (
          <Alert tone="warning" title="Verificação em duas etapas obrigatória" className="mb-6">
            Administradores da plataforma precisam ativar o autenticador para continuar.
          </Alert>
        ) : null}
        <MfaSetup
          verified={factors.verified}
          unverifiedIds={factors.unverified.map((factor) => factor.id)}
          aal2={state.aal2}
          next={required ? next : null}
        />
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        <Link href={next ?? "/entrar"} className="font-medium text-accent-soft-fg underline underline-offset-4">
          Voltar
        </Link>
      </p>
    </AuthShell>
  );
}
