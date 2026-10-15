import Link from "next/link";
import { notFound } from "next/navigation";
import { Hourglass } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

type Props = { params: Promise<{ slug: string; publicCode: string }> };

export const metadata = { title: "Acompanhar pedido" };

/**
 * O acompanhamento de pedidos (RPC pública de status) chega na próxima etapa.
 * Até lá a página é honesta: não consulta nem exibe nenhum pedido.
 */
export default async function Page({ params }: Props) {
  const { slug, publicCode } = await params;
  if (!/^[A-Za-z0-9-]{3,40}$/.test(publicCode)) notFound();

  return (
    <EmptyState
      icon={<Hourglass />}
      title="Acompanhamento de pedido em breve"
      description="O envio e o acompanhamento de pedidos online ainda não estão disponíveis neste cardápio. Nenhum pedido foi registrado."
      action={
        <Link href={`/r/${encodeURIComponent(slug)}`} className={buttonStyles({ variant: "secondary" })}>
          Voltar ao cardápio
        </Link>
      }
    />
  );
}
