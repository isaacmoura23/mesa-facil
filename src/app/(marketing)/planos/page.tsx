import type { Metadata } from "next";
import Link from "next/link";
import { Tags } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Planos" };

export default function PlansPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        title="Planos"
        description="Os planos e valores ainda estão em definição."
      />
      <EmptyState
        icon={<Tags />}
        title="Nenhum plano publicado"
        description="Quando os planos forem definidos, eles aparecerão aqui com preços e recursos. Enquanto isso, você pode criar sua conta e registrar seu restaurante."
        action={
          <Link href="/cadastro" className={buttonStyles()}>
            Criar conta
          </Link>
        }
      />
    </div>
  );
}
