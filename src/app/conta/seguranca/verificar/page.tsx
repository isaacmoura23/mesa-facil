import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getPublicEnvStatus } from "@/lib/env";
import { requireUser } from "@/lib/auth/guards";
import { getMfaFactors, getMfaState } from "@/lib/auth/mfa";
import { sanitizeNext } from "@/lib/utils/safe-redirect";
import { AuthShell, AuthSkeleton } from "@/components/auth/auth-shell";
import { MfaVerifyForm } from "@/components/auth/mfa-verify-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Verificação em duas etapas", robots: { index: false, follow: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function VerifyPage(props: PageProps<"/conta/seguranca/verificar">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <VerifyContent searchParams={props.searchParams} />
    </Suspense>
  );
}

async function VerifyContent({
  searchParams,
}: {
  searchParams: PageProps<"/conta/seguranca/verificar">["searchParams"];
}) {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;
  await requireUser("/conta/seguranca/verificar");

  const params = await searchParams;
  const next = sanitizeNext(first(params.next)) ?? "/entrar";
  const [state, factors] = await Promise.all([getMfaState(), getMfaFactors()]);

  if (state.aal2) redirect(next);
  const factor = factors.verified[0];
  // Sem fator cadastrado não há o que verificar: vai ao cadastro.
  if (!factor) redirect(`/conta/seguranca?obrigatorio=1&next=${encodeURIComponent(next)}`);

  return (
    <AuthShell>
      <Card aria-labelledby="titulo-verificar">
        <h1 id="titulo-verificar" className="text-2xl font-semibold tracking-tight text-fg">
          Verificação em duas etapas
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted">
          Digite o código de 6 números do seu aplicativo autenticador para continuar.
        </p>
        <MfaVerifyForm factorId={factor.id} next={next} />
      </Card>
    </AuthShell>
  );
}
