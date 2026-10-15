import type { Metadata } from "next";
import Link from "next/link";
import { getPublicEnvStatus } from "@/lib/env";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { SupabaseNotConfigured } from "@/components/supabase-not-configured";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Criar conta" };

export default function SignupPage() {
  if (!getPublicEnvStatus().ok) return <SupabaseNotConfigured />;

  return (
    <AuthShell>
      <Card aria-labelledby="titulo-cadastro">
        <h1 id="titulo-cadastro" className="text-2xl font-semibold tracking-tight text-fg">
          Criar conta
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted">
          Depois de criar a conta, você pode registrar seu restaurante ou aguardar um
          convite.
        </p>
        <SignupForm />
      </Card>
      <p className="mt-6 text-center text-sm text-muted">
        Já tem conta?{" "}
        <Link href="/login" className="font-medium text-accent-soft-fg underline underline-offset-4">
          Entrar
        </Link>
      </p>
    </AuthShell>
  );
}
