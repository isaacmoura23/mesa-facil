"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { SearchX } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";

/** 404 dentro do cardápio (produto inexistente ou de outro restaurante). */
export default function StorefrontNotFound() {
  const { slug } = useParams<{ slug?: string }>();
  const home = slug ? `/r/${encodeURIComponent(slug)}` : "/";
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-control bg-surface-2 text-muted"
      >
        <SearchX className="size-6" />
      </span>
      <h1 className="text-xl font-semibold text-fg">Página não encontrada</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        Este item ou página não existe neste cardápio. Volte ao cardápio para ver o que está disponível.
      </p>
      <Link href={home} className={buttonStyles({ className: "mt-6" })}>
        Voltar ao cardápio
      </Link>
    </div>
  );
}
