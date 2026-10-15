"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Erro dentro do cardápio (a moldura com o carrinho continua visível). */
export default function StorefrontError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="flex flex-col items-center py-16 text-center">
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-control bg-danger-soft text-danger-soft-fg"
      >
        <TriangleAlert className="size-6" />
      </span>
      <h1 className="text-xl font-semibold text-fg">Não foi possível carregar o cardápio</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        Tivemos um problema ao buscar as informações. Tente de novo em instantes.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-muted">Código: {error.digest}</p>
      ) : null}
      <Button className="mt-6" onClick={() => retry()}>
        Tentar novamente
      </Button>
    </div>
  );
}
