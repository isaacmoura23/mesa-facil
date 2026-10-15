"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PackageSearch } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";

/** Código de pedido inexistente (ou de outro restaurante). Não revela nada além disso. */
export default function OrderNotFound() {
  const { slug } = useParams<{ slug?: string }>();
  const home = slug ? `/r/${encodeURIComponent(slug)}` : "/";
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-control bg-surface-2 text-muted"
      >
        <PackageSearch className="size-6" />
      </span>
      <h1 className="text-xl font-semibold text-fg">Pedido não encontrado</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        Não existe um pedido com este código neste restaurante. Confira o endereço que você recebeu
        ou faça um novo pedido pelo cardápio.
      </p>
      <Link href={home} className={buttonStyles({ className: "mt-6" })}>
        Voltar ao cardápio
      </Link>
    </div>
  );
}
