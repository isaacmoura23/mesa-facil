import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldOff } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SessionView } from "@/components/platform-admin/session-view";
import { toOverview } from "@/modules/platform-admin/overview";
import { fetchSupportOverview, getPlatformAccess } from "@/modules/platform-admin/queries";
import { sessionIdSchema } from "@/modules/platform-admin/schemas";

export const metadata: Metadata = { title: "Visão de suporte (plataforma)" };

export default async function Page({ params }: PageProps<"/platform/support/[sessionId]">) {
  const { sessionId } = await params;
  const id = sessionIdSchema.safeParse(sessionId);
  if (!id.success) notFound();
  await getPlatformAccess(`/platform/support/${id.data}`);

  const result = await fetchSupportOverview(id.data);
  const overview = result.ok ? toOverview(result.data) : null;

  return (
    <>
      <PageHeader title="Visão de suporte" description="Leitura de apoio ao atendimento. Nada aqui pode ser alterado." />
      {overview ? (
        <SessionView overview={overview} />
      ) : (
        <EmptyState
          icon={<ShieldOff />}
          title={result.ok || result.code === "error" ? "Não foi possível abrir a visão" : "Sessão indisponível"}
          description={result.ok ? "A resposta do servidor não pôde ser lida." : result.message}
          action={
            <Link href="/platform/support?aba=sessoes" className={buttonStyles({ variant: "secondary" })}>
              Voltar às sessões
            </Link>
          }
        />
      )}
    </>
  );
}
