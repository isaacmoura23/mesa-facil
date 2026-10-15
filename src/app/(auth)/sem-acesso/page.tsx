import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Sem permissão" };

export default function NoAccessPage() {
  return (
    <AuthShell>
      <EmptyState
        icon={<Lock />}
        title="Você não tem permissão para esta área"
        description="Seu papel neste restaurante não inclui acesso a esta página. Peça ao proprietário para ajustar suas permissões."
        action={
          <Link href="/entrar" className={buttonStyles()}>
            Voltar ao início
          </Link>
        }
      />
    </AuthShell>
  );
}
