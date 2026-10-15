"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button, buttonStyles } from "@/components/ui/button";

type ErrorViewProps = {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref?: string;
  homeLabel?: string;
};

/** Conteúdo padrão dos error.tsx: mensagem genérica, código de suporte e nova tentativa. */
export function ErrorView({
  error,
  retry,
  homeHref = "/",
  homeLabel = "Voltar ao início",
}: ErrorViewProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
      <BrandMark className="mb-8" />
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-control bg-danger-soft text-danger-soft-fg"
      >
        <TriangleAlert className="size-6" />
      </span>
      <h1 className="text-xl font-semibold text-fg">Algo deu errado</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        Não foi possível carregar esta página. Tente de novo; se o problema continuar,
        informe o código abaixo ao suporte.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-muted">Código: {error.digest}</p>
      ) : null}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => retry()}>Tentar novamente</Button>
        <Link href={homeHref} className={buttonStyles({ variant: "secondary" })}>
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
